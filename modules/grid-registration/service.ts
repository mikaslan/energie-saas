// F13-02 Netzanmeldung: EIN Datensatz je Projekt (v1-Grenze) mit
// Maschine vorbereitung → eingereicht → genehmigt → fertiggemeldet →
// abgeschlossen (+ storniert terminal, keine Rückübergänge).
// F13-12 Vertiefung: + rueckfrage-Loop (eingereicht ↔ rueckfrage),
// einspeisezusage zwischen genehmigt und fertiggemeldet,
// storniert → vorbereitung (Wiedereröffnung), Fertigmeldungs-Guards
// (Zählernummer + ≥16 Fotos), Details-Sperre, 6-Monats-Frist,
// MaStR/Wallbox-Add-ons mit Preis-Snapshot.
// Berechtigung: installation.read/write (KEINE neuen Keys — Mandat).
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";

export class GridRegistrationNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super("grid registration not found");
    this.name = "GridRegistrationNotFoundError";
  }
}

export class GridRegistrationValidationError extends Error {
  constructor(message = "grid registration validation failed") {
    super(message);
    this.name = "GridRegistrationValidationError";
  }
}

export const gridRegistrationStatuses = [
  "vorbereitung",
  "eingereicht",
  "rueckfrage",
  "genehmigt",
  "einspeisezusage",
  "fertiggemeldet",
  "abgeschlossen",
  "storniert",
] as const;
export type GridRegistrationStatus = (typeof gridRegistrationStatuses)[number];

export const GRID_REGISTRATION_STATUS_LABEL: Record<GridRegistrationStatus, string> = {
  vorbereitung: "In Vorbereitung",
  eingereicht: "Eingereicht",
  rueckfrage: "Rückfrage",
  genehmigt: "Genehmigt",
  einspeisezusage: "Einspeisezusage",
  fertiggemeldet: "Fertig gemeldet",
  abgeschlossen: "Abgeschlossen",
  storniert: "Storniert",
};

// F13-12 §2: Fertigmeldung erfordert Zählernummer + Foto-Mindestzahl.
export const GRID_REGISTRATION_FERTIGMELDUNG_REQUIRES_METER = true;
export const GRID_REGISTRATION_FERTIGMELDUNG_MIN_PHOTOS = 16;
// F13-12 §5: Add-on-Spalten (Flags); DTO trägt zusätzlich den
// Preis-Snapshot (addonProdukt/addonBetragCents).
export const GRID_REGISTRATION_ADDONS = ["mastr_addon", "wallbox_addon"] as const;
// F13-12 §6: Details nur in diesen Status pflegbar.
export const GRID_REGISTRATION_EDITABLE_STATUSES: GridRegistrationStatus[] = [
  "vorbereitung",
  "rueckfrage",
];

const allowedTransitions: Record<GridRegistrationStatus, GridRegistrationStatus[]> = {
  vorbereitung: ["eingereicht", "storniert"],
  eingereicht: ["rueckfrage", "genehmigt", "storniert"],
  rueckfrage: ["eingereicht", "storniert"],
  genehmigt: ["einspeisezusage", "storniert"],
  einspeisezusage: ["fertiggemeldet", "storniert"],
  fertiggemeldet: ["abgeschlossen", "storniert"],
  abgeschlossen: [],
  storniert: ["vorbereitung"],
};

export function nextGridRegistrationStatuses(from: GridRegistrationStatus): GridRegistrationStatus[] {
  return allowedTransitions[from];
}

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const detailsSchema = z.strictObject({
  operatorName: z.string().trim().min(1).max(160).nullable(),
  meterNumber: z.string().trim().min(1).max(64).nullable(),
});

const addonsSchema = z.strictObject({
  mastrAddon: z.boolean(),
  wallboxAddon: z.boolean(),
  addonProdukt: z.enum(["pv", "wp"]).nullable(),
  addonBetragCents: z.number().int().min(0).nullable(),
});

// F13-12 §5/§6: setDetails trägt optional die Add-ons mit (ein Formular,
// eine Sperre); fehlende Add-on-Felder behalten den gespeicherten Wert.
const detailsWithAddonsSchema = detailsSchema.extend({
  mastrAddon: z.boolean().optional(),
  wallboxAddon: z.boolean().optional(),
  addonProdukt: z.enum(["pv", "wp"]).nullable().optional(),
  addonBetragCents: z.number().int().min(0).nullable().optional(),
});

export type GridRegistrationDto = {
  id: string;
  projectId: string;
  status: GridRegistrationStatus;
  operatorName: string | null;
  meterNumber: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  completedAt: string | null;
  fertigmeldungDue: string | null;
  mastrAddon: boolean;
  wallboxAddon: boolean;
  addonProdukt: "pv" | "wp" | null;
  addonBetragCents: number | null;
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
};

type GridRegistrationRow = {
  id: string;
  project_id: string;
  status: string;
  operator_name: string | null;
  meter_number: string | null;
  submitted_at: Date | string | null;
  decided_at: Date | string | null;
  completed_at: Date | string | null;
  fertigmeldung_due: Date | string | null;
  mastr_addon: boolean;
  wallbox_addon: boolean;
  addon_produkt: string | null;
  addon_betrag_cents: number | null;
  created_at: Date | string;
  updated_at: Date | string;
  [key: string]: unknown;
};

const ROW_COLUMNS = sql`
  id, project_id, status, operator_name, meter_number,
  submitted_at, decided_at, completed_at, fertigmeldung_due,
  mastr_addon, wallbox_addon, addon_produkt, addon_betrag_cents,
  created_at, updated_at
`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function toDto(row: GridRegistrationRow, ctx: ServiceCtx): GridRegistrationDto {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status as GridRegistrationStatus,
    operatorName: row.operator_name,
    meterNumber: row.meter_number,
    submittedAt: row.submitted_at === null ? null : toIso(row.submitted_at),
    decidedAt: row.decided_at === null ? null : toIso(row.decided_at),
    completedAt: row.completed_at === null ? null : toIso(row.completed_at),
    fertigmeldungDue: row.fertigmeldung_due === null ? null : toDateOnly(row.fertigmeldung_due),
    mastrAddon: row.mastr_addon,
    wallboxAddon: row.wallbox_addon,
    addonProdukt: row.addon_produkt as "pv" | "wp" | null,
    addonBetragCents: row.addon_betrag_cents,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    permissions: { canWrite: can(ctx, "installation.write") },
  };
}

function requireRead(ctx: ServiceCtx, projectId: string): void {
  if (!can(ctx, "installation.read")) {
    throw new PermissionDeniedError("installation.read", "grid_registration", projectId, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx, projectId: string): void {
  if (!can(ctx, "installation.write")) {
    throw new PermissionDeniedError("installation.write", "grid_registration", projectId, ctx.actor);
  }
}

async function readByProject(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<GridRegistrationRow | null> {
  const found = await tx.execute<GridRegistrationRow>(sql`
    select ${ROW_COLUMNS} from grid_registration
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${projectId}::uuid
     limit 1
  `);
  return found.rows[0] ?? null;
}

export async function getGridRegistration(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<GridRegistrationDto | null> {
  requireRead(ctx, projectId);
  if (!uuidSchema.safeParse(projectId).success) throw new GridRegistrationValidationError();
  const row = await readByProject(tx, ctx, projectId);
  return row === null ? null : toDto(row, ctx);
}

// Idempotent je Projekt (UNIQUE): anlegen oder bestehenden liefern.
export async function ensureGridRegistration(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<GridRegistrationDto> {
  requireWrite(ctx, projectId);
  if (!uuidSchema.safeParse(projectId).success) throw new GridRegistrationValidationError();
  const project = await tx.execute<{ id: string }>(sql`
    select id from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${projectId}::uuid
     limit 1
  `);
  if (!project.rows[0]) throw new GridRegistrationNotFoundError(projectId);
  const existing = await readByProject(tx, ctx, projectId);
  if (existing) return toDto(existing, ctx);

  try {
    const inserted = await tx.execute<GridRegistrationRow>(sql`
      insert into grid_registration (workspace_id, project_id, created_by)
      values (${ctx.workspaceId}::uuid, ${projectId}::uuid, ${ctx.actor}::uuid)
      returning ${ROW_COLUMNS}
    `);
    const row = inserted.rows[0];
    if (!row) throw new GridRegistrationNotFoundError(projectId);
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "project",
      aggregateId: projectId,
      eventType: "grid_registration.created",
      actor: ctx.actor,
      payload: { registrationId: row.id },
    });
    await writeAudit(tx, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      action: "grid_registration.create",
      resource: "project",
      allowed: true,
      details: { projectId, registrationId: row.id },
    });
    return toDto(row, ctx);
  } catch (error) {
    // Race zweier Anlagen: UNIQUE greift → bestehenden liefern.
    const cause = (error as { cause?: unknown }).cause;
    const code = cause && typeof cause === "object" && "code" in cause
      ? (cause as { code?: unknown }).code
      : null;
    if (code === "23505") {
      const raced = await readByProject(tx, ctx, projectId);
      if (raced) return toDto(raced, ctx);
    }
    throw error;
  }
}

export async function setGridRegistrationDetails(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    projectId: string;
    operatorName: string | null;
    meterNumber: string | null;
    mastrAddon?: boolean;
    wallboxAddon?: boolean;
    addonProdukt?: "pv" | "wp" | null;
    addonBetragCents?: number | null;
  },
): Promise<GridRegistrationDto> {
  requireWrite(ctx, input.projectId);
  const parsed = detailsWithAddonsSchema.safeParse({
    operatorName: input.operatorName,
    meterNumber: input.meterNumber,
    mastrAddon: input.mastrAddon,
    wallboxAddon: input.wallboxAddon,
    addonProdukt: input.addonProdukt,
    addonBetragCents: input.addonBetragCents,
  });
  if (!parsed.success || !uuidSchema.safeParse(input.projectId).success) {
    throw new GridRegistrationValidationError();
  }
  // F13-12 §6: Details-Sperre — nur in vorbereitung/rueckfrage pflegbar.
  const current = await tx.execute<GridRegistrationRow>(sql`
    select ${ROW_COLUMNS} from grid_registration
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
     for update
  `);
  const existing = current.rows[0];
  if (!existing) throw new GridRegistrationNotFoundError(input.projectId);
  if (!(GRID_REGISTRATION_EDITABLE_STATUSES as readonly string[]).includes(existing.status)) {
    throw new GridRegistrationValidationError(
      `details locked in status ${existing.status}`,
    );
  }
  const updated = await tx.execute<GridRegistrationRow>(sql`
    update grid_registration
       set operator_name = ${parsed.data.operatorName},
           meter_number = ${parsed.data.meterNumber},
           mastr_addon = ${parsed.data.mastrAddon ?? existing.mastr_addon},
           wallbox_addon = ${parsed.data.wallboxAddon ?? existing.wallbox_addon},
           addon_produkt = ${parsed.data.addonProdukt === undefined ? existing.addon_produkt : parsed.data.addonProdukt},
           addon_betrag_cents = ${parsed.data.addonBetragCents === undefined ? existing.addon_betrag_cents : parsed.data.addonBetragCents},
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
    returning ${ROW_COLUMNS}
  `);
  const row = updated.rows[0];
  if (!row) throw new GridRegistrationNotFoundError(input.projectId);
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "grid_registration.details",
    resource: "project",
    allowed: true,
    details: { projectId: input.projectId },
  });
  return toDto(row, ctx);
}

// F13-12 §5: Add-on-Flags + Preis-Snapshot (reine Vormerkung, keine
// Fremdsystem-Anbindung). Keine Status-Sperre (nur Details sind per §6
// gesperrt).
export async function setGridRegistrationAddons(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    projectId: string;
    mastrAddon: boolean;
    wallboxAddon: boolean;
    addonProdukt: "pv" | "wp" | null;
    addonBetragCents: number | null;
  },
): Promise<GridRegistrationDto> {
  requireWrite(ctx, input.projectId);
  const parsed = addonsSchema.safeParse({
    mastrAddon: input.mastrAddon,
    wallboxAddon: input.wallboxAddon,
    addonProdukt: input.addonProdukt,
    addonBetragCents: input.addonBetragCents,
  });
  if (!parsed.success || !uuidSchema.safeParse(input.projectId).success) {
    throw new GridRegistrationValidationError();
  }
  const updated = await tx.execute<GridRegistrationRow>(sql`
    update grid_registration
       set mastr_addon = ${parsed.data.mastrAddon},
           wallbox_addon = ${parsed.data.wallboxAddon},
           addon_produkt = ${parsed.data.addonProdukt},
           addon_betrag_cents = ${parsed.data.addonBetragCents},
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
    returning ${ROW_COLUMNS}
  `);
  const row = updated.rows[0];
  if (!row) throw new GridRegistrationNotFoundError(input.projectId);
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "grid_registration.addons",
    resource: "project",
    allowed: true,
    details: { projectId: input.projectId },
  });
  return toDto(row, ctx);
}

export async function transitionGridRegistration(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; status: GridRegistrationStatus; photoCount?: number },
): Promise<GridRegistrationDto> {
  requireWrite(ctx, input.projectId);
  if (!uuidSchema.safeParse(input.projectId).success) {
    throw new GridRegistrationValidationError();
  }
  if (!(gridRegistrationStatuses as readonly string[]).includes(input.status)) {
    throw new GridRegistrationValidationError();
  }
  const current = await tx.execute<GridRegistrationRow>(sql`
    select ${ROW_COLUMNS} from grid_registration
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
     for update
  `);
  const row = current.rows[0];
  if (!row) throw new GridRegistrationNotFoundError(input.projectId);
  const from = row.status as GridRegistrationStatus;
  if (!allowedTransitions[from].includes(input.status)) {
    throw new GridRegistrationValidationError(`illegal transition ${from} -> ${input.status}`);
  }
  // F13-12 §2: Fertigmeldungs-Guards (fail-closed). Die Fotozahl liefert
  // der Aufrufer (Datei-Slots §3) — der Service fragt file_request NICHT
  // selbst ab.
  if (input.status === "fertiggemeldet") {
    const meter = row.meter_number;
    if (
      GRID_REGISTRATION_FERTIGMELDUNG_REQUIRES_METER &&
      (meter === null || meter.trim().length === 0)
    ) {
      throw new GridRegistrationValidationError("meter number required for fertiggemeldet");
    }
    // NaN-hart: nur echte Zahlen ≥ 16 passieren (NaN < 16 ist false!).
    if (
      typeof input.photoCount !== "number" ||
      !(input.photoCount >= GRID_REGISTRATION_FERTIGMELDUNG_MIN_PHOTOS)
    ) {
      throw new GridRegistrationValidationError(
        `at least ${GRID_REGISTRATION_FERTIGMELDUNG_MIN_PHOTOS} photos required for fertiggemeldet`,
      );
    }
  }

  const updated = await tx.execute<GridRegistrationRow>(sql`
    update grid_registration
       set status = ${input.status},
           submitted_at = case
             when ${input.status} = 'eingereicht' then statement_timestamp()
             else submitted_at end,
           fertigmeldung_due = case
             when ${input.status} = 'eingereicht'
               then (statement_timestamp() + make_interval(months => 6))::date
             else fertigmeldung_due end,
           decided_at = case
             when ${input.status} = 'genehmigt' then statement_timestamp()
             else decided_at end,
           completed_at = case
             when ${input.status} = 'abgeschlossen' then statement_timestamp()
             else completed_at end,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
    returning ${ROW_COLUMNS}
  `);
  const next = updated.rows[0];
  if (!next) throw new GridRegistrationNotFoundError(input.projectId);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: input.projectId,
    eventType: "grid_registration.status_changed",
    actor: ctx.actor,
    payload: { from, to: input.status },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "grid_registration.transition",
    resource: "project",
    allowed: true,
    details: { projectId: input.projectId, from, to: input.status },
  });
  return toDto(next, ctx);
}
