import { z } from "zod";

export const WORKSPACE_ECONOMICS_SETTINGS_COMMAND_VERSION =
  "workspace-economics-settings-command.v1" as const;
export const WORKSPACE_ECONOMICS_SETTINGS_VERSION =
  "workspace-economics-settings.v1" as const;

export const ECONOMICS_SETTINGS_MAX_REVISION = 2_147_483_647 as const;
export const CASHFLOW_HORIZON_DEFAULT_YEARS = 20 as const;
export const MAX_PRICE_NET_CENTS = 1_000_000 as const;
export const MAX_ESCALATION_RATE_BPS = 2000 as const;

// Preise in Cent je Einheit (Cent/kWh bzw. Cent/Liter), 0…10.000 €.
// nullable = „leer → Länderreferenz" (UNK-F4-03: keine erfundenen Zahlen).
const priceNetCentsSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_PRICE_NET_CENTS)
  .nullable();

const escalationRateBpsSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_ESCALATION_RATE_BPS)
  .nullable();

const cashflowHorizonYearsSchema = z.number().int().min(1).max(50);

export const economicsSettingsInputV1Schema = z.strictObject({
  electricityPriceNetCentsPerKwh: priceNetCentsSchema,
  escalationRateBps: escalationRateBpsSchema,
  oilPriceNetCentsPerLiter: priceNetCentsSchema,
  gasPriceNetCentsPerKwh: priceNetCentsSchema,
  // Command-Pflichtfeld: der Client sendet den Horizont immer; der
  // DB-DEFAULT 20 ist nur Absicherung (Kimi-P2-2).
  cashflowHorizonYears: cashflowHorizonYearsSchema,
});
export type EconomicsSettingsInputV1 = z.infer<typeof economicsSettingsInputV1Schema>;

const revisionSchema = z.number().int().min(0).max(ECONOMICS_SETTINGS_MAX_REVISION);

export const economicsSettingsCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_ECONOMICS_SETTINGS_COMMAND_VERSION),
  // 0 = Insert erwartet (keine Zeile); >= 1 = CAS-Update gegen baseRevision.
  baseRevision: revisionSchema,
  input: economicsSettingsInputV1Schema,
});
export type EconomicsSettingsCommandV1 = z.infer<typeof economicsSettingsCommandV1Schema>;

// Read-Semantik (Kimi-P1-1): vor dem ersten Upsert liefert der Read ein
// DTO mit revision 0 und allen nullable Feldern null — KEIN not_found.
export const economicsSettingsV1Schema = z
  .strictObject({
    schemaVersion: z.literal(WORKSPACE_ECONOMICS_SETTINGS_VERSION),
    revision: revisionSchema,
    electricityPriceNetCentsPerKwh: priceNetCentsSchema,
    escalationRateBps: escalationRateBpsSchema,
    oilPriceNetCentsPerLiter: priceNetCentsSchema,
    gasPriceNetCentsPerKwh: priceNetCentsSchema,
    cashflowHorizonYears: cashflowHorizonYearsSchema,
    // Kimi-P1-2: true ⇔ mindestens eines der 4 nullable Felder gesetzt;
    // der Horizont zählt nie. Kimi-Code-P2-2: Konsistenz ist ERZWUNGEN.
    hasAnyDefaults: z.boolean(),
    permissions: z.strictObject({ canWrite: z.boolean() }),
  })
  .superRefine((value, ctx) => {
    const anySet = value.electricityPriceNetCentsPerKwh !== null
      || value.escalationRateBps !== null
      || value.oilPriceNetCentsPerLiter !== null
      || value.gasPriceNetCentsPerKwh !== null;
    if (value.hasAnyDefaults !== anySet) {
      ctx.addIssue({
        code: "custom",
        path: ["hasAnyDefaults"],
        message: "hasAnyDefaults must match the nullable fields",
      });
    }
  });
export type EconomicsSettingsV1 = z.infer<typeof economicsSettingsV1Schema>;

export const economicsErrorCodeSchema = z.enum([
  "invalid",
  "not_found",
  "conflict",
  "denied",
  "unauthenticated",
]);
