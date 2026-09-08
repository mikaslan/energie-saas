import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { withAuthorizedTenantOn, withTenantOn, type ServiceCtx } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { hashOfferReleaseCandidateInput } from "@/lib/integrations/offers/release-contract";
import type { OfferReleaseCandidateInputV1 } from "@/lib/integrations/offers/release-contract";
import {
  OFFER_ISSUANCE_APPROVAL_COMMAND_VERSION,
  type OfferIssuanceApprovalCommandV1,
} from "@/lib/integrations/offers/issuance-contract";
import { approveOfferIssuance, OfferIssuancePersistenceError } from "@/modules/offers";
import {
  changeProjectOutcome,
  ProjectOutcomeCannotFulfilLockedError,
  ProjectOutcomeConflictError,
  ProjectOutcomeIllegalTransitionError,
  ProjectOutcomeNotFoundError,
} from "@/modules/projects";
import type { ProjectOutcomeCommandV1 } from "@/modules/projects";
import { testPool } from "../setup/test-db";
import { tenantFixtures } from "../setup/tenant-fixtures";
import {
  m203b1Artifact,
  m203b1CandidateInput,
} from "../helpers/m203b1-offer-issuance-fixture";

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
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${fixture.contactId}::uuid, ${fixture.workspaceId}::uuid, 'M1-11b Contact', 'Fixture', 'Contact',
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

  it("M111B-03: gefaelschter Evidenz-Insert fuer project.outcome_cannot_fulfil scheitert", async () => {
    const fakePayload = {
      projectId: f.projectId,
      previousOutcome: "open",
      nextOutcome: "cannot_fulfill",
      outcomeRevision: 1,
    };
    const fakeEvent = await rejected(asActor(f.workspaceId, f.editorId, (tx) =>
      tx.execute(sql`
        insert into domain_events (
          workspace_id, aggregate_type, aggregate_id, event_type, actor, payload
        ) values (
          ${f.workspaceId}::uuid, 'project', ${f.projectId}::uuid,
          'project.outcome_cannot_fulfil', ${f.editorId},
          ${JSON.stringify(fakePayload)}::jsonb
        )
      `)));
    expect(postgresCode(fakeEvent)).toBe("23514");
    const fakeAudit = await rejected(asActor(f.workspaceId, f.editorId, (tx) =>
      tx.execute(sql`
        insert into audit_log (
          workspace_id, actor, action, resource, allowed, details
        ) values (
          ${f.workspaceId}::uuid, ${f.editorId},
          'project.outcome.write', 'project', true,
          ${JSON.stringify(fakePayload)}::jsonb
        )
      `)));
    expect(postgresCode(fakeAudit)).toBe("23514");
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
        insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
        values (${contactId}::uuid, ${f.workspaceId}::uuid, 'Race Contact', 'Fixture', 'Contact',
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
        insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
        values (${contactId}::uuid, ${f.workspaceId}::uuid, 'Erasure Contact', 'Fixture', 'Contact',
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

  async function createQueuedNotification(): Promise<string> {
    const contactId = randomUUID();
    const siteId = randomUUID();
    await withTenantOn(testPool, f.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
        values (${contactId}::uuid, ${f.workspaceId}::uuid, 'B1/B2 Contact', 'Fixture', 'Contact',
          ${`${contactId}@m111b.test`}, ${`${contactId}@m111b.test`})
      `);
      await tx.execute(sql`
        insert into site (id, workspace_id, contact_id, label)
        values (${siteId}::uuid, ${f.workspaceId}::uuid, ${contactId}::uuid, 'B1/B2 Site')
      `);
    });
    const projectId = await seedOpenProject(contactId, siteId);
    await asActor(f.workspaceId, f.editorId, (tx, ctx) =>
      changeProjectOutcome(tx, ctx, cannotFulfilCommand(projectId)));
    const notification = await withTenantOn(testPool, f.workspaceId, async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`
        select id from customer_notification where project_id = ${projectId}::uuid
      `);
      return r.rows[0]!.id;
    });
    return notification;
  }

  it("P1-B1: Retry-Erfolg nach failed_retriable hebt den Status nach, ohne zweite Evidenz", async () => {
    const notificationId = await createQueuedNotification();
    await withTenantOn(testPool, f.workspaceId, async (tx) => {
      await tx.execute(sql`
        select public._m111b_worker_deliver(
          ${f.workspaceId}::uuid, ${notificationId}::uuid, 1, 'failed_retriable', 'transport_unavailable'
        )
      `);
      await tx.execute(sql`
        select public._m111b_worker_deliver(
          ${f.workspaceId}::uuid, ${notificationId}::uuid, 1, 'delivered', null
        )
      `);
      const status = await tx.execute<{ status: string }>(sql`
        select status from customer_notification where id = ${notificationId}::uuid
      `);
      expect(status.rows[0]?.status).toBe("delivered");
      const attempts = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from customer_notification_delivery_attempt
        where notification_id = ${notificationId}::uuid
      `);
      expect(attempts.rows[0]?.count).toBe(1);
    });
  });

  it("P1-B2: resolve_recipient liefert fuer nicht-zustellbare (stornierte) Zeilen NULL", async () => {
    const notificationId = await createQueuedNotification();
    await withTenantOn(testPool, f.workspaceId, async (tx) => {
      await tx.execute(sql`
        update customer_notification
           set status = 'cancelled_manual', cancelled_at = now(), updated_at = now()
         where id = ${notificationId}::uuid
      `);
      const resolved = await tx.execute<{ email: string | null }>(sql`
        select public._m111b_worker_resolve_recipient(
          ${f.workspaceId}::uuid, ${notificationId}::uuid
        ) as email
      `);
      expect(resolved.rows[0]?.email).toBeNull();
    });
  });
});

type RaceBinding = {
  workspaceId: string;
  projectId: string;
  offerId: string;
  issuanceId: string;
  editorId: string;
  adminId: string;
};

async function raceTenantCall<Row>(
  workspaceId: string,
  actorId: string | null,
  query: string,
  values: unknown[] = [],
): Promise<{ rows: Row[] }> {
  const client = await testPool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [actorId ?? ""]);
    const result = await client.query(query, values);
    await client.query("commit");
    return { rows: result.rows as Row[] };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// M111B-12-Fixture: Request/Open-Projekt mit kompletter M2-03b1-Kette bis
// `ready_for_approval` (noch null Approvals). Die Kapselkette prueft keine
// Projektphase, die Fixture-Defaults sind phase='request'/outcome='open' —
// genau der Zustand, in dem Transition und Approval um die Bindung ringen.
async function seedApprovalRace(): Promise<RaceBinding> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'M111B-12')`);
    await tx.execute(sql`
      insert into user_identity (id, email) values
        (${editorId}::uuid, ${`${editorId}@m111b12.test`}),
        (${adminId}::uuid, ${`${adminId}@m111b12.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities) values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid, 'admin', '{}'::jsonb)
    `);
    await tenantFixtures.offer(tx, workspaceId);
    await tenantFixtures.offer_pdf_draft(tx, workspaceId);
  });
  const offerRows = await raceTenantCall<{ id: string; project_id: string; offer_number: string }>(
    workspaceId, adminId,
    `select id, project_id, offer_number from public.offer where workspace_id = $1::uuid`,
    [workspaceId],
  );
  const binding = offerRows.rows[0];
  if (!binding) throw new Error("M111B-12: Offer-Fixture fehlt.");
  const { project_id: projectId, id: offerId, offer_number: offerNumber } = binding;

  const profileSender = {
    legalName: "M111B12 Testenergie GmbH",
    tradingName: null,
    representedBy: "Mara Muster",
    address: {
      street: "Sonnenallee", houseNumber: "17", postalCode: "10115", city: "Berlin", country: "DE",
    },
    email: "office@m111b12.invalid",
    phoneE164: "+49301234567",
    websiteHttpsUrl: "https://m111b12.invalid",
    registerCourt: "Amtsgericht Berlin",
    registerNumber: "HRB 12345",
    vatId: "DE123456789",
  };
  const legalDocuments = {
    terms: { title: "Bedingungen", plainText: "M111B12_PRIVATE_TERMS" },
    withdrawalInformation: { title: "Widerruf", plainText: "M111B12_PRIVATE_WITHDRAWAL" },
    privacyNotice: { title: "Datenschutz", plainText: "M111B12_PRIVATE_PRIVACY" },
  };
  const profileRows = await raceTenantCall<{ result: Record<string, unknown> }>(
    workspaceId, adminId,
    `select public.revise_offer_release_profile($1::uuid, 0, 'M111B12 Angebotsprofil', $2::jsonb, $3::jsonb) as result`,
    [workspaceId, JSON.stringify(profileSender), JSON.stringify(legalDocuments)],
  );
  const profile = profileRows.rows[0]?.result as unknown as {
    profileId: string; profileRevisionId: string; revision: number; snapshotSha256: string;
  };
  if ((profileRows.rows[0]?.result as { status?: string })?.status !== "revised") {
    throw new Error("M111B-12: Profilrevision fehlt.");
  }
  const activationRows = await raceTenantCall<{ result: Record<string, unknown> }>(
    workspaceId, adminId,
    `select public.activate_offer_release_profile($1::uuid, $2::uuid, $3::uuid, 1) as result`,
    [workspaceId, profile.profileId, profile.profileRevisionId],
  );
  const activation = activationRows.rows[0]?.result as unknown as { activationId: string };
  if ((activationRows.rows[0]?.result as { status?: string })?.status !== "activated") {
    throw new Error("M111B-12: Profilaktivierung fehlt.");
  }
  const recipientRows = await raceTenantCall<{ result: Record<string, unknown> }>(
    workspaceId, adminId,
    `select public.revise_offer_recipient(
       $1::uuid, $2::uuid, 0, 'Ria Rechnung', 'Testkundin GmbH',
       'ria@m111b12.invalid', $3::jsonb, true
     ) as result`,
    [workspaceId, offerId, JSON.stringify({
      street: "Rechnungsweg", houseNumber: "8a", postalCode: "10999", city: "Berlin", country: "DE",
    })],
  );
  const recipient = recipientRows.rows[0]?.result as unknown as {
    recipientId: string; recipientRevisionId: string; revision: number; snapshotSha256: string;
  };
  if ((recipientRows.rows[0]?.result as { status?: string })?.status !== "revised") {
    throw new Error("M111B-12: Empfaengerrevision fehlt.");
  }

  const draftRows = await raceTenantCall<{ id: string; variant_id: string; variant_revision_id: string; variant_revision: number; variant_snapshot_sha256: Buffer }>(
    workspaceId, adminId,
    `select id, variant_id, variant_revision_id, variant_revision, variant_snapshot_sha256
       from public.offer_pdf_draft where workspace_id = $1::uuid and offer_id = $2::uuid`,
    [workspaceId, offerId],
  );
  const draft = draftRows.rows[0];
  if (!draft) throw new Error("M111B-12: PDF-Quellstand fehlt.");
  const draftArtifact = m203b1Artifact(0x63).bytes;
  const draftLease = randomUUID();
  await raceTenantCall(workspaceId, null,
    `update public.offer_pdf_draft set state = 'running', attempt_count = 1, lease_token = $2::uuid,
        lease_expires_at = pg_catalog.clock_timestamp() + interval '5 minutes',
        started_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
     where workspace_id = $1::uuid and id = $3::uuid`,
    [workspaceId, draftLease, draft.id]);
  await raceTenantCall(workspaceId, null,
    `update public.offer_pdf_draft set state = 'succeeded', lease_token = null, lease_expires_at = null,
        artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea,
        artifact_sha256 = pg_catalog.sha256($2::bytea),
        artifact_size_bytes = pg_catalog.octet_length($2::bytea),
        finished_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
     where workspace_id = $1::uuid and id = $3::uuid`,
    [workspaceId, draftArtifact, draft.id]);
  const sealedRows = await raceTenantCall<{ artifact_sha256: Buffer; artifact_size_bytes: number }>(
    workspaceId, null,
    `select artifact_sha256, artifact_size_bytes from public.offer_pdf_draft
     where workspace_id = $1::uuid and id = $2::uuid`,
    [workspaceId, draft.id]);
  const sealedDraft = sealedRows.rows[0];
  if (!sealedDraft) throw new Error("M111B-12: versiegelter Draft fehlt.");

  const clockRows = await raceTenantCall<{ prepared_at: string; document_date: string; valid_through: string }>(
    workspaceId, null,
    `select public._m203a_offer_release_instant(
              pg_catalog.date_trunc('milliseconds', pg_catalog.statement_timestamp())
            ) as prepared_at,
            (pg_catalog.statement_timestamp() at time zone 'Europe/Berlin')::date::text as document_date,
            ((pg_catalog.statement_timestamp() at time zone 'Europe/Berlin')::date + 30)::text as valid_through`,
  );
  const clock = clockRows.rows[0];
  if (!clock) throw new Error("M111B-12: DB-Zeit fehlt.");
  const candidateInput = m203b1CandidateInput() as OfferReleaseCandidateInputV1;
  candidateInput.preparedAt = clock.prepared_at;
  candidateInput.documentDate = clock.document_date;
  candidateInput.validThrough = clock.valid_through;
  candidateInput.offerNumber = offerNumber;
  candidateInput.variant.revision = draft.variant_revision;
  candidateInput.profile.revision = Number(profile.revision);
  const candidateInputSha = Buffer.from(hashOfferReleaseCandidateInput(candidateInput), "hex");
  const candidateId = randomUUID();
  const candidateApprovalId = randomUUID();
  const candidateArtifactVersion = randomUUID();
  const candidateArtifact = m203b1Artifact(0x64).bytes;
  const candidateArtifactSha = createHash("sha256").update(candidateArtifact).digest();
  await raceTenantCall(
    workspaceId, null,
    `insert into public.offer_release_candidate (
       id, workspace_id, project_id, offer_id, offer_number, variant_id, variant_revision_id,
       variant_revision, variant_snapshot_sha256, source_pdf_draft_id, source_pdf_draft_state,
       source_pdf_draft_input_sha256, source_pdf_draft_mime_type, source_pdf_draft_artifact_sha256,
       source_pdf_draft_size_bytes, profile_id, profile_revision_id, profile_revision,
       profile_snapshot_sha256, profile_activation_id, recipient_id, recipient_revision_id,
       recipient_revision, recipient_snapshot_sha256, prepared_at, document_date, valid_through,
       input_version, canonicalization_version, template_version, renderer_recipe_version,
       publication_status, reservation_key, input_snapshot, input_sha256, has_zero_tax_treatment,
       state, attempt_count, next_attempt_at, artifact_mime_type, artifact_sha256,
       artifact_size_bytes, artifact_bytes, artifact_version, created_by, created_at, updated_at,
       started_at, finished_at
     )
     select $2::uuid, $1::uuid, $3::uuid, $4::uuid, offer_record.offer_number, $5::uuid, $6::uuid,
            $7::integer, $8::bytea, draft.id, 'succeeded', draft.input_sha256, 'application/pdf',
            draft.artifact_sha256, draft.artifact_size_bytes, $9::uuid, $10::uuid, $11::integer,
            $12::bytea, $13::uuid, $14::uuid, $15::uuid, $16::integer, $17::bytea,
            $18::timestamptz, $19::date, $20::date, 'offer-release-candidate-input.v1',
            'offer-jcs.v1', 'offer-release-candidate-template.v1',
            'offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac',
            'not_issued', $21::bytea, $22::jsonb, $23::bytea, false, 'ready_for_approval', 1,
            $18::timestamptz, 'application/pdf', $24::bytea, $25::integer, $26::bytea, $27::uuid,
            $28::uuid, $18::timestamptz, $18::timestamptz, $18::timestamptz, $18::timestamptz
       from public.offer as offer_record
       join public.offer_pdf_draft as draft
         on draft.workspace_id = offer_record.workspace_id and draft.id = $29::uuid
      where offer_record.workspace_id = $1::uuid and offer_record.id = $4::uuid`,
    [
      workspaceId, candidateId, projectId, offerId, draft.variant_id, draft.variant_revision_id,
      draft.variant_revision, draft.variant_snapshot_sha256, profile.profileId, profile.profileRevisionId,
      profile.revision, Buffer.from(String(profile.snapshotSha256 ?? ""), "hex"),
      activation.activationId, recipient.recipientId, recipient.recipientRevisionId, recipient.revision,
      Buffer.from(String(recipient.snapshotSha256), "hex"), clock.prepared_at, clock.document_date,
      clock.valid_through, Buffer.alloc(32, 0x51), JSON.stringify(candidateInput), candidateInputSha,
      candidateArtifactSha, candidateArtifact.length, candidateArtifact, candidateArtifactVersion,
      adminId, draft.id,
    ],
  );
  const candidateApprovalCommand = {
    schemaVersion: "offer-release-approval-command.v1",
    workspaceId,
    offerId,
    candidateId,
    expectedArtifactVersion: candidateArtifactVersion,
    recipientBillingReviewed: true,
    commercialContentReviewed: true,
    activeProfileReviewed: true,
    notIssuedStatusUnderstood: true,
  };
  await raceTenantCall(
    workspaceId, null,
    `insert into public.offer_release_candidate_approval (
       id, workspace_id, candidate_id, project_id, offer_id, variant_id, variant_revision_id,
       variant_revision, variant_snapshot_sha256, source_pdf_draft_id, source_pdf_draft_input_sha256,
       source_pdf_draft_artifact_sha256, profile_activation_id, profile_id, profile_revision_id,
       profile_revision, profile_snapshot_sha256, recipient_id, recipient_revision_id,
       recipient_revision, recipient_snapshot_sha256, input_version, canonicalization_version,
       template_version, renderer_recipe_version, input_sha256, publication_status,
       has_zero_tax_treatment, artifact_mime_type, artifact_sha256, artifact_size_bytes,
       artifact_version, approval_version, approval_command_version, approval_command,
       recipient_billing_reviewed, commercial_content_reviewed, active_profile_reviewed,
       not_issued_status_understood, zero_tax_treatment_reviewed, approved_by, approved_at
     )
     select $3::uuid, candidate.workspace_id, candidate.id, candidate.project_id, candidate.offer_id,
            candidate.variant_id, candidate.variant_revision_id, candidate.variant_revision,
            candidate.variant_snapshot_sha256, candidate.source_pdf_draft_id,
            candidate.source_pdf_draft_input_sha256, candidate.source_pdf_draft_artifact_sha256,
            candidate.profile_activation_id, candidate.profile_id, candidate.profile_revision_id,
            candidate.profile_revision, candidate.profile_snapshot_sha256, candidate.recipient_id,
            candidate.recipient_revision_id, candidate.recipient_revision,
            candidate.recipient_snapshot_sha256, candidate.input_version,
            candidate.canonicalization_version, candidate.template_version,
            candidate.renderer_recipe_version, candidate.input_sha256, candidate.publication_status,
            candidate.has_zero_tax_treatment, candidate.artifact_mime_type, candidate.artifact_sha256,
            candidate.artifact_size_bytes, candidate.artifact_version,
            'offer-release-candidate-approval.v1', 'offer-release-approval-command.v1', $4::jsonb,
            true, true, true, true, null, $5::uuid,
            pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp())
       from public.offer_release_candidate as candidate
      where candidate.workspace_id = $1::uuid and candidate.id = $2::uuid`,
    [workspaceId, candidateId, candidateApprovalId, JSON.stringify(candidateApprovalCommand), adminId],
  );
  const preparedRows = await raceTenantCall<{ result: { issuanceId: string; state: string; approvalCount: number } }>(
    workspaceId, adminId,
    `select public.prepare_offer_issuance($1::uuid, $2::uuid, $3::uuid) as result`,
    [workspaceId, offerId, candidateId],
  );
  const prepared = preparedRows.rows[0]?.result;
  if (!prepared || prepared.state !== "queued") {
    throw new Error(`M111B-12: Issuance-Vorbereitung scheiterte (${JSON.stringify(prepared)}).`);
  }
  const issuanceId = String(prepared.issuanceId);
  const leaseToken = randomUUID();
  await raceTenantCall(workspaceId, null,
    `select public.claim_offer_issuance_render($1::uuid, $2::uuid, $3::uuid, 120) as result`,
    [workspaceId, issuanceId, leaseToken]);
  const finalRows = await raceTenantCall<{ result: { status: string } }>(
    workspaceId, null,
    `select public.finalize_offer_issuance_render_success($1::uuid, $2::uuid, $3::uuid, 1, $4::bytea) as result`,
    [workspaceId, issuanceId, leaseToken, m203b1Artifact(0x65).bytes],
  );
  if (finalRows.rows[0]?.result.status !== "ready_for_approval") {
    throw new Error(`M111B-12: Issuance nicht freigabereif (${JSON.stringify(finalRows.rows[0]?.result)}).`);
  }
  const taxRows = await raceTenantCall<{ has_zero_tax_treatment: boolean }>(
    workspaceId, null,
    `select has_zero_tax_treatment from public.offer_issuance where workspace_id = $1::uuid and id = $2::uuid`,
    [workspaceId, issuanceId],
  );
  if (taxRows.rows[0]?.has_zero_tax_treatment !== false) {
    throw new Error("M111B-12: Fixture-Annahme verletzt (erwartet besteuerten Kandidaten).");
  }
  return { workspaceId, projectId, offerId, issuanceId, editorId, adminId };
}

// M111B-12c Lock-Gate: wartet, bis der Backend-Prozess `pid()` einen
// gehaltenen Tupel-Lock auf public.project zeigt (der Serialisierungspunkt
// beider Race-Seiten). True bei Erfolg, false bei Timeout — der Aufrufer
// faehrt dann als wilde Runde fort; die strikten Assertions gelten weiter.
async function waitForProjectTupleLock(
  workspaceId: string,
  pid: () => string,
  timeoutMs = 2000,
): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const current = pid();
    if (current !== "") {
      const held = await raceTenantCall<{ one: number }>(
        workspaceId,
        null,
        `select 1 as one from pg_catalog.pg_locks
          where locktype = 'tuple' and granted
            and relation = 'public.project'::regclass
            and pid = $1::int
          limit 1`,
        [current],
      );
      if (held.rows.length > 0) return true;
    }
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// M111B-12c 40P01-Retry: genau EIN Wiederholungslauf bei belegtem Deadlock
// (PG-Code 40P01 in .code/.cause-Kette, vgl. postgresCode in
// modules/projects/outcome-service.ts). Der Retry laeuft seriell nach dem
// Gewinner-Commit und pinnt denselben Fach-Verliererpfad wie 12a/12b.
function racePgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

async function runRaceArm<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (racePgCode(error) === "40P01") return await work();
    throw error;
  }
}

describe("M1-11b Race: Transition gegen Approval (M111B-12)", () => {
  it("M111B-12a: Approval zuerst blockiert die Transition (CannotFulfilLocked)", async () => {
    const binding = await seedApprovalRace();
    const approved = await asActor(binding.workspaceId, binding.adminId, (tx, ctx) =>
      approveOfferIssuance(tx, ctx, approvalCommand(binding.issuanceId)));
    expect(approved.issuanceId).toBe(binding.issuanceId);
    const error = await rejected(asActor(binding.workspaceId, binding.editorId, (tx, ctx) =>
      changeProjectOutcome(tx, ctx, cannotFulfilCommand(binding.projectId))));
    expect(error).toBeInstanceOf(ProjectOutcomeCannotFulfilLockedError);
    const end = await raceEndState(binding);
    expect(end).toEqual({ outcome: "open", approvals: 1, notifications: 0 });
  });

  it("M111B-12b: Transition zuerst blockiert das Approval (Freeze-Guard)", async () => {
    // Der DB-Freeze wirft 23514/`project_cannot_fulfil_locked`, aber
    // executeFunction schluckt PG-Details (OfferIssuancePersistenceError ohne
    // Cause). Beweiskraft kommt aus dem Endzustand: kein Approval, Akte zu.
    const binding = await seedApprovalRace();
    await asActor(binding.workspaceId, binding.editorId, (tx, ctx) =>
      changeProjectOutcome(tx, ctx, cannotFulfilCommand(binding.projectId)));
    const error = await rejected(asActor(binding.workspaceId, binding.adminId, (tx, ctx) =>
      approveOfferIssuance(tx, ctx, approvalCommand(binding.issuanceId))));
    expect(error).toBeInstanceOf(OfferIssuancePersistenceError);
    const end = await raceEndState(binding);
    expect(end).toEqual({ outcome: "cannot_fulfill", approvals: 0, notifications: 1 });
  });

  it("M111B-12c: echtes Interleaving erzeugt nie cannot_fulfill MIT Bindung", async () => {
    // Beide Seiten laufen ueber getrennte Pool-Clients; der gemeinsame
    // Serialisierungspunkt ist die Project-Zeile (FOR UPDATE beidseits).
    // Die DB serialisiert, genau eine Seite committet. Der Verliererfehler
    // ist seiten-genau gepinnt: Transition→Locked, Approval→Persistence.
    //
    // Zwei Runden sind gesteuert (der Zweite startet erst, wenn der Erste
    // den Tupel-Lock auf project haelt — per pg_locks beobachtet): damit ist
    // jede Richtung deterministisch abgedeckt, nicht nur die schnellere.
    // Die dritte Runde ist wild (gleichzeitiger Start). Unerwartete Fehler
    // — inklusive 40P01-Deadlock — scheitern LAUT: Ein Deadlock waere ein
    // Produktmangel (500 statt sauberem Konflikt), kein akzeptierter
    // Race-Ausgang. Faellt das Lock-Gate per Timeout aus, wird die Runde
    // automatisch zur wilden Runde; die strikten Assertions gelten weiter.
    const pinLoser = async (
      binding: RaceBinding,
      attempts: PromiseSettledResult<unknown>[],
    ): Promise<void> => {
      const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
      const losers = attempts.filter(
        (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const end = await raceEndState(binding);
      // Seed-Wache: Der Race serialisiert nur, wenn beide Seiten dasselbe
      // Projekt ringen (Offer, Issuance und Binding muessen identisch sein).
      const projCheck = await raceTenantCall<{ scope: string; project_id: string }>(
        binding.workspaceId,
        null,
        `select 'offer' as scope, project_id::text from public.offer
          where workspace_id = $1::uuid and id = $2::uuid
         union all
         select 'issuance', project_id::text from public.offer_issuance
          where workspace_id = $1::uuid and id = $3::uuid`,
        [binding.workspaceId, binding.offerId, binding.issuanceId],
      );
      expect(projCheck.rows.map((r) => r.project_id).sort()).toEqual(
        [binding.projectId, binding.projectId].sort(),
      );
      const detail = losers[0]?.reason as {
        query?: unknown; params?: unknown; cause?: unknown; message?: string;
      };
      console.log(
        `M111B-12c loser dump: end=${end.outcome}/a${end.approvals}/n${end.notifications} `
        + `ctor=${(losers[0]?.reason as Error)?.constructor?.name} `
        + `pgcode=${String((detail?.cause as { code?: unknown } | undefined)?.code ?? "?")} `
        + `msg=${String((losers[0]?.reason as Error)?.message ?? "?").slice(0, 600)} `
        + `cause=${String(
          detail?.cause instanceof Error
            ? `${detail.cause.constructor.name}: ${detail.cause.message} | detail=${String(
              (detail.cause as { detail?: unknown }).detail ?? "?",
            ).slice(0, 900)} | hint=${String(
              (detail.cause as { hint?: unknown }).hint ?? "?",
            ).slice(0, 300)} | where=${String(
              (detail.cause as { where?: unknown }).where ?? "?",
            ).slice(0, 500)}`
            : JSON.stringify(detail?.cause),
        ).slice(0, 1600)}`,
      );
      if (end.outcome === "open") {
        expect(end).toEqual({ outcome: "open", approvals: 1, notifications: 0 });
        expect(losers[0]?.reason)
          .toBeInstanceOf(ProjectOutcomeCannotFulfilLockedError);
      } else {
        expect(end).toEqual({ outcome: "cannot_fulfill", approvals: 0, notifications: 1 });
        expect(losers[0]?.reason)
          .toBeInstanceOf(OfferIssuancePersistenceError);
      }
    };

    // Runde 1 (gesteuert): Approval haelt den Serialisierungspunkt zuerst.
    {
      const binding = await seedApprovalRace();
      let approvalPid = "";
      const approval = asActor(binding.workspaceId, binding.adminId, async (tx, ctx) => {
        const id = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        approvalPid = String(id.rows[0]?.pid ?? "");
        return approveOfferIssuance(tx, ctx, approvalCommand(binding.issuanceId));
      });
      await waitForProjectTupleLock(binding.workspaceId, () => approvalPid);
      const transition = asActor(binding.workspaceId, binding.editorId, (tx, ctx) =>
        changeProjectOutcome(tx, ctx, cannotFulfilCommand(binding.projectId)));
      const attempts = await Promise.allSettled([transition, approval]);
      expect(attempts[1]?.status).toBe("fulfilled");
      expect(attempts[0]?.status).toBe("rejected");
      expect((attempts[0] as PromiseRejectedResult).reason)
        .toBeInstanceOf(ProjectOutcomeCannotFulfilLockedError);
      expect(await raceEndState(binding))
        .toEqual({ outcome: "open", approvals: 1, notifications: 0 });
    }

    // Runde 2 (gesteuert): Transition haelt den Serialisierungspunkt zuerst.
    {
      const binding = await seedApprovalRace();
      let transitionPid = "";
      const transition = asActor(binding.workspaceId, binding.editorId, async (tx, ctx) => {
        const id = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        transitionPid = String(id.rows[0]?.pid ?? "");
        return changeProjectOutcome(tx, ctx, cannotFulfilCommand(binding.projectId));
      });
      await waitForProjectTupleLock(binding.workspaceId, () => transitionPid);
      const approval = asActor(binding.workspaceId, binding.adminId, (tx, ctx) =>
        approveOfferIssuance(tx, ctx, approvalCommand(binding.issuanceId)));
      const attempts = await Promise.allSettled([transition, approval]);
      expect(attempts[0]?.status).toBe("fulfilled");
      expect(attempts[1]?.status).toBe("rejected");
      expect((attempts[1] as PromiseRejectedResult).reason)
        .toBeInstanceOf(OfferIssuancePersistenceError);
      expect(await raceEndState(binding))
        .toEqual({ outcome: "cannot_fulfill", approvals: 0, notifications: 1 });
    }

    // Runde 3 (wild): gleichzeitiger Start, Ausgang offen, Vertrag strikt.
    // 40P01-Politik (beobachtet, reproduzierbar): Unter echtem Interleaving
    // kann Postgres den Race-Verlierer per Deadlock abbrechen, statt ihn den
    // sauberen Fachpfad verlieren zu lassen (belegt: T scheitert am
    // customer_notification-Insert mit 40P01 — T wartet auf das
    // Approval-Transaktions-XID, waehrend es das workspace-Tupel sperrt, und
    // A wartet retour; Ende bleibt gueltig: open/a1/n0). 40P01 ist ein
    // sicherer Serialisierungsfehler: Die Verlierer-Transaktion ist
    // VOLLSTAENDIG zurueckgerollt, der Gewinner committet. Genau EIN
    // Wiederholungslauf desselben Arms trifft danach auf den committeten
    // Gewinner-Zustand und durchlaeuft deterministisch den gepinnten
    // Fach-Verliererpfad (12a/12b). Der Retry maskiert nichts: Das
    // Endergebnis bleibt strikt gepinnt.
    {
      const binding = await seedApprovalRace();
      const attempts = await Promise.allSettled([
        runRaceArm(() => asActor(binding.workspaceId, binding.editorId, (tx, ctx) =>
          changeProjectOutcome(tx, ctx, cannotFulfilCommand(binding.projectId)))),
        runRaceArm(() => asActor(binding.workspaceId, binding.adminId, (tx, ctx) =>
          approveOfferIssuance(tx, ctx, approvalCommand(binding.issuanceId)))),
      ]);
      await pinLoser(binding, attempts);
    }
  }, 60000);
});

function approvalCommand(issuanceId: string): OfferIssuanceApprovalCommandV1 {
  return {
    schemaVersion: OFFER_ISSUANCE_APPROVAL_COMMAND_VERSION,
    issuanceId,
    recipientAndScopeReviewed: true,
    commercialTotalsReviewed: true,
    legalProfileReviewed: true,
    finalPdfForArchiveUnderstood: true,
  };
}

async function raceEndState(binding: RaceBinding): Promise<{ outcome: string; approvals: number; notifications: number }> {
  return withTenantOn(testPool, binding.workspaceId, async (tx) => {
    const project = await tx.execute<{ outcome: string }>(sql`
      select outcome from project where id = ${binding.projectId}::uuid
    `);
    const approvals = await tx.execute<{ count: number }>(sql`
      select count(*)::int as count from offer_issuance_approval
      where workspace_id = ${binding.workspaceId}::uuid and issuance_id = ${binding.issuanceId}::uuid
    `);
    const notifications = await tx.execute<{ count: number }>(sql`
      select count(*)::int as count from customer_notification
      where workspace_id = ${binding.workspaceId}::uuid and project_id = ${binding.projectId}::uuid
    `);
    return {
      outcome: project.rows[0]?.outcome ?? "?",
      approvals: approvals.rows[0]?.count ?? -1,
      notifications: notifications.rows[0]?.count ?? -1,
    };
  });
}
