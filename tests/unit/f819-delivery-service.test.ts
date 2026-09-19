import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_DELIVERY_COMMAND_VERSION,
  markSentWithDelivery,
} from "@/modules/invoicing/delivery-service";
import { InvoicingConflictError } from "@/modules/invoicing/errors";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";

function ctx(): ServiceCtx {
  return {
    role: "editor",
    capabilities: { invoicing: true },
    featureFlags: {},
    workspaceId: WORKSPACE_ID,
    actor: ACTOR_ID,
  };
}

function txStub(executions: Array<{ rows: unknown[] } | { throws: unknown }>): TenantTx {
  const execute = vi.fn();
  for (const step of executions) {
    if ("throws" in step) execute.mockRejectedValueOnce(step.throws);
    else execute.mockResolvedValueOnce({ rows: step.rows });
  }
  return { execute } as unknown as TenantTx;
}

describe("F8-19 delivery service (Fehler-Mapping)", () => {
  it("F819-UT-FK: 23503 beim Nachweis-Insert wird Konflikt, nie 500", async () => {
    // Reihenfolge: Beleg lesen, Invoice-Job lesen, Sent-Gate,
    // Nachweis-Insert (FK bricht parallel weg).
    const tx = txStub([
      { rows: [{ id: DOCUMENT_ID, type: "invoice", status: "issued", sent_at: null, gross_cents: 100, paid_cents: 100 }] },
      { rows: [{ id: JOB_ID, artifact_sha256_hex: "ab".repeat(32) }] },
      { rows: [{ sent_at: new Date("2026-09-19T10:00:00.000Z") }] },
      { throws: new Error("insert", { cause: { code: "23503" } }) },
    ]);
    await expect(markSentWithDelivery(tx, ctx(), {
      schemaVersion: COMMERCIAL_DOCUMENT_DELIVERY_COMMAND_VERSION,
      documentId: DOCUMENT_ID,
      channel: "manual",
    })).rejects.toBeInstanceOf(InvoicingConflictError);
    expect(tx.execute).toHaveBeenCalledTimes(4);
  });

  it("F819-UT-FK: unbekannte Insert-Fehler werden nicht verschluckt", async () => {
    const boom = new Error("insert", { cause: { code: "XX000" } });
    const tx = txStub([
      { rows: [{ id: DOCUMENT_ID, type: "invoice", status: "issued", sent_at: null, gross_cents: 100, paid_cents: 100 }] },
      { rows: [{ id: JOB_ID, artifact_sha256_hex: "ab".repeat(32) }] },
      { rows: [{ sent_at: new Date("2026-09-19T10:00:00.000Z") }] },
      { throws: boom },
    ]);
    await expect(markSentWithDelivery(tx, ctx(), {
      schemaVersion: COMMERCIAL_DOCUMENT_DELIVERY_COMMAND_VERSION,
      documentId: DOCUMENT_ID,
      channel: "manual",
    })).rejects.toBe(boom);
  });
});
