"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import {
  WORKSPACE_ECONOMICS_SETTINGS_COMMAND_VERSION,
  MAX_ESCALATION_RATE_BPS,
  MAX_PRICE_NET_CENTS,
  type EconomicsSettingsCommandV1,
} from "@/lib/integrations/economics/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  upsertEconomicsSettings,
  EconomicsConflictError,
  EconomicsNotFoundError,
  EconomicsValidationError,
} from "@/modules/economics";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const INTEGER_PATTERN = /^[0-9]\d*$/u;

export type EconomicsSettingsActionState =
  | { status: "idle" }
  | { status: "success"; revision: number; created: boolean }
  | { status: "invalid" }
  | { status: "conflict"; currentRevision?: number }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || !INTEGER_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseNullablePrice(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return parseNonNegativeInteger(value);
}

function parseNullableBps(value: FormDataEntryValue | null): number | null {
  // Das Formular liefert Prozent mit bis zu 2 Nachkommastellen (z. B. 1,50);
  // gespeichert wird in Basispunkten (1,50 % = 150 bps).
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/u.test(trimmed)) return null;
  const bps = Math.round(Number(trimmed) * 100);
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > MAX_ESCALATION_RATE_BPS) return null;
  return bps;
}

export async function upsertEconomicsSettingsAction(
  _previous: EconomicsSettingsActionState,
  formData: FormData,
): Promise<EconomicsSettingsActionState> {
  const workspaceValue = formData.get("workspaceId");
  if (typeof workspaceValue !== "string") return { status: "invalid" };
  const workspace = workspaceIdSchema.safeParse(workspaceValue);
  if (!workspace.success) return { status: "invalid" };

  const baseRevisionValue = formData.get("baseRevision");
  const baseRevision = parseNonNegativeInteger(
    typeof baseRevisionValue === "string" ? baseRevisionValue : undefined,
  );
  if (baseRevision === null) return { status: "invalid" };

  const electricity = parseNullablePrice(formData.get("electricityPriceNetCentsPerKwh"));
  const escalation = parseNullableBps(formData.get("escalationRateBps"));
  const oil = parseNullablePrice(formData.get("oilPriceNetCentsPerLiter"));
  const gas = parseNullablePrice(formData.get("gasPriceNetCentsPerKwh"));
  const horizonValue = formData.get("cashflowHorizonYears");
  const horizon = parseNonNegativeInteger(
    typeof horizonValue === "string" ? horizonValue : undefined,
  );
  if (horizon === null) return { status: "invalid" };
  if (electricity !== null && (electricity < 0 || electricity > MAX_PRICE_NET_CENTS)) {
    return { status: "invalid" };
  }
  if (oil !== null && (oil < 0 || oil > MAX_PRICE_NET_CENTS)) return { status: "invalid" };
  if (gas !== null && (gas < 0 || gas > MAX_PRICE_NET_CENTS)) return { status: "invalid" };
  if (escalation !== null && escalation > MAX_ESCALATION_RATE_BPS) return { status: "invalid" };
  if (horizon < 1 || horizon > 50) return { status: "invalid" };

  const command: EconomicsSettingsCommandV1 = {
    schemaVersion: WORKSPACE_ECONOMICS_SETTINGS_COMMAND_VERSION,
    baseRevision,
    input: {
      electricityPriceNetCentsPerKwh: electricity,
      escalationRateBps: escalation,
      oilPriceNetCentsPerLiter: oil,
      gasPriceNetCentsPerKwh: gas,
      cashflowHorizonYears: horizon,
    },
  };

  try {
    const result = await authorizedAction(
      workspace.data,
      "economics.write",
      "workspace_economics_settings",
      (tx, ctx) => upsertEconomicsSettings(tx, ctx, command),
    );
    revalidatePath(`/w/${workspace.data}/einstellungen/wirtschaftlichkeit`);
    return { status: "success", revision: result.revision, created: baseRevision === 0 };
  } catch (error) {
    if (error instanceof EconomicsValidationError) return { status: "invalid" };
    if (error instanceof EconomicsConflictError) {
      return { status: "conflict", currentRevision: error.currentRevision };
    }
    if (error instanceof EconomicsNotFoundError) return { status: "not_found" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    throw error;
  }
}
