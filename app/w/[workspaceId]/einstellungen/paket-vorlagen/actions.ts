"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PACKAGE_TEMPLATE_MAX_LINES,
  PACKAGE_TEMPLATE_SCHEMA_VERSION,
  packageTemplateCategories,
  packageTemplatePositionTypes,
  packageTemplateUnits,
} from "@/lib/integrations/offers/package-contract";
import {
  archivePackageTemplate,
  createPackageTemplate,
  PackageTemplateConflictError,
  PackageTemplateNotFoundError,
  PackageTemplateStaleError,
  PackageTemplateValidationError,
  restorePackageTemplate,
  updatePackageTemplate,
} from "@/modules/offers";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type PackageTemplateActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "stale"; lineName: string }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseWorkspace(formData: FormData): string | null {
  const value = formData.get("workspaceId");
  if (typeof value !== "string") return null;
  const parsed = workspaceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseText(value: FormDataEntryValue | null, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").trim();
  if (text.length < 1 || text.length > max || /[\p{Cc}\p{Cf}]/u.test(text)) return null;
  return text;
}

function parseOptionalText(value: FormDataEntryValue | null, max: number): string | null | undefined {
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.normalize("NFKC").trim();
  if (text.length < 1 || text.length > max || /[\p{Cc}\p{Cf}]/u.test(text)) return undefined;
  return text;
}

// Euro-Betrag ("12,34"/"12.34"/"12") → Cent (fail-closed, max 2 Nachkommastellen).
function parseEuroCents(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/u, "");
  const match = /^(\d{1,12})([.,](\d{1,2}))?$/u.exec(normalized);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[3] ?? "0").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= 9_000_000_000_000_000 ? cents : null;
}

// Menge ("2"/"2,5"/"0,125") → Milli-Einheiten (fail-closed, max 3 Nachkommastellen).
function parseQuantityMilli(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/u, "");
  const match = /^(\d{1,7})([.,](\d{1,3}))?$/u.exec(normalized);
  if (!match) return null;
  const milli = Number(match[1]) * 1_000 + Number((match[3] ?? "0").padEnd(3, "0"));
  return Number.isSafeInteger(milli) && milli >= 1 && milli <= 100_000_000 ? milli : null;
}

const CATEGORY_SET = new Set<string>(packageTemplateCategories);
const UNIT_SET = new Set<string>(packageTemplateUnits);
const POSITION_TYPE_SET = new Set<string>(packageTemplatePositionTypes);
const TAX_SET = new Set(["standard_19", "zero_operator_confirmed"]);

type ParsedLine = {
  displayName: string;
  description: string | null;
  unit: "piece" | "set" | "meter";
  quantityMilli: number;
  salesUnitNetCents: number;
  purchaseUnitNetCents: number;
  positionType: "required" | "additional" | "optional";
  isHidden: boolean;
  taxTreatment: "standard_19" | "zero_operator_confirmed";
  catalogComponentId?: string;
  catalogComponentRevision?: number;
};

// F16-11: Paket-Zeilen als JSON-Liste (dynamische Formularzeilen);
// striktes Fail-closed — der Service validiert zusätzlich.
function parseLines(value: FormDataEntryValue | null): ParsedLine[] | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > PACKAGE_TEMPLATE_MAX_LINES) return null;
  const lines: ParsedLine[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const displayName = typeof record.displayName === "string"
      ? parseText(record.displayName, 200)
      : null;
    // undefined = ungültig, null = leer (beides fail-closed eine Stufe höher).
    const description = record.description === null || record.description === undefined
      ? null
      : typeof record.description === "string"
        ? parseOptionalText(record.description, 1_000)
        : undefined;
    const unit = typeof record.unit === "string" && UNIT_SET.has(record.unit)
      ? (record.unit as ParsedLine["unit"])
      : null;
    const quantityMilli = parseQuantityMilli(record.quantity);
    const salesUnitNetCents = parseEuroCents(record.salesEuros);
    const purchaseUnitNetCents = parseEuroCents(record.purchaseEuros);
    const positionType = typeof record.positionType === "string" && POSITION_TYPE_SET.has(record.positionType)
      ? (record.positionType as ParsedLine["positionType"])
      : null;
    // F16-11b: Steuer je Zeile (Default 19 %); die 0-%-Bestätigung
    // gehört zum Einsetzen, nie in die Vorlage.
    const taxTreatment = record.taxTreatment === undefined || record.taxTreatment === null
      ? "standard_19"
      : typeof record.taxTreatment === "string" && TAX_SET.has(record.taxTreatment)
        ? (record.taxTreatment as ParsedLine["taxTreatment"])
        : null;
    // F16-13 Katalogbindung (beide Felder gemeinsam oder keines;
    // Preise/Einheit stammen beim Speichern aus dem Katalog).
    const rawComponentId = record.catalogComponentId === undefined || record.catalogComponentId === null
      || record.catalogComponentId === ""
      ? undefined
      : record.catalogComponentId;
    const catalogComponentId = rawComponentId === undefined
      ? undefined
      : typeof rawComponentId === "string" && idSchema.safeParse(rawComponentId).success
        ? rawComponentId
        : null;
    const rawRevision = record.catalogComponentRevision === undefined || record.catalogComponentRevision === null
      || record.catalogComponentRevision === ""
      ? undefined
      : record.catalogComponentRevision;
    const catalogComponentRevision = rawRevision === undefined
      ? undefined
      : typeof rawRevision === "number" && Number.isSafeInteger(rawRevision) && rawRevision >= 1
        ? rawRevision
        : null;
    if (
      displayName === null || description === undefined || unit === null
      || quantityMilli === null || salesUnitNetCents === null
      || purchaseUnitNetCents === null || positionType === null
      || taxTreatment === null
      || catalogComponentId === null || catalogComponentRevision === null
      || (catalogComponentId === undefined) !== (catalogComponentRevision === undefined)
    ) return null;
    if (unit !== "meter" && quantityMilli % 1_000 !== 0) return null;
    lines.push({
      displayName,
      description,
      unit,
      quantityMilli,
      salesUnitNetCents,
      purchaseUnitNetCents,
      positionType,
      isHidden: record.isHidden === true,
      taxTreatment,
      ...(catalogComponentId !== undefined
        ? { catalogComponentId, catalogComponentRevision: catalogComponentRevision! }
        : {}),
    });
  }
  return lines;
}

function parseFields(formData: FormData):
  | { name: string; sectionTitle: string; category: string; lines: ParsedLine[]; position: number }
  | null {
  const name = parseText(formData.get("name"), 200);
  const sectionTitle = parseText(formData.get("sectionTitle"), 120);
  const categoryValue = formData.get("category");
  const category = typeof categoryValue === "string" && CATEGORY_SET.has(categoryValue)
    ? categoryValue
    : null;
  const positionValue = formData.get("position");
  const lines = parseLines(formData.get("linesJson"));
  if (name === null || sectionTitle === null || category === null || lines === null) return null;
  if (typeof positionValue !== "string" || !/^\d+$/u.test(positionValue)) return null;
  const position = Number(positionValue);
  if (!Number.isSafeInteger(position) || position < 0) return null;
  return { name, sectionTitle, category, lines, position };
}

function mapError(error: unknown): PackageTemplateActionState {
  if (error instanceof PackageTemplateValidationError) return { status: "invalid" };
  if (error instanceof PackageTemplateStaleError) return { status: "stale", lineName: error.lineDisplayName };
  if (error instanceof PackageTemplateConflictError) return { status: "conflict" };
  if (error instanceof PackageTemplateNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

const SETTINGS_PATH = (workspace: string): string => `/w/${workspace}/einstellungen/paket-vorlagen`;

export async function createPackageTemplateAction(
  _previous: PackageTemplateActionState,
  formData: FormData,
): Promise<PackageTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const fields = parseFields(formData);
  if (!workspace || !fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "discount_template.write", "package_template", (tx, ctx) =>
      createPackageTemplate(tx, ctx, {
        schemaVersion: PACKAGE_TEMPLATE_SCHEMA_VERSION,
        name: fields.name,
        sectionTitle: fields.sectionTitle,
        category: fields.category as (typeof packageTemplateCategories)[number],
        lines: fields.lines,
        position: fields.position,
      }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Paket angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function updatePackageTemplateAction(
  _previous: PackageTemplateActionState,
  formData: FormData,
): Promise<PackageTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  const fields = parseFields(formData);
  if (!workspace || !id?.success || !fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "discount_template.write", "package_template", (tx, ctx) =>
      updatePackageTemplate(tx, ctx, {
        schemaVersion: PACKAGE_TEMPLATE_SCHEMA_VERSION,
        id: id.data,
        name: fields.name,
        sectionTitle: fields.sectionTitle,
        category: fields.category as (typeof packageTemplateCategories)[number],
        lines: fields.lines,
        position: fields.position,
      }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Paket aktualisiert." };
  } catch (error) {
    return mapError(error);
  }
}

async function setActive(
  formData: FormData,
  active: boolean,
  message: string,
): Promise<PackageTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "discount_template.write", "package_template", (tx, ctx) =>
      active
        ? restorePackageTemplate(tx, ctx, {
          schemaVersion: PACKAGE_TEMPLATE_SCHEMA_VERSION,
          id: id.data,
          active,
        })
        : archivePackageTemplate(tx, ctx, {
          schemaVersion: PACKAGE_TEMPLATE_SCHEMA_VERSION,
          id: id.data,
          active,
        }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message };
  } catch (error) {
    return mapError(error);
  }
}

export async function archivePackageTemplateAction(
  _previous: PackageTemplateActionState,
  formData: FormData,
): Promise<PackageTemplateActionState> {
  return setActive(formData, false, "Paket archiviert.");
}

export async function restorePackageTemplateAction(
  _previous: PackageTemplateActionState,
  formData: FormData,
): Promise<PackageTemplateActionState> {
  return setActive(formData, true, "Paket reaktiviert.");
}
