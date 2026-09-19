import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantTx } from "@/lib/db/types";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  ACCOUNTING_SYNC_COMMAND_VERSION,
  buildAccountingExportPayload,
  hashAccountingExportPayload,
} from "@/lib/integrations/invoicing/accounting-contract";
import { FakeAccountingProvider } from "@/lib/integrations/invoicing/accounting-provider";
import {
  getAccountingSyncStatus,
  listAccountingSyncs,
  queueAccountingSync,
  runAccountingSync,
} from "@/modules/invoicing/accounting-sync-service";
import {
  InvoicingConflictError,
  InvoicingNotFoundError,
  InvoicingValidationError,
} from "@/modules/invoicing/errors";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const UPDATED_AT = "2026-11-15T10:00:00.000Z";

type StubResponse = { rows: Record<string, unknown>[] } | Error;

function makeTx(responses: StubResponse[]) {
  const queue = [...responses];
  const execute = vi.fn(async () => {
    const next = queue.shift() ?? { rows: [] };
    if (next instanceof Error) throw next;
    return next;
  });
  return { tx: { execute } as unknown as TenantTx, execute };
}

function ctx(
  role: ServiceCtx["role"],
  capabilities: ServiceCtx["capabilities"],
): ServiceCtx {
  return { role, capabilities, featureFlags: {}, workspaceId: WORKSPACE_ID, actor: ACTOR_ID };
}

const editorCtx = () => ctx("editor", { invoicing: true });
const viewerCtx = () => ctx("viewer", {});
const externalCtx = () => ctx("editor", { invoicing: true, external_only: true });
const editorNoCapCtx = () => ctx("editor", {});
const adminCtx = () => ctx("admin", {});

const command = {
  schemaVersion: ACCOUNTING_SYNC_COMMAND_VERSION,
  documentId: DOCUMENT_ID,
  vendor: "lexoffice",
} as const;

function docRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOCUMENT_ID,
    type: "invoice",
    status: "issued",
    number: "RE-2026-000001",
    currency: "EUR",
    issued_date: "2026-11-15",
    contact_name: "Muster Kundin",
    net_cents: 15000,
    tax_cents: 2850,
    gross_cents: 17850,
    ...overrides,
  };
}

function lineRows() {
  return [
    { tax_rate_bps: 1900, net_cents: 10000, tax_cents: 1900, gross_cents: 11900 },
    { tax_rate_bps: 1900, net_cents: 5000, tax_cents: 950, gross_cents: 5950 },
  ];
}

// Geänderter Belegstand (summenkonsistent) für Drift/Re-Queue-Fälle.
function changedDocRow() {
  return docRow({ net_cents: 16000, tax_cents: 3040, gross_cents: 19040 });
}

function changedLineRows() {
  return [
    { tax_rate_bps: 1900, net_cents: 11000, tax_cents: 2090, gross_cents: 13090 },
    { tax_rate_bps: 1900, net_cents: 5000, tax_cents: 950, gross_cents: 5950 },
  ];
}

function shaFor(document: Record<string, unknown>, lines: Record<string, unknown>[]) {
  const payload = buildAccountingExportPayload({
    kind: document.type as string,
    status: document.status as string,
    number: (document.number as string) ?? "",
    issueDate: (document.issued_date as string) ?? "",
    contactName: (document.contact_name as string) ?? "",
    currency: document.currency as string,
    lines: lines.map((line) => ({
      taxRateBps: Number(line.tax_rate_bps),
      netCents: Number(line.net_cents),
      taxCents: Number(line.tax_cents),
      grossCents: Number(line.gross_cents),
    })),
    netCents: Number(document.net_cents),
    taxCents: Number(document.tax_cents),
    grossCents: Number(document.gross_cents),
  });
  return hashAccountingExportPayload(payload);
}

const CURRENT_SHA = shaFor(docRow(), lineRows());
const CHANGED_SHA = shaFor(changedDocRow(), changedLineRows());

function syncRow(overrides: Record<string, unknown> = {}) {
  return {
    document_id: DOCUMENT_ID,
    vendor: "lexoffice",
    state: "queued",
    payload_sha256: CURRENT_SHA,
    external_id: null,
    attempts: 0,
    last_error: null,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

describe("F8-21 Service-Gating (F821-CT-05)", () => {
  it("Editor mit invoicing.write queued, liest und startet", async () => {
    const queued = makeTx([
      { rows: [docRow()] },
      { rows: lineRows() },
      { rows: [] },
      { rows: [syncRow()] },
    ]);
    const created = await queueAccountingSync(queued.tx, editorCtx(), { ...command });
    expect(created.state).toBe("queued");
    expect(queued.execute).toHaveBeenCalledTimes(4);

    const read = makeTx([{ rows: [syncRow()] }]);
    await expect(
      getAccountingSyncStatus(read.tx, editorCtx(), { ...command }),
    ).resolves.toMatchObject({ state: "queued" });
    const listed = makeTx([{ rows: [syncRow()] }]);
    await expect(listAccountingSyncs(listed.tx, editorCtx())).resolves.toMatchObject({
      syncs: [{ state: "queued" }],
    });
    const run = makeTx([
      { rows: [syncRow()] },
      { rows: [docRow()] },
      { rows: lineRows() },
      { rows: [syncRow({ state: "exported", external_id: "fake-lexoffice-000001", attempts: 1 })] },
    ]);
    await expect(
      runAccountingSync(run.tx, editorCtx(), { ...command }, new FakeAccountingProvider("lexoffice")),
    ).resolves.toMatchObject({ state: "exported" });
  });

  it("Admin ohne Capability-Flag darf (Admin-Bypass wie M3-02d)", async () => {
    const harness = makeTx([{ rows: [syncRow()] }]);
    await expect(
      getAccountingSyncStatus(harness.tx, adminCtx(), { ...command }),
    ).resolves.toMatchObject({ documentId: DOCUMENT_ID });
  });

  it("Viewer/External/kappeneditor fail-closed VOR jedem DB-Zugriff", async () => {
    for (const deniedCtx of [viewerCtx(), externalCtx(), editorNoCapCtx()]) {
      for (const call of [
        (tx: TenantTx) => queueAccountingSync(tx, deniedCtx, { ...command }),
        (tx: TenantTx) => getAccountingSyncStatus(tx, deniedCtx, { ...command }),
        (tx: TenantTx) => listAccountingSyncs(tx, deniedCtx),
        (tx: TenantTx) =>
          runAccountingSync(tx, deniedCtx, { ...command }, new FakeAccountingProvider("lexoffice")),
      ]) {
        const harness = makeTx([{ rows: [syncRow()] }]);
        await expect(call(harness.tx)).rejects.toThrowError(PermissionDeniedError);
        expect(harness.execute).not.toHaveBeenCalled();
      }
    }
  });

  it("ungueltige Kommandos fail-closed (UUID, Vendor, Version, Filter)", async () => {
    const harness = makeTx([]);
    await expect(
      queueAccountingSync(harness.tx, editorCtx(), { ...command, documentId: "keine-uuid" }),
    ).rejects.toThrowError(InvoicingValidationError);
    await expect(
      queueAccountingSync(harness.tx, editorCtx(), { ...command, vendor: "datev" as never }),
    ).rejects.toThrowError(InvoicingValidationError);
    await expect(
      queueAccountingSync(harness.tx, editorCtx(), { ...command, schemaVersion: "x" as never }),
    ).rejects.toThrowError(InvoicingValidationError);
    await expect(
      listAccountingSyncs(harness.tx, editorCtx(), { documentId: "keine-uuid" }),
    ).rejects.toThrowError(InvoicingValidationError);
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("kein Orakel: fehlend/entwurf/fremdtyp melden unterschiedslos not_found", async () => {
    const missing = makeTx([]);
    await expect(
      queueAccountingSync(missing.tx, editorCtx(), { ...command }),
    ).rejects.toThrowError(InvoicingNotFoundError);
    const draft = makeTx([{ rows: [docRow({ status: "draft" })] }]);
    await expect(
      queueAccountingSync(draft.tx, editorCtx(), { ...command }),
    ).rejects.toThrowError(InvoicingNotFoundError);
    const foreign = makeTx([{ rows: [docRow({ type: "delivery_note" })] }]);
    await expect(
      queueAccountingSync(foreign.tx, editorCtx(), { ...command }),
    ).rejects.toThrowError(InvoicingNotFoundError);
    const unknownSync = makeTx([{ rows: [] }]);
    await expect(
      getAccountingSyncStatus(unknownSync.tx, editorCtx(), { ...command }),
    ).rejects.toThrowError(InvoicingNotFoundError);
  });
});

describe("F8-21 Idempotenz + Re-Queue (F821-CT-04)", () => {
  it("gleicher Stand → gleicher Satz ohne Schreibzugriff", async () => {
    const harness = makeTx([
      { rows: [docRow()] },
      { rows: lineRows() },
      { rows: [syncRow({ state: "queued" })] },
    ]);
    const result = await queueAccountingSync(harness.tx, editorCtx(), { ...command });
    expect(result).toMatchObject({ state: "queued", payloadSha256: CURRENT_SHA, attempts: 0 });
    expect(harness.execute).toHaveBeenCalledTimes(3);
  });

  it("neuer Stand → exported + Drift verweigert Konflikt (kein Maschinen-Uebergang)", async () => {
    // exported→queued ist kein Uebergang (F821-CT-03): stilles Re-Queue
    // liesse den alten external_id auf die neue Payload zeigen
    // (GoBD-Drift). Pfad: run markiert failed, dann Re-Queue aus failed.
    const harness = makeTx([
      { rows: [changedDocRow()] },
      { rows: changedLineRows() },
      { rows: [syncRow({ state: "exported", payload_sha256: CURRENT_SHA, external_id: "fake-lexoffice-000001", attempts: 1 })] },
    ]);
    await expect(
      queueAccountingSync(harness.tx, editorCtx(), { ...command }),
    ).rejects.toThrowError(InvoicingConflictError);
    expect(harness.execute).toHaveBeenCalledTimes(3);
  });

  it("Retry über Re-Queue aus failed mit attempts+1", async () => {
    const harness = makeTx([
      { rows: [docRow()] },
      { rows: lineRows() },
      { rows: [syncRow({ state: "failed", attempts: 1, last_error: "timeout" })] },
      { rows: [syncRow({ state: "queued", attempts: 2, last_error: null })] },
    ]);
    const result = await queueAccountingSync(harness.tx, editorCtx(), { ...command });
    expect(result).toMatchObject({ state: "queued", attempts: 2, lastError: null });
  });

  it("acknowledged ist terminal: gleicher Stand lesbar, neuer Stand Konflikt", async () => {
    const same = makeTx([
      { rows: [docRow()] },
      { rows: lineRows() },
      { rows: [syncRow({ state: "acknowledged", external_id: "fake-lexoffice-000001", attempts: 2 })] },
    ]);
    await expect(
      queueAccountingSync(same.tx, editorCtx(), { ...command }),
    ).resolves.toMatchObject({ state: "acknowledged" });
    expect(same.execute).toHaveBeenCalledTimes(3);

    const drifted = makeTx([
      { rows: [changedDocRow()] },
      { rows: changedLineRows() },
      { rows: [syncRow({ state: "acknowledged", payload_sha256: CURRENT_SHA })] },
    ]);
    await expect(
      queueAccountingSync(drifted.tx, editorCtx(), { ...command }),
    ).rejects.toThrowError(InvoicingConflictError);
  });

  it("UNIQUE-Race beim Insert meldet Konflikt statt Doppelsatz", async () => {
    const race = Object.assign(new Error("duplicate"), { cause: { code: "23505" } });
    const harness = makeTx([{ rows: [docRow()] }, { rows: lineRows() }, { rows: [] }, race]);
    await expect(
      queueAccountingSync(harness.tx, editorCtx(), { ...command }),
    ).rejects.toThrowError(InvoicingConflictError);
  });
});

describe("F8-21 Fake-Transport-Run (F821-CT-06)", () => {
  it("queued → exported → acknowledged mit stabiler external_id", async () => {
    const provider = new FakeAccountingProvider("lexoffice");
    const first = makeTx([
      { rows: [syncRow()] },
      { rows: [docRow()] },
      { rows: lineRows() },
      { rows: [syncRow({ state: "exported", external_id: "fake-lexoffice-000001", attempts: 1 })] },
    ]);
    const exported = await runAccountingSync(first.tx, editorCtx(), { ...command }, provider);
    expect(exported).toMatchObject({
      state: "exported",
      externalId: "fake-lexoffice-000001",
      attempts: 1,
    });
    expect(provider.sent).toHaveLength(1);

    const second = makeTx([
      { rows: [syncRow({ state: "exported", external_id: "fake-lexoffice-000001", attempts: 1 })] },
      { rows: [docRow()] },
      { rows: lineRows() },
      { rows: [syncRow({ state: "acknowledged", external_id: "fake-lexoffice-000001", attempts: 2 })] },
    ]);
    const acknowledged = await runAccountingSync(second.tx, editorCtx(), { ...command }, provider);
    expect(acknowledged).toMatchObject({
      state: "acknowledged",
      externalId: "fake-lexoffice-000001",
      attempts: 2,
    });
    expect(provider.attempts).toBe(2);
  });

  it("Provider-Fehler → failed mit last_error, Retry erst nach Re-Queue", async () => {
    const provider = new FakeAccountingProvider("lexoffice");
    provider.failNext("kaputt-timeout");
    const harness = makeTx([
      { rows: [syncRow()] },
      { rows: [docRow()] },
      { rows: lineRows() },
      { rows: [syncRow({ state: "failed", attempts: 1, last_error: "kaputt-timeout" })] },
    ]);
    // Worker-Muster: Run persistiert failed + last_error und RETURNED den
    // Satz (ein Throw wuerde das failed-Update zurueckrollen).
    const failed = await runAccountingSync(harness.tx, editorCtx(), { ...command }, provider);
    expect(failed.state).toBe("failed");
    expect(failed.lastError).toContain("kaputt-timeout");
    expect(failed.attempts).toBe(1);
    expect(harness.execute).toHaveBeenCalledTimes(4);
    const serialized = JSON.stringify(harness.execute.mock.calls);
    expect(serialized).toContain("failed");
    expect(serialized).toContain("kaputt-timeout");

    const retry = makeTx([
      { rows: [syncRow({ state: "failed", attempts: 1, last_error: "kaputt-timeout" })] },
    ]);
    const fresh = new FakeAccountingProvider("lexoffice");
    await expect(
      runAccountingSync(retry.tx, editorCtx(), { ...command }, fresh),
    ).rejects.toThrowError(InvoicingConflictError);
    expect(fresh.attempts).toBe(0);
  });

  it("failed/acknowledged verweigern Run direkt (Konflikt, kein Transport)", async () => {
    for (const state of ["failed", "acknowledged"]) {
      const harness = makeTx([{ rows: [syncRow({ state })] }]);
      const provider = new FakeAccountingProvider("lexoffice");
      await expect(
        runAccountingSync(harness.tx, editorCtx(), { ...command }, provider),
      ).rejects.toThrowError(InvoicingConflictError);
      expect(provider.attempts).toBe(0);
      expect(harness.execute).toHaveBeenCalledTimes(1);
    }
  });

  it("Replay erkennt Drift: abweichender Belegstand → failed wird returniert", async () => {
    const harness = makeTx([
      { rows: [syncRow({ payload_sha256: CURRENT_SHA })] },
      { rows: [changedDocRow()] },
      { rows: changedLineRows() },
      { rows: [syncRow({ state: "failed", attempts: 1, last_error: "payload-drift: Belegstand abweichend, Re-Queue noetig" })] },
    ]);
    const provider = new FakeAccountingProvider("lexoffice");
    const failed = await runAccountingSync(harness.tx, editorCtx(), { ...command }, provider);
    expect(failed.state).toBe("failed");
    expect(failed.lastError).toContain("payload-drift");
    expect(provider.attempts).toBe(0);
    expect(JSON.stringify(harness.execute.mock.calls)).toContain("payload-drift");
  });

  it("Vendor-Mismatch (Provider ≠ Satz) fail-closed vor DB-Zugriff", async () => {
    const harness = makeTx([{ rows: [syncRow()] }]);
    await expect(
      runAccountingSync(harness.tx, editorCtx(), { ...command }, new FakeAccountingProvider("bexio")),
    ).rejects.toThrowError(InvoicingValidationError);
    expect(harness.execute).not.toHaveBeenCalled();
  });
});

describe("F8-21 Keine Secrets in DB/DTOs (F821-CT-07)", () => {
  it("Sync-SQL und DTOs enthalten nur Vendor + external_id", async () => {
    const provider = new FakeAccountingProvider("sevdesk");
    const queueHarness = makeTx([
      { rows: [docRow()] },
      { rows: lineRows() },
      { rows: [] },
      { rows: [syncRow({ vendor: "sevdesk" })] },
    ]);
    const created = await queueAccountingSync(
      queueHarness.tx,
      editorCtx(),
      { ...command, vendor: "sevdesk" },
    );
    const runHarness = makeTx([
      { rows: [syncRow({ vendor: "sevdesk" })] },
      { rows: [docRow()] },
      { rows: lineRows() },
      { rows: [syncRow({ vendor: "sevdesk", state: "exported", external_id: "fake-sevdesk-000001", attempts: 1 })] },
    ]);
    const exported = await runAccountingSync(
      runHarness.tx,
      editorCtx(),
      { ...command, vendor: "sevdesk" },
      provider,
    );
    const serialized = JSON.stringify({
      queueCalls: queueHarness.execute.mock.calls,
      runCalls: runHarness.execute.mock.calls,
      created,
      exported,
      providerSent: provider.sent,
    }).toLowerCase();
    for (const secret of ["token", "secret", "password", "credential", "api_key", "apikey", "bearer", "private_key", "client_secret"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(Object.keys(created).sort()).toEqual(
      ["attempts", "documentId", "externalId", "lastError", "payloadSha256", "schemaVersion", "state", "updatedAt", "vendor"],
    );
  });
});
