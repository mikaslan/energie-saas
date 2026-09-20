// F13-15 Finanzierungs-Intake (Katalog F13.4): Filing-Objekt je Projekt
// mit Maschine §2 (beantragt → bonitaet → entschieden → ausgezahlt →
// abgeschlossen; abgelehnt/storniert aus beantragt/bonitaet/entschieden,
// terminal). Berechtigung: Wiederverwendung installation.read/write
// (KEINE neuen Permission-Keys — Mandat). Genau ein aktiver Vorgang je
// Projekt (Service-Check + DB-partial-UQ als Netz); terminale Vorgänge
// bleiben Historie, Reopen nur via neuen Vorgang. Modul ist server-only
// (Muster modules/service-cases/service.ts).
// Spec: docs/spec/F13-15-finanzierung-intake.md §1/§2.
import "server-only";

import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { hashPortalToken } from "@/lib/integrations/portal/portal-contract";
import { PortalNotFoundError, resolvePortalByToken } from "@/modules/portal";
import {
  FINANCING_CASE_TRANSITION_EVENT,
  financingCaseStatuses,
  financingProdukttypen,
  financingProviders,
  FinancingCaseNotFoundError,
  FinancingCaseValidationError,
  isAllowedFinancingCaseTransition,
  validateFinancingTerms,
  type FinancingCaseDto,
  type FinancingCaseStatus,
} from "@/lib/financing-case";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";

export {
  FINANCING_CASE_TRANSITION_EVENT,
  FinancingCaseNotFoundError,
  FinancingCaseValidationError,
  financingProdukttypen,
  financingProviders,
  financingCaseStatuses,
  financingTransitions,
  FINANCING_CASE_STATUS_LABEL,
  FINANCING_PRODUKTTYP_LABEL,
  FINANCING_PROVIDER_LABEL,
  FINANCING_RATENKAUF_MAX_LAUFZEIT_JAHRE,
  FINANCING_RATENKAUF_MAX_VOLUMEN_EUR_CENTS,
  FINANCING_RATENKAUF_MIN_LAUFZEIT_JAHRE,
  isAllowedFinancingCaseTransition,
  nextFinancingCaseStatuses,
  validateFinancingTerms,
  type FinancingCaseDto,
  type FinancingCaseStatus,
  type FinancingProdukttyp,
  type FinancingProvider,
  type FinancingTerms,
} from "@/lib/financing-case";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const createFinancingCaseCommandSchema = z.strictObject({
  projectId: uuidSchema,
  produkttyp: z.enum(financingProdukttypen),
  laufzeitJahre: z.number().int(),
  volumenEurCents: z.number().int(),
  provider: z.enum(financingProviders),
  providerReferenz: z.string().trim().min(1).max(200).nullable().optional(),
});

const setFinancingCaseStatusCommandSchema = z.strictObject({
  id: uuidSchema,
  status: z.enum(financingCaseStatuses),
  providerReferenz: z.string().trim().min(1).max(200).nullable().optional(),
});

type FinancingCaseRow = {
  id: string;
  project_id: string;
  produkttyp: string;
  laufzeit_jahre: number;
  volumen_eur_cents: number;
  provider: string;
  provider_referenz: string | null;
  status: string;
  beantragt_at: string | null;
  entschieden_at: string | null;
  ausgezahlt_at: string | null;
  abgeschlossen_at: string | null;
  created_at: string;
  updated_at: string;
};

function toIsoOrNull(value: string | null): string | null {
  if (value === null) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) throw new FinancingCaseValidationError();
  return new Date(value).toISOString();
}

function toDto(row: FinancingCaseRow, canWrite: boolean): FinancingCaseDto {
  if (!(financingCaseStatuses as readonly string[]).includes(row.status)) {
    throw new FinancingCaseValidationError();
  }
  if (!(financingProdukttypen as readonly string[]).includes(row.produkttyp)) {
    throw new FinancingCaseValidationError();
  }
  if (!(financingProviders as readonly string[]).includes(row.provider)) {
    throw new FinancingCaseValidationError();
  }
  return {
    id: row.id,
    projectId: row.project_id,
    produkttyp: row.produkttyp as FinancingCaseDto["produkttyp"],
    laufzeitJahre: row.laufzeit_jahre,
    volumenEurCents: row.volumen_eur_cents,
    provider: row.provider as FinancingCaseDto["provider"],
    providerReferenz: row.provider_referenz,
    status: row.status as FinancingCaseStatus,
    beantragtAt: toIsoOrNull(row.beantragt_at),
    entschiedenAt: toIsoOrNull(row.entschieden_at),
    ausgezahltAt: toIsoOrNull(row.ausgezahlt_at),
    abgeschlossenAt: toIsoOrNull(row.abgeschlossen_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  };
}

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "installation.read")) {
    throw new PermissionDeniedError("installation.read", "financing_case", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "installation.write")) {
    throw new PermissionDeniedError("installation.write", "financing_case", undefined, ctx.actor);
  }
}

const ROW_COLUMNS = sql`id, project_id, produkttyp, laufzeit_jahre, volumen_eur_cents, provider, provider_referenz, status, beantragt_at, entschieden_at, ausgezahlt_at, abgeschlossen_at, created_at, updated_at`;

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: unknown }).cause;
  const code = cause && typeof cause === "object" && "code" in cause
    ? (cause as { code?: unknown }).code
    : null;
  return code === "23505";
}

export async function createFinancingCase(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    projectId: string;
    produkttyp: FinancingCaseDto["produkttyp"];
    laufzeitJahre: number;
    volumenEurCents: number;
    provider: FinancingCaseDto["provider"];
    providerReferenz?: string | null;
  },
): Promise<FinancingCaseDto> {
  requireWrite(ctx);
  const parsed = createFinancingCaseCommandSchema.safeParse({
    projectId: input.projectId,
    produkttyp: input.produkttyp,
    laufzeitJahre: input.laufzeitJahre,
    volumenEurCents: input.volumenEurCents,
    provider: input.provider,
    providerReferenz: input.providerReferenz ?? null,
  });
  if (!parsed.success) throw new FinancingCaseValidationError();
  const command = parsed.data;
  // Katalogschranken §1 (fail-closed, kein Filing bei Verletzung).
  validateFinancingTerms({
    produkttyp: command.produkttyp,
    laufzeitJahre: command.laufzeitJahre,
    volumenEurCents: command.volumenEurCents,
    provider: command.provider,
  });

  const project = await tx.execute<{ id: string }>(sql`
    select id from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.projectId}::uuid
     limit 1
  `);
  if (!project.rows[0]) throw new FinancingCaseNotFoundError(command.projectId);

  // Genau ein aktiver Vorgang je Projekt (v1-Grenze): Service-Check,
  // DB-partial-UQ fängt die Race als Netz (→ ValidationError unten).
  const active = await tx.execute<{ id: string }>(sql`
    select id from financing_case
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${command.projectId}::uuid
       and status not in ('abgeschlossen', 'storniert', 'abgelehnt')
     limit 1
  `);
  if (active.rows[0]) {
    throw new FinancingCaseValidationError("project already has an active financing case");
  }

  try {
    const inserted = await tx.execute<FinancingCaseRow>(sql`
      insert into financing_case (
        workspace_id, project_id, produkttyp, laufzeit_jahre,
        volumen_eur_cents, provider, provider_referenz, status,
        beantragt_at, created_by
      ) values (
        ${ctx.workspaceId}::uuid, ${command.projectId}::uuid,
        ${command.produkttyp}, ${command.laufzeitJahre},
        ${command.volumenEurCents}, ${command.provider},
        ${command.providerReferenz ?? null}, 'beantragt',
        statement_timestamp(), ${ctx.actor}::uuid
      )
      returning ${ROW_COLUMNS}
    `);
    const row = inserted.rows[0];
    if (!row) throw new FinancingCaseNotFoundError(command.projectId);
    // KEIN created-Event (Owner-DECIDED): nur minimales Audit mit IDs —
    // Volumen/Laufzeit/Referenz treten nie in Audit/Events aus.
    await writeAudit(tx, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      action: "financing_case.create",
      resource: "project",
      allowed: true,
      details: { projectId: command.projectId, caseId: row.id },
    });
    return toDto(row, true);
  } catch (error) {
    if (error instanceof FinancingCaseNotFoundError || error instanceof FinancingCaseValidationError) {
      throw error;
    }
    if (isUniqueViolation(error)) {
      throw new FinancingCaseValidationError("project already has an active financing case");
    }
    throw error;
  }
}

export async function setFinancingCaseStatus(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { id: string; status: FinancingCaseStatus; providerReferenz?: string | null },
): Promise<FinancingCaseDto> {
  requireWrite(ctx);
  const parsed = setFinancingCaseStatusCommandSchema.safeParse({
    id: input.id,
    status: input.status,
    providerReferenz: input.providerReferenz ?? null,
  });
  if (!parsed.success) throw new FinancingCaseValidationError();
  const command = parsed.data;

  const current = await tx.execute<FinancingCaseRow>(sql`
    select ${ROW_COLUMNS} from financing_case
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.id}::uuid
     for update
  `);
  const row = current.rows[0];
  if (!row) throw new FinancingCaseNotFoundError(command.id);
  const from = row.status as FinancingCaseStatus;

  // No-op (wertgleicher Status) → Return ohne Event/Audit/Touch
  // (F2.5-§3.5-Präzedenz, portal-link.v1-Noop-Disziplin).
  if (from === command.status) return toDto(row, true);

  if (!isAllowedFinancingCaseTransition(from, command.status)) {
    throw new FinancingCaseValidationError(`illegal transition ${from} -> ${command.status}`);
  }

  // Phasenstempel je Übergang (entschieden/ausgezahlt/abgeschlossen;
  // abgelehnt/storniert ohne Stempel, beantragt_at nur bei Anlage).
  // provider_referenz nur bei Übergabe überschrieben (Human-Gate §3).
  const hasReferenz = input.providerReferenz !== undefined && input.providerReferenz !== null;
  const updated = await tx.execute<FinancingCaseRow>(sql`
    update financing_case
       set status = ${command.status},
           provider_referenz = case
             when ${hasReferenz} then ${command.providerReferenz ?? null}
             else provider_referenz end,
           entschieden_at = case
             when ${command.status} = 'entschieden' then statement_timestamp()
             else entschieden_at end,
           ausgezahlt_at = case
             when ${command.status} = 'ausgezahlt' then statement_timestamp()
             else ausgezahlt_at end,
           abgeschlossen_at = case
             when ${command.status} = 'abgeschlossen' then statement_timestamp()
             else abgeschlossen_at end,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.id}::uuid
    returning ${ROW_COLUMNS}
  `);
  const next = updated.rows[0];
  if (!next) throw new FinancingCaseNotFoundError(command.id);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: next.project_id,
    eventType: FINANCING_CASE_TRANSITION_EVENT,
    actor: ctx.actor,
    payload: { caseId: command.id, from, to: command.status },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "financing_case.transition",
    resource: "project",
    allowed: true,
    details: { projectId: next.project_id, caseId: command.id, from, to: command.status },
  });

  return toDto(next, true);
}

export async function getFinancingCase(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<FinancingCaseDto | null> {
  requireRead(ctx);
  if (!uuidSchema.safeParse(id).success) throw new FinancingCaseValidationError();
  const result = await tx.execute<FinancingCaseRow>(sql`
    select ${ROW_COLUMNS} from financing_case
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${id}::uuid
     limit 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return toDto(row, can(ctx, "installation.write"));
}

export async function listFinancingCases(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { projectId: string },
): Promise<FinancingCaseDto[]> {
  requireRead(ctx);
  const parsed = z.strictObject({ projectId: uuidSchema }).safeParse(query);
  if (!parsed.success) throw new FinancingCaseValidationError();
  const result = await tx.execute<FinancingCaseRow>(sql`
    select ${ROW_COLUMNS} from financing_case
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${parsed.data.projectId}::uuid
     order by created_at desc, id desc
  `);
  const canWrite = can(ctx, "installation.write");
  return result.rows.map((row) => toDto(row, canWrite));
}

// F13-15 Finanzierungs-Antrag via Token-Kapsel (dritter anonymer
// Schreibpfad nach F10-04/F13-06; Muster confirmServiceCaseByToken,
// Kapsel-Snippet Agent I, Owner-eingebaut): legt 'beantragt' an. Kapsel
// antwortet mit Fall-ID oder NULL (uniform, kein Orakel) — NULL fällt
// auf NotFound (toter Link, Guard-Verletzung, bereits aktiver Vorgang).
export async function postFinancingRequestByToken(
  pool: Pool,
  input: {
    token: string;
    produkttyp: "ratenkauf" | "kredit";
    laufzeitJahre: number;
    volumenCents: number;
    provider: "bees_bears" | "psd_bank";
  },
): Promise<{ caseId: string }> {
  const parsed = z.strictObject({
    token: z.string().min(1),
    produkttyp: z.enum(["ratenkauf", "kredit"]),
    laufzeitJahre: z.number().int().min(1),
    volumenCents: z.number().int().min(1),
    provider: z.enum(["bees_bears", "psd_bank"]),
  }).safeParse(input);
  if (!parsed.success) throw new FinancingCaseValidationError();
  const { token, produkttyp, laufzeitJahre, volumenCents, provider } = parsed.data;
  // Technischer Guard (keine Domain-Schranke): Spalte ist integer —
  // Überlauf würde als DB-Fehler statt Validation enden.
  if (volumenCents > 2_147_483_647) {
    throw new FinancingCaseValidationError("volumen exceeds integer range");
  }
  // Katalogwahrheit §1 spiegeln (Kapsel prüft fail-closed nach).
  validateFinancingTerms({
    produkttyp,
    laufzeitJahre,
    volumenEurCents: volumenCents,
    provider,
  });
  let view;
  try {
    view = await resolvePortalByToken(pool, { token });
  } catch (error) {
    if (error instanceof PortalNotFoundError) throw new FinancingCaseNotFoundError(token);
    throw error;
  }
  const tokenHash = hashPortalToken(token);
  if (tokenHash === null) throw new FinancingCaseValidationError("token rejected");
  const outcome = await pool.query(
    `select public.request_financing_case_by_token($1::bytea, $2::text, $3::integer, $4::integer, $5::text) as id`,
    [tokenHash, produkttyp, laufzeitJahre, volumenCents, provider],
  );
  const result = z.strictObject({ id: uuidSchema }).safeParse(outcome.rows[0]);
  if (!result.success) throw new FinancingCaseNotFoundError(view.project.id);
  return { caseId: result.data.id };
}
