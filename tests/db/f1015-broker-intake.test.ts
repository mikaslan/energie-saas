import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

// Wie Rechner-Intake: der Intake-Graph zieht "server-only"-Module.
vi.mock("server-only", () => ({}));
import { contact } from "@/lib/db/schema";
import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  BrokerIdempotencyConflictError,
  BrokerInvalidRequestError,
} from "@/lib/integrations/broker/errors";
import {
  BROKER_INTAKE_PATH,
  sha256Hex,
  signatureMessage,
  verifyBrokerSignature,
  type VerifiedBrokerIdentity,
} from "@/lib/integrations/broker/signature";
import type {
  BrokerIntakeMeta,
  BrokerIntakeReceiptV1,
  BrokerIntakeV1,
} from "@/lib/integrations/broker/types";
import { LEAD_SOURCE_SCHEMA_VERSION } from "@/lib/integrations/lead-sources/contract";
import { processBrokerIntake } from "@/modules/intake";
import { createLeadSource } from "@/modules/lead-sources";
import { testPool } from "../setup/test-db";

const NOW = new Date("2026-09-18T21:30:00.000Z");
const FIXTURE = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/broker-intake.v1.json"),
  "utf8",
)) as BrokerIntakeV1;

function payload(recordId = `WF-${randomUUID().slice(0, 8)}`): BrokerIntakeV1 {
  const value = structuredClone(FIXTURE);
  value.brokerRecordId = recordId;
  return value;
}

function meta(value: BrokerIntakeV1): BrokerIntakeMeta {
  return {
    payloadSha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    signedAt: NOW,
    receivedAt: NOW,
  };
}

function verifiedIdentity(workspaceId: string, keyId = "broker-test"): VerifiedBrokerIdentity {
  const secret = Buffer.alloc(32, keyId.length);
  const body = Buffer.from("{}", "utf8");
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const idempotencyKey = randomUUID();
  const contentSha256 = sha256Hex(body);
  const signature = createHmac("sha256", secret)
    .update(signatureMessage({
      method: "POST",
      path: BROKER_INTAKE_PATH,
      keyId,
      timestamp,
      idempotencyKey,
      contentSha256,
    }))
    .digest("base64url");
  return verifyBrokerSignature({
    method: "POST",
    path: BROKER_INTAKE_PATH,
    body,
    nowSeconds: Number(timestamp),
    credentialsJson: JSON.stringify([{
      keyId,
      workspaceId,
      scope: "broker-intake.write",
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
    tx.execute(sql`insert into workspace (id, name) values (${id}::uuid, 'Broker Intake Test')`));
  return id;
}

async function submit(
  workspaceId: string,
  identity: VerifiedBrokerIdentity,
  value: BrokerIntakeV1,
  intakeMeta = meta(value),
): Promise<BrokerIntakeReceiptV1> {
  return withTenantOn(testPool, workspaceId, (tx) =>
    processBrokerIntake(tx, identity, value, intakeMeta));
}

async function seedLeadSource(workspaceId: string, name: string): Promise<string> {
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1015.test`})
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

describe("F1-15 Broker-Intake-Fachtransaktion", () => {
  it("F1015-01: Happy Path legt Receipt + Kontakt + Site + Projekt an (Quelle gesetzt)", async () => {
    const ws = await workspace();
    const sourceId = await seedLeadSource(ws, "wattfox");
    const identity = verifiedIdentity(ws);
    const value = payload();

    const receipt = await submit(ws, identity, value);

    expect(receipt.contractVersion).toBe("broker-intake-receipt.v1");
    expect(receipt.brokerKey).toBe("wattfox");
    expect(receipt.brokerRecordId).toBe(value.brokerRecordId);
    expect(receipt.status).toBe("processed");
    expect(receipt.duplicate).toBe(false);
    await withTenantOn(testPool, ws, async (tx) => {
      const rows = await tx.execute<{
        source_key: string; lead_source_id: string | null; assignment_revision: number;
      }>(sql`select source_key, lead_source_id, assignment_revision from project`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].source_key).toBe("broker");
      expect(rows.rows[0].lead_source_id).toBe(sourceId);
      expect(rows.rows[0].assignment_revision).toBe(0);
      const receipts = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from inbound_broker_receipt`);
      expect(receipts.rows[0].n).toBe(1);
    });
  });

  it("F1015-02: ohne Lead-Quelle bleibt lead_source_id ehrlich null", async () => {
    const ws = await workspace();
    const receipt = await submit(ws, verifiedIdentity(ws), payload());
    expect(receipt.duplicate).toBe(false);
    await withTenantOn(testPool, ws, async (tx) => {
      const rows = await tx.execute<{ lead_source_id: string | null }>(
        sql`select lead_source_id from project`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].lead_source_id).toBeNull();
    });
  });

  it("F1015-03: Replay gleichen Records ist idempotent (kein 2. Projekt)", async () => {
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

  it("F1015-04: gleicher Record mit anderem Hash ist Conflict ohne Teilstand", async () => {
    const ws = await workspace();
    const identity = verifiedIdentity(ws);
    const value = payload();
    await submit(ws, identity, value);
    const drifted = structuredClone(value);
    drifted.customer.displayName = "Abweichender Name";
    await expect(submit(ws, identity, drifted, meta(drifted)))
      .rejects.toBeInstanceOf(BrokerIdempotencyConflictError);
    await withTenantOn(testPool, ws, async (tx) => {
      const rows = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from project`);
      expect(rows.rows[0].n).toBe(1);
    });
  });

  it("F1015-05: Cross-Broker-Kontakt wird review-pflichtig, nie still gemergt", async () => {
    const ws = await workspace();
    const email = `cross-${randomUUID()}@f1015.test`;
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

  it("F1015-06: unbekannter Broker-Key scheitert an der Validation", async () => {
    const ws = await workspace();
    const value = payload();
    (value as unknown as Record<string, unknown>).brokerKey = "check24";
    await expect(submit(ws, verifiedIdentity(ws), value))
      .rejects.toBeInstanceOf(BrokerInvalidRequestError);
  });

  it("F1015-07: Dedupe-Namespace ist tenant-isoliert (gleicher Record, zwei Workspaces)", async () => {
    const wsA = await workspace();
    const wsB = await workspace();
    const recordId = `TENANT-${randomUUID().slice(0, 8)}`;
    const receiptA = await submit(wsA, verifiedIdentity(wsA), payload(recordId));
    const receiptB = await submit(wsB, verifiedIdentity(wsB), payload(recordId));
    expect(receiptA.receiptId).not.toBe(receiptB.receiptId);
    await withTenantOn(testPool, wsB, async (tx) => {
      const rows = await tx.execute<{ broker_record_id: string }>(
        sql`select broker_record_id from inbound_broker_receipt`);
      expect(rows.rows).toHaveLength(1);
    });
  });

  it("F1015-08: Race gleichen Records erzeugt genau 1 Projekt", async () => {
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
});
