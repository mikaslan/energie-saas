import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

// Wie Broker-Intake: der Intake-Graph zieht "server-only"-Module.
vi.mock("server-only", () => ({}));
import { contact } from "@/lib/db/schema";
import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  RestIdempotencyConflictError,
  RestInvalidRequestError,
  RestRateLimitError,
} from "@/lib/integrations/rest/errors";
import {
  REST_INTAKE_PATH,
  sha256Hex,
  signatureMessage,
  verifyRestSignature,
  type VerifiedRestIdentity,
} from "@/lib/integrations/rest/signature";
import type {
  RestIntakeMeta,
  RestIntakeReceiptV1,
  RestIntakeV1,
} from "@/lib/integrations/rest/types";
import { LEAD_SOURCE_SCHEMA_VERSION } from "@/lib/integrations/lead-sources/contract";
import { processRestIntake } from "@/modules/intake";
import { createLeadSource } from "@/modules/lead-sources";
import { testPool } from "../setup/test-db";

const NOW = new Date("2026-09-19T08:30:00.000Z");
const FIXTURE = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/rest-intake.v1.json"),
  "utf8",
)) as RestIntakeV1;

function payload(recordId = `CL-${randomUUID().slice(0, 8)}`): RestIntakeV1 {
  const value = structuredClone(FIXTURE);
  value.clientRecordId = recordId;
  return value;
}

function meta(value: RestIntakeV1): RestIntakeMeta {
  return {
    payloadSha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    signedAt: NOW,
    receivedAt: NOW,
  };
}

function verifiedIdentity(workspaceId: string, keyId = "rest-test"): VerifiedRestIdentity {
  const secret = Buffer.alloc(32, keyId.length);
  const body = Buffer.from("{}", "utf8");
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const idempotencyKey = randomUUID();
  const contentSha256 = sha256Hex(body);
  const signature = createHmac("sha256", secret)
    .update(signatureMessage({
      method: "POST",
      path: REST_INTAKE_PATH,
      keyId,
      timestamp,
      idempotencyKey,
      contentSha256,
    }))
    .digest("base64url");
  return verifyRestSignature({
    method: "POST",
    path: REST_INTAKE_PATH,
    body,
    nowSeconds: Number(timestamp),
    credentialsJson: JSON.stringify([{
      keyId,
      workspaceId,
      scope: "rest-intake.write",
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
    tx.execute(sql`insert into workspace (id, name) values (${id}::uuid, 'REST Intake Test')`));
  return id;
}

async function submit(
  workspaceId: string,
  identity: VerifiedRestIdentity,
  value: RestIntakeV1,
  intakeMeta = meta(value),
): Promise<RestIntakeReceiptV1> {
  return withTenantOn(testPool, workspaceId, (tx) =>
    processRestIntake(tx, identity, value, intakeMeta));
}

async function seedLeadSource(workspaceId: string, name: string): Promise<string> {
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1018.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb)
    `);
  });
  const created = await withAuthorizedTenantOn(
    testPool, editorId, workspaceId,
    (tx, ctx) => createLeadSource(tx, ctx, {
      schemaVersion: LEAD_SOURCE_SCHEMA_VERSION,
      name,
      projectDomain: "residential",
      color: null,
    }),
  );
  return created.id;
}

async function seedContact(
  workspaceId: string,
  values: { email?: string | null; phoneRaw?: string | null; phoneE164?: string | null },
): Promise<string> {
  const id = randomUUID();
  const email = values.email === undefined ? null : values.email;
  await withTenantOn(testPool, workspaceId, (tx) => tx.insert(contact).values({
    id,
    workspaceId,
    displayName: "Vorhandener Kontakt",
    firstName: "Vorhandener",
    lastName: "Kontakt",
    emailPrimary: email,
    emailNormalized: email?.toLowerCase() ?? null,
    phoneRaw: values.phoneRaw ?? null,
    phoneE164: values.phoneE164 ?? null,
    dedupeReviewRequired: false,
  }));
  return id;
}

async function fillRestReceipts(workspaceId: string, keyId: string, count: number): Promise<void> {
  await withTenantOn(testPool, workspaceId, async (tx) => {
    const contactId = randomUUID();
    const siteId = randomUUID();
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'Rate Kontakt', 'Rate', 'Kontakt',
              ${`${keyId}-rate@f1018.test`}, ${`${keyId}-rate@f1018.test`})`);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'Rate-Standort')`);
    const lane = await tx.execute<{ board_id: string; column_id: string }>(sql`
      select b.id as board_id, c.id as column_id from kanban_board b
      join kanban_column c on c.workspace_id = b.workspace_id and c.board_id = b.id
      where b.workspace_id = ${workspaceId}::uuid and b.scope = 'residential' and b.is_default = true
        and b.archived_at is null and c.is_intake = true and c.archived_at is null
      limit 1`);
    expect(lane.rows).toHaveLength(1);
    for (let i = 0; i < count; i += 1) {
      const projectId = randomUUID();
      await tx.execute(sql`
        insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
        values (${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid,
                ${lane.rows[0].board_id}::uuid, ${lane.rows[0].column_id}::uuid, 'Rate', 'rest')`);
      await tx.execute(sql`
        insert into inbound_rest_receipt (
          workspace_id, client_record_id, contract_version, body_sha256,
          auth_key_id, signed_at, received_at, contact_resolution, contact_id, site_id, project_id
        ) values (
          ${workspaceId}::uuid, ${`${keyId}-RATE-${i}`}, 'rest-intake.v1',
          decode(repeat('00', 32), 'hex'), ${keyId}, now(), now(),
          'created', ${contactId}::uuid, ${siteId}::uuid, ${projectId}::uuid)`);
    }
  });
}

describe("F1-18 Generische-REST-Intake-Fachtransaktion", () => {
  it("F1018-01: Happy Path legt Receipt + Kontakt + Site + Projekt an (Quelle gesetzt)", async () => {
    const ws = await workspace();
    const sourceId = await seedLeadSource(ws, "webhook-partner");
    const identity = verifiedIdentity(ws);
    const value = payload();
    value.sourceName = "webhook-partner";

    const receipt = await submit(ws, identity, value);

    expect(receipt.contractVersion).toBe("rest-intake-receipt.v1");
    expect(receipt.clientRecordId).toBe(value.clientRecordId);
    expect(receipt.status).toBe("processed");
    expect(receipt.duplicate).toBe(false);
    await withTenantOn(testPool, ws, async (tx) => {
      const rows = await tx.execute<{
        source_key: string; lead_source_id: string | null; assignment_revision: number;
      }>(sql`select source_key, lead_source_id, assignment_revision from project`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].source_key).toBe("rest");
      expect(rows.rows[0].lead_source_id).toBe(sourceId);
      expect(rows.rows[0].assignment_revision).toBe(0);
      const receipts = await tx.execute<{ n: number; source_name: string | null }>(
        sql`select count(*)::int as n, max(source_name) as source_name from inbound_rest_receipt`);
      expect(receipts.rows[0].n).toBe(1);
      expect(receipts.rows[0].source_name).toBe("webhook-partner");
      const events = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from domain_events
        where event_type = 'project.requested_from_rest'`);
      expect(events.rows[0].n).toBe(1);
      const audits = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from audit_log
        where action = 'rest.intake.write' and allowed = true`);
      expect(audits.rows[0].n).toBe(1);
    });
  });

  it("F1018-02: ohne sourceName bleibt lead_source_id ehrlich null", async () => {
    const ws = await workspace();
    const value = payload();
    delete value.sourceName;
    const receipt = await submit(ws, verifiedIdentity(ws), value);
    expect(receipt.duplicate).toBe(false);
    await withTenantOn(testPool, ws, async (tx) => {
      const rows = await tx.execute<{ lead_source_id: string | null }>(
        sql`select lead_source_id from project`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].lead_source_id).toBeNull();
    });
  });

  it("F1018-03: Replay gleichen Records ist idempotent (kein 2. Projekt)", async () => {
    const ws = await workspace();
    const identity = verifiedIdentity(ws);
    const value = payload();
    const first = await submit(ws, identity, value);
    const second = await submit(ws, identity, value);
    expect(second.receiptId).toBe(first.receiptId);
    expect(second.duplicate).toBe(true);
    await withTenantOn(testPool, ws, async (tx) => {
      const rows = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from project`);
      expect(rows.rows[0].n).toBe(1);
    });
  });

  it("F1018-04: gleicher Record mit anderem Hash ist Conflict ohne Teilstand", async () => {
    const ws = await workspace();
    const identity = verifiedIdentity(ws);
    const value = payload();
    const originalHash = meta(value).payloadSha256;
    await submit(ws, identity, value);
    const drifted = structuredClone(value);
    drifted.customer.displayName = "Abweichender Name";
    await expect(submit(ws, identity, drifted, meta(drifted)))
      .rejects.toBeInstanceOf(RestIdempotencyConflictError);
    await withTenantOn(testPool, ws, async (tx) => {
      const rows = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from project`);
      expect(rows.rows[0].n).toBe(1);
      const graph = await tx.execute<{ contacts: number; sites: number; receipts: number }>(sql`
        select (select count(*)::int from contact) as contacts,
               (select count(*)::int from site) as sites,
               (select count(*)::int from inbound_rest_receipt) as receipts`);
      expect(graph.rows[0]).toEqual({ contacts: 1, sites: 1, receipts: 1 });
      const receipt = await tx.execute<{ h: string }>(
        sql`select encode(body_sha256, 'hex') as h from inbound_rest_receipt`);
      expect(receipt.rows[0].h).toBe(originalHash);
    });
  });

  it("F1018-05: Konflikt-Kontakt wird review-pflichtig, nie still gemergt", async () => {
    const ws = await workspace();
    const email = `cross-${randomUUID()}@f1018.test`;
    await seedContact(ws, { email });
    await seedContact(ws, { phoneRaw: "0151 1234567", phoneE164: "+491511234567" });
    const identity = verifiedIdentity(ws);
    const value = payload();
    value.customer.email = email;
    value.customer.phoneRaw = "0151 1234567";
    const receipt = await submit(ws, identity, value);
    expect(receipt.duplicate).toBe(false);
    await withTenantOn(testPool, ws, async (tx) => {
      const rows = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from project where dedupe_review_required = true`);
      expect(rows.rows[0].n).toBe(1);
      const contacts = await tx.execute<{ n: number }>(sql`select count(*)::int as n from contact`);
      expect(contacts.rows[0].n).toBe(3);
    });
  });

  it("F1018-06: vertragswidriger Payload scheitert an der Validation", async () => {
    const ws = await workspace();
    const value = payload();
    (value as unknown as Record<string, unknown>).clientRecordId = "";
    await expect(submit(ws, verifiedIdentity(ws), value))
      .rejects.toBeInstanceOf(RestInvalidRequestError);
  });

  it("F1018-07: Dedupe-Namespace ist tenant-isoliert (gleicher Record, zwei Workspaces)", async () => {
    const wsA = await workspace();
    const wsB = await workspace();
    const recordId = `TENANT-${randomUUID().slice(0, 8)}`;
    const receiptA = await submit(wsA, verifiedIdentity(wsA), payload(recordId));
    const receiptB = await submit(wsB, verifiedIdentity(wsB), payload(recordId));
    expect(receiptA.receiptId).not.toBe(receiptB.receiptId);
    await withTenantOn(testPool, wsB, async (tx) => {
      const rows = await tx.execute<{ client_record_id: string }>(
        sql`select client_record_id from inbound_rest_receipt`);
      expect(rows.rows).toHaveLength(1);
    });
  });

  it("F1018-08: Race gleichen Records erzeugt genau 1 Projekt", async () => {
    const ws = await workspace();
    const identity = verifiedIdentity(ws);
    const value = payload();
    const intakeMeta = meta(value);
    const [left, right] = await Promise.all([
      submit(ws, identity, value, intakeMeta),
      submit(ws, identity, value, intakeMeta),
    ]);
    expect(left.receiptId).toBe(right.receiptId);
    await withTenantOn(testPool, ws, async (tx) => {
      const rows = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from project`);
      expect(rows.rows[0].n).toBe(1);
    });
  });

  it("F1018-09: zweiter Record gleichen Kontakts mit gleicher Adresse nutzt Site wieder", async () => {
    const ws = await workspace();
    const identity = verifiedIdentity(ws);
    const email = `reuse-${randomUUID()}@f1018.test`;
    const first = payload();
    first.customer.email = email;
    const second = payload();
    second.customer.email = email;
    await submit(ws, identity, first);
    const receipt = await submit(ws, identity, second);
    expect(receipt.duplicate).toBe(false);
    await withTenantOn(testPool, ws, async (tx) => {
      const graph = await tx.execute<{ contacts: number; sites: number; projects: number }>(sql`
        select (select count(*)::int from contact) as contacts,
               (select count(*)::int from site) as sites,
               (select count(*)::int from project) as projects`);
      expect(graph.rows[0]).toEqual({ contacts: 1, sites: 1, projects: 2 });
    });
  });

  it("F1018-10: Rotation-Replay unter neuem Key ist idempotent, Drift ist Conflict (Dedupe ohne keyId)", async () => {
    const ws = await workspace();
    const value = payload();
    const intakeMeta = meta(value);
    const first = await submit(ws, verifiedIdentity(ws, "rest-key-a"), value, intakeMeta);
    const second = await submit(ws, verifiedIdentity(ws, "rest-key-b"), value, intakeMeta);
    expect(second.receiptId).toBe(first.receiptId);
    expect(second.duplicate).toBe(true);
    // Gleiche Record-ID unter drittem Key mit anderem Hash: Conflict
    // (409), kein zweites Projekt — Rotation erzeugt nie Duplikate.
    const drifted = structuredClone(value);
    drifted.customer.displayName = "Rotierter Drift";
    await expect(submit(ws, verifiedIdentity(ws, "rest-key-c"), drifted, meta(drifted)))
      .rejects.toBeInstanceOf(RestIdempotencyConflictError);
    await withTenantOn(testPool, ws, async (tx) => {
      const graph = await tx.execute<{ projects: number; receipts: number }>(sql`
        select (select count(*)::int from project) as projects,
               (select count(*)::int from inbound_rest_receipt) as receipts`);
      expect(graph.rows[0]).toEqual({ projects: 1, receipts: 1 });
    });
  });

  it("F1018-11: gleiche sourceName ist kein Dedupe-Merkmal (2 Records = 2 Projekte)", async () => {
    const ws = await workspace();
    const identity = verifiedIdentity(ws);
    const first = payload();
    first.sourceName = "shared-partner";
    const second = payload();
    second.sourceName = "shared-partner";
    const receiptA = await submit(ws, identity, first);
    const receiptB = await submit(ws, identity, second);
    expect(receiptA.duplicate).toBe(false);
    expect(receiptB.duplicate).toBe(false);
    expect(receiptA.receiptId).not.toBe(receiptB.receiptId);
    await withTenantOn(testPool, ws, async (tx) => {
      const rows = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from project`);
      expect(rows.rows[0].n).toBe(2);
    });
  });

  it("F1018-12: E-Mail-Treffer wird wiederverwendet, angereichert, Review vererbt", async () => {
    const ws = await workspace();
    const email = `match-${randomUUID()}@f1018.test`;
    const contactId = randomUUID();
    await withTenantOn(testPool, ws, (tx) => tx.insert(contact).values({
      id: contactId,
      workspaceId: ws,
      displayName: "Treffer Kontakt",
      firstName: "Treffer",
      lastName: "Kontakt",
      emailPrimary: email,
      emailNormalized: email.toLowerCase(),
      dedupeReviewRequired: true,
    }));
    const identity = verifiedIdentity(ws);
    const value = payload();
    value.customer.email = email;
    value.customer.phoneRaw = "030 999888";
    await submit(ws, identity, value);
    await withTenantOn(testPool, ws, async (tx) => {
      const contacts = await tx.execute<{ n: number }>(sql`select count(*)::int as n from contact`);
      expect(contacts.rows[0].n).toBe(1);
      const enriched = await tx.execute<{ phone_raw: string | null }>(
        sql`select phone_raw from contact where id = ${contactId}::uuid`);
      expect(enriched.rows[0].phone_raw).toBe("030 999888");
      const projects = await tx.execute<{ review: boolean; resolution: string }>(sql`
        select p.dedupe_review_required as review, r.contact_resolution as resolution
        from project p join inbound_rest_receipt r
          on r.workspace_id = p.workspace_id and r.project_id = p.id`);
      expect(projects.rows).toHaveLength(1);
      expect(projects.rows[0]).toEqual({ review: true, resolution: "email_match" });
    });
  });

  it("F1018-13: Telefon-nur-Treffer wird per phone_match wiederverwendet", async () => {
    const ws = await workspace();
    await seedContact(ws, { phoneRaw: "0151 7778899", phoneE164: "+491517778899" });
    const identity = verifiedIdentity(ws);
    const value = payload();
    value.customer.email = `phone-${randomUUID()}@f1018.test`;
    value.customer.phoneRaw = "0151 7778899";
    await submit(ws, identity, value);
    await withTenantOn(testPool, ws, async (tx) => {
      const contacts = await tx.execute<{ n: number; email: string | null }>(
        sql`select count(*)::int as n, max(email_primary) as email from contact`);
      expect(contacts.rows[0].n).toBe(1);
      expect(contacts.rows[0].email).toBe(value.customer.email);
      const resolution = await tx.execute<{ resolution: string }>(
        sql`select contact_resolution as resolution from inbound_rest_receipt`);
      expect(resolution.rows[0].resolution).toBe("phone_match");
    });
  });

  it("F1018-14: Conflict-unter-Race ergibt genau 1 Erfolg + 1 Conflict", async () => {
    const ws = await workspace();
    const identity = verifiedIdentity(ws);
    const value = payload();
    const drifted = structuredClone(value);
    drifted.customer.displayName = "Race Drift";
    const outcomes = await Promise.allSettled([
      submit(ws, identity, value, meta(value)),
      submit(ws, identity, drifted, meta(drifted)),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected") as Array<{
      status: "rejected"; reason: unknown;
    }>;
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(RestIdempotencyConflictError);
    await withTenantOn(testPool, ws, async (tx) => {
      const rows = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from project`);
      expect(rows.rows[0].n).toBe(1);
    });
  });

  it("F1018-15: 120 Receipts im Fenster loesen das Rate-Limit aus", async () => {
    const ws = await workspace();
    const identity = verifiedIdentity(ws, "rest-ratelimit");
    await fillRestReceipts(ws, "rest-ratelimit", 120);
    await expect(submit(ws, identity, payload()))
      .rejects.toBeInstanceOf(RestRateLimitError);
  });

  it("F1018-17: Rate-Budget gilt pro (Workspace, Key) — Zweit-Key bleibt frei", async () => {
    const ws = await workspace();
    await fillRestReceipts(ws, "rest-key-a", 120);
    const identityB = verifiedIdentity(ws, "rest-key-b");
    const receipt = await submit(ws, identityB, payload());
    expect(receipt.duplicate).toBe(false);
    await expect(submit(ws, verifiedIdentity(ws, "rest-key-a"), payload("RATE-A-PROBE")))
      .rejects.toBeInstanceOf(RestRateLimitError);
  });

  it("F1018-18: 120. Receipt ok, 121. stoesst an (Grenze exakt)", async () => {
    const ws = await workspace();
    const identity = verifiedIdentity(ws, "rest-grenze");
    await fillRestReceipts(ws, "rest-grenze", 119);
    const ok = await submit(ws, identity, payload());
    expect(ok.duplicate).toBe(false);
    await expect(submit(ws, identity, payload("GRENZE-121")))
      .rejects.toBeInstanceOf(RestRateLimitError);
  });

  it("F1018-19: fehlende Intake-Lane scheitert ehrlich ohne Teilstand", async () => {
    const ws = await workspace();
    const identity = verifiedIdentity(ws);
    await withTenantOn(testPool, ws, (tx) => tx.execute(sql`
      update kanban_column set archived_at = now()
       where workspace_id = ${ws}::uuid and is_intake = true`));
    await expect(submit(ws, identity, payload()))
      .rejects.toThrow(/intake lane is missing/);
    const leftovers = await withTenantOn(testPool, ws, async (tx) => {
      const receipts = await tx.execute(sql`select id from inbound_rest_receipt`);
      const projects = await tx.execute(sql`select id from project`);
      return { receipts: receipts.rows.length, projects: projects.rows.length };
    });
    expect(leftovers).toEqual({ receipts: 0, projects: 0 });
  });

  it("F1018-16: Record-ID mit Padding wird kanonisch getrimmt", async () => {
    const ws = await workspace();
    const identity = verifiedIdentity(ws);
    const value = payload("  PAD-1  ");
    const first = await submit(ws, identity, value);
    expect(first.clientRecordId).toBe("PAD-1");
    const second = await submit(ws, identity, value);
    expect(second.receiptId).toBe(first.receiptId);
    expect(second.duplicate).toBe(true);
    await withTenantOn(testPool, ws, async (tx) => {
      const rows = await tx.execute<{ client_record_id: string }>(
        sql`select client_record_id from inbound_rest_receipt`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].client_record_id).toBe("PAD-1");
    });
  });
});
