import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { getDefaultRequestBoard } from "@/modules/boards";
import {
  PROJECT_ASSIGNMENT_COMMAND_VERSION,
  PROJECT_OUTCOME_COMMAND_VERSION,
  PROJECT_ASSIGNMENT_MAX_USERS,
  changeProjectAssignment,
  changeProjectOutcome,
  getProjectAssignmentContext,
  getProjectPageDetail,
  getProjectTriageDetail,
  ProjectAssignmentConflictError,
  ProjectAssignmentLimitError,
  ProjectAssignmentRoleError,
  ProjectAssignmentTargetError,
} from "@/modules/projects";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  projectId: string;
  unassignedProjectId: string;
  editorId: string;
  editorWithoutRightId: string;
  externalAId: string;
  externalBId: string;
  internalTargetId: string;
  editorMembershipId: string;
  externalAMembershipId: string;
  externalBMembershipId: string;
  internalTargetMembershipId: string;
  crossTenantMembershipId: string;
};

function postgresCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  if (typeof candidate.cause !== "object" || candidate.cause === null) return undefined;
  const cause = candidate.cause as { code?: unknown };
  return typeof cause.code === "string" ? cause.code : undefined;
}

function postgresConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { constraint?: unknown; cause?: unknown };
    if (typeof candidate.constraint === "string") return candidate.constraint;
    current = candidate.cause;
  }
  return undefined;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settlesWithin(work: Promise<unknown>, milliseconds = 60): Promise<boolean> {
  return Promise.race([
    work.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);
}

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const projectId = randomUUID();
  const unassignedProjectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const editorWithoutRightId = randomUUID();
  const externalAId = randomUUID();
  const externalBId = randomUUID();
  const internalTargetId = randomUUID();
  const crossTenantId = randomUUID();
  const editorMembershipId = randomUUID();
  const editorWithoutRightMembershipId = randomUUID();
  const externalAMembershipId = randomUUID();
  const externalBMembershipId = randomUUID();
  const internalTargetMembershipId = randomUUID();
  const crossTenantMembershipId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${workspaceId}::uuid, 'M1-09 Assignment')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@m109.test`}),
        (${editorWithoutRightId}::uuid, ${`limited-${editorWithoutRightId}@m109.test`}),
        (${externalAId}::uuid, ${`external-a-${externalAId}@m109.test`}),
        (${externalBId}::uuid, ${`external-b-${externalBId}@m109.test`}),
        (${internalTargetId}::uuid, ${`target-${internalTargetId}@m109.test`}),
        (${crossTenantId}::uuid, ${`cross-${crossTenantId}@m109.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
          'editor', '{"assign_projects": true}'::jsonb),
        (${editorWithoutRightMembershipId}::uuid, ${workspaceId}::uuid,
          ${editorWithoutRightId}::uuid, 'editor', '{}'::jsonb),
        (${externalAMembershipId}::uuid, ${workspaceId}::uuid, ${externalAId}::uuid,
          'viewer', '{"external_only": true}'::jsonb),
        (${externalBMembershipId}::uuid, ${workspaceId}::uuid, ${externalBId}::uuid,
          'viewer', '{"external_only": true}'::jsonb),
        (${internalTargetMembershipId}::uuid, ${workspaceId}::uuid,
          ${internalTargetId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized,
        phone_raw, phone_e164
      ) values (
        ${contactId}::uuid, ${workspaceId}::uuid, 'Kundin M1-09', 'Fixture', 'Contact',
        'kundin@m109.test', 'kundin@m109.test', '+49 30 123456', '+4930123456'
      )
    `);
    await tx.execute(sql`
      insert into site (
        id, workspace_id, contact_id, label, formatted_address,
        address_fingerprint, address_fingerprint_version, address_mode,
        street, house_number, postal_code, city, country, lat, lng,
        geocode_source, geocode_precision, address_follow_up_required
      ) values (
        ${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'Projektstandort',
        'Testweg 9, 10115 Berlin', decode(repeat('39', 32), 'hex'), 1, 'selected',
        'Testweg', '9', '10115', 'Berlin', 'DE', 52.5201, 13.4051,
        'photon', 'house', false
      )
    `);
    const projects = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select project_seed.id, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake.id, project_seed.name, 'manual'
      from (
        values
          (${projectId}::uuid, 'Zugewiesene Testanfrage'::text),
          (${unassignedProjectId}::uuid, 'Unzugewiesene Testanfrage'::text)
      ) as project_seed(id, name)
      join kanban_board board
        on board.workspace_id = ${workspaceId}::uuid
       and board.scope = 'residential'
       and board.is_default = true
       and board.archived_at is null
      join kanban_column intake
        on intake.workspace_id = board.workspace_id
       and intake.board_id = board.id
       and intake.is_intake = true
       and intake.archived_at is null
      returning id
    `);
    if (projects.rows.length !== 2) throw new Error("M1-09 projects were not seeded");
  });

  await withTenantOn(testPool, otherWorkspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${otherWorkspaceId}::uuid, 'M1-09 Other Tenant')
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${crossTenantMembershipId}::uuid, ${otherWorkspaceId}::uuid,
        ${crossTenantId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });

  return {
    workspaceId,
    otherWorkspaceId,
    projectId,
    unassignedProjectId,
    editorId,
    editorWithoutRightId,
    externalAId,
    externalBId,
    internalTargetId,
    editorMembershipId,
    externalAMembershipId,
    externalBMembershipId,
    internalTargetMembershipId,
    crossTenantMembershipId,
  };
}

function command(
  kind: "set_key_account" | "add_user" | "remove_user",
  fixture: Fixture,
  membershipId: string,
  expectedAssignmentRevision: number,
) {
  return {
    schemaVersion: PROJECT_ASSIGNMENT_COMMAND_VERSION,
    kind,
    projectId: fixture.projectId,
    membershipId,
    expectedAssignmentRevision,
  } as const;
}

describe("M1-09 Assignment-Service und External-Sicht", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("startet ehrlich unzugewiesen und sucht nur Memberships im Actor-Workspace", async () => {
    const context = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getProjectAssignmentContext(tx, ctx, fixture.projectId, {
        query: "target-",
      }),
    );

    expect(context).toMatchObject({
      projectId: fixture.projectId,
      assignmentRevision: 0,
      keyAccount: null,
      users: [],
      canAssign: true,
    });
    if (context === null) throw new Error("M1-09 assignment context is missing");
    expect(context.searchResults).toHaveLength(1);
    expect(context.searchResults[0]).toMatchObject({
      membershipId: fixture.internalTargetMembershipId,
      alreadyAssigned: false,
    });
    expect(JSON.stringify(context)).not.toContain(fixture.crossTenantMembershipId);
  });

  it("setzt und wechselt den Key Account atomar, idempotent und PII-frei", async () => {
    const first = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("set_key_account", fixture, fixture.internalTargetMembershipId, 0),
      ),
    );
    expect(first).toEqual({
      projectId: fixture.projectId,
      assignmentRevision: 1,
      changed: true,
    });

    const replay = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("set_key_account", fixture, fixture.internalTargetMembershipId, 1),
      ),
    );
    expect(replay).toEqual({
      projectId: fixture.projectId,
      assignmentRevision: 1,
      changed: false,
    });

    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("set_key_account", fixture, fixture.externalAMembershipId, 1),
      ),
    );
    const context = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => getProjectAssignmentContext(tx, ctx, fixture.projectId),
    );
    if (context === null) throw new Error("M1-09 assignment context is missing");
    expect(context.assignmentRevision).toBe(2);
    expect(context.keyAccount?.membershipId).toBe(fixture.externalAMembershipId);
    expect(context.users.map(({ membershipId }) => membershipId)).toContain(
      fixture.internalTargetMembershipId,
    );

    const proof = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      events: number;
      audits: number;
      evidence: string;
      [key: string]: unknown;
    }>(sql`
      select
        (select count(*)::int from domain_events
          where aggregate_id = ${fixture.projectId}::uuid
            and event_type = 'project.assignment_key_account_changed') as events,
        (select count(*)::int from audit_log
          where details->>'projectId' = ${fixture.projectId}
            and action = 'project.assign' and allowed = true) as audits,
        concat(
          coalesce((select string_agg(payload::text, '') from domain_events
            where aggregate_id = ${fixture.projectId}::uuid), ''),
          coalesce((select string_agg(details::text, '') from audit_log
            where details->>'projectId' = ${fixture.projectId}), '')
        ) as evidence
    `));
    expect(proof.rows[0].events).toBe(2);
    expect(proof.rows[0].audits).toBe(2);
    expect(proof.rows[0].evidence).not.toContain("@m109.test");
    expect(proof.rows[0].evidence).not.toContain("Kundin M1-09");
  });

  it("liefert External nur die direkt zugewiesene offene Anfrage und sperrt Mutationen", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("set_key_account", fixture, fixture.externalAMembershipId, 0),
      ),
    );

    const [assignedBoard, unassignedBoard, assignedDetail, hiddenDetail, internalBoard] = await Promise.all([
      withAuthorizedTenantOn(testPool, fixture.externalAId, fixture.workspaceId, (tx, ctx) =>
        getDefaultRequestBoard(tx, ctx)),
      withAuthorizedTenantOn(testPool, fixture.externalBId, fixture.workspaceId, (tx, ctx) =>
        getDefaultRequestBoard(tx, ctx)),
      withAuthorizedTenantOn(testPool, fixture.externalAId, fixture.workspaceId, (tx, ctx) =>
        getProjectPageDetail(tx, ctx, fixture.projectId)),
      withAuthorizedTenantOn(testPool, fixture.externalBId, fixture.workspaceId, (tx, ctx) =>
        getProjectPageDetail(tx, ctx, fixture.projectId)),
      withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
        getDefaultRequestBoard(tx, ctx)),
    ]);

    expect(assignedBoard.audience).toBe("assigned_external");
    const assignedCards = assignedBoard.columns.flatMap(({ cards }) => cards);
    expect(assignedCards.map(({ id }) => id)).toEqual([fixture.projectId]);
    expect(assignedCards[0]).toMatchObject({
      sourceLabel: "Zugewiesene Anfrage",
      assignment: null,
    });
    expect(assignedBoard.permissions).toEqual({ canMoveCards: false, canOpenCatalog: false });
    expect(unassignedBoard.columns.flatMap(({ cards }) => cards)).toHaveLength(0);
    if (assignedDetail?.audience !== "assigned_external") {
      throw new Error("M1-09 external detail is missing");
    }
    expect(Object.keys(assignedDetail.record).sort()).toEqual([
      "blockers",
      "contact",
      "project",
      "requirements",
      "site",
    ]);
    expect(Object.keys(assignedDetail.record.project).sort()).toEqual([
      "columnName",
      "createdAt",
      "id",
      "name",
      "outcome",
      "phase",
    ]);
    expect(Object.keys(assignedDetail.record.contact).sort()).toEqual([
      "displayName",
      "email",
      "phone",
    ]);
    expect(Object.keys(assignedDetail.record.site)).toEqual(["formattedAddress"]);
    expect(Object.keys(assignedDetail.record.requirements).sort()).toEqual([
      "backupPower",
      "bidirectionalCharging",
      "branch",
      "productGroupLabel",
      "targetStorageKwh",
      "wallbox",
    ]);
    expect(Object.keys(assignedDetail.record.blockers).sort()).toEqual([
      "addressFollowUpRequired",
      "catalogResolutionPending",
      "dedupeReviewRequired",
      "pinConfirmationRequired",
    ]);
    expect(assignedDetail.record.requirements.productGroupLabel).toBe("Photovoltaik");
    expect(hiddenDetail).toBeNull();
    const internalCard = internalBoard.columns
      .flatMap(({ cards }) => cards)
      .find(({ id }) => id === fixture.projectId);
    expect(internalCard?.assignment).toEqual({
      assignmentRevision: 1,
      keyAccountLabel: `external-a-${fixture.externalAId}@m109.test`,
    });

    const serialized = JSON.stringify(assignedDetail);
    for (const forbidden of [
      "latitude",
      "longitude",
      "calculatorEstimate",
      "assignmentRevision",
      "searchResults",
      "producerRevision",
    ]) expect(serialized).not.toContain(forbidden);
    const serializedBoard = JSON.stringify(assignedBoard);
    for (const forbidden of [
      "assignmentRevision",
      "keyAccountLabel",
      fixture.externalAMembershipId,
      fixture.internalTargetMembershipId,
      `external-a-${fixture.externalAId}@m109.test`,
      `target-${fixture.internalTargetId}@m109.test`,
      "52.5201",
      "13.4051",
      "photon",
    ]) expect(serializedBoard).not.toContain(forbidden);

    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.externalAId,
      fixture.workspaceId,
      (tx, ctx) => getProjectTriageDetail(tx, ctx, fixture.projectId),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.externalAId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("add_user", fixture, fixture.externalBMembershipId, 1),
      ),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("lässt internen Lesern den Stand, führt die Membership-Suche aber nur mit project.assign aus", async () => {
    const readOnly = await withAuthorizedTenantOn(
      testPool,
      fixture.editorWithoutRightId,
      fixture.workspaceId,
      (tx, ctx) => getProjectAssignmentContext(tx, ctx, fixture.projectId),
    );
    expect(readOnly).toMatchObject({
      projectId: fixture.projectId,
      assignmentRevision: 0,
      keyAccount: null,
      users: [],
      canAssign: false,
      searchResults: [],
    });

    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorWithoutRightId,
      fixture.workspaceId,
      (tx, ctx) => getProjectAssignmentContext(tx, ctx, fixture.projectId, {
        query: "external",
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("entzieht die External-Sicht sowohl nach Phasenwechsel als auch nach Abschluss", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("add_user", fixture, fixture.externalAMembershipId, 0),
      ),
    );

    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      update project
         set phase = 'offer'
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${fixture.projectId}::uuid
    `));
    const [offerBoard, offerDetail] = await Promise.all([
      withAuthorizedTenantOn(testPool, fixture.externalAId, fixture.workspaceId, (tx, ctx) =>
        getDefaultRequestBoard(tx, ctx)),
      withAuthorizedTenantOn(testPool, fixture.externalAId, fixture.workspaceId, (tx, ctx) =>
        getProjectPageDetail(tx, ctx, fixture.projectId)),
    ]);
    expect(offerBoard.columns.flatMap(({ cards }) => cards)).toHaveLength(0);
    expect(offerDetail).toBeNull();

    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      update project
         set phase = 'request'
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${fixture.projectId}::uuid
    `));
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectOutcome(tx, ctx, {
        schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
        kind: "mark_won",
        projectId: fixture.projectId,
        expectedOutcomeRevision: 0,
        confirmation: "mark_won",
      }),
    );
    const [closedBoard, closedDetail] = await Promise.all([
      withAuthorizedTenantOn(testPool, fixture.externalAId, fixture.workspaceId, (tx, ctx) =>
        getDefaultRequestBoard(tx, ctx)),
      withAuthorizedTenantOn(testPool, fixture.externalAId, fixture.workspaceId, (tx, ctx) =>
        getProjectPageDetail(tx, ctx, fixture.projectId)),
    ]);
    expect(closedBoard.columns.flatMap(({ cards }) => cards)).toHaveLength(0);
    expect(closedDetail).toBeNull();
  });

  it("entzieht External nach explizitem Clear und Remove ab der nächsten Transaktion", async () => {
    await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
      changeProjectAssignment(
        tx,
        ctx,
        command("set_key_account", fixture, fixture.externalAMembershipId, 0),
      ));
    await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
      changeProjectAssignment(tx, ctx, {
        schemaVersion: PROJECT_ASSIGNMENT_COMMAND_VERSION,
        kind: "clear_key_account",
        projectId: fixture.projectId,
        expectedAssignmentRevision: 1,
      }));
    await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
      changeProjectAssignment(
        tx,
        ctx,
        command("remove_user", fixture, fixture.externalAMembershipId, 2),
      ));

    const [detail, board] = await Promise.all([
      withAuthorizedTenantOn(testPool, fixture.externalAId, fixture.workspaceId, (tx, ctx) =>
        getProjectPageDetail(tx, ctx, fixture.projectId)),
      withAuthorizedTenantOn(testPool, fixture.externalAId, fixture.workspaceId, (tx, ctx) =>
        getDefaultRequestBoard(tx, ctx)),
    ]);
    expect(detail).toBeNull();
    expect(board.columns.flatMap(({ cards }) => cards)).toHaveLength(0);
  });

  it("weist fehlendes Recht, Cross-Tenant-Ziele, KAM-Remove und stale Revisionen ohne Teilstand ab", async () => {
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorWithoutRightId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("add_user", fixture, fixture.internalTargetMembershipId, 0),
      ),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("add_user", fixture, fixture.crossTenantMembershipId, 0),
      ),
    )).rejects.toBeInstanceOf(ProjectAssignmentTargetError);

    await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
      changeProjectAssignment(
        tx,
        ctx,
        command("set_key_account", fixture, fixture.internalTargetMembershipId, 0),
      ));
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("remove_user", fixture, fixture.internalTargetMembershipId, 1),
      ),
    )).rejects.toBeInstanceOf(ProjectAssignmentRoleError);
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("add_user", fixture, fixture.externalAMembershipId, 0),
      ),
    )).rejects.toBeInstanceOf(ProjectAssignmentConflictError);

    const state = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      assignment_revision: number;
      assignments: number;
      [key: string]: unknown;
    }>(sql`
      select p.assignment_revision,
        (select count(*)::int from project_assignment a
          where a.project_id = p.id) as assignments
      from project p where p.id = ${fixture.projectId}::uuid
    `));
    expect(state.rows[0]).toEqual({ assignment_revision: 1, assignments: 1 });
  });

  it("erlaubt exakt 50 direkte Memberships und hält den 51. Versuch vollständig ohne Teilstand", async () => {
    const candidates = Array.from({ length: PROJECT_ASSIGNMENT_MAX_USERS + 1 }, (_, index) => ({
      userId: randomUUID(),
      membershipId: randomUUID(),
      email: `limit-${index}-${randomUUID()}@m109.test`,
    }));

    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values ${sql.join(
          candidates.map((candidate) => sql`(${candidate.userId}::uuid, ${candidate.email})`),
          sql`, `,
        )}
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values ${sql.join(
          candidates.map((candidate) => sql`(
            ${candidate.membershipId}::uuid,
            ${fixture.workspaceId}::uuid,
            ${candidate.userId}::uuid,
            'viewer',
            '{}'::jsonb
          )`),
          sql`, `,
        )}
      `);
      await tx.execute(sql`
        insert into project_assignment (
          workspace_id, project_id, membership_id, assignment_role
        )
        values ${sql.join(
          candidates.slice(0, PROJECT_ASSIGNMENT_MAX_USERS - 1).map((candidate) => sql`(
            ${fixture.workspaceId}::uuid,
            ${fixture.projectId}::uuid,
            ${candidate.membershipId}::uuid,
            'user'
          )`),
          sql`, `,
        )}
      `);
      await tx.execute(sql`
        update project
           set assignment_revision = ${PROJECT_ASSIGNMENT_MAX_USERS - 1}
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.projectId}::uuid
      `);
    });

    const fiftieth = candidates[PROJECT_ASSIGNMENT_MAX_USERS - 1];
    const accepted = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command(
          "add_user",
          fixture,
          fiftieth.membershipId,
          PROJECT_ASSIGNMENT_MAX_USERS - 1,
        ),
      ),
    );
    expect(accepted).toMatchObject({
      assignmentRevision: PROJECT_ASSIGNMENT_MAX_USERS,
      changed: true,
    });

    const fiftyFirst = candidates[PROJECT_ASSIGNMENT_MAX_USERS];
    await expect(withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command(
          "add_user",
          fixture,
          fiftyFirst.membershipId,
          PROJECT_ASSIGNMENT_MAX_USERS,
        ),
      ),
    )).rejects.toBeInstanceOf(ProjectAssignmentLimitError);

    const state = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      assignment_revision: number;
      assignments: number;
      events: number;
      audits: number;
      [key: string]: unknown;
    }>(sql`
      select p.assignment_revision,
        (select count(*)::int from project_assignment assignment_record
          where assignment_record.project_id = p.id) as assignments,
        (select count(*)::int from domain_events event_record
          where event_record.aggregate_id = p.id
            and event_record.event_type = 'project.assignment_user_added') as events,
        (select count(*)::int from audit_log audit_record
          where audit_record.details->>'projectId' = p.id::text
            and audit_record.action = 'project.assign'
            and audit_record.allowed = true) as audits
      from project p
      where p.workspace_id = ${fixture.workspaceId}::uuid
        and p.id = ${fixture.projectId}::uuid
    `));
    expect(state.rows[0]).toEqual({
      assignment_revision: PROJECT_ASSIGNMENT_MAX_USERS,
      assignments: PROJECT_ASSIGNMENT_MAX_USERS,
      events: 1,
      audits: 1,
    });
  });

  it("kaskadiert Project-Erasure auf Assignments und gibt die Membership danach frei", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("add_user", fixture, fixture.internalTargetMembershipId, 0),
      ),
    );

    const proof = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        delete from project
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.projectId}::uuid
      `);
      const assignments = await tx.execute<{ count: number; [key: string]: unknown }>(sql`
        select count(*)::int as count
          from project_assignment
         where project_id = ${fixture.projectId}::uuid
      `);
      const membership = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
        delete from membership
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.internalTargetMembershipId}::uuid
        returning id
      `);
      return { assignments: assignments.rows[0].count, deleted: membership.rows.length };
    });
    expect(proof).toEqual({ assignments: 0, deleted: 1 });
  });

  it("serialisiert konkurrierende Commands und blockiert Membership-Löschung", async () => {
    const attempts = await Promise.allSettled([
      withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
        changeProjectAssignment(
          tx,
          ctx,
          command("set_key_account", fixture, fixture.externalAMembershipId, 0),
        )),
      withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
        changeProjectAssignment(
          tx,
          ctx,
          command("set_key_account", fixture, fixture.internalTargetMembershipId, 0),
        )),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejection = attempts.find(({ status }) => status === "rejected");
    expect(rejection?.status === "rejected" ? rejection.reason : null)
      .toBeInstanceOf(ProjectAssignmentConflictError);

    const winner = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      membership_id: string;
      assignment_revision: number;
      [key: string]: unknown;
    }>(sql`
      select a.membership_id, p.assignment_revision
      from project p
      join project_assignment a
        on a.workspace_id = p.workspace_id and a.project_id = p.id
      where p.id = ${fixture.projectId}::uuid
        and a.assignment_role = 'key_account'
    `));
    expect(winner.rows).toHaveLength(1);
    expect(winner.rows[0].assignment_revision).toBe(1);

    let deletionError: unknown;
    try {
      await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
        delete from membership
        where id = ${winner.rows[0].membership_id}::uuid
      `));
    } catch (error) {
      deletionError = error;
    }
    expect(["23001", "23503"]).toContain(postgresCode(deletionError));
  });

  it("liefert Assignment-Kontext und Project-Existenz als ungeteilten Snapshot", async () => {
    const contextLoaded = deferred();
    const allowContextCommit = deferred();
    const contextRead = withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      async (tx, ctx) => {
        const context = await getProjectAssignmentContext(tx, ctx, fixture.projectId, {
          query: "external-a",
        });
        contextLoaded.resolve();
        await allowContextCommit.promise;
        return context;
      },
    );
    await contextLoaded.promise;

    const blockedMutation = withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("add_user", fixture, fixture.externalAMembershipId, 0),
      ),
    );
    try {
      expect(await settlesWithin(blockedMutation)).toBe(false);
    } finally {
      allowContextCommit.resolve();
    }
    await expect(contextRead).resolves.toMatchObject({
      assignmentRevision: 0,
      keyAccount: null,
      users: [],
      searchResults: [{
        membershipId: fixture.externalAMembershipId,
        alreadyAssigned: false,
        assignmentRole: null,
      }],
    });
    await expect(blockedMutation).resolves.toMatchObject({
      assignmentRevision: 1,
      changed: true,
    });

    const deletionContextLoaded = deferred();
    const allowDeletionContextCommit = deferred();
    const deletionContextRead = withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      async (tx, ctx) => {
        const context = await getProjectAssignmentContext(
          tx,
          ctx,
          fixture.unassignedProjectId,
        );
        deletionContextLoaded.resolve();
        await allowDeletionContextCommit.promise;
        return context;
      },
    );
    await deletionContextLoaded.promise;

    const blockedProjectDelete = withTenantOn(
      testPool,
      fixture.workspaceId,
      (tx) => tx.execute(sql`
        delete from project
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.unassignedProjectId}::uuid
        returning id
      `),
    );
    try {
      expect(await settlesWithin(blockedProjectDelete)).toBe(false);
    } finally {
      allowDeletionContextCommit.resolve();
    }
    await expect(deletionContextRead).resolves.toMatchObject({
      projectId: fixture.unassignedProjectId,
      assignmentRevision: 0,
      users: [],
    });
    await expect(blockedProjectDelete).resolves.toMatchObject({ rowCount: 1 });
  });

  it("serialisiert Zuweisung und Membership-Offboarding in beiden Commit-Reihenfolgen", async () => {
    const assignmentInserted = deferred();
    const allowAssignmentCommit = deferred();
    const assignmentWins = withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      async (tx, ctx) => {
        const result = await changeProjectAssignment(
          tx,
          ctx,
          command("add_user", fixture, fixture.externalAMembershipId, 0),
        );
        assignmentInserted.resolve();
        await allowAssignmentCommit.promise;
        return result;
      },
    );
    await assignmentInserted.promise;

    const blockedDeletion = withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      delete from membership
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${fixture.externalAMembershipId}::uuid
    `));
    try {
      expect(await settlesWithin(blockedDeletion)).toBe(false);
    } finally {
      allowAssignmentCommit.resolve();
    }
    await expect(assignmentWins).resolves.toMatchObject({
      assignmentRevision: 1,
      changed: true,
    });
    const deletionFailure = await blockedDeletion.then(
      () => null,
      (error: unknown) => error,
    );
    expect(["23001", "23503"]).toContain(postgresCode(deletionFailure));
    expect(postgresConstraint(deletionFailure)).toBe("project_assignment_membership_fk");

    const deletionApplied = deferred();
    const allowDeletionCommit = deferred();
    const deletionWins = withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const result = await tx.execute(sql`
        delete from membership
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.externalBMembershipId}::uuid
      `);
      deletionApplied.resolve();
      await allowDeletionCommit.promise;
      return result;
    });
    await deletionApplied.promise;

    const blockedAssignment = withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("add_user", fixture, fixture.externalBMembershipId, 1),
      ),
    );
    try {
      expect(await settlesWithin(blockedAssignment)).toBe(false);
    } finally {
      allowDeletionCommit.resolve();
    }
    await expect(deletionWins).resolves.toMatchObject({ rowCount: 1 });
    await expect(blockedAssignment).rejects.toBeInstanceOf(ProjectAssignmentTargetError);

    const state = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      assignment_revision: number;
      assignments: number;
      events: number;
      audits: number;
      [key: string]: unknown;
    }>(sql`
      select p.assignment_revision,
        (select count(*)::int from project_assignment assignment_record
          where assignment_record.project_id = p.id) as assignments,
        (select count(*)::int from domain_events event_record
          where event_record.aggregate_id = p.id
            and event_record.event_type = 'project.assignment_user_added') as events,
        (select count(*)::int from audit_log audit_record
          where audit_record.details->>'projectId' = p.id::text
            and audit_record.action = 'project.assign'
            and audit_record.allowed = true) as audits
      from project p
      where p.workspace_id = ${fixture.workspaceId}::uuid
        and p.id = ${fixture.projectId}::uuid
    `));
    expect(state.rows[0]).toEqual({
      assignment_revision: 1,
      assignments: 1,
      events: 1,
      audits: 1,
    });
  });

  it("serialisiert Key-Account-Clear und Offboarding ohne Deadlock in beiden Lock-Reihenfolgen", async () => {
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("set_key_account", fixture, fixture.externalAMembershipId, 0),
      ),
    );

    const clearApplied = deferred();
    const allowClearCommit = deferred();
    const clearWins = withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      async (tx, ctx) => {
        const result = await changeProjectAssignment(tx, ctx, {
          schemaVersion: PROJECT_ASSIGNMENT_COMMAND_VERSION,
          kind: "clear_key_account",
          projectId: fixture.projectId,
          expectedAssignmentRevision: 1,
        });
        clearApplied.resolve();
        await allowClearCommit.promise;
        return result;
      },
    );
    await clearApplied.promise;

    const deletionAfterClear = withTenantOn(
      testPool,
      fixture.workspaceId,
      (tx) => tx.execute(sql`
        delete from membership
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.externalAMembershipId}::uuid
        returning id
      `),
    );
    try {
      expect(await settlesWithin(deletionAfterClear)).toBe(false);
    } finally {
      allowClearCommit.resolve();
    }
    await expect(clearWins).resolves.toMatchObject({
      assignmentRevision: 2,
      changed: true,
    });
    const deletionAfterClearFailure = await deletionAfterClear.then(
      () => null,
      (error: unknown) => error,
    );
    expect(["23001", "23503"]).toContain(postgresCode(deletionAfterClearFailure));
    expect(postgresConstraint(deletionAfterClearFailure))
      .toBe("project_assignment_membership_fk");

    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(
        tx,
        ctx,
        command("set_key_account", fixture, fixture.externalBMembershipId, 2),
      ),
    );

    const workspaceLockedForOffboarding = deferred();
    const allowOffboardingDelete = deferred();
    const offboardingStartsFirst = withTenantOn(
      testPool,
      fixture.workspaceId,
      async (tx) => {
        await tx.execute(sql`
          select id
            from workspace
           where id = ${fixture.workspaceId}::uuid
           for update
        `);
        workspaceLockedForOffboarding.resolve();
        await allowOffboardingDelete.promise;
        return tx.execute(sql`
          delete from membership
           where workspace_id = ${fixture.workspaceId}::uuid
             and id = ${fixture.externalBMembershipId}::uuid
          returning id
        `);
      },
    );
    await workspaceLockedForOffboarding.promise;

    const blockedClear = withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => changeProjectAssignment(tx, ctx, {
        schemaVersion: PROJECT_ASSIGNMENT_COMMAND_VERSION,
        kind: "clear_key_account",
        projectId: fixture.projectId,
        expectedAssignmentRevision: 3,
      }),
    );
    try {
      expect(await settlesWithin(blockedClear)).toBe(false);
    } finally {
      allowOffboardingDelete.resolve();
    }
    const deletionFailure = await offboardingStartsFirst.then(
      () => null,
      (error: unknown) => error,
    );
    expect(["23001", "23503"]).toContain(postgresCode(deletionFailure));
    expect(postgresConstraint(deletionFailure)).toBe("project_assignment_membership_fk");
    await expect(blockedClear).resolves.toMatchObject({
      assignmentRevision: 4,
      changed: true,
    });

    const state = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      assignment_revision: number;
      key_accounts: number;
      users: number;
      [key: string]: unknown;
    }>(sql`
      select p.assignment_revision,
             count(*) filter (where a.assignment_role = 'key_account')::int as key_accounts,
             count(*) filter (where a.assignment_role = 'user')::int as users
        from project p
        left join project_assignment a
          on a.workspace_id = p.workspace_id
         and a.project_id = p.id
       where p.workspace_id = ${fixture.workspaceId}::uuid
         and p.id = ${fixture.projectId}::uuid
       group by p.assignment_revision
    `));
    expect(state.rows[0]).toEqual({
      assignment_revision: 4,
      key_accounts: 0,
      users: 2,
    });
  });
});
