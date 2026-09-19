"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  LEAD_SOURCE_COLOR_PATTERN,
  LEAD_SOURCE_DOMAINS,
  LEAD_SOURCE_NAME_MAX,
  LEAD_SOURCE_SCHEMA_VERSION,
  type CreateLeadSourceCommand,
  type UpdateLeadSourceCommand,
} from "@/lib/integrations/lead-sources/contract";
import { FunnelCampaignNotFoundError } from "@/modules/funnel-campaigns";
import {
  archiveLeadSource,
  archiveRoutingRule,
  clearRoutingRule,
  createLeadSource,
  LeadSourceConflictError,
  LeadSourceNotFoundError,
  LeadSourceValidationError,
  reactivateRoutingRule,
  restoreLeadSource,
  setRoutingRule,
  updateLeadSource,
} from "@/modules/lead-sources";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type LeadSourceActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid"; message?: string }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseName(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.normalize("NFKC").trim();
  if (trimmed.length < 1 || trimmed.length > LEAD_SOURCE_NAME_MAX) return null;
  return trimmed;
}

// Kimi-P3-2: unbekannter Domain-Wert (crafted Request) → "invalid" statt
// still zu null zu koerzieren — symmetrisch zur Farb-Validierung.
function parseDomain(
  value: FormDataEntryValue | null,
): "residential" | "commercial" | null | "invalid" {
  if (typeof value !== "string" || value === "") return null;
  return LEAD_SOURCE_DOMAINS.includes(value as (typeof LEAD_SOURCE_DOMAINS)[number])
    ? (value as "residential" | "commercial")
    : "invalid";
}

function parseColor(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.trim();
  return LEAD_SOURCE_COLOR_PATTERN.test(trimmed) ? trimmed : null;
}

function mapError(error: unknown): LeadSourceActionState {
  if (error instanceof LeadSourceValidationError) return { status: "invalid" };
  if (error instanceof LeadSourceConflictError) return { status: "conflict" };
  if (error instanceof LeadSourceNotFoundError) return { status: "not_found" };
  // F1-23: unbekannte Kampagne fail-closed (T8-Tests-DB-Vertrag).
  if (error instanceof FunnelCampaignNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

function parseWorkspace(formData: FormData): string | null {
  const workspaceValue = formData.get("workspaceId");
  if (typeof workspaceValue !== "string") return null;
  const workspace = workspaceIdSchema.safeParse(workspaceValue);
  return workspace.success ? workspace.data : null;
}

export async function createLeadSourceAction(
  _previous: LeadSourceActionState,
  formData: FormData,
): Promise<LeadSourceActionState> {
  const workspace = parseWorkspace(formData);
  const name = parseName(formData.get("name"));
  if (!workspace || name === null) return { status: "invalid" };
  const domain = parseDomain(formData.get("projectDomain"));
  if (domain === "invalid") return { status: "invalid" };
  const colorValue = formData.get("color");
  // Ungültige Farbe → invalid, statt still zu nullen (transparente UI).
  const color = parseColor(colorValue);
  if (colorValue && typeof colorValue === "string" && colorValue.trim() !== "" && color === null) {
    return { status: "invalid", message: "Die Farbe muss im Format #RRGGBB angegeben werden." };
  }

  const command: CreateLeadSourceCommand = {
    schemaVersion: LEAD_SOURCE_SCHEMA_VERSION,
    name,
    projectDomain: domain,
    color,
  };
  try {
    await authorizedAction(workspace, "lead_source.write", "lead_source", (tx, ctx) =>
      createLeadSource(tx, ctx, command),
    );
    revalidatePath(`/w/${workspace}/einstellungen/lead-quellen`);
    return { status: "success", message: "Lead-Quelle angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function updateLeadSourceAction(
  _previous: LeadSourceActionState,
  formData: FormData,
): Promise<LeadSourceActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  const name = parseName(formData.get("name"));
  if (!workspace || !id?.success || name === null) return { status: "invalid" };
  const domain = parseDomain(formData.get("projectDomain"));
  if (domain === "invalid") return { status: "invalid" };
  const colorValue = formData.get("color");
  const color = parseColor(colorValue);
  if (colorValue && typeof colorValue === "string" && colorValue.trim() !== "" && color === null) {
    return { status: "invalid", message: "Die Farbe muss im Format #RRGGBB angegeben werden." };
  }

  const command: UpdateLeadSourceCommand = {
    schemaVersion: LEAD_SOURCE_SCHEMA_VERSION,
    id: id.data,
    name,
    projectDomain: domain,
    color,
  };
  try {
    await authorizedAction(workspace, "lead_source.write", "lead_source", (tx, ctx) =>
      updateLeadSource(tx, ctx, command),
    );
    revalidatePath(`/w/${workspace}/einstellungen/lead-quellen`);
    return { status: "success", message: "Lead-Quelle aktualisiert." };
  } catch (error) {
    return mapError(error);
  }
}

async function toggleArchived(
  workspace: string,
  id: string,
  archive: boolean,
): Promise<LeadSourceActionState> {
  try {
    await authorizedAction(workspace, "lead_source.write", "lead_source", (tx, ctx) =>
      archive ? archiveLeadSource(tx, ctx, id) : restoreLeadSource(tx, ctx, id),
    );
    revalidatePath(`/w/${workspace}/einstellungen/lead-quellen`);
    return {
      status: "success",
      message: archive ? "Lead-Quelle archiviert." : "Lead-Quelle reaktiviert.",
    };
  } catch (error) {
    return mapError(error);
  }
}

export async function archiveLeadSourceAction(
  _previous: LeadSourceActionState,
  formData: FormData,
): Promise<LeadSourceActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  return toggleArchived(workspace, id.data, true);
}

export async function restoreLeadSourceAction(
  _previous: LeadSourceActionState,
  formData: FormData,
): Promise<LeadSourceActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  return toggleArchived(workspace, id.data, false);
}

// F1-23 Routing-Vertiefung (T8-UI): Regeln mit Dimension (Quelle XOR
// Kampagne), Modus, Priorität und Auto-Auslösern. Gleiche Schranke
// (lead_source.write) wie alle Quellen-Aktionen. Angenommene
// T8-IMPL-Signatur: setRoutingRule mit optionaler ruleId (Update statt
// Neuanlage) plus Dimensions-/Feld-Parametern; clearRoutingRule per ruleId.
const ROUTING_MODES = ["suggest", "auto"] as const;
type RoutingRuleModeInput = (typeof ROUTING_MODES)[number];

function parseOptionalId(value: FormDataEntryValue | null): string | undefined | null {
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseRequiredId(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || value === "") return null;
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseMode(value: FormDataEntryValue | null): RoutingRuleModeInput | null {
  if (typeof value !== "string" || value === "") return "suggest";
  return (ROUTING_MODES as readonly string[]).includes(value)
    ? (value as RoutingRuleModeInput)
    : null;
}

function parsePriority(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return 0;
  if (!/^(?:0|[1-9]\d*)$/u.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed <= 9999 ? parsed : null;
}

// Checkbox-Paar (Checkbox value="true" zuerst, Hidden value="false"
// danach): get() liefert "true" nur bei gesetzter Box. Crafted values
// werden invalid statt koerziert; fehlt das Feld ganz, gilt der Default.
function parseToggle(value: FormDataEntryValue | null, defaultValue: boolean): boolean | null {
  if (value === null) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export async function setRoutingRuleAction(
  _previous: LeadSourceActionState,
  formData: FormData,
): Promise<LeadSourceActionState> {
  const workspace = parseWorkspace(formData);
  const ruleId = parseOptionalId(formData.get("ruleId"));
  const leadSourceId = parseOptionalId(formData.get("leadSourceId"));
  const funnelCampaignId = parseOptionalId(formData.get("funnelCampaignId"));
  const assigneeMembershipId = parseRequiredId(formData.get("assigneeMembershipId"));
  const mode = parseMode(formData.get("mode"));
  const priority = parsePriority(formData.get("priority"));
  const autoOnManual = parseToggle(formData.get("autoOnManual"), true);
  const autoOnIntake = parseToggle(formData.get("autoOnIntake"), false);
  if (
    !workspace
    || ruleId === null
    || leadSourceId === null
    || funnelCampaignId === null
    || assigneeMembershipId === null
    || mode === null
    || priority === null
    || autoOnManual === null
    || autoOnIntake === null
  ) {
    return { status: "invalid" };
  }
  // Dimension: Quelle XOR Kampagne.
  const hasSource = leadSourceId !== undefined;
  const hasCampaign = funnelCampaignId !== undefined;
  if (hasSource === hasCampaign) return { status: "invalid" };
  // Kampagnen-Regeln NUR suggest — Guard auch serverseitig.
  if (hasCampaign && mode === "auto") {
    return { status: "invalid", message: "Kampagnen-Regeln sind immer Vorschläge." };
  }
  // Zentrales Regelformular (T8-Tests-E2E-Vertrag) meldet neutral.
  const variantValue = formData.get("formVariant");
  const isRuleForm = variantValue === "rule-form";
  try {
    await authorizedAction(workspace, "lead_source.write", "lead_source", (tx, ctx) =>
      setRoutingRule(tx, ctx, {
        ...(ruleId === undefined ? {} : { ruleId }),
        ...(leadSourceId === undefined ? {} : { leadSourceId }),
        ...(funnelCampaignId === undefined ? {} : { funnelCampaignId }),
        assigneeMembershipId,
        mode,
        priority,
        autoOnManual,
        autoOnIntake,
      }),
    );
    revalidatePath(`/w/${workspace}/einstellungen/lead-quellen`);
    return {
      status: "success",
      message: isRuleForm
        ? "Routing-Regel gespeichert."
        : hasCampaign
          ? "Routing-Vorschlag gespeichert."
          : "Standard-Betreuer gespeichert.",
    };
  } catch (error) {
    return mapError(error);
  }
}

export async function clearRoutingRuleAction(
  _previous: LeadSourceActionState,
  formData: FormData,
): Promise<LeadSourceActionState> {
  const workspace = parseWorkspace(formData);
  const ruleId = parseRequiredId(formData.get("ruleId"));
  if (!workspace || ruleId === null) return { status: "invalid" };
  // Dimensions-Echo nur für die Erfolgsmeldung (kein Teil des Löschpfads).
  const campaignValue = formData.get("funnelCampaignId");
  const hasCampaign = typeof campaignValue === "string" && campaignValue !== "";
  try {
    const result = await authorizedAction(
      workspace,
      "lead_source.write",
      "lead_source",
      (tx, ctx) => clearRoutingRule(tx, ctx, { ruleId }),
    );
    revalidatePath(`/w/${workspace}/einstellungen/lead-quellen`);
    if (!result.deleted) {
      return {
        status: "success",
        message: hasCampaign
          ? "Für diese Kampagne war kein Routing-Vorschlag hinterlegt."
          : "Für diese Quelle war kein Standard-Betreuer hinterlegt.",
      };
    }
    return {
      status: "success",
      message: hasCampaign ? "Routing-Vorschlag entfernt." : "Standard-Betreuer entfernt.",
    };
  } catch (error) {
    return mapError(error);
  }
}

export async function archiveRoutingRuleAction(
  _previous: LeadSourceActionState,
  formData: FormData,
): Promise<LeadSourceActionState> {
  const workspace = parseWorkspace(formData);
  const ruleId = parseRequiredId(formData.get("ruleId"));
  if (!workspace || ruleId === null) return { status: "invalid" };
  try {
    await authorizedAction(
      workspace,
      "lead_source.write",
      "lead_source",
      (tx, ctx) => archiveRoutingRule(tx, ctx, { ruleId }),
    );
    revalidatePath(`/w/${workspace}/einstellungen/lead-quellen`);
    return { status: "success", message: "Routing-Regel archiviert." };
  } catch (error) {
    return mapError(error);
  }
}

export async function reactivateRoutingRuleAction(
  _previous: LeadSourceActionState,
  formData: FormData,
): Promise<LeadSourceActionState> {
  const workspace = parseWorkspace(formData);
  const ruleId = parseRequiredId(formData.get("ruleId"));
  if (!workspace || ruleId === null) return { status: "invalid" };
  try {
    await authorizedAction(
      workspace,
      "lead_source.write",
      "lead_source",
      (tx, ctx) => reactivateRoutingRule(tx, ctx, { ruleId }),
    );
    revalidatePath(`/w/${workspace}/einstellungen/lead-quellen`);
    return { status: "success", message: "Routing-Regel reaktiviert." };
  } catch (error) {
    return mapError(error);
  }
}
