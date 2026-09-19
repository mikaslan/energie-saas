import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * F1-23 Routing-Vertiefung (PostgreSQL) — TDD gegen T8-IMPL.
 *
 * Vertrag (Annahmen an Migration 0235 + T8-IMPL, Slice-Spec
 * docs/spec/F1-23-routing-deepening.md):
 * - Regelmodell: Dimension Quelle XOR Kampagne; mode suggest(default)/auto;
 *   priority 0..9999 (first-match AUFSTEIGEND, 0 zuerst); Trigger
 *   auto_on_manual (default true) / auto_on_intake (default FALSE);
 *   Kampagnen-Regeln NUR suggest; archivierte Regeln feuern nicht.
 * - Konflikt (Auto-Entscheid zur Erfassung): F12-02-Beauftragter schlägt
 *   Kampagnen-suggest schlägt Quellen-Auto — die höhere Stufe UNTERDRÜCKT
 *   das Auto-Feuern der tieferen (Kampagnen-Regel da → kein Quellen-Auto,
 *   nur Vorschlag).
 * - Suggest-Union: max 5, Ordnung Kampagne-vor-Quelle, je priority
 *   aufsteigend; suggestAssigneeForProject (singular) = erstes Glied;
 *   NEU suggestAssigneesForProject = volle Union
 *   ({ projectId, membershipId, label, ruleId }[]).
 * - Feuerung: project.assignment_key_account_changed trägt ruleId + trigger
 *   ('manual' | 'intake'); Intake-Drift (Ziel weg): Projekt unzugewiesen +
 *   lead_routing.failed, KEIN Throw; manuell + Race: Erfassung VERWEIGERT
 *   (Throw + Rollback). Impl muss baumelnde Regelziele fail-closed
 *   erkennen (kein stilles INNER-JOIN-Wegfiltern).
 * - Fehler: LeadSourceValidationError (XOR, Kampagnen-auto, Priority-Range),
 *   FunnelCampaignNotFoundError (unbekannte Kampagne); Pflege weiter
 *   lead_source.write.
 */
import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  BROKER_INTAKE_PATH,
  sha256Hex,
  signatureMessage,
  verifyBrokerSignature,
} from "@/lib/integrations/broker/signature";
import type {
  BrokerIntakeMeta,
  BrokerIntakeV1,
} from "@/lib/integrations/broker/types";
import {
  FUNNEL_CAMPAIGN_SCHEMA_VERSION,
  type CreateFunnelCampaignCommand,
} from "@/lib/integrations/funnel-campaigns/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import { processBrokerIntake } from "@/modules/intake";
import { FunnelCampaignNotFoundError, createFunnelCampaign } from "@/modules/funnel-campaigns";
import {
  LeadSourceValidationError,
  applyAutoRouting,
  archiveRoutingRule,
  clearRoutingRule,
  reactivateRoutingRule,
  setRoutingRule,
  suggestAssigneeForProject,
  suggestAssigneesForProject,
} from "@/modules/lead-sources";
import {
  ManualLeadValidationError,
  createManualLead,
} from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

type Fixture = {
  workspaceId: string;
  editorId: string;
  editorMembershipId: string;
  viewerId: string;
  sourceId: string;
  brokerSourceId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const editorMembershipId = randomUUID();
  const sourceId = randomUUID();
  const brokerSourceId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-23 Routing')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f123.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f123.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into lead_source (id, workspace_id, name, name_normalized)
      values (${sourceId}::uuid, ${workspaceId}::uuid, 'F123 Quelle', 'f123 quelle'),
             (${brokerSourceId}::uuid, ${workspaceId}::uuid, 'Wattfox', 'wattfox')
    `);
  });

  return { workspaceId, editorId, editorMembershipId, viewerId, sourceId, brokerSourceId };
}

async function addMember(fx: Fixture, emailPrefix: string): Promise<{ userId: string; membershipId: string; email: string }> {
  const userId = randomUUID();
  const membershipId = randomUUID();
  const email = `${emailPrefix}-${userId}@f123.test`;
  await withTenantOn(testPool, fx.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into user_identity (id, email) values (${userId}::uuid, ${email})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${membershipId}::uuid, ${fx.workspaceId}::uuid, ${userId}::uuid, 'editor', '{}'::jsonb)
    `);
  });
  return { userId, membershipId, email };
}

async function seedSource(workspaceId: string, name: string, normalized: string): Promise<string> {
  const id = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into lead_source (id, workspace_id, name, name_normalized)
      values (${id}::uuid, ${workspaceId}::uuid, ${name}, ${normalized})
    `);
  });
  return id;
}

async function projectState(workspaceId: string, projectId: string) {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const project = await tx.execute<{ assignment_revision: number }>(sql`
      select assignment_revision from project
       where workspace_id = ${workspaceId}::uuid and id = ${projectId}::uuid
    `);
    const assignments = await tx.execute<{ membership_id: string; assignment_role: string }>(sql`
      select membership_id, assignment_role from project_assignment
       where workspace_id = ${workspaceId}::uuid and project_id = ${projectId}::uuid
    `);
    const events = await tx.execute<{ event_type: string; aggregate_id: string; payload: Record<string, unknown> }>(sql`
      select event_type, aggregate_id, payload from domain_events
       where workspace_id = ${workspaceId}::uuid
         and aggregate_id = ${projectId}::uuid
       order by id
    `);
    return { project: project.rows[0], assignments: assignments.rows, events: events.rows };
  });
}

// --- Broker-Intake-Helfer (Muster f1015) ----------------------------------

const NOW = new Date("2026-09-18T21:30:00.000Z");
const FIXTURE = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/broker-intake.v1.json"),
  "utf8",
)) as BrokerIntakeV1;

function brokerPayload(recordId: string): BrokerIntakeV1 {
  const value = structuredClone(FIXTURE);
  value.brokerRecordId = recordId;
  return value;
}

function brokerMeta(value: BrokerIntakeV1): BrokerIntakeMeta {
  return {
    payloadSha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    signedAt: NOW,
    receivedAt: NOW,
  };
}

function brokerIdentity(workspaceId: string, keyId = "broker-test") {
  // Echte verifizierte Identität (Muster f1015) — der Brand-Typ lässt
  // keine Abkürzung zu, processBrokerIntake nutzt daraus nur wenige Felder.
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

async function intakeProjectId(workspaceId: string, brokerRecordId: string): Promise<string> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const found = await tx.execute<{ project_id: string }>(sql`
      select project_id from inbound_broker_receipt
       where workspace_id = ${workspaceId}::uuid
         and broker_record_id = ${brokerRecordId}
       limit 1
    `);
    if (!found.rows[0]) throw new Error("Broker-Receipt ohne Projekt — Intake schlug fehl?");
    return found.rows[0].project_id;
  });
}

/**
 * Direkter DB-Eingriff für die Race-/Drift-Zweige: löscht die Mitgliedschaft
 * unter Umgehung der RESTRICT-FK (wie F1202-DB-05 feststellt, ist der Zweig
 * sonst nicht erreichbar — per Konstruktion fail-closed).
 */
async function deleteMembershipBypassingFk(workspaceId: string, membershipId: string): Promise<void> {
  const superuserUrl = process.env.POSTGRES_URL_TEST_SUPERUSER;
  if (!superuserUrl) throw new Error("POSTGRES_URL_TEST_SUPERUSER fehlt (embedded-Test-DB setzt sie).");
  const pool = createDrainTrackedPool({ connectionString: superuserUrl, max: 1 });
  try {
    // Einzelstatements: pg-pool Prepared Statements verweigern
    // Multi-Command-Strings mit Parametern.
    await pool.query("SET session_replication_role = 'replica'");
    try {
      await pool.query(
        "DELETE FROM membership WHERE workspace_id = $1::uuid AND id = $2::uuid",
        [workspaceId, membershipId],
      );
    } finally {
      await pool.query("RESET session_replication_role");
    }
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

describe("F1-23 Routing-Vertiefung (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  function campaignCommand(overrides: Partial<CreateFunnelCampaignCommand> = {}): CreateFunnelCampaignCommand {
    return {
      schemaVersion: FUNNEL_CAMPAIGN_SCHEMA_VERSION,
      name: "F123-Kampagne",
      slug: "f123-2026",
      leadSourceId: fixture.sourceId,
      ...overrides,
    };
  }

  it("F123-DB-01: Quellen-suggest — kein Auto, Vorschlag in Singular+Union", async () => {
    const target = await addMember(fixture, "suggest");
    const rule = await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: target.membershipId,
    }));
    expect(rule.mode).toBe("suggest");
    expect(rule.autoOnManual).toBe(true);
    expect(rule.autoOnIntake).toBe(false);
    expect(rule.priority).toBeGreaterThanOrEqual(0);
    expect(rule.priority).toBeLessThanOrEqual(9999);
    expect(rule.funnelCampaignId).toBeNull();
    expect(rule.archivedAt).toBeNull();

    const result = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Suggest Lead",
      email: "suggest@f123.test",
      leadSourceId: fixture.sourceId,
    }));
    const state = await projectState(fixture.workspaceId, result.projectId);
    expect(state.project?.assignment_revision).toBe(0);
    expect(state.assignments).toHaveLength(0);
    expect(state.events.map((event) => event.event_type)).not.toContain(
      "project.assignment_key_account_changed",
    );

    const singular = await asEditor(fixture, (tx, ctx) => suggestAssigneeForProject(tx, ctx, {
      projectId: result.projectId,
    }));
    expect(singular?.membershipId).toBe(target.membershipId.toLowerCase());
    const union = await asEditor(fixture, (tx, ctx) => suggestAssigneesForProject(tx, ctx, {
      projectId: result.projectId,
    }));
    expect(union).toHaveLength(1);
    expect(union[0]).toMatchObject({
      projectId: result.projectId.toLowerCase(),
      membershipId: target.membershipId.toLowerCase(),
      ruleId: rule.id,
    });
    expect(union[0]?.label).toContain("@f123.test");
  });

  it("F123-DB-02: Quellen-auto — manuelle Erfassung weist zu (Regelvollzug)", async () => {
    const target = await addMember(fixture, "auto");
    const rule = await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: target.membershipId,
      mode: "auto",
      priority: 10,
    }));
    expect(rule.mode).toBe("auto");

    const result = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Auto Lead",
      email: "auto@f123.test",
      leadSourceId: fixture.sourceId,
    }));
    const state = await projectState(fixture.workspaceId, result.projectId);
    expect(state.project?.assignment_revision).toBe(1);
    expect(state.assignments).toHaveLength(1);
    expect(state.assignments[0]).toMatchObject({
      membership_id: target.membershipId.toLowerCase(),
      assignment_role: "key_account",
    });
    const routingEvents = state.events.filter(
      (event) => event.event_type === "project.assignment_key_account_changed",
    );
    expect(routingEvents).toHaveLength(1);
    expect(routingEvents[0]!.payload).toMatchObject({
      assignmentRevision: 1,
      commandKind: "set_key_account",
      membershipId: target.membershipId.toLowerCase(),
      autoRouted: true,
      ruleId: rule.id,
      trigger: "manual",
    });

    // Verbrauchte Regel: Ziel ist Key Account → kein Vorschlag mehr.
    const singular = await asEditor(fixture, (tx, ctx) => suggestAssigneeForProject(tx, ctx, {
      projectId: result.projectId,
    }));
    expect(singular).toBeNull();
    const union = await asEditor(fixture, (tx, ctx) => suggestAssigneesForProject(tx, ctx, {
      projectId: result.projectId,
    }));
    expect(union).toHaveLength(0);
  });

  it("F123-DB-03: Kampagnen-Dimension — nur suggest; Schreiben validiert", async () => {
    const target = await addMember(fixture, "kampagne");
    const campaign = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, campaignCommand()));
    const rule = await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      funnelCampaignId: campaign.id,
      assigneeMembershipId: target.membershipId,
      priority: 5,
    }));
    expect(rule.mode).toBe("suggest");
    expect(rule.funnelCampaignId).toBe(campaign.id.toLowerCase());

    const result = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Kampagnen Lead",
      email: "kampagne@f123.test",
      funnelCampaignId: campaign.id,
    }));
    const state = await projectState(fixture.workspaceId, result.projectId);
    expect(state.project?.assignment_revision).toBe(0);
    expect(state.assignments).toHaveLength(0);

    const union = await asEditor(fixture, (tx, ctx) => suggestAssigneesForProject(tx, ctx, {
      projectId: result.projectId,
    }));
    expect(union).toHaveLength(1);
    expect(union[0]).toMatchObject({
      membershipId: target.membershipId.toLowerCase(),
      ruleId: rule.id,
    });
    const singular = await asEditor(fixture, (tx, ctx) => suggestAssigneeForProject(tx, ctx, {
      projectId: result.projectId,
    }));
    expect(singular?.membershipId).toBe(target.membershipId.toLowerCase());

    // Kampagnen-Regeln NUR suggest — auto wird verweigert.
    await expect(asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      funnelCampaignId: campaign.id,
      assigneeMembershipId: target.membershipId,
      mode: "auto",
    }))).rejects.toBeInstanceOf(LeadSourceValidationError);

    // Dimension XOR: beide oder keine → Validation.
    await expect(asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      funnelCampaignId: campaign.id,
      assigneeMembershipId: target.membershipId,
    }))).rejects.toBeInstanceOf(LeadSourceValidationError);
    await expect(asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      assigneeMembershipId: target.membershipId,
    } as never))).rejects.toBeInstanceOf(LeadSourceValidationError);

    // Priority-Range 0..9999.
    for (const priority of [-1, 10_000]) {
      await expect(asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
        leadSourceId: fixture.sourceId,
        assigneeMembershipId: target.membershipId,
        priority,
      }))).rejects.toBeInstanceOf(LeadSourceValidationError);
    }

    // Unbekannte Kampagne fail-closed; Pflege braucht lead_source.write.
    await expect(asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      funnelCampaignId: randomUUID(),
      assigneeMembershipId: target.membershipId,
    }))).rejects.toBeInstanceOf(FunnelCampaignNotFoundError);
    await expect(asViewer(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      funnelCampaignId: campaign.id,
      assigneeMembershipId: target.membershipId,
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F123-DB-04: priority-first-match — niedrigste Priority gewinnt", async () => {
    const slow = await addMember(fixture, "prio-hoch");
    const fast = await addMember(fixture, "prio-niedrig");
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: slow.membershipId,
      mode: "auto",
      priority: 50,
    }));
    const winner = await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: fast.membershipId,
      mode: "auto",
      priority: 10,
    }));

    const result = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Prio Lead",
      email: "prio@f123.test",
      leadSourceId: fixture.sourceId,
    }));
    const state = await projectState(fixture.workspaceId, result.projectId);
    expect(state.assignments).toHaveLength(1);
    expect(state.assignments[0]?.membership_id).toBe(fast.membershipId.toLowerCase());
    const routingEvents = state.events.filter(
      (event) => event.event_type === "project.assignment_key_account_changed",
    );
    expect(routingEvents[0]!.payload).toMatchObject({ ruleId: winner.id, trigger: "manual" });

    // Suggest-Seite: Union nach Priority aufsteigend (eigene Quelle).
    const otherSource = await seedSource(fixture.workspaceId, "F123 Prio", "f123 prio");
    const campaign = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, campaignCommand({
      slug: "f123-prio", leadSourceId: otherSource,
    })));
    const late = await addMember(fixture, "prio-spaet");
    const early = await addMember(fixture, "prio-frueh");
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      funnelCampaignId: campaign.id, assigneeMembershipId: late.membershipId, priority: 50,
    }));
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      funnelCampaignId: campaign.id, assigneeMembershipId: early.membershipId, priority: 5,
    }));
    const second = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Prio Suggest",
      email: "prio-suggest@f123.test",
      funnelCampaignId: campaign.id,
    }));
    const union = await asEditor(fixture, (tx, ctx) => suggestAssigneesForProject(tx, ctx, {
      projectId: second.projectId,
    }));
    expect(union.map((item) => item.membershipId)).toEqual([
      early.membershipId.toLowerCase(),
      late.membershipId.toLowerCase(),
    ]);
  });

  it("F123-DB-05: Konfliktordnung F12-02 > Kampagnen-suggest > Quellen-Auto", async () => {
    // (a) F12-02-Beauftragter schlägt Quellen-Auto.
    const f1202Source = await seedSource(fixture.workspaceId, "F123 F1202", "f123 f1202");
    const f1202Target = await addMember(fixture, "f1202-siegt");
    const autoTarget = await addMember(fixture, "auto-verliert");
    const f1202Campaign = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, campaignCommand({
      slug: "f123-f1202",
      leadSourceId: f1202Source,
      assigneeMembershipId: f1202Target.membershipId,
    })));
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: f1202Source,
      assigneeMembershipId: autoTarget.membershipId,
      mode: "auto",
      priority: 1,
    }));
    const first = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "F1202 siegt",
      email: "f1202-siegt@f123.test",
      funnelCampaignId: f1202Campaign.id,
    }));
    const firstState = await projectState(fixture.workspaceId, first.projectId);
    expect(firstState.project?.assignment_revision).toBe(1);
    expect(firstState.assignments).toHaveLength(1);
    expect(firstState.assignments[0]?.membership_id).toBe(f1202Target.membershipId.toLowerCase());

    // (b) Kampagnen-suggest unterdrückt Quellen-Auto → unzugewiesen, Union
    // trägt Kampagne-vor-Quelle.
    const campaignSource = await seedSource(fixture.workspaceId, "F123 Block", "f123 block");
    const campaignTarget = await addMember(fixture, "kampagne-siegt");
    const blockedTarget = await addMember(fixture, "auto-blockiert");
    const campaign = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, campaignCommand({
      name: "F123-Block-Kampagne",
      slug: "f123-block", leadSourceId: campaignSource,
    })));
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      funnelCampaignId: campaign.id,
      assigneeMembershipId: campaignTarget.membershipId,
      priority: 100,
    }));
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: campaignSource,
      assigneeMembershipId: blockedTarget.membershipId,
      mode: "auto",
      priority: 1,
    }));
    const second = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Kampagne blockt Auto",
      email: "block@f123.test",
      funnelCampaignId: campaign.id,
    }));
    const secondState = await projectState(fixture.workspaceId, second.projectId);
    expect(secondState.project?.assignment_revision).toBe(0);
    expect(secondState.assignments).toHaveLength(0);
    const union = await asEditor(fixture, (tx, ctx) => suggestAssigneesForProject(tx, ctx, {
      projectId: second.projectId,
    }));
    expect(union.map((item) => item.membershipId)).toEqual([
      campaignTarget.membershipId.toLowerCase(),
      blockedTarget.membershipId.toLowerCase(),
    ]);
  });

  it("F123-DB-06: Suggest-Union max 5 — Tier+Priority-Reihenfolge", async () => {
    const source = await seedSource(fixture.workspaceId, "F123 Union", "f123 union");
    const campaign = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, campaignCommand({
      slug: "f123-union", leadSourceId: source,
    })));
    const c1 = await addMember(fixture, "union-c1");
    const c2 = await addMember(fixture, "union-c2");
    const s1 = await addMember(fixture, "union-s1");
    const s2 = await addMember(fixture, "union-s2");
    const s3 = await addMember(fixture, "union-s3");
    const s4 = await addMember(fixture, "union-s4");
    const s5 = await addMember(fixture, "union-s5");
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      funnelCampaignId: campaign.id, assigneeMembershipId: c1.membershipId, priority: 20,
    }));
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      funnelCampaignId: campaign.id, assigneeMembershipId: c2.membershipId, priority: 5,
    }));
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: source, assigneeMembershipId: s1.membershipId, mode: "auto", priority: 1,
    }));
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: source, assigneeMembershipId: s2.membershipId, priority: 2,
    }));
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: source, assigneeMembershipId: s3.membershipId, mode: "auto",
      priority: 3, autoOnManual: false,
    }));
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: source, assigneeMembershipId: s4.membershipId, priority: 4,
    }));
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: source, assigneeMembershipId: s5.membershipId, priority: 5,
    }));

    const result = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Union Lead",
      email: "union@f123.test",
      funnelCampaignId: campaign.id,
    }));
    // Kampagnen-Stufe unterdrückt das Quellen-Auto (DB-05b).
    const state = await projectState(fixture.workspaceId, result.projectId);
    expect(state.project?.assignment_revision).toBe(0);

    const union = await asEditor(fixture, (tx, ctx) => suggestAssigneesForProject(tx, ctx, {
      projectId: result.projectId,
    }));
    expect(union).toHaveLength(5);
    expect(union.map((item) => item.membershipId)).toEqual([
      c2.membershipId.toLowerCase(),
      c1.membershipId.toLowerCase(),
      s1.membershipId.toLowerCase(),
      s2.membershipId.toLowerCase(),
      s3.membershipId.toLowerCase(),
    ]);
    const singular = await asEditor(fixture, (tx, ctx) => suggestAssigneeForProject(tx, ctx, {
      projectId: result.projectId,
    }));
    expect(singular?.membershipId).toBe(c2.membershipId.toLowerCase());
  });

  it("F123-DB-07: auto_on_intake default false — Opt-in feuert (trigger intake)", async () => {
    const target = await addMember(fixture, "intake");
    const rule = await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.brokerSourceId,
      assigneeMembershipId: target.membershipId,
      mode: "auto",
    }));
    expect(rule.autoOnIntake).toBe(false);

    const firstPayload = brokerPayload(`WF-${randomUUID().slice(0, 8)}`);
    await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      processBrokerIntake(tx, brokerIdentity(fixture.workspaceId), firstPayload, brokerMeta(firstPayload)));
    const firstProject = await intakeProjectId(fixture.workspaceId, firstPayload.brokerRecordId);
    const firstState = await projectState(fixture.workspaceId, firstProject);
    expect(firstState.project?.assignment_revision).toBe(0);
    expect(firstState.assignments).toHaveLength(0);
    // Kein Feuerungsversuch → auch kein Failure-Event.
    expect(firstState.events.map((event) => event.event_type)).not.toContain("lead_routing.failed");

    await asEditor(fixture, (tx, ctx) => clearRoutingRule(tx, ctx, { leadSourceId: fixture.brokerSourceId }));
    const optIn = await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.brokerSourceId,
      assigneeMembershipId: target.membershipId,
      mode: "auto",
      autoOnIntake: true,
    }));
    expect(optIn.autoOnIntake).toBe(true);

    const secondPayload = brokerPayload(`WF-${randomUUID().slice(0, 8)}`);
    await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      processBrokerIntake(tx, brokerIdentity(fixture.workspaceId), secondPayload, brokerMeta(secondPayload)));
    const secondProject = await intakeProjectId(fixture.workspaceId, secondPayload.brokerRecordId);
    const secondState = await projectState(fixture.workspaceId, secondProject);
    expect(secondState.project?.assignment_revision).toBe(1);
    expect(secondState.assignments).toHaveLength(1);
    expect(secondState.assignments[0]).toMatchObject({
      membership_id: target.membershipId.toLowerCase(),
      assignment_role: "key_account",
    });
    const routingEvents = secondState.events.filter(
      (event) => event.event_type === "project.assignment_key_account_changed",
    );
    expect(routingEvents).toHaveLength(1);
    expect(routingEvents[0]!.payload).toMatchObject({
      membershipId: target.membershipId.toLowerCase(),
      autoRouted: true,
      ruleId: optIn.id,
      trigger: "intake",
    });
  });

  it("F123-DB-08: Race manuell — Ziel weg → Erfassung verweigert (Rollback)", async () => {
    const target = await addMember(fixture, "race");
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: target.membershipId,
      mode: "auto",
      priority: 1,
    }));
    // Race-Simulation: Ziel verschwindet zwischen Regelpflege und Erfassung.
    await deleteMembershipBypassingFk(fixture.workspaceId, target.membershipId);

    await expect(asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Race Lead",
      email: "race@f123.test",
      leadSourceId: fixture.sourceId,
    }))).rejects.toThrowError(ManualLeadValidationError);

    // Volle Verweigerung: weder Kontakt noch Projekt bleiben zurück.
    const leftovers = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const contacts = await tx.execute<{ id: string }>(sql`
        select id from contact
         where workspace_id = ${fixture.workspaceId}::uuid
           and email_normalized = 'race@f123.test'
      `);
      const projects = await tx.execute<{ id: string }>(sql`
        select id from project
         where workspace_id = ${fixture.workspaceId}::uuid
           and name = 'Race Lead'
      `);
      return { contacts: contacts.rows, projects: projects.rows };
    });
    expect(leftovers.contacts).toHaveLength(0);
    expect(leftovers.projects).toHaveLength(0);
  });

  it("F123-DB-09: Intake-Drift — unzugewiesen + lead_routing.failed, kein 500", async () => {
    const target = await addMember(fixture, "drift");
    const rule = await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.brokerSourceId,
      assigneeMembershipId: target.membershipId,
      mode: "auto",
      autoOnIntake: true,
    }));
    await deleteMembershipBypassingFk(fixture.workspaceId, target.membershipId);

    // Kein Throw an den Sender: Receipt kommt normal zurück.
    const value = brokerPayload(`WF-${randomUUID().slice(0, 8)}`);
    const receipt = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      processBrokerIntake(tx, brokerIdentity(fixture.workspaceId), value, brokerMeta(value)));
    expect(receipt.brokerRecordId).toBe(value.brokerRecordId);

    const projectId = await intakeProjectId(fixture.workspaceId, value.brokerRecordId);
    const state = await projectState(fixture.workspaceId, projectId);
    expect(state.project?.assignment_revision).toBe(0);
    expect(state.assignments).toHaveLength(0);
    expect(state.events.map((event) => event.event_type)).not.toContain(
      "project.assignment_key_account_changed",
    );
    const failed = state.events.filter((event) => event.event_type === "lead_routing.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({
      ruleId: rule.id,
      trigger: "intake",
      reason: "assignee_gone",
    });
    const failures = state.events.filter((event) => event.event_type === "lead_routing.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.aggregate_id).toBe(projectId.toLowerCase());
  });

  it("F123-DB-10: archivierte Regeln feuern nicht (weder Auto noch Suggest)", async () => {
    const autoTarget = await addMember(fixture, "archiv-auto");
    const campaignSource = await seedSource(fixture.workspaceId, "F123 Archiv", "f123 archiv");
    const campaignTarget = await addMember(fixture, "archiv-kampagne");
    const campaign = await asEditor(fixture, (tx, ctx) => createFunnelCampaign(tx, ctx, campaignCommand({
      slug: "f123-archiv", leadSourceId: campaignSource,
    })));
    const autoRule = await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: autoTarget.membershipId,
      mode: "auto",
      priority: 1,
    }));
    const campaignRule = await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      funnelCampaignId: campaign.id,
      assigneeMembershipId: campaignTarget.membershipId,
      priority: 1,
    }));
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        update project_lead_routing_rule
           set archived_at = statement_timestamp()
         where workspace_id = ${fixture.workspaceId}::uuid
           and id in (${autoRule.id}::uuid, ${campaignRule.id}::uuid)
      `);
    });

    const first = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Archiv Auto",
      email: "archiv-auto@f123.test",
      leadSourceId: fixture.sourceId,
    }));
    const firstState = await projectState(fixture.workspaceId, first.projectId);
    expect(firstState.project?.assignment_revision).toBe(0);
    expect(firstState.assignments).toHaveLength(0);
    expect(await asEditor(fixture, (tx, ctx) => suggestAssigneesForProject(tx, ctx, {
      projectId: first.projectId,
    }))).toHaveLength(0);

    const second = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Archiv Kampagne",
      email: "archiv-kampagne@f123.test",
      funnelCampaignId: campaign.id,
    }));
    const secondState = await projectState(fixture.workspaceId, second.projectId);
    expect(secondState.project?.assignment_revision).toBe(0);
    expect(await asEditor(fixture, (tx, ctx) => suggestAssigneeForProject(tx, ctx, {
      projectId: second.projectId,
    }))).toBeNull();
  });

  it("F123-DB-11: Offboarding des Regelziels per RESTRICT blockiert", async () => {
    const target = await addMember(fixture, "restrict");
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: target.membershipId,
      mode: "auto",
    }));
    const blocked = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      try {
        await tx.execute(sql`
          delete from membership
           where workspace_id = ${fixture.workspaceId}::uuid
             and id = ${target.membershipId}::uuid
        `);
        return null;
      } catch (error) {
        const code = (error as { cause?: { code?: unknown } }).cause?.code;
        return typeof code === "string" ? code : "unknown";
      }
    });
    // 23001 = restrict_violation (ON DELETE RESTRICT greift).
    expect(blocked).toBe("23001");
  });

  it("F123-DB-12: Archiv-API — archiviert feuert nicht, ueberlebt Clear, idempotent", async () => {
    const target = await addMember(fixture, "archiv-api");
    const rule = await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: target.membershipId,
      mode: "auto",
      priority: 1,
    }));
    const archived = await asEditor(fixture, (tx, ctx) => archiveRoutingRule(tx, ctx, { ruleId: rule.id }));
    expect(archived.archivedAt).not.toBeNull();
    const again = await asEditor(fixture, (tx, ctx) => archiveRoutingRule(tx, ctx, { ruleId: rule.id }));
    expect(again.archivedAt).toBe(archived.archivedAt);

    const lead = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Archiv API",
      email: "archiv-api@f123.test",
      leadSourceId: fixture.sourceId,
    }));
    const state = await projectState(fixture.workspaceId, lead.projectId);
    expect(state.project?.assignment_revision).toBe(0);
    expect(state.assignments).toHaveLength(0);
    expect(await asEditor(fixture, (tx, ctx) => suggestAssigneeForProject(tx, ctx, {
      projectId: lead.projectId,
    }))).toBeNull();

    // Clear-by-source laesst die Archivzeile bestehen (Historie).
    const cleared = await asEditor(fixture, (tx, ctx) => clearRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
    }));
    expect(cleared.deleted).toBe(false);
    const rows = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{ id: string }>(sql`
      select id from project_lead_routing_rule
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${rule.id}::uuid
    `));
    expect(rows.rows).toHaveLength(1);

    // ruleId-Pfad bleibt explizit-total + belegt rule.cleared.
    const byId = await asEditor(fixture, (tx, ctx) => clearRoutingRule(tx, ctx, { ruleId: rule.id }));
    expect(byId.deleted).toBe(true);
    const clearedEvents = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      event_type: string; payload: Record<string, unknown>;
    }>(sql`
      select event_type, payload from domain_events
       where workspace_id = ${fixture.workspaceId}::uuid
         and event_type = 'lead_routing_rule.cleared'
    `));
    expect(clearedEvents.rows).toHaveLength(1);
    expect(clearedEvents.rows[0]!.payload).toMatchObject({ ruleId: rule.id, deletedCount: 1 });
  });

  it("F123-DB-13: Reaktivierung — feuert wieder, Twin-Konflikt ehrlich", async () => {
    const target = await addMember(fixture, "reaktiv");
    const rule = await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: target.membershipId,
      mode: "auto",
      priority: 1,
    }));
    await asEditor(fixture, (tx, ctx) => archiveRoutingRule(tx, ctx, { ruleId: rule.id }));

    // Archiv gibt den Unique frei: Zwilling anlegbar.
    const twin = await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: target.membershipId,
      mode: "auto",
      priority: 1,
    }));
    expect(twin.id).not.toBe(rule.id);

    // Reaktivierung scheitert ehrlich am aktiven Zwilling.
    await expect(asEditor(fixture, (tx, ctx) => reactivateRoutingRule(tx, ctx, {
      ruleId: rule.id,
    }))).rejects.toThrowError(LeadSourceValidationError);

    // Zwilling weg → Reaktivierung feuert wieder.
    await asEditor(fixture, (tx, ctx) => clearRoutingRule(tx, ctx, { ruleId: twin.id }));
    const back = await asEditor(fixture, (tx, ctx) => reactivateRoutingRule(tx, ctx, { ruleId: rule.id }));
    expect(back.archivedAt).toBeNull();
    const lead = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Reaktiviert",
      email: "reaktiviert@f123.test",
      leadSourceId: fixture.sourceId,
    }));
    const state = await projectState(fixture.workspaceId, lead.projectId);
    expect(state.assignments).toHaveLength(1);
    expect(state.assignments[0]!.membership_id).toBe(target.membershipId.toLowerCase());
  });

  it("F123-DB-14: Revisions-Konflikt — kein luegendes Event, kein Rest", async () => {
    const target = await addMember(fixture, "revkonflikt");
    const first = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Rev Konflikt",
      email: "rev-konflikt@f123.test",
      leadSourceId: fixture.sourceId,
    }));
    const rule = await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: target.membershipId,
      mode: "auto",
      priority: 1,
      autoOnIntake: true,
    }));
    // Fremder Vollzug zuerst: Revision vorweggenommen, keine Zeile.
    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      update project set assignment_revision = 1
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${first.projectId}::uuid
    `));
    const outcome = await asEditor(fixture, (tx, ctx) => applyAutoRouting(tx, ctx, {
      projectId: first.projectId,
      leadSourceId: fixture.sourceId,
      funnelCampaignId: null,
      campaignAssigneeMembershipId: null,
      trigger: "manual",
    }));
    expect(outcome).toMatchObject({ status: "unassigned", reason: "revision_conflict", ruleId: rule.id });
    const state = await projectState(fixture.workspaceId, first.projectId);
    expect(state.assignments).toHaveLength(0);
    expect(state.events.map((event) => event.event_type)).not.toContain(
      "project.assignment_key_account_changed",
    );

    // Intake-Variante belegt failed/revision_conflict (Projekt ueber
    // regellose Quelle anlegen, damit die Erfassung selbst nicht feuert).
    const plainSource = await seedSource(fixture.workspaceId, "F123 Ohne Regel", "f123 ohne regel");
    const second = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Rev Konflikt Intake",
      email: "rev-konflikt-intake@f123.test",
      leadSourceId: plainSource,
    }));
    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      update project set assignment_revision = 1
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${second.projectId}::uuid
    `));
    const intakeOutcome = await asEditor(fixture, (tx, ctx) => applyAutoRouting(tx, ctx, {
      projectId: second.projectId,
      leadSourceId: fixture.sourceId,
      funnelCampaignId: null,
      campaignAssigneeMembershipId: null,
      trigger: "intake",
    }));
    expect(intakeOutcome).toMatchObject({ status: "unassigned", reason: "revision_conflict" });
    const intakeState = await projectState(fixture.workspaceId, second.projectId);
    const failed = intakeState.events.filter((event) => event.event_type === "lead_routing.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({
      ruleId: rule.id,
      trigger: "intake",
      reason: "revision_conflict",
    });
  });

  it("F123-DB-15: autoOnManual=false — kein Auto bei manuell, aber vorschlagbar", async () => {
    const target = await addMember(fixture, "keinauto");
    await asEditor(fixture, (tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: target.membershipId,
      mode: "auto",
      priority: 1,
      autoOnManual: false,
    }));
    const lead = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "Kein Auto",
      email: "kein-auto@f123.test",
      leadSourceId: fixture.sourceId,
    }));
    const state = await projectState(fixture.workspaceId, lead.projectId);
    expect(state.project?.assignment_revision).toBe(0);
    expect(state.assignments).toHaveLength(0);
    // Auto impliziert vorschlagbar (Union kennt keinen Trigger-Filter).
    const union = await asEditor(fixture, (tx, ctx) => suggestAssigneesForProject(tx, ctx, {
      projectId: lead.projectId,
    }));
    expect(union.map((item) => item.membershipId)).toEqual([target.membershipId.toLowerCase()]);
  });
});
