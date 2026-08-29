import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { contact } from "@/lib/db/schema";
import { withTenantOn } from "@/lib/db/tenant";
import {
  RechnerIdempotencyConflictError,
  RechnerInvalidRequestError,
} from "@/lib/integrations/rechner/errors";
import {
  RECHNER_INTAKE_PATH,
  sha256Hex,
  signatureMessage,
  verifyRechnerSignature,
  type VerifiedRechnerIdentity,
} from "@/lib/integrations/rechner/signature";
import type {
  RechnerIntakeMeta,
  RechnerIntakeReceiptV1,
  RechnerIntakeV1,
} from "@/lib/integrations/rechner/types";
import { processRechnerIntake } from "@/modules/intake";
import { testPool } from "../setup/test-db";

const NOW = new Date("2026-08-29T08:30:00.000Z");
const FIXTURE = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/rechner-intake.v1.json"),
  "utf8",
)) as RechnerIntakeV1;

type GraphCounts = {
  contacts: number;
  sites: number;
  projects: number;
  receipts: number;
  snapshots: number;
  requirements: number;
  events: number;
  audits: number;
};

function payload(submissionId = randomUUID()): RechnerIntakeV1 {
  const value = structuredClone(FIXTURE);
  value.submissionId = submissionId;
  return value;
}

function meta(value: RechnerIntakeV1): RechnerIntakeMeta {
  return {
    payloadSha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    signedAt: NOW,
    receivedAt: NOW,
  };
}

function verifiedIdentity(workspaceId: string, keyId = "rechner-test"): VerifiedRechnerIdentity {
  const secret = Buffer.alloc(32, keyId.length);
  const body = Buffer.from("{}", "utf8");
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const idempotencyKey = randomUUID();
  const contentSha256 = sha256Hex(body);
  const signature = createHmac("sha256", secret)
    .update(signatureMessage({
      method: "POST",
      path: RECHNER_INTAKE_PATH,
      keyId,
      timestamp,
      idempotencyKey,
      contentSha256,
    }))
    .digest("base64url");
  return verifyRechnerSignature({
    method: "POST",
    path: RECHNER_INTAKE_PATH,
    body,
    nowSeconds: Number(timestamp),
    credentialsJson: JSON.stringify([{
      keyId,
      workspaceId,
      scope: "rechner-intake.write",
      secretBase64: secret.toString("base64"),
    }]),
    headers: {
      keyId,
      timestamp,
      idempotencyKey,
      contentSha256,
      signature: `v1=${signature}`,
    },
  });
}

async function workspace(): Promise<string> {
  const id = randomUUID();
  await withTenantOn(testPool, id, (tx) =>
    tx.execute(sql`insert into workspace (id, name) values (${id}::uuid, 'Rechner Intake Test')`));
  return id;
}

async function submit(
  workspaceId: string,
  identity: VerifiedRechnerIdentity,
  value: RechnerIntakeV1,
  intakeMeta = meta(value),
): Promise<RechnerIntakeReceiptV1> {
  return withTenantOn(testPool, workspaceId, (tx) =>
    processRechnerIntake(tx, identity, value, intakeMeta));
}

async function counts(workspaceId: string): Promise<GraphCounts> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<GraphCounts & { [key: string]: unknown }>(sql`
      select
        (select count(*)::int from contact) as contacts,
        (select count(*)::int from site) as sites,
        (select count(*)::int from project) as projects,
        (select count(*)::int from inbound_receipt) as receipts,
        (select count(*)::int from calculator_snapshot) as snapshots,
        (select count(*)::int from project_requirement) as requirements,
        (select count(*)::int from domain_events) as events,
        (select count(*)::int from audit_log) as audits
    `);
    return result.rows[0];
  });
}

async function seedContact(
  workspaceId: string,
  values: {
    email?: string | null;
    phoneRaw?: string | null;
    phoneE164?: string | null;
    review?: boolean;
  },
): Promise<string> {
  const id = randomUUID();
  const email = values.email === undefined ? null : values.email;
  await withTenantOn(testPool, workspaceId, (tx) => tx.insert(contact).values({
    id,
    workspaceId,
    displayName: "Vorhandener Kontakt",
    emailPrimary: email,
    emailNormalized: email?.toLowerCase() ?? null,
    phoneRaw: values.phoneRaw ?? null,
    phoneE164: values.phoneE164 ?? null,
    dedupeReviewRequired: values.review ?? false,
  }));
  return id;
}

describe("Rechner-Intake-Fachtransaktion", () => {
  it("persistiert den vollstaendigen Golden Path ohne Angebots- oder Katalogwahrheit", async () => {
    const ws = await workspace();
    const identity = verifiedIdentity(ws);
    const value = payload();
    const receipt = await submit(ws, identity, value);
    expect(receipt).toMatchObject({
      submissionId: value.submissionId,
      duplicate: false,
      status: "processed",
    });

    const graph = await withTenantOn(testPool, ws, async (tx) => {
      const rows = await tx.execute<{
        phase: string;
        outcome: string;
        catalog_status: string;
        pin_confirmed: boolean;
        address_mode: string;
        fingerprint_version: number;
        fingerprint: string;
        snapshot: Record<string, unknown>;
        requirements: Record<string, unknown>;
        [key: string]: unknown;
      }>(sql`
        select p.phase, p.outcome, p.catalog_resolution_status as catalog_status,
               s.pin_confirmed, s.address_mode,
               s.address_fingerprint_version as fingerprint_version,
               encode(s.address_fingerprint, 'hex') as fingerprint,
               cs.snapshot, pr.requirements
        from inbound_receipt r
        join project p on p.workspace_id = r.workspace_id and p.id = r.project_id
        join site s on s.workspace_id = r.workspace_id and s.id = r.site_id
        join calculator_snapshot cs
          on cs.workspace_id = r.workspace_id and cs.receipt_id = r.id
        join project_requirement pr
          on pr.workspace_id = p.workspace_id and pr.project_id = p.id
        where r.id = ${receipt.receiptId}::uuid
      `);
      return rows.rows[0];
    });
    expect(graph).toMatchObject({
      phase: "request",
      outcome: "open",
      catalog_status: "pending",
      pin_confirmed: false,
      address_mode: "selected",
      fingerprint_version: 1,
    });
    expect(graph.fingerprint).toBe("84c8a3ac7802db91f7e8d7dee8c128d3421b37602404dd74edf62d043aa0c687");
    expect(Object.keys(graph.snapshot).sort()).toEqual([
      "branch",
      "calculatedAt",
      "inputs",
      "provenance",
      "questionnaireVariant",
      "result",
      "resultIntegrity",
      "schemaVersion",
    ]);
    expect(graph.snapshot).not.toHaveProperty("customer");
    expect(graph.snapshot).not.toHaveProperty("site");
    expect(graph.requirements).toEqual({
      schemaVersion: "project-requirements.rechner.v1",
      source: "wmee-rechner-v3",
      branch: "new_installation",
      requestedProducts: value.calculation.inputs.requestedProducts,
    });
    for (const forbidden of ["sku", "bom", "catalogComponentId", "brand", "price"]) {
      expect(JSON.stringify(graph.requirements).toLowerCase()).not.toContain(forbidden.toLowerCase());
    }

    const appendOnly = await withTenantOn(testPool, ws, (tx) =>
      tx.execute<{ value: string; [key: string]: unknown }>(sql`
        select payload::text as value from domain_events
        union all
        select details::text as value from audit_log
      `));
    const serialized = appendOnly.rows.map((row) => row.value).join("\n");
    for (const pii of [
      value.customer.displayName,
      value.customer.email,
      value.customer.phoneRaw,
      value.site.formattedAddress,
      value.site.postalCode!,
    ]) {
      expect(serialized).not.toContain(pii);
    }
    expect(await counts(ws)).toEqual({
      contacts: 1,
      sites: 1,
      projects: 1,
      receipts: 1,
      snapshots: 1,
      requirements: 1,
      events: 3,
      audits: 1,
    });
  });

  it("liefert Exact Replay ohne Seiteneffekt und Conflict ohne Mutation", async () => {
    const ws = await workspace();
    const identity = verifiedIdentity(ws);
    const value = payload();
    const first = await submit(ws, identity, value);
    const baseline = await counts(ws);

    const replay = await submit(ws, identity, value);
    expect(replay).toEqual({ ...first, duplicate: true });
    expect(await counts(ws)).toEqual(baseline);

    const changed = structuredClone(value);
    changed.customer.displayName = "Anderer Inhalt";
    await expect(submit(ws, identity, changed)).rejects.toBeInstanceOf(
      RechnerIdempotencyConflictError,
    );
    expect(await counts(ws)).toEqual(baseline);
  });

  it("begrenzt normalisierte Identitaeten in Unicode-Codepoints vor der Fachmutation", async () => {
    const ws = await workspace();
    const value = payload();
    value.customer.displayName = "\uFDFA".repeat(20);
    await expect(submit(ws, verifiedIdentity(ws), value)).rejects.toBeInstanceOf(
      RechnerInvalidRequestError,
    );
    expect(await counts(ws)).toEqual({
      contacts: 0,
      sites: 0,
      projects: 0,
      receipts: 0,
      snapshots: 0,
      requirements: 0,
      events: 0,
      audits: 0,
    });

    const astralName = "😀".repeat(101);
    value.customer.displayName = astralName;
    await submit(ws, verifiedIdentity(ws), value);
    const stored = await withTenantOn(testPool, ws, (tx) =>
      tx.execute<{ display_name: string; [key: string]: unknown }>(sql`
        select display_name from contact
      `));
    expect(stored.rows).toEqual([{ display_name: astralName }]);
  });

  it("serialisiert parallele Replays auch ueber rotierende Keys", async () => {
    const ws = await workspace();
    const value = payload();
    const results = await Promise.all([
      submit(ws, verifiedIdentity(ws, "rechner-current"), value),
      submit(ws, verifiedIdentity(ws, "rechner-previous"), value),
    ]);
    expect(results.map((row) => row.duplicate).sort()).toEqual([false, true]);
    expect(new Set(results.map((row) => row.receiptId)).size).toBe(1);
    expect((await counts(ws)).receipts).toBe(1);
  });

  it("rollt einen gehaltenen Erstversuch komplett zurueck und laesst den wartenden Retry gewinnen", async () => {
    const ws = await workspace();
    const identity = verifiedIdentity(ws);
    const value = payload();
    let ready!: () => void;
    let release!: () => void;
    const firstReady = new Promise<void>((resolve) => { ready = resolve; });
    const mayRollback = new Promise<void>((resolve) => { release = resolve; });

    const first = withTenantOn(testPool, ws, async (tx) => {
      await processRechnerIntake(tx, identity, value, meta(value));
      ready();
      await mayRollback;
      throw new Error("beabsichtigter Rollback nach Gesamtgraph");
    });
    const firstExpectation = expect(first).rejects.toThrow("beabsichtigter Rollback");
    await firstReady;
    const waitingRetry = submit(ws, identity, value);
    release();

    await firstExpectation;
    const retried = await waitingRetry;
    expect(retried.duplicate).toBe(false);
    expect(await counts(ws)).toMatchObject({
      contacts: 1,
      sites: 1,
      projects: 1,
      receipts: 1,
      snapshots: 1,
      requirements: 1,
    });
  });

  it("serialisiert verschiedene Submissions derselben Identitaet auf einen Contact und eine Exact-Site", async () => {
    const ws = await workspace();
    const first = payload();
    const second = payload();
    await Promise.all([
      submit(ws, verifiedIdentity(ws, "rechner-a"), first),
      submit(ws, verifiedIdentity(ws, "rechner-b"), second),
    ]);
    expect(await counts(ws)).toMatchObject({
      contacts: 1,
      sites: 1,
      projects: 2,
      receipts: 2,
    });
  });

  it("legt bei Split-Match einen Review-Contact an und mergt nichts still", async () => {
    const ws = await workspace();
    const incoming = payload();
    const normalizedIncomingPhone = "+496222123456";
    const emailContactId = await seedContact(ws, {
      email: incoming.customer.email,
      phoneRaw: "+49 151 11111111",
      phoneE164: "+4915111111111",
    });
    const phoneContactId = await seedContact(ws, {
      email: "andere.person@example.com",
      phoneRaw: incoming.customer.phoneRaw,
      phoneE164: normalizedIncomingPhone,
    });
    const receipt = await submit(ws, verifiedIdentity(ws), incoming);

    const row = await withTenantOn(testPool, ws, (tx) =>
      tx.execute<{
        contact_resolution: string;
        email_match_contact_id: string;
        phone_match_contact_id: string;
        project_review: boolean;
        contact_review: boolean;
        [key: string]: unknown;
      }>(sql`
        select r.contact_resolution, r.email_match_contact_id, r.phone_match_contact_id,
               p.dedupe_review_required as project_review,
               c.dedupe_review_required as contact_review
        from inbound_receipt r
        join project p on p.workspace_id = r.workspace_id and p.id = r.project_id
        join contact c on c.workspace_id = r.workspace_id and c.id = r.contact_id
        where r.id = ${receipt.receiptId}::uuid
      `));
    expect(row.rows[0]).toMatchObject({
      contact_resolution: "review_created",
      email_match_contact_id: emailContactId,
      phone_match_contact_id: phoneContactId,
      project_review: true,
      contact_review: true,
    });
    expect((await counts(ws)).contacts).toBe(3);
  });

  it("speichert bei Mehrfachtreffern keine willkuerliche Match-ID", async () => {
    const ws = await workspace();
    const incoming = payload();
    incoming.customer.phoneRaw = "nicht-erreichbar";
    await seedContact(ws, { email: incoming.customer.email });
    await seedContact(ws, { email: incoming.customer.email });
    const receipt = await submit(ws, verifiedIdentity(ws), incoming);
    const row = await withTenantOn(testPool, ws, (tx) =>
      tx.execute<{ email_match_contact_id: string | null; contact_resolution: string; [key: string]: unknown }>(sql`
        select email_match_contact_id, contact_resolution
        from inbound_receipt where id = ${receipt.receiptId}::uuid
      `));
    expect(row.rows[0]).toEqual(expect.objectContaining({
      email_match_contact_id: null,
      contact_resolution: "review_created",
    }));
  });

  it("kann einen eindeutigen Telefonkontakt ergaenzen und uebernimmt dessen Review-Flag", async () => {
    const ws = await workspace();
    const incoming = payload();
    const existingId = await seedContact(ws, {
      email: null,
      phoneRaw: incoming.customer.phoneRaw,
      phoneE164: "+496222123456",
      review: true,
    });
    const receipt = await submit(ws, verifiedIdentity(ws), incoming);
    const row = await withTenantOn(testPool, ws, (tx) =>
      tx.execute<{
        contact_id: string;
        contact_resolution: string;
        email_primary: string;
        phone_raw: string;
        project_review: boolean;
        [key: string]: unknown;
      }>(sql`
        select r.contact_id, r.contact_resolution, c.email_primary, c.phone_raw,
               p.dedupe_review_required as project_review
        from inbound_receipt r
        join contact c on c.workspace_id = r.workspace_id and c.id = r.contact_id
        join project p on p.workspace_id = r.workspace_id and p.id = r.project_id
        where r.id = ${receipt.receiptId}::uuid
      `));
    expect(row.rows[0]).toMatchObject({
      contact_id: existingId,
      contact_resolution: "phone_match",
      email_primary: incoming.customer.email,
      phone_raw: incoming.customer.phoneRaw,
      project_review: true,
    });
  });

  it("dedupliziert regionale Richtwerte niemals als reale Site", async () => {
    const ws = await workspace();
    const first = payload();
    first.site = {
      addressMode: "regional_estimate",
      formattedAddress: "Region Rhein-Neckar",
      street: null,
      houseNumber: null,
      postalCode: null,
      city: null,
      countryCode: "DE",
      latitude: 49.4,
      longitude: 8.7,
      geocodeSource: "regional_default",
      precision: "region",
    };
    const second = structuredClone(first);
    second.submissionId = randomUUID();
    await submit(ws, verifiedIdentity(ws), first);
    await submit(ws, verifiedIdentity(ws), second);

    const rows = await withTenantOn(testPool, ws, (tx) =>
      tx.execute<{ follow_up: boolean; pin_confirmed: boolean; fingerprint: Buffer | null; [key: string]: unknown }>(sql`
        select address_follow_up_required as follow_up, pin_confirmed, address_fingerprint as fingerprint
        from site order by created_at, id
      `));
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows).toEqual([
      { follow_up: true, pin_confirmed: false, fingerprint: null },
      { follow_up: true, pin_confirmed: false, fingerprint: null },
    ]);
  });

  it("erzwingt Receipt-FK-Aufschub und geschlossene Snapshot-/Requirement-JSONs", async () => {
    const constraint = await testPool.query<{
      condeferrable: boolean;
      condeferred: boolean;
    }>(`
      select condeferrable, condeferred
      from pg_constraint
      where conname = 'inbound_receipt_project_graph_fk'
    `);
    expect(constraint.rows).toEqual([{ condeferrable: true, condeferred: true }]);

    const ws = await workspace();
    await submit(ws, verifiedIdentity(ws), payload());
    await expect(withTenantOn(testPool, ws, (tx) => tx.execute(sql`
      update calculator_snapshot
      set snapshot = snapshot || '{"customer":{"email":"pii@example.com"}}'::jsonb
    `))).rejects.toThrow();
    await expect(withTenantOn(testPool, ws, (tx) => tx.execute(sql`
      update project_requirement
      set requirements = requirements || '{"sku":"FAKE-SKU","price":1}'::jsonb
    `))).rejects.toThrow();
  });
});
