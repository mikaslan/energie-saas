// Hinweis: KEIN "server-only"-Import — der Intake-Service (modules/intake)
// importiert diesen Modul-Graphen und wird von Build-/Route-Importtests
// ohne server-only-Mock geladen (Muster modules/intake).
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  LEAD_SOURCE_SCHEMA_VERSION,
  createLeadSourceCommandSchema,
  leadSourceDtoSchema,
  updateLeadSourceCommandSchema,
  type CreateLeadSourceCommand,
  type LeadSourceDto,
  type UpdateLeadSourceCommand,
} from "@/lib/integrations/lead-sources/contract";
import {
  LeadSourceConflictError,
  LeadSourceNotFoundError,
  LeadSourceValidationError,
} from "./errors";

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "lead_source.read")) {
    throw new PermissionDeniedError("lead_source.read", "lead_source", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "lead_source.write")) {
    throw new PermissionDeniedError("lead_source.write", "lead_source", undefined, ctx.actor);
  }
}

// Namens-Normalisierung (Vertrag §3.2): NFKC + Trim + lowercase.
export function normalizeLeadSourceName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function postgresErrorCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

type LeadSourceRow = {
  id: string;
  name: string;
  project_domain: string | null;
  color: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

function toDto(row: LeadSourceRow, canWrite: boolean): LeadSourceDto {
  return leadSourceDtoSchema.parse({
    schemaVersion: LEAD_SOURCE_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    projectDomain: row.project_domain,
    color: row.color,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

const ROW_SELECT = sql`
  select id, name, project_domain, color, archived_at, created_at, updated_at
    from lead_source
`;

export async function listLeadSources(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { includeArchived?: boolean } = {},
): Promise<LeadSourceDto[]> {
  requireRead(ctx);
  const includeArchived = query.includeArchived === true;
  const result = await tx.execute<LeadSourceRow>(sql`
    ${ROW_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     ${includeArchived ? sql`` : sql`and archived_at is null`}
   order by name asc, id asc
  `);
  const canWrite = can(ctx, "lead_source.write");
  return result.rows.map((row) => toDto(row, canWrite));
}

async function writeAuditFor(
  tx: TenantTx,
  ctx: ServiceCtx,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action,
    resource: "lead_source",
    allowed: true,
    details,
  });
}

export async function createLeadSource(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateLeadSourceCommand,
): Promise<LeadSourceDto> {
  requireWrite(ctx);
  const parsed = createLeadSourceCommandSchema.safeParse(input);
  if (!parsed.success) throw new LeadSourceValidationError();
  const command = parsed.data;
  const normalized = normalizeLeadSourceName(command.name);

  let row: LeadSourceRow;
  try {
    const inserted = await tx.execute<LeadSourceRow>(sql`
      insert into lead_source (
        workspace_id, name, name_normalized, project_domain, color
      ) values (
        ${ctx.workspaceId}::uuid,
        ${command.name},
        ${normalized},
        ${command.projectDomain ?? null},
        ${command.color ?? null}
      )
      returning id, name, project_domain, color, archived_at, created_at, updated_at
    `);
    row = inserted.rows[0]!;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new LeadSourceConflictError(command.name);
    if (code === "23514") throw new LeadSourceValidationError();
    throw error;
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "lead_source",
    aggregateId: row.id,
    eventType: "lead_source.created",
    actor: ctx.actor,
    payload: {
      name: command.name,
      projectDomain: command.projectDomain ?? null,
      color: command.color ?? null,
    },
  });
  await writeAuditFor(tx, ctx, "lead_source.create", { name: command.name });

  return toDto(row, true);
}

export async function updateLeadSource(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UpdateLeadSourceCommand,
): Promise<LeadSourceDto> {
  requireWrite(ctx);
  const parsed = updateLeadSourceCommandSchema.safeParse(input);
  if (!parsed.success) throw new LeadSourceValidationError();
  const command = parsed.data;
  const normalized = normalizeLeadSourceName(command.name);

  let rows: LeadSourceRow[];
  try {
    const updated = await tx.execute<LeadSourceRow>(sql`
      update lead_source
         set name = ${command.name},
             name_normalized = ${normalized},
             project_domain = ${command.projectDomain ?? null},
             color = ${command.color ?? null},
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
       returning id, name, project_domain, color, archived_at, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new LeadSourceConflictError(command.name);
    if (code === "23514") throw new LeadSourceValidationError();
    throw error;
  }
  if (!rows[0]) throw new LeadSourceNotFoundError(command.id);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "lead_source",
    aggregateId: command.id,
    eventType: "lead_source.updated",
    actor: ctx.actor,
    payload: {
      name: command.name,
      projectDomain: command.projectDomain ?? null,
      color: command.color ?? null,
    },
  });
  await writeAuditFor(tx, ctx, "lead_source.update", { id: command.id });

  return toDto(rows[0], true);
}

async function setArchived(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
  archived: boolean,
  action: "archive" | "restore",
): Promise<LeadSourceDto> {
  requireWrite(ctx);
  let rows: LeadSourceRow[];
  try {
    const updated = await tx.execute<LeadSourceRow>(sql`
      update lead_source
         set archived_at = ${archived ? sql`statement_timestamp()` : sql`null`},
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${id}::uuid
         and (${archived ? sql`archived_at is null` : sql`archived_at is not null`})
       returning id, name, project_domain, color, archived_at, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    // Kimi-P1-2: Restore kollidiert mit einer zwischenzeitlich neu
    // vergebenen aktiven Namens-Quelle (partieller Unique-Index) —
    // sauber als Conflict mappen statt rohen 23505 durchzureichen.
    const code = postgresErrorCode(error);
    if (code === "23505") throw new LeadSourceConflictError(id);
    if (code === "23514") throw new LeadSourceValidationError();
    throw error;
  }
  const row = rows[0];
  if (!row) {
    // Idempotenz: Zustand bereits erreicht → aktuellen Datensatz zurückgeben,
    // existiert er nicht → NotFound.
    const current = await tx.execute<LeadSourceRow>(sql`
      ${ROW_SELECT}
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${id}::uuid
     limit 1
    `);
    if (!current.rows[0]) throw new LeadSourceNotFoundError(id);
    return toDto(current.rows[0], true);
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "lead_source",
    aggregateId: id,
    eventType: archived ? "lead_source.archived" : "lead_source.restored",
    actor: ctx.actor,
    payload: {},
  });
  await writeAuditFor(tx, ctx, `lead_source.${action}`, { id });

  return toDto(row, true);
}

export function archiveLeadSource(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<LeadSourceDto> {
  return setArchived(tx, ctx, id, true, "archive");
}

export function restoreLeadSource(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<LeadSourceDto> {
  return setArchived(tx, ctx, id, false, "restore");
}

// Intake-Fan-in (Vertrag §3.5): aktive Lead-Quelle mit Name = Producer-
// Anwendung (z. B. "wmee-rechner-v5") auflösen. Kein Treffer → null (kein
// Fehler). RLS-begrenzt durch app.workspace_id; bewusst ohne Permission-Gate,
// da der Intake-Service selbst autorisiert ist (HMAC/verified identity) und
// dieser Helfer nur die Workspace-Id benötigt.
export async function resolveLeadSourceForProducer(
  tx: TenantTx,
  ctx: Pick<ServiceCtx, "workspaceId">,
  producerName: string,
): Promise<string | null> {
  const normalized = normalizeLeadSourceName(producerName);
  const result = await tx.execute<{ id: string }>(sql`
    select id from lead_source
     where workspace_id = ${ctx.workspaceId}::uuid
       and name_normalized = ${normalized}
       and archived_at is null
     limit 1
  `);
  return result.rows[0]?.id ?? null;
}
