// F1-22 Duplikat-Triage-Fläche: Queue + Detail + zwei explizite Aktionen
// (Als-geprüft-Markieren, Projekt→Kanon-Kontakt-Verknüpfen). KEIN Merge,
// KEIN Auto-Clear, KEIN Bulk-Clear — jede Flag-Rücksetzung ist eine
// protokollierte Einzelentscheidung (Event + Audit).
//
// Berechtigung: bestehende Keys (KEIN neuer Key). Lesen braucht
// contact.read bzw. project.read (zeilenweise: Kontakt-Zeilen nur mit
// contact.read, Projekt-Zeilen nur mit project.read, extern nur
// zugewiesene Projekte — Boards-Muster). Schreiben braucht contact.write
// (Kontakt-Flag), project.write (Projekt-Flag) bzw. beide (Verknüpfen).
import "server-only";

import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type ServiceCtx,
} from "@/lib/permissions";
import { DedupeConflictError, DedupeNotFoundError, DedupeValidationError } from "./errors";

export const DEDUPE_ENTITIES = ["contact", "project"] as const;
export type DedupeEntity = (typeof DEDUPE_ENTITIES)[number];

// Intake-Regel (modules/intake contactCandidates): Kandidaten sind
// Kontakte desselben Workspaces (nicht gelöscht) mit gleicher
// normalisierter E-Mail ODER gleicher E164-Nummer. Die Triage nutzt
// exakt diese Regel für candidate_count und Gegenüberstellung.
export const DEDUPE_DETAIL_CANDIDATE_LIMIT = 10;

export type DedupeQueueFilter = {
  entity?: DedupeEntity;
  sourceKey?: string;
  q?: string;
};

export type DedupeQueueEntry = {
  entity: DedupeEntity;
  id: string;
  // Kontakt: display_name; Projekt: Projektname.
  displayName: string;
  // Kontakt: display_name; Projekt: Name des verknüpften Kontakts.
  contactName: string;
  email: string | null;
  phone: string | null;
  // Nur Projekt (Kontakte haben keine Quelle).
  sourceKey: string | null;
  candidateCount: number;
  flaggedAt: string;
  createdAt: string;
  // Nur Kontakt (CAS für markDedupeReviewed); Projekt: null.
  revision: number | null;
};

export type DedupeCandidate = {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  createdAt: string;
  // Kandidat ist selbst zur Prüfung markiert.
  flagged: boolean;
  matchEmail: boolean;
  matchPhone: boolean;
};

export type DedupeDetailPermissions = {
  canMarkReviewed: boolean;
  canLink: boolean;
};

export type DedupeContactSubject = {
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  emailNormalized: string | null;
  phoneRaw: string | null;
  phoneE164: string | null;
  phoneMobile: string | null;
  street: string | null;
  houseNumber: string | null;
  postalCode: string | null;
  city: string | null;
  revision: number;
  createdAt: string;
  flaggedAt: string;
};

export type DedupeProjectSubject = {
  id: string;
  name: string;
  sourceKey: string;
  phase: string;
  outcome: string;
  createdAt: string;
  flaggedAt: string;
  contact: { id: string; displayName: string; email: string | null; phone: string | null };
  site: {
    id: string;
    formattedAddress: string | null;
    street: string | null;
    houseNumber: string | null;
    postalCode: string | null;
    city: string | null;
    addressMode: string;
  };
};

export type DedupeDetail =
  | {
    entity: "contact";
    subject: DedupeContactSubject;
    candidates: DedupeCandidate[];
    permissions: DedupeDetailPermissions;
  }
  | {
    entity: "project";
    subject: DedupeProjectSubject;
    candidates: DedupeCandidate[];
    permissions: DedupeDetailPermissions;
  };

export type MarkDedupeReviewedResult = {
  changed: boolean;
  // Kontakt: aktuelle Revision (nach Bump bei changed); Projekt: null.
  revision: number | null;
};

export type LinkDedupeProjectResult = {
  // Ob das Projekt-Flag dabei zurückgesetzt wurde.
  changed: boolean;
};

type QueueRow = {
  entity: string;
  id: string;
  display_name: string;
  contact_name: string;
  email: string | null;
  phone: string | null;
  source_key: string | null;
  candidate_count: number | string;
  flagged_at: Date | string;
  created_at: Date | string;
  revision: number | string | null;
  [key: string]: unknown;
};

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new DedupeValidationError("invalid dedupe timestamp");
  return date.toISOString();
}

function asInt(value: number | string, what: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) throw new DedupeValidationError(`invalid dedupe ${what}`);
  return parsed;
}

// LIKE-Sonderzeichen im Queue-Suchtext: ohne Escaping wäre % ein
// stiller Alle-Treffer statt einer wörtlichen Suche.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function requireEntity(value: string): DedupeEntity {
  if (value !== "contact" && value !== "project") {
    throw new DedupeValidationError(`unknown dedupe entity ${JSON.stringify(value)}`);
  }
  return value;
}

function requireContactWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "contact.write")) {
    throw new PermissionDeniedError("contact.write", "contact", undefined, ctx.actor);
  }
}

function requireProjectWrite(ctx: ServiceCtx, resource: string): void {
  if (!can(ctx, "project.write")) {
    throw new PermissionDeniedError("project.write", resource, undefined, ctx.actor);
  }
  // Boards-Muster: project.write kennt kein internalOnly — externe
  // Schreiber werden hier explizit abgewiesen.
  if (isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      "project.write",
      resource,
      "external_only_without_assignment",
      ctx.actor,
    );
  }
}

// Triage-Queue: UNION aller gesetzten Kontakt-/Projekt-Flags mit
// Kandidatenzahl nach Intake-Regel. RBAC zeilenweise — Kontakt-Zeilen
// nur mit contact.read, Projekt-Zeilen nur mit project.read, externe
// Leser nur zugewiesene Projekte (Boards-Muster).
export async function listDedupeQueue(
  tx: TenantTx,
  ctx: ServiceCtx,
  filter: DedupeQueueFilter = {},
): Promise<DedupeQueueEntry[]> {
  const canContact = can(ctx, "contact.read");
  const canProject = can(ctx, "project.read");
  if (!canContact && !canProject) {
    throw new PermissionDeniedError("project.read", "dedupe_queue", undefined, ctx.actor);
  }
  const entity = filter.entity === undefined ? null : requireEntity(filter.entity);
  const sourceKey = filter.sourceKey ?? null;
  if (sourceKey !== null && (sourceKey.length === 0 || sourceKey.length > 80)) {
    throw new DedupeValidationError("dedupe sourceKey filter is invalid");
  }
  const trimmedQ = filter.q === undefined ? null : filter.q.trim();
  if (trimmedQ !== null && trimmedQ.length > 200) {
    throw new DedupeValidationError("dedupe search filter is too long");
  }
  const likeQ = trimmedQ === null || trimmedQ.length === 0 ? null : escapeLike(trimmedQ);
  const external = isExternalOnly(ctx);

  const result = await tx.execute<QueueRow>(sql`
    select entity, id, display_name, contact_name, email, phone, source_key,
           candidate_count, flagged_at, created_at, revision
    from (
      select 'contact'::text as entity,
             c.id as id,
             c.display_name as display_name,
             c.display_name as contact_name,
             c.email_primary as email,
             coalesce(c.phone_e164, c.phone_mobile, c.phone_raw) as phone,
             null::text as source_key,
             (select count(*)::int
                from contact c2
               where c2.workspace_id = c.workspace_id
                 and c2.deleted_at is null
                 and c2.id <> c.id
                 and ((c.email_normalized is not null
                       and c2.email_normalized = c.email_normalized)
                   or (c.phone_e164 is not null
                       and c2.phone_e164 = c.phone_e164))
             ) as candidate_count,
             c.updated_at as flagged_at,
             c.created_at as created_at,
             c.revision as revision
        from contact c
       where c.workspace_id = ${ctx.workspaceId}::uuid
         and c.deleted_at is null
         and c.dedupe_review_required = true
         and ${canContact}
         and ${sourceKey}::text is null
         and (${entity}::text is null or ${entity}::text = 'contact')
         and (${likeQ}::text is null
           or c.display_name ilike '%' || ${likeQ} || '%' escape '\\'
           or c.email_primary ilike '%' || ${likeQ} || '%' escape '\\'
           or coalesce(c.phone_e164, c.phone_mobile, c.phone_raw)
              ilike '%' || ${likeQ} || '%' escape '\\')
      union all
      select 'project'::text as entity,
             p.id as id,
             p.name as display_name,
             c.display_name as contact_name,
             c.email_primary as email,
             coalesce(c.phone_e164, c.phone_mobile, c.phone_raw) as phone,
             p.source_key as source_key,
             (select count(*)::int
                from contact c2
               where c2.workspace_id = p.workspace_id
                 and c2.deleted_at is null
                 and c2.id <> p.contact_id
                 and ((c.email_normalized is not null
                       and c2.email_normalized = c.email_normalized)
                   or (c.phone_e164 is not null
                       and c2.phone_e164 = c.phone_e164))
             ) as candidate_count,
             p.updated_at as flagged_at,
             p.created_at as created_at,
             null::int as revision
        from project p
        join contact c
          on c.workspace_id = p.workspace_id
         and c.id = p.contact_id
       where p.workspace_id = ${ctx.workspaceId}::uuid
         and p.dedupe_review_required = true
         and c.deleted_at is null
         and ${canProject}
         and (${sourceKey}::text is null or p.source_key = ${sourceKey}::text)
         and (${entity}::text is null or ${entity}::text = 'project')
         and (${likeQ}::text is null
           or p.name ilike '%' || ${likeQ} || '%' escape '\\'
           or c.display_name ilike '%' || ${likeQ} || '%' escape '\\'
           or c.email_primary ilike '%' || ${likeQ} || '%' escape '\\'
           or coalesce(c.phone_e164, c.phone_mobile, c.phone_raw)
              ilike '%' || ${likeQ} || '%' escape '\\')
         and (${external} = false
           or exists (
             select 1
               from membership actor_membership
               join project_assignment direct_assignment
                 on direct_assignment.workspace_id = actor_membership.workspace_id
                and direct_assignment.membership_id = actor_membership.id
                and direct_assignment.project_id = p.id
                and direct_assignment.assignment_role in ('key_account', 'user')
              where actor_membership.workspace_id = p.workspace_id
                and actor_membership.user_id = ${ctx.actor}::uuid
           ))
    ) queue
    order by created_at desc, id desc
  `);

  return result.rows.map((row) => ({
    entity: requireEntity(row.entity),
    id: row.id,
    displayName: row.display_name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    sourceKey: row.source_key,
    candidateCount: asInt(row.candidate_count, "candidate_count"),
    flaggedAt: iso(row.flagged_at),
    createdAt: iso(row.created_at),
    revision: row.revision === null ? null : asInt(row.revision, "revision"),
  }));
}

type ContactSubjectRow = {
  id: string;
  display_name: string;
  first_name: string;
  last_name: string;
  email_primary: string | null;
  email_normalized: string | null;
  phone_raw: string | null;
  phone_e164: string | null;
  phone_mobile: string | null;
  address_street: string | null;
  address_house_number: string | null;
  address_postal_code: string | null;
  address_city: string | null;
  revision: number | string;
  created_at: Date | string;
  flagged_at: Date | string;
  [key: string]: unknown;
};

type ProjectSubjectRow = {
  id: string;
  name: string;
  source_key: string;
  phase: string;
  outcome: string;
  created_at: Date | string;
  flagged_at: Date | string;
  contact_id: string;
  contact_name: string;
  contact_email: string | null;
  contact_email_normalized: string | null;
  contact_phone: string | null;
  contact_phone_e164: string | null;
  site_id: string;
  formatted_address: string | null;
  street: string | null;
  house_number: string | null;
  postal_code: string | null;
  city: string | null;
  address_mode: string;
  [key: string]: unknown;
};

type CandidateRow = {
  id: string;
  display_name: string;
  email_primary: string | null;
  email_normalized: string | null;
  phone_e164: string | null;
  phone_mobile: string | null;
  phone_raw: string | null;
  dedupe_review_required: boolean;
  created_at: Date | string;
  [key: string]: unknown;
};

function toCandidate(
  row: CandidateRow,
  subjectEmail: string | null,
  subjectPhone: string | null,
): DedupeCandidate {
  const phone = row.phone_e164 ?? row.phone_mobile ?? row.phone_raw;
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email_primary,
    phone,
    createdAt: iso(row.created_at),
    flagged: row.dedupe_review_required,
    matchEmail: subjectEmail !== null && row.email_normalized === subjectEmail,
    matchPhone: subjectPhone !== null && row.phone_e164 === subjectPhone,
  };
}

async function candidateContacts(
  tx: TenantTx,
  ctx: ServiceCtx,
  subjectContactId: string,
  subjectEmail: string | null,
  subjectPhone: string | null,
): Promise<DedupeCandidate[]> {
  const result = await tx.execute<CandidateRow>(sql`
    select c2.id, c2.display_name, c2.email_primary, c2.email_normalized,
           c2.phone_e164, c2.phone_mobile, c2.phone_raw,
           c2.dedupe_review_required, c2.created_at
      from contact c2
     where c2.workspace_id = ${ctx.workspaceId}::uuid
       and c2.deleted_at is null
       and c2.id <> ${subjectContactId}::uuid
       and ((${subjectEmail}::text is not null
             and c2.email_normalized = ${subjectEmail}::text)
         or (${subjectPhone}::text is not null
             and c2.phone_e164 = ${subjectPhone}::text))
     order by c2.created_at asc, c2.id asc
     limit ${DEDUPE_DETAIL_CANDIDATE_LIMIT}
  `);
  return result.rows.map((row) => toCandidate(row, subjectEmail, subjectPhone));
}

// Triage-Detail: Gegenüberstellung des markierten Eintrags mit höchstens
// 10 Kandidaten nach Intake-Regel. Lesen ändert NICHTS — keine Locks,
// keine Writes, keine Seiteneffekte.
export async function getDedupeDetail(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { entity: DedupeEntity; id: string },
): Promise<DedupeDetail> {
  const entity = requireEntity(input.entity);
  const permissions: DedupeDetailPermissions = entity === "contact"
    ? { canMarkReviewed: can(ctx, "contact.write"), canLink: false }
    : {
      canMarkReviewed: can(ctx, "project.write") && !isExternalOnly(ctx),
      canLink: can(ctx, "project.write") && can(ctx, "contact.write") && !isExternalOnly(ctx),
    };

  if (entity === "contact") {
    if (!can(ctx, "contact.read")) {
      throw new PermissionDeniedError("contact.read", "dedupe_detail", undefined, ctx.actor);
    }
    const subject = await tx.execute<ContactSubjectRow>(sql`
      select c.id, c.display_name, c.first_name, c.last_name,
             c.email_primary, c.email_normalized,
             c.phone_raw, c.phone_e164, c.phone_mobile,
             c.address_street, c.address_house_number,
             c.address_postal_code, c.address_city,
             c.revision, c.created_at, c.updated_at as flagged_at
        from contact c
       where c.workspace_id = ${ctx.workspaceId}::uuid
         and c.id = ${input.id}::uuid
         and c.deleted_at is null
         and c.dedupe_review_required = true
    `);
    const row = subject.rows[0];
    if (!row) throw new DedupeNotFoundError();
    return {
      entity: "contact",
      subject: {
        id: row.id,
        displayName: row.display_name,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email_primary,
        emailNormalized: row.email_normalized,
        phoneRaw: row.phone_raw,
        phoneE164: row.phone_e164,
        phoneMobile: row.phone_mobile,
        street: row.address_street,
        houseNumber: row.address_house_number,
        postalCode: row.address_postal_code,
        city: row.address_city,
        revision: asInt(row.revision, "revision"),
        createdAt: iso(row.created_at),
        flaggedAt: iso(row.flagged_at),
      },
      candidates: await candidateContacts(tx, ctx, row.id, row.email_normalized, row.phone_e164),
      permissions,
    };
  }

  if (!can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", "dedupe_detail", undefined, ctx.actor);
  }
  const external = isExternalOnly(ctx);
  const subject = await tx.execute<ProjectSubjectRow>(sql`
    select p.id, p.name, p.source_key, p.phase, p.outcome,
           p.created_at, p.updated_at as flagged_at,
           p.contact_id, c.display_name as contact_name,
           c.email_primary as contact_email,
           c.email_normalized as contact_email_normalized,
           coalesce(c.phone_e164, c.phone_mobile, c.phone_raw) as contact_phone,
           c.phone_e164 as contact_phone_e164,
           p.site_id, s.formatted_address, s.street, s.house_number,
           s.postal_code, s.city, s.address_mode
      from project p
      join contact c
        on c.workspace_id = p.workspace_id
       and c.id = p.contact_id
      join site s
        on s.workspace_id = p.workspace_id
       and s.id = p.site_id
     where p.workspace_id = ${ctx.workspaceId}::uuid
       and p.id = ${input.id}::uuid
       and p.dedupe_review_required = true
       and c.deleted_at is null
       and (${external} = false
         or exists (
           select 1
             from membership actor_membership
             join project_assignment direct_assignment
               on direct_assignment.workspace_id = actor_membership.workspace_id
              and direct_assignment.membership_id = actor_membership.id
              and direct_assignment.project_id = p.id
              and direct_assignment.assignment_role in ('key_account', 'user')
            where actor_membership.workspace_id = p.workspace_id
              and actor_membership.user_id = ${ctx.actor}::uuid
         ))
  `);
  const row = subject.rows[0];
  // Fail-closed ohne Existenzleck: unsichtbar und inexistent sind
  // ununterscheidbar (gilt auch für externe Leser ohne Zuweisung).
  if (!row) throw new DedupeNotFoundError();
  return {
    entity: "project",
    subject: {
      id: row.id,
      name: row.name,
      sourceKey: row.source_key,
      phase: row.phase,
      outcome: row.outcome,
      createdAt: iso(row.created_at),
      flaggedAt: iso(row.flagged_at),
      contact: {
        id: row.contact_id,
        displayName: row.contact_name,
        email: row.contact_email,
        phone: row.contact_phone,
      },
      site: {
        id: row.site_id,
        formattedAddress: row.formatted_address,
        street: row.street,
        houseNumber: row.house_number,
        postalCode: row.postal_code,
        city: row.city,
        addressMode: row.address_mode,
      },
    },
    candidates: await candidateContacts(
      tx,
      ctx,
      row.contact_id,
      row.contact_email_normalized,
      row.contact_phone_e164,
    ),
    permissions,
  };
}

// Aktion 1: Flag→false als explizite Einzelentscheidung (Event + Audit).
// Kontakt: FOR UPDATE + Revisions-CAS (optional) + Bump. Projekt: FOR
// UPDATE + Flag-Check. Beide idempotent (changed:false ohne Writes).
export async function markDedupeReviewed(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { entity: DedupeEntity; id: string; expectedRevision?: number },
): Promise<MarkDedupeReviewedResult> {
  const entity = requireEntity(input.entity);
  if (entity === "contact") {
    requireContactWrite(ctx);
    const locked = await tx.execute<{
      id: string;
      revision: number | string;
      dedupe_review_required: boolean;
      [key: string]: unknown;
    }>(sql`
      select id, revision, dedupe_review_required
        from contact
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${input.id}::uuid
         and deleted_at is null
       for update
    `);
    const row = locked.rows[0];
    if (!row) throw new DedupeNotFoundError();
    const revision = asInt(row.revision, "revision");
    if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
      throw new DedupeConflictError("dedupe contact revision is stale", revision);
    }
    if (!row.dedupe_review_required) return { changed: false, revision };
    const updated = await tx.execute<{ revision: number | string; [key: string]: unknown }>(sql`
      update contact
         set dedupe_review_required = false,
             revision = revision + 1,
             updated_at = now()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${input.id}::uuid
       returning revision
    `);
    const nextRevision = asInt(updated.rows[0].revision, "revision");
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "contact",
      aggregateId: input.id,
      eventType: "contact.dedupe_reviewed",
      actor: ctx.actor,
      payload: { contactId: input.id, revision: nextRevision },
    });
    await writeAudit(tx, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      action: "dedupe.mark_reviewed",
      resource: "contact",
      allowed: true,
      details: { contactId: input.id, revision: nextRevision },
    });
    return { changed: true, revision: nextRevision };
  }

  requireProjectWrite(ctx, "project");
  const locked = await tx.execute<{
    id: string;
    dedupe_review_required: boolean;
    [key: string]: unknown;
  }>(sql`
    select id, dedupe_review_required
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${input.id}::uuid
     for update
  `);
  const row = locked.rows[0];
  if (!row) throw new DedupeNotFoundError();
  if (!row.dedupe_review_required) return { changed: false, revision: null };
  await tx.execute(sql`
    update project
       set dedupe_review_required = false,
           updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${input.id}::uuid
  `);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: input.id,
    eventType: "project.dedupe_reviewed",
    actor: ctx.actor,
    payload: { projectId: input.id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "dedupe.mark_reviewed",
    resource: "project",
    allowed: true,
    details: { projectId: input.id },
  });
  return { changed: true, revision: null };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

// Aktion 2: Projekt→Kanon-Kontakt, atomar INKLUSIVE site.contact_id
// (project_site_contact_fk ist nicht deferrable — deshalb EIN Statement
// mit datenändernden CTEs; zwei Statements würden zwischenzeitlich die
// FK verletzen). Flag→false. KEIN Merge: kein Kontakt wird gelöscht,
// zusammengeführt oder verändert — nur die Verknüpfung wandert.
export async function linkDedupeProject(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; canonicalContactId: string },
): Promise<LinkDedupeProjectResult> {
  requireProjectWrite(ctx, "project");
  requireContactWrite(ctx);

  const locked = await tx.execute<{
    id: string;
    contact_id: string;
    site_id: string;
    dedupe_review_required: boolean;
    [key: string]: unknown;
  }>(sql`
    select id, contact_id, site_id, dedupe_review_required
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${input.projectId}::uuid
     for update
  `);
  const project = locked.rows[0];
  if (!project) throw new DedupeNotFoundError("dedupe project was not found");

  const canonical = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
      from contact
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${input.canonicalContactId}::uuid
       and deleted_at is null
     for update
  `);
  if (!canonical.rows[0]) throw new DedupeNotFoundError("dedupe canonical contact was not found");
  if (project.contact_id === input.canonicalContactId) {
    throw new DedupeValidationError("dedupe project is already linked to this contact");
  }

  // Angebote binden den Projektgraphen (offer_project_graph_fk: Projekt +
  // Kontakt + Standort) und tragen einen Kontakt-Snapshot — ein Relink
  // darunter würde Zeugnis und Referenz entkoppeln. Fail-closed.
  const offers = await tx.execute<{ one: number; [key: string]: unknown }>(sql`
    select 1 as one
      from offer
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
     limit 1
  `);
  if (offers.rows.length > 0) {
    throw new DedupeConflictError("dedupe link blocked: project already has offers");
  }

  // Adresskollision: der Kanon-Kontakt darf dieselbe bestätigte Adresse
  // nicht schon an einem anderen Standort tragen (site-Adress-Uniqueness).
  const collision = await tx.execute<{ one: number; [key: string]: unknown }>(sql`
    select 1 as one
      from site current_site
      join site other_site
        on other_site.workspace_id = current_site.workspace_id
       and other_site.contact_id = ${input.canonicalContactId}::uuid
       and other_site.id <> current_site.id
       and other_site.address_mode = 'selected'
       and other_site.address_fingerprint_version
         = current_site.address_fingerprint_version
       and other_site.address_fingerprint = current_site.address_fingerprint
     where current_site.workspace_id = ${ctx.workspaceId}::uuid
       and current_site.id = ${project.site_id}::uuid
       and current_site.address_mode = 'selected'
     limit 1
  `);
  if (collision.rows.length > 0) {
    throw new DedupeConflictError(
      "dedupe link blocked: canonical contact already has this address",
    );
  }

  let moved: { site_id: string | null; project_id: string | null };
  try {
    const result = await tx.execute<{
      site_id: string | null;
      project_id: string | null;
      [key: string]: unknown;
    }>(sql`
      with moved_site as (
        update site
           set contact_id = ${input.canonicalContactId}::uuid,
               updated_at = now()
         where workspace_id = ${ctx.workspaceId}::uuid
           and id = ${project.site_id}::uuid
         returning id
      ),
      moved_project as (
        update project
           set contact_id = ${input.canonicalContactId}::uuid,
               dedupe_review_required = false,
               updated_at = now()
         where workspace_id = ${ctx.workspaceId}::uuid
           and id = ${input.projectId}::uuid
         returning id
      )
      select (select id from moved_site) as site_id,
             (select id from moved_project) as project_id
    `);
    const row = result.rows[0];
    if (!row?.site_id || !row.project_id) throw new DedupeNotFoundError();
    moved = { site_id: row.site_id, project_id: row.project_id };
  } catch (error) {
    // Race gegen den Adress-Vorcheck: das Unique-Constraint bleibt der
    // Letztentscheider und wird typisiert statt als 500 gemeldet.
    if (isUniqueViolation(error)) {
      throw new DedupeConflictError(
        "dedupe link blocked: canonical contact already has this address",
      );
    }
    throw error;
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: input.projectId,
    eventType: "project.dedupe_linked",
    actor: ctx.actor,
    payload: {
      projectId: moved.project_id,
      siteId: moved.site_id,
      fromContactId: project.contact_id,
      toContactId: input.canonicalContactId,
      clearedFlag: project.dedupe_review_required,
    },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "dedupe.link_project",
    resource: "project",
    allowed: true,
    details: {
      projectId: moved.project_id,
      siteId: moved.site_id,
      fromContactId: project.contact_id,
      toContactId: input.canonicalContactId,
    },
  });
  return { changed: project.dedupe_review_required };
}
