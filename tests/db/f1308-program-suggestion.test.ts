import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  getSubsidyProgramSuggestion,
  SubsidyCaseValidationError,
} from "@/modules/subsidy-cases";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(name: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${name})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1308.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1308.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, viewerId };
}

describe("F13-08 Programm-Vorschlag (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("F13-08 Vorschlag");
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  const seedSnapshot = async (
    fx: Fixture,
    projectId: string,
    snapshot: Record<string, unknown>,
    requirements: Record<string, unknown> | null = null,
  ): Promise<void> => {
    await withTenantOn(testPool, fx.workspaceId, async (tx) => {
      const project = await tx.execute<{ contact_id: string; site_id: string }>(sql`
        select contact_id, site_id from project
         where workspace_id = ${fx.workspaceId}::uuid and id = ${projectId}::uuid
      `);
      const row = project.rows[0];
      if (!row) throw new Error("Projekt fehlt");
      const receiptId = randomUUID();
      const snapshotId = randomUUID();
      await tx.execute(sql`
        insert into inbound_receipt (
          id, workspace_id, source_key, submission_id, contract_version,
          body_sha256, auth_key_id, signed_at, submitted_at, received_at,
          producer_application, producer_git_revision, producer_environment,
          calculator_engine, acquisition, privacy_purpose, privacy_legal_basis,
          privacy_notice_version, privacy_notice_url, contact_resolution,
          contact_id, site_id, project_id
        ) values (
          ${receiptId}::uuid, ${fx.workspaceId}::uuid, 'wmee-rechner-v3',
          ${randomUUID()}::uuid, 'rechner-intake.v1',
          decode(repeat('7a', 32), 'hex'), 'f1308-key', now(), now(), now(),
          'wmee-rechner-v3', repeat('5b', 20), 'development', 'wmee-solar.v1',
          '{}'::jsonb, 'offer_request', 'art_6_1_b_precontractual', 'fixture',
          'https://example.test/privacy', 'created', ${row.contact_id}::uuid,
          ${row.site_id}::uuid, ${projectId}::uuid
        )
      `);
      await tx.execute(sql`
        insert into calculator_snapshot (
          id, workspace_id, receipt_id, project_id, schema_version,
          calculator_engine, result_integrity, investment_source,
          calculated_at, snapshot
        ) values (
          ${snapshotId}::uuid, ${fx.workspaceId}::uuid, ${receiptId}::uuid,
          ${projectId}::uuid, 'wmee-solar-snapshot.v1', 'wmee-solar.v1',
          'client_reported_unverified', 'market_estimate', now(),
          ${JSON.stringify(snapshot)}::jsonb
        )
      `);
      if (requirements !== null) {
        await tx.execute(sql`
          insert into project_requirement (
            id, workspace_id, project_id, revision, schema_version,
            source_snapshot_id, requirements
          ) values (
            ${randomUUID()}::uuid, ${fx.workspaceId}::uuid, ${projectId}::uuid,
            1, 'project-requirements.rechner.v1', ${snapshotId}::uuid,
            ${JSON.stringify(requirements)}::jsonb
          )
        `);
      }
    });
  };

  it("F1308-DB-01: Wärmepumpen-Signal schlägt vor, Leser sehen Vorschlag, Fremdform fail-closed", async () => {
    const lead = await asEditor(fixture, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Vorschlag WP", phone: "+49 171 3333333" }),
    );
    await seedSnapshot(fixture, lead.projectId, {
      schemaVersion: "wmee-solar-snapshot.v1",
      calculatedAt: "2026-09-10T00:00:00.000Z",
      branch: "new_installation",
      questionnaireVariant: "short",
      resultIntegrity: "client_reported_unverified",
      inputs: {
        answeredFieldIds: ["waermepumpe", "wohnflaeche"],
        requestedProducts: {
          targetStorageKwh: 10,
          wallbox: true,
          bidirectionalCharging: false,
          backupPower: false,
        },
      },
      provenance: { investment: "market_estimate" },
      result: { mode: "new_installation" },
    });

    const editorView = await asEditor(fixture, (tx, ctx) =>
      getSubsidyProgramSuggestion(tx, ctx, lead.projectId),
    );
    expect(editorView.outcome).toBe("suggested");
    if (editorView.outcome !== "suggested") throw new Error("Vorschlag erwartet");
    expect(editorView.program).toBe("bafa");
    expect(editorView.rulesVersion).toBe("f13-08-suggest.v1");
    expect(editorView.reasons.join(" ")).toMatch(/Wärmepumpe/u);

    const viewerView = await asViewer(fixture, (tx, ctx) =>
      getSubsidyProgramSuggestion(tx, ctx, lead.projectId),
    );
    expect(viewerView).toEqual(editorView);

    await expect(
      asEditor(fixture, (tx, ctx) => getSubsidyProgramSuggestion(tx, ctx, "keine-uuid")),
    ).rejects.toBeInstanceOf(SubsidyCaseValidationError);
  });

  it("F1308-DB-02: ohne Signale ehrlich no_basis; Anforderungs-Fallback; fremder Mandant unsichtbar", async () => {
    const lead = await asEditor(fixture, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Vorschlag leer", phone: "+49 171 4444444" }),
    );
    const empty = await asEditor(fixture, (tx, ctx) =>
      getSubsidyProgramSuggestion(tx, ctx, lead.projectId),
    );
    expect(empty.outcome).toBe("no_basis");
    expect(empty.program).toBeNull();

    // Snapshot-Branch schlägt, Anforderungs-Produkte ergänzen Gründe
    // (DB-Check verlangt Snapshot-Branch; Fallback trägt Produkte bei).
    await seedSnapshot(
      fixture,
      lead.projectId,
      {
        schemaVersion: "wmee-solar-snapshot.v1",
        calculatedAt: "2026-09-10T00:00:00.000Z",
        branch: "new_installation",
        questionnaireVariant: "short",
        resultIntegrity: "client_reported_unverified",
        inputs: {},
        provenance: { investment: "market_estimate" },
        result: { mode: "new_installation" },
      },
      {
        schemaVersion: "project-requirements.rechner.v1",
        source: "wmee-rechner-v3",
        branch: "existing_installation",
        requestedProducts: {
          targetStorageKwh: 5,
          wallbox: false,
          bidirectionalCharging: false,
          backupPower: false,
        },
      },
    );
    const fallback = await asEditor(fixture, (tx, ctx) =>
      getSubsidyProgramSuggestion(tx, ctx, lead.projectId),
    );
    expect(fallback.outcome).toBe("suggested");
    if (fallback.outcome !== "suggested") throw new Error("Fallback-Vorschlag erwartet");
    expect(fallback.program).toBe("kfw");
    expect(fallback.reasons.join(" ")).toMatch(/Speicherwunsch/u);

    // Fremder Mandant: kein Lesen fremder Snapshots → no_basis statt Leak.
    const foreign = await seedFixture("F13-08 fremd");
    const foreignView = await asEditor(foreign, (tx, ctx) =>
      getSubsidyProgramSuggestion(tx, ctx, lead.projectId),
    );
    expect(foreignView.outcome).toBe("no_basis");

  });
});
