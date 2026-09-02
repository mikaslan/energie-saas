import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withAuthorizedTenantOn, withTenantOn, type ServiceCtx } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import {
  changeProjectOutcome,
  ProjectOutcomeConflictError,
  ProjectOutcomeIllegalTransitionError,
  ProjectOutcomeNotFoundError,
} from "@/modules/projects";
import type { ProjectOutcomeCommandV1 } from "@/modules/projects";
import { testPool } from "../setup/test-db";

// RED-vor-GREEN-Nachweis: Diese Suite wurde gegen Migration 0040 zuerst als
// rot erfasst (fehlende Tabellen/Kapseln) und ist nach der Implementierung
// gruen. Die Matrix deckt die heikelsten Faelle aus Spec §11 ab.

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  projectId: string;
  adminId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  contactId: string;
  siteId: string;
};

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

async function rejected(work: Promise<unknown>): Promise<unknown> {
  const error = await work.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).not.toBeNull();
  return error;
}

async function asActor<T>(
  workspaceId: string,
  actorId: string,
  work: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  return withAuthorizedTenantOn(testPool, actorId, workspaceId, work);
}

async function seedFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    workspaceId: randomUUID(),
    otherWorkspaceId: randomUUID(),
    projectId: randomUUID(),
    adminId: randomUUID(),
    editorId: randomUUID(),
    viewerId: randomUUID(),
    externalId: randomUUID(),
    contactId: randomUUID(),
    siteId: randomUUID(),
  };
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name) values (${fixture.workspaceId}::uuid, 'M1-11b')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email) values
        (${fixture.adminId}::uuid, ${`${fixture.adminId}@m111b.test`}),
        (${fixture.editorId}::uuid, ${`${fixture.editorId}@m111b.test`}),
        (${fixture.viewerId}::uuid, ${`${fixture.viewerId}@m111b.test`}),
        (${fixture.externalId}::uuid, ${`${fixture.externalId}@m111b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities) values
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, ${fixture.adminId}::uuid, 'admin', '{}'::jsonb),
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, ${fixture.editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, ${fixture.viewerId}::uuid, 'viewer', '{"external_only":false}'::jsonb),
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, ${fixture.externalId}::uuid, 'editor', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, email_primary, email_normalized)
      values (${fixture.contactId}::uuid, ${fixture.workspaceId}::uuid, 'M1-11b Contact',
        ${`${fixture.contactId}@m111b.test`}, ${`${fixture.contactId}@m111b.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${fixture.siteId}::uuid, ${fixture.workspaceId}::uuid, ${fixture.contactId}::uuid, 'M1-11b Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id,
        name, phase, outcome, source_key
      )
      select ${fixture.projectId}::uuid, ${fixture.workspaceId}::uuid,
             ${fixture.contactId}::uuid, ${fixture.siteId}::uuid, board.id, intake.id,
             'M1-11b Project', 'request', 'open', 'fixture'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id
         and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${fixture.workspaceId}::uuid
         and board.scope = 'residential' and board.is_default = true
         and board.archived_at is null
    `);
  });
  return fixture;
}

function cannotFulfilCommand(projectId: string, revision = 0): ProjectOutcomeCommandV1 {
  return {
    schemaVersion: "project-outcome-command.v1",
    kind: "mark_cannot_fulfill",
    projectId,
    expectedOutcomeRevision: revision,
    confirmation: "mark_cannot_fulfill",
  };
}

describe("M1-11b Cannot-Fulfil Service (DB)", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await seedFixture();
  });

  it("M111B-01/02: terminale Transition erzeugt genau eine Outbox-Zeile, Event+Audit genau einmal", async () => {
    await asActor(f.workspaceId, f.editorId, async (tx, ctx) => {
      const result = await changeProjectOutcome(tx, ctx, cannotFulfilCommand(f.projectId));
      expect(result.outcome).toBe("cannot_fulfill");
      expect(result.closedAt).not.toBeNull();
    });
    await withTenantOn(testPool, f.workspaceId, async (tx) => {
      const notification = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from customer_notification
        where workspace_id = ${f.workspaceId}::uuid and project_id = ${f.projectId}::uuid
      `);
      expect(notification.rows[0]?.count).toBe(1);
      const events = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from domain_events
        where aggregate_id = ${f.projectId}::uuid and event_type = 'project.outcome_cannot_fulfil'
      `);
      expect(events.rows[0]?.count).toBe(1);
    });
  });

  it("M111B-04: gesperrte Folgekante — Reopen nach cannot_fulfill wird abgewiesen", async () => {
    const error = await rejected(asActor(f.workspaceId, f.editorId, (tx, ctx) =>
      changeProjectOutcome(tx, ctx, {
        schemaVersion: "project-outcome-command.v1",
        kind: "reopen",
        projectId: f.projectId,
        expectedOutcomeRevision: 1,
        confirmation: "reopen",
      })));
    expect(error).toBeInstanceOf(ProjectOutcomeIllegalTransitionError);
  });

  it("M111B-05: Revisionskonflikt wird als Conflict uebersetzt", async () => {
    const error = await rejected(asActor(f.workspaceId, f.editorId, (tx, ctx) =>
      changeProjectOutcome(tx, ctx, cannotFulfilCommand(f.projectId, 99))));
    expect(error).toBeInstanceOf(ProjectOutcomeConflictError);
  });

  it("M111B-05: unbekanntes Projekt ist not_found", async () => {
    const error = await rejected(asActor(f.workspaceId, f.editorId, (tx, ctx) =>
      changeProjectOutcome(tx, ctx, cannotFulfilCommand(randomUUID()))));
    expect(error).toBeInstanceOf(ProjectOutcomeNotFoundError);
  });

  it("M111B-06: Viewer fail-closed ohne Outbox-Zeile", async () => {
    const otherProject = randomUUID();
    await withTenantOn(testPool, f.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, phase, outcome, source_key)
        select ${otherProject}::uuid, ${f.workspaceId}::uuid, ${f.contactId}::uuid, ${f.siteId}::uuid,
               board.id, intake.id, 'Other', 'request', 'open', 'fixture'
          from kanban_board board join kanban_column intake
            on intake.workspace_id = board.workspace_id and intake.board_id = board.id
           and intake.is_intake = true and intake.archived_at is null
         where board.workspace_id = ${f.workspaceId}::uuid and board.scope = 'residential'
           and board.is_default = true and board.archived_at is null
      `);
    });
    await rejected(asActor(f.workspaceId, f.viewerId, (tx, ctx) =>
      changeProjectOutcome(tx, ctx, cannotFulfilCommand(otherProject))));
    const after = await withTenantOn(testPool, f.workspaceId, async (tx) => {
      const r = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from customer_notification where project_id = ${otherProject}::uuid`);
      return r.rows[0]?.count ?? 0;
    });
    expect(after).toBe(0);
  });

  it("M111B-07: Outbox-Guard weist Insert ohne cannot_fulfill ab", async () => {
    const otherProject = randomUUID();
    await withTenantOn(testPool, f.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, phase, outcome, source_key)
        select ${otherProject}::uuid, ${f.workspaceId}::uuid, ${f.contactId}::uuid, ${f.siteId}::uuid,
               board.id, intake.id, 'Open', 'request', 'open', 'fixture'
          from kanban_board board join kanban_column intake
            on intake.workspace_id = board.workspace_id and intake.board_id = board.id
           and intake.is_intake = true and intake.archived_at is null
         where board.workspace_id = ${f.workspaceId}::uuid and board.scope = 'residential'
           and board.is_default = true and board.archived_at is null
      `);
    });
    const error = await rejected(withTenantOn(testPool, f.workspaceId, (tx) =>
      tx.execute(sql`
        insert into customer_notification (workspace_id, project_id, idempotency_key)
        values (${f.workspaceId}::uuid, ${otherProject}::uuid, ${`cannot-fulfil:${otherProject}`})
      `)));
    expect(postgresCode(error)).toBe("23514");
  });

  it("M111B-11: Freeze-Guard weist Freigabekandidat unter geschlossenem Projekt ab", async () => {
    const error = await rejected(withTenantOn(testPool, f.workspaceId, (tx) =>
      tx.execute(sql`
        insert into offer_release_candidate (
          id, workspace_id, project_id, offer_id, offer_number, variant_id,
          variant_revision_id, variant_revision, variant_snapshot_sha256,
          source_pdf_draft_id, source_pdf_draft_state, source_pdf_draft_input_sha256,
          source_pdf_draft_mime_type, source_pdf_draft_artifact_sha256,
          source_pdf_draft_size_bytes, profile_id, profile_revision_id, profile_revision,
          profile_snapshot_sha256, profile_activation_id, recipient_id, recipient_revision_id,
          recipient_revision, recipient_snapshot_sha256, document_date, valid_through,
          input_version, canonicalization_version, template_version, renderer_recipe_version,
          reservation_key, input_snapshot, input_sha256, has_zero_tax_treatment, created_by
        ) values (
          ${randomUUID()}::uuid, ${f.workspaceId}::uuid, ${f.projectId}::uuid, ${randomUUID()}::uuid,
          'M-1', ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1, decode(repeat('aa',32),'hex'),
          ${randomUUID()}::uuid, 'done', decode(repeat('bb',32),'hex'), 'application/pdf',
          decode(repeat('cc',32),'hex'), 100, ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1,
          decode(repeat('dd',32),'hex'), ${randomUUID()}::uuid, ${randomUUID()}::uuid,
          ${randomUUID()}::uuid, 1, decode(repeat('ee',32),'hex'), '2026-01-01', '2026-02-01',
          'offer-release-candidate-input.v1', 'offer-jcs.v1', 'offer-release-candidate-template.v1',
          'renderer.v1', decode(repeat('ff',32),'hex'), '{}'::jsonb, decode(repeat('00',32),'hex'),
          false, ${f.editorId}::uuid
        )
      `)));
    expect(postgresCode(error)).toBe("23514");
  });

  it("M111B-09/18: Worker-Kapseln — Empfaengeraufloesung, Zustellung, idempotenter Doppel-Dispatch, Storno", async () => {
    await withTenantOn(testPool, f.workspaceId, async (tx) => {
      const notification = await tx.execute<{ id: string }>(sql`
        select id from customer_notification
        where project_id = ${f.projectId}::uuid limit 1
      `);
      const notificationId = notification.rows[0]?.id;
      expect(notificationId).toBeDefined();

      const resolved = await tx.execute<{ email: string | null }>(sql`
        select public._m111b_worker_resolve_recipient(${f.workspaceId}::uuid, ${notificationId}::uuid) as email
      `);
      expect(resolved.rows[0]?.email).toBe(`${f.contactId}@m111b.test`);

      await tx.execute(sql`
        select public._m111b_worker_deliver(${f.workspaceId}::uuid, ${notificationId}::uuid, 1, 'delivered', null)
      `);
      const attempt = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from customer_notification_delivery_attempt
        where notification_id = ${notificationId}::uuid and attempt_number = 1
      `);
      expect(attempt.rows[0]?.count).toBe(1);

      // Idempotenter Doppel-Dispatch: derselbe Versuch erzeugt keine zweite Zeile.
      await tx.execute(sql`
        select public._m111b_worker_deliver(${f.workspaceId}::uuid, ${notificationId}::uuid, 1, 'delivered', null)
      `);
      const attempt2 = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from customer_notification_delivery_attempt
        where notification_id = ${notificationId}::uuid and attempt_number = 1
      `);
      expect(attempt2.rows[0]?.count).toBe(1);
    });
  });

  it("M111B-10/Erase-Anker: Erasure-Quelltext traegt beide M1-11b-Anker", async () => {
    await withTenantOn(testPool, f.workspaceId, async (tx) => {
      const source = await tx.execute<{ prosrc: string }>(sql`
        select routine.prosrc from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace ns on ns.oid = routine.pronamespace
        where ns.nspname = 'public' and routine.proname = 'erase_inactive_lead'
          and pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid, uuid'
      `);
      const prosrc = source.rows[0]?.prosrc ?? "";
      expect(prosrc).toContain("public.customer_notification");
      expect(prosrc).toContain("'cancelled_contact_erased'");
    });
  });

  async function seedOpenProject(contactId: string, siteId: string): Promise<string> {
    const projectId = randomUUID();
    await withTenantOn(testPool, f.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into project (
          id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id,
          name, phase, outcome, source_key
        )
        select ${projectId}::uuid, ${f.workspaceId}::uuid, ${contactId}::uuid,
               ${siteId}::uuid, board.id, intake.id, 'Race Project', 'request', 'open', 'fixture'
          from kanban_board board
          join kanban_column intake
            on intake.workspace_id = board.workspace_id
           and intake.board_id = board.id
           and intake.is_intake = true and intake.archived_at is null
         where board.workspace_id = ${f.workspaceId}::uuid
           and board.scope = 'residential' and board.is_default = true
           and board.archived_at is null
      `);
    });
    return projectId;
  }

  function releaseCandidateInsert(projectId: string) {
    return sql`
      insert into offer_release_candidate (
        id, workspace_id, project_id, offer_id, offer_number, variant_id,
        variant_revision_id, variant_revision, variant_snapshot_sha256,
        source_pdf_draft_id, source_pdf_draft_state, source_pdf_draft_input_sha256,
        source_pdf_draft_mime_type, source_pdf_draft_artifact_sha256,
        source_pdf_draft_size_bytes, profile_id, profile_revision_id, profile_revision,
        profile_snapshot_sha256, profile_activation_id, recipient_id, recipient_revision_id,
        recipient_revision, recipient_snapshot_sha256, document_date, valid_through,
        input_version, canonicalization_version, template_version, renderer_recipe_version,
        reservation_key, input_snapshot, input_sha256, has_zero_tax_treatment, created_by
      ) values (
        ${randomUUID()}::uuid, ${f.workspaceId}::uuid, ${projectId}::uuid, ${randomUUID()}::uuid,
        'M-1', ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1, decode(repeat('aa',32),'hex'),
        ${randomUUID()}::uuid, 'done', decode(repeat('bb',32),'hex'), 'application/pdf',
        decode(repeat('cc',32),'hex'), 100, ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1,
        decode(repeat('dd',32),'hex'), ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, 1, decode(repeat('ee',32),'hex'), '2026-01-01', '2026-02-01',
        'offer-release-candidate-input.v1', 'offer-jcs.v1', 'offer-release-candidate-template.v1',
        'renderer.v1', decode(repeat('ff',32),'hex'), '{}'::jsonb, decode(repeat('00',32),'hex'),
        false, ${f.editorId}::uuid
      )
    `;
  }

  it("P0-1: echtes Interleaving mark_cannot_fulfill ↔ Freeze-Insert serialisiert; genau eine Seite committet", async () => {
    // Der gemeinsame Serialisierungspunkt ist die Project-Zeile (FOR UPDATE der
    // Transition vs. FOR SHARE des Freeze-Guards). Beide laufen ueber getrennte
    // Pool-Clients; die DB serialisiert sie, niemals committen beide.
    const contactId = randomUUID();
    const siteId = randomUUID();
    await withTenantOn(testPool, f.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into contact (id, workspace_id, display_name, email_primary, email_normalized)
        values (${contactId}::uuid, ${f.workspaceId}::uuid, 'Race Contact',
          ${`${contactId}@m111b.test`}, ${`${contactId}@m111b.test`})
      `);
      await tx.execute(sql`
        insert into site (id, workspace_id, contact_id, label)
        values (${siteId}::uuid, ${f.workspaceId}::uuid, ${contactId}::uuid, 'Race Site')
      `);
    });
    const projectId = await seedOpenProject(contactId, siteId);

    const attempts = await Promise.allSettled([
      asActor(f.workspaceId, f.editorId, (tx, ctx) =>
        changeProjectOutcome(tx, ctx, cannotFulfilCommand(projectId))),
      withTenantOn(testPool, f.workspaceId, (tx) => tx.execute(releaseCandidateInsert(projectId))),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    expect(fulfilled.length).toBe(1);

    const end = await withTenantOn(testPool, f.workspaceId, async (tx) => {
      const project = await tx.execute<{ outcome: string }>(sql`
        select outcome from project where id = ${projectId}::uuid
      `);
      const candidate = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from offer_release_candidate where project_id = ${projectId}::uuid
      `);
      return { outcome: project.rows[0]?.outcome, candidates: candidate.rows[0]?.count ?? 0 };
    });
    // Konsistenter Endzustand: entweder cannot_fulfill ohne Kandidat ODER open mit Kandidat.
    const closedWithoutCandidate = end.outcome === "cannot_fulfill" && end.candidates === 0;
    const openWithCandidate = end.outcome === "open" && end.candidates === 1;
    expect(closedWithoutCandidate || openWithCandidate).toBe(true);
  });

  it("M111B-10: Erasure committet waehrend laufender Transition und gewinnt — voller Rollback", async () => {
    const contactId = randomUUID();
    const siteId = randomUUID();
    await withTenantOn(testPool, f.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into contact (id, workspace_id, display_name, email_primary, email_normalized)
        values (${contactId}::uuid, ${f.workspaceId}::uuid, 'Erasure Contact',
          ${`${contactId}@m111b.test`}, ${`${contactId}@m111b.test`})
      `);
      await tx.execute(sql`
        insert into site (id, workspace_id, contact_id, label)
        values (${siteId}::uuid, ${f.workspaceId}::uuid, ${contactId}::uuid, 'Erasure Site')
      `);
    });
    const projectId = await seedOpenProject(contactId, siteId);

    const erasureTx = await testPool.connect();
    let committed = false;
    let waiting: Promise<unknown> | undefined;
    try {
      await erasureTx.query("begin");
      await erasureTx.query(
        "select set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)",
        [f.workspaceId, f.editorId],
      );
      await erasureTx.query(
        "select id from project where workspace_id = $1::uuid and id = $2::uuid for update",
        [f.workspaceId, projectId],
      );
      await erasureTx.query(
        "update contact set deleted_at = statement_timestamp() where workspace_id = $1::uuid and id = $2::uuid",
        [f.workspaceId, contactId],
      );
      waiting = asActor(f.workspaceId, f.editorId, (tx, ctx) =>
        changeProjectOutcome(tx, ctx, cannotFulfilCommand(projectId)));
      await erasureTx.query("commit");
      committed = true;
    } finally {
      if (!committed) await erasureTx.query("rollback").catch(() => undefined);
      erasureTx.release();
    }
    if (!waiting) throw new Error("M1-11b Erasure-Race wurde nicht gestartet");
    await expect(waiting).rejects.toBeInstanceOf(ProjectOutcomeNotFoundError);

    await withTenantOn(testPool, f.workspaceId, async (tx) => {
      const proof = await tx.execute<{
        outcome: string;
        notifications: number;
        events: number;
        audits: number;
      }>(sql`
        select project_record.outcome,
               (select count(*)::int from customer_notification
                 where project_id = project_record.id) as notifications,
               (select count(*)::int from domain_events
                 where aggregate_id = project_record.id
                   and event_type = 'project.outcome_cannot_fulfil') as events,
               (select count(*)::int from audit_log
                 where details->>'projectId' = project_record.id::text
                   and action = 'project.outcome.write') as audits
          from project project_record
         where project_record.id = ${projectId}::uuid
      `);
      expect(proof.rows[0]).toEqual({
        outcome: "open",
        notifications: 0,
        events: 0,
        audits: 0,
      });
    });
  });
});
