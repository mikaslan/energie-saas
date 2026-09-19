import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn, type ServiceCtx } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { getRequestBoard } from "@/modules/boards";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  editorMembershipId: string;
  externalId: string;
  externalMembershipId: string;
  sourceId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const editorMembershipId = randomUUID();
  const externalId = randomUUID();
  const externalMembershipId = randomUUID();
  const sourceId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-21 Score')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f121.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${externalId}::uuid, ${`extern-${externalId}@f121.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${externalMembershipId}::uuid, ${workspaceId}::uuid, ${externalId}::uuid, 'editor', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into lead_source (id, workspace_id, name, name_normalized)
      values (${sourceId}::uuid, ${workspaceId}::uuid, 'F121 Messe', 'f121 messe')
    `);
  });
  return { workspaceId, editorId, editorMembershipId, externalId, externalMembershipId, sourceId };
}

// Minimal valides Profil-JSON (site_energy_profile_json_ck inkl.
// T4-Verschärfung: exakt die sieben Top-Level-Schlüssel, 1–4 Dächer,
// Version passend zur Spalte, Provenance-Quelle für consumption).
function minimalProfileJson(): string {
  return JSON.stringify({
    schemaVersion: "site-energy-profile.v1",
    inputMode: "consumption",
    building: {},
    roofs: [{}],
    consumption: {},
    existingAssets: {},
    provenance: { source: "rechner_snapshot" },
  });
}

function minimalRequirementsJson(): string {
  return JSON.stringify({
    schemaVersion: "project-requirements.rechner.v1",
    source: "wmee-rechner-v3",
    branch: "new_installation",
    requestedProducts: {
      targetStorageKwh: 8,
      wallbox: false,
      bidirectionalCharging: false,
      backupPower: false,
    },
  });
}

function minimalSnapshotJson(): string {
  return JSON.stringify({
    schemaVersion: "wmee-solar-snapshot.v1",
    calculatedAt: "2026-09-19T00:00:00.000Z",
    branch: "new_installation",
    questionnaireVariant: "short",
    resultIntegrity: "client_reported_unverified",
    inputs: {},
    provenance: { investment: "market_estimate" },
    result: { mode: "new_installation" },
  });
}

type CapsuleRow = {
  score_value: number;
  score_band: string;
  score_signals: string[];
  score_computed_at: Date | string;
};

describe("F1-21 Lead-Score-Vertiefung (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const run = <T>(fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn);

  const runExternal = <T>(fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.externalId, fx.workspaceId, fn);

  // Kapselaufruf MIT Editor-Actor: Im Testmodus greifen die
  // Actor-Restriktiv-Policies (TO PUBLIC, da app_runtime fehlt) auch für den
  // Funktions-Owner — ohne Actor wären Intent-Zeilen unsichtbar. Prod: Owner
  // außerhalb der TO-app_runtime-Policies, Worker-Kontext genügt.
  const recompute = async (fx: Fixture, projectId: string): Promise<CapsuleRow | null> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, async (tx) => {
      const result = await tx.execute<CapsuleRow>(sql`
        select * from public._f121_recompute_lead_score(
          ${fx.workspaceId}::uuid,
          ${projectId}::uuid
        )
      `);
      return result.rows[0] ?? null;
    });

  const enrichHotLead = async (fx: Fixture, projectId: string, siteId: string): Promise<void> => {
    await withTenantOn(testPool, fx.workspaceId, async (tx) => {
      await tx.execute(sql`
        update site set lat = 49.28, lng = 8.73
        where workspace_id = ${fx.workspaceId}::uuid and id = ${siteId}::uuid
      `);
      const profile = minimalProfileJson();
      const hash = createHash("sha256").update(profile, "utf8").digest("hex");
      await tx.execute(sql`
        insert into site_energy_profile (
          workspace_id, site_id, revision, schema_version, input_mode,
          source_kind, source_snapshot_id, source_project_id, address_revision,
          profile, profile_sha256, confirmed_profile_revision,
          confirmed_address_revision, confirmed_by, confirmed_at
        ) values (
          ${fx.workspaceId}::uuid, ${siteId}::uuid, 1,
          'site-energy-profile.v1', 'consumption', 'manual', null, null, 1,
          ${profile}::jsonb, decode(${hash}, 'hex'), 1, 1,
          ${fx.editorId}::uuid, now()
        )
      `);
      await tx.execute(sql`
        insert into project_assignment (workspace_id, project_id, membership_id, assignment_role)
        values (
          ${fx.workspaceId}::uuid, ${projectId}::uuid,
          ${fx.editorMembershipId}::uuid, 'key_account'
        )
      `);
    });
  };

  const seedRequirements = async (
    fx: Fixture,
    contactId: string,
    siteId: string,
    projectId: string,
  ): Promise<void> => {
    await withTenantOn(testPool, fx.workspaceId, async (tx) => {
      const receiptId = randomUUID();
      const snapshotId = randomUUID();
      await tx.execute(sql`
        insert into inbound_receipt (
          id, workspace_id, source_key, submission_id, contract_version, body_sha256,
          auth_key_id, signed_at, submitted_at, received_at, producer_application,
          producer_git_revision, producer_environment, calculator_engine, acquisition,
          privacy_purpose, privacy_legal_basis, privacy_notice_version, privacy_notice_url,
          contact_resolution, contact_id, site_id, project_id
        ) values (
          ${receiptId}::uuid, ${fx.workspaceId}::uuid, 'wmee-rechner-v3',
          ${randomUUID()}::uuid, 'rechner-intake.v1', decode(repeat('00', 32), 'hex'),
          'f121-red', now(), now(), now(), 'wmee-rechner-v3', ${"0".repeat(40)},
          'development', 'wmee-solar.v1', '{}'::jsonb, 'offer_request',
          'art_6_1_b_precontractual', 'f121', 'https://example.test/privacy', 'created',
          ${contactId}::uuid, ${siteId}::uuid, ${projectId}::uuid
        )
      `);
      await tx.execute(sql`
        insert into calculator_snapshot (
          id, workspace_id, receipt_id, project_id, schema_version, calculator_engine,
          result_integrity, investment_source, calculated_at, snapshot
        ) values (
          ${snapshotId}::uuid, ${fx.workspaceId}::uuid, ${receiptId}::uuid,
          ${projectId}::uuid, 'wmee-solar-snapshot.v1', 'wmee-solar.v1',
          'client_reported_unverified', 'market_estimate', now(), ${minimalSnapshotJson()}::jsonb
        )
      `);
      await tx.execute(sql`
        insert into project_requirement (
          id, workspace_id, project_id, revision, schema_version, source_snapshot_id, requirements
        ) values (
          ${randomUUID()}::uuid, ${fx.workspaceId}::uuid, ${projectId}::uuid,
          1, 'project-requirements.rechner.v1', ${snapshotId}::uuid, ${minimalRequirementsJson()}::jsonb
        )
      `);
    });
  };

  const seedPhoneLead = async (fx: Fixture, displayName: string) =>
    run(fx, (tx, ctx) =>
      createManualLead(tx, ctx, {
        scope: "residential",
        displayName,
        phone: "+49 171 1111111",
      }),
    );

  const seedAppointment = async (fx: Fixture, projectId: string): Promise<void> => {
    await run(fx, async (tx) => {
      const calendar = await tx.execute<{ id: string }>(sql`
        insert into calendar (workspace_id, name, calendar_type, created_by)
        values (${fx.workspaceId}::uuid, ${`F121 Kalender ${randomUUID()}`}, 'tenancy', ${fx.editorId}::uuid)
        returning id
      `);
      const calendarId = calendar.rows[0]?.id;
      if (!calendarId) throw new Error("Kalender-Fixture fehlt.");
      await tx.execute(sql`
        insert into project_appointment (
          id, workspace_id, project_id, title, start_at, end_at, all_day,
          appointment_type, revision, calendar_id, created_by
        ) values (
          ${randomUUID()}::uuid, ${fx.workspaceId}::uuid, ${projectId}::uuid, 'F121 Termin',
          now() - interval '1 hour', now() + interval '1 hour', false,
          'on_site', 1, ${calendarId}::uuid, ${fx.editorId}::uuid
        )
      `);
    });
  };

  const seedPortalView = async (fx: Fixture, projectId: string): Promise<void> => {
    await run(fx, async (tx) => {
      const invite = await tx.execute<{ id: string }>(sql`
        insert into portal_invite (
          id, workspace_id, project_id, token_hash, expires_at, created_by
        ) values (
          ${randomUUID()}::uuid, ${fx.workspaceId}::uuid, ${projectId}::uuid,
          ${randomBytes(32)}, now() + interval '7 days', ${fx.editorId}::uuid
        )
        returning id
      `);
      const inviteId = invite.rows[0]?.id;
      if (!inviteId) throw new Error("Portal-Invite-Fixture fehlt.");
      await tx.execute(sql`
        insert into portal_view_log (workspace_id, portal_invite_id)
        values (${fx.workspaceId}::uuid, ${inviteId}::uuid)
      `);
    });
  };

  const seedFileUpload = async (fx: Fixture, projectId: string): Promise<void> => {
    await run(fx, async (tx) => {
      const request = await tx.execute<{ id: string }>(sql`
        insert into file_request (workspace_id, project_id, title, created_by)
        values (${fx.workspaceId}::uuid, ${projectId}::uuid, 'F121 Datei', ${fx.editorId}::uuid)
        returning id
      `);
      const requestId = request.rows[0]?.id;
      if (!requestId) throw new Error("Datei-Anfrage-Fixture fehlt.");
      await tx.execute(sql`
        insert into file_request_upload (
          workspace_id, project_id, file_request_id, storage_key, file_sha256,
          content_type, byte_size, original_filename, uploaded_at
        ) values (
          ${fx.workspaceId}::uuid, ${projectId}::uuid, ${requestId}::uuid,
          ${`immutable/f121/${randomUUID()}.pdf`},
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          'application/pdf', 8, 'f121.pdf', now()
        )
      `);
    });
  };

  const cardsById = (board: Awaited<ReturnType<typeof getRequestBoard>>) => {
    const map = new Map<string, (typeof board.columns)[number]["cards"][number]>();
    for (const column of board.columns) {
      for (const card of column.cards) map.set(card.id, card);
    }
    return map;
  };

  it("F121-DB-01: Intent-OR — jede der 4 Quellen setzt das Signal (Kapsel)", async () => {
    // Termin-Quelle.
    const appointmentLead = await seedPhoneLead(fixture, "Intent Termin");
    const appointmentBase = await recompute(fixture, appointmentLead.projectId);
    expect(appointmentBase?.score_signals).toEqual(["phone"]);
    await seedAppointment(fixture, appointmentLead.projectId);
    const appointmentIntent = await recompute(fixture, appointmentLead.projectId);
    expect(appointmentIntent?.score_value).toBe((appointmentBase?.score_value ?? 0) + 10);
    expect(appointmentIntent?.score_signals).toContain("intent");

    // Portal-Quelle.
    const portalLead = await seedPhoneLead(fixture, "Intent Portal");
    await seedPortalView(fixture, portalLead.projectId);
    const portalIntent = await recompute(fixture, portalLead.projectId);
    expect(portalIntent?.score_value).toBe(20);
    expect(portalIntent?.score_signals).toEqual(["phone", "intent"]);

    // Datei-Upload-Quelle.
    const uploadLead = await seedPhoneLead(fixture, "Intent Upload");
    await seedFileUpload(fixture, uploadLead.projectId);
    const uploadIntent = await recompute(fixture, uploadLead.projectId);
    expect(uploadIntent?.score_value).toBe(20);
    expect(uploadIntent?.score_signals).toEqual(["phone", "intent"]);

    // Signatur-Quelle (voller Ausstellungs-Graph aus der Tenant-Fixture).
    const signatureProject = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tenantFixtures.signature_request(tx, fixture.workspaceId);
      const found = await tx.execute<{ project_id: string; id: string }>(sql`
        select project_id, id
          from signature_request
         where workspace_id = ${fixture.workspaceId}::uuid
         order by created_at desc, id desc
         limit 1
      `);
      const row = found.rows[0];
      if (!row) throw new Error("Signatur-Request-Fixture fehlt.");
      return { projectId: row.project_id, requestId: row.id };
    });
    const signatureBase = await recompute(fixture, signatureProject.projectId);
    expect(signatureBase?.score_signals).not.toContain("intent");
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into signature_view_log (workspace_id, signature_request_id)
        values (${fixture.workspaceId}::uuid, ${signatureProject.requestId}::uuid)
      `);
    });
    const signatureIntent = await recompute(fixture, signatureProject.projectId);
    expect(signatureIntent?.score_value).toBe((signatureBase?.score_value ?? 0) + 10);
    expect(signatureIntent?.score_signals).toContain("intent");
  });

  it("F121-DB-02: Clamp — 110 Rohpunkte werden 100 (Kapsel)", async () => {
    const lead = await run(fixture, (tx, ctx) =>
      createManualLead(tx, ctx, {
        scope: "residential",
        displayName: "Clamp Lead",
        email: "clamp@example.com",
        phone: "+49 171 2222222",
        postalCode: "69234",
        city: "Dielheim",
        leadSourceId: fixture.sourceId,
      }),
    );
    await enrichHotLead(fixture, lead.projectId, lead.siteId);
    await seedAppointment(fixture, lead.projectId);
    await seedRequirements(fixture, lead.contactId, lead.siteId, lead.projectId);
    const score = await recompute(fixture, lead.projectId);
    // 10+10+10+10+20+10+15+10+5+10 = 110 → Clamp 100, heiß.
    expect(score?.score_value).toBe(100);
    expect(score?.score_band).toBe("hot");
    expect(score?.score_signals).toHaveLength(10);
    expect(score?.score_signals).toContain("intent");
  });

  it("F121-DB-03: Kapsel-Idempotenz + fehlendes Projekt", async () => {
    const lead = await seedPhoneLead(fixture, "Idempotenz Lead");
    const first = await recompute(fixture, lead.projectId);
    const second = await recompute(fixture, lead.projectId);
    expect(first?.score_value).toBe(10);
    expect(second?.score_value).toBe(first?.score_value);
    expect(second?.score_band).toBe(first?.score_band);
    expect(second?.score_signals).toEqual(first?.score_signals);
    const stored = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const result = await tx.execute<{ lead_score_status: string; lead_score_computed_at: Date | string }>(sql`
        select lead_score_status, lead_score_computed_at
          from project
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${lead.projectId}::uuid
      `);
      return result.rows[0];
    });
    expect(stored?.lead_score_status).toBe("ready");
    // Drizzle liefert timestamptz als String — parsbar und frisch genügt.
    const computedAt = stored?.lead_score_computed_at;
    expect(computedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(String(computedAt)))).toBe(false);
    // Gelöschtes Projekt = stiller No-Op (keine Zeile, kein Wurf).
    await expect(recompute(fixture, randomUUID())).resolves.toBeNull();
  });

  it("F121-DB-04: Board-Stale-Regel — cold/fresh/backdate/pending", async () => {
    const lead = await seedPhoneLead(fixture, "Stale Lead");
    const cold = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential" }));
    const coldCard = cardsById(cold).get(lead.projectId);
    expect(coldCard?.score?.value).toBe(10);
    expect(coldCard?.score?.stale).toBe(true);
    expect(coldCard?.score?.computedAt).toBeNull();

    await recompute(fixture, lead.projectId);
    const fresh = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential" }));
    const freshCard = cardsById(fresh).get(lead.projectId);
    expect(freshCard?.score?.value).toBe(10);
    expect(freshCard?.score?.stale).toBe(false);
    expect(freshCard?.score?.computedAt).not.toBeNull();

    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        update project set lead_score_computed_at = now() - interval '16 minutes'
        where workspace_id = ${fixture.workspaceId}::uuid and id = ${lead.projectId}::uuid
      `);
    });
    const expired = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential" }));
    const expiredCard = cardsById(expired).get(lead.projectId);
    expect(expiredCard?.score?.value).toBe(10);
    expect(expiredCard?.score?.stale).toBe(true);

    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        update project
           set lead_score_status = 'pending',
               lead_score_computed_at = now()
        where workspace_id = ${fixture.workspaceId}::uuid and id = ${lead.projectId}::uuid
      `);
    });
    const pending = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential" }));
    expect(cardsById(pending).get(lead.projectId)?.score?.stale).toBe(true);
  });

  it("F121-DB-05: Extern-null — kein Score, keine Filter", async () => {
    const lead = await seedPhoneLead(fixture, "Extern Lead");
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into project_assignment (workspace_id, project_id, membership_id, assignment_role)
        values (
          ${fixture.workspaceId}::uuid, ${lead.projectId}::uuid,
          ${fixture.externalMembershipId}::uuid, 'user'
        )
      `);
    });
    const board = await runExternal(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential" }));
    const card = cardsById(board).get(lead.projectId);
    expect(card).toBeDefined();
    expect(card?.score).toBeNull();
    await expect(
      runExternal(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential", intentFilter: "active" })),
    ).rejects.toThrow("intent filter is not available for external readers");
    await expect(
      runExternal(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential", anspracheFilter: "ready" })),
    ).rejects.toThrow("ansprache filter is not available for external readers");
    await expect(
      runExternal(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential", lueckeFilter: "profile" })),
    ).rejects.toThrow("luecke filter is not available for external readers");
  });

  it("F121-DB-06: Presets intent/ansprache/luecke — einzeln, kombiniert, fail-closed", async () => {
    const plain = await seedPhoneLead(fixture, "Preset Blank");
    const active = await seedPhoneLead(fixture, "Preset Aktiv");
    await seedAppointment(fixture, active.projectId);
    const ready = await run(fixture, (tx, ctx) =>
      createManualLead(tx, ctx, {
        scope: "residential",
        displayName: "Preset Bereit",
        email: "bereit@example.com",
        phone: "+49 171 3333333",
        postalCode: "69234",
        city: "Dielheim",
        leadSourceId: fixture.sourceId,
      }),
    );
    await enrichHotLead(fixture, ready.projectId, ready.siteId);

    const board = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential" }));
    const cards = cardsById(board);
    // Live-Intent erscheint im angezeigten (stalen) Score.
    expect(cards.get(active.projectId)?.score?.signals).toContain("intent");
    expect(cards.get(plain.projectId)?.score?.signals).not.toContain("intent");
    expect(cards.get(ready.projectId)?.score?.band).toBe("hot");

    const intentOnly = await run(fixture, (tx, ctx) =>
      getRequestBoard(tx, ctx, { scope: "residential", intentFilter: "active" }),
    );
    expect(intentOnly.columns.flatMap((column) => column.cards.map((card) => card.id)).sort()).toEqual(
      [active.projectId].sort(),
    );

    const anspracheOnly = await run(fixture, (tx, ctx) =>
      getRequestBoard(tx, ctx, { scope: "residential", anspracheFilter: "ready" }),
    );
    expect(anspracheOnly.columns.flatMap((column) => column.cards.map((card) => card.id)).sort()).toEqual(
      [ready.projectId].sort(),
    );

    const lueckeOnly = await run(fixture, (tx, ctx) =>
      getRequestBoard(tx, ctx, { scope: "residential", lueckeFilter: "profile" }),
    );
    expect(lueckeOnly.columns.flatMap((column) => column.cards.map((card) => card.id)).sort()).toEqual(
      [plain.projectId, active.projectId].sort(),
    );

    const combined = await run(fixture, (tx, ctx) =>
      getRequestBoard(tx, ctx, { scope: "residential", intentFilter: "active", lueckeFilter: "profile" }),
    );
    expect(combined.columns.flatMap((column) => column.cards.map((card) => card.id))).toEqual(
      [active.projectId],
    );

    const empty = await run(fixture, (tx, ctx) =>
      getRequestBoard(tx, ctx, { scope: "residential", anspracheFilter: "ready", lueckeFilter: "profile" }),
    );
    expect(empty.columns.flatMap((column) => column.cards)).toHaveLength(0);

    await expect(
      run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential", intentFilter: "bogus" as never })),
    ).rejects.toThrow("unknown intent filter");
    await expect(
      run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential", anspracheFilter: "bogus" as never })),
    ).rejects.toThrow("unknown ansprache filter");
    await expect(
      run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential", lueckeFilter: "bogus" as never })),
    ).rejects.toThrow("unknown luecke filter");
  });
});
