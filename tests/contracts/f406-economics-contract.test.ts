import { describe, expect, it } from "vitest";

import {
  CASHFLOW_HORIZON_DEFAULT_YEARS,
  ECONOMICS_SETTINGS_MAX_REVISION,
  MAX_ESCALATION_RATE_BPS,
  MAX_PRICE_NET_CENTS,
  WORKSPACE_ECONOMICS_SETTINGS_COMMAND_VERSION,
  WORKSPACE_ECONOMICS_SETTINGS_VERSION,
  economicsSettingsCommandV1Schema,
  economicsSettingsV1Schema,
} from "@/lib/integrations/economics/contract";

describe("F4.6 Workspace-Economics-Defaults — Contracts", () => {
  const command = {
    schemaVersion: WORKSPACE_ECONOMICS_SETTINGS_COMMAND_VERSION,
    baseRevision: 0,
    input: {
      electricityPriceNetCentsPerKwh: null,
      escalationRateBps: null,
      oilPriceNetCentsPerLiter: null,
      gasPriceNetCentsPerKwh: null,
      cashflowHorizonYears: CASHFLOW_HORIZON_DEFAULT_YEARS,
    },
  };

  it("F406-CON-01: Command minimal gültig (alle Preisfelder leer, Horizont 20)", () => {
    expect(economicsSettingsCommandV1Schema.safeParse(command).success).toBe(true);
    expect(economicsSettingsCommandV1Schema.safeParse({
      ...command, baseRevision: -1,
    }).success).toBe(false);
    expect(economicsSettingsCommandV1Schema.safeParse({
      ...command, baseRevision: ECONOMICS_SETTINGS_MAX_REVISION + 1,
    }).success).toBe(false);
  });

  it("F406-CON-01: Bereichsgrenzen Preise/Eskalation/Horizont", () => {
    expect(economicsSettingsCommandV1Schema.safeParse({
      ...command,
      input: { ...command.input, electricityPriceNetCentsPerKwh: MAX_PRICE_NET_CENTS + 1 },
    }).success).toBe(false);
    expect(economicsSettingsCommandV1Schema.safeParse({
      ...command,
      input: { ...command.input, electricityPriceNetCentsPerKwh: -1 },
    }).success).toBe(false);
    expect(economicsSettingsCommandV1Schema.safeParse({
      ...command,
      input: { ...command.input, escalationRateBps: MAX_ESCALATION_RATE_BPS + 1 },
    }).success).toBe(false);
    expect(economicsSettingsCommandV1Schema.safeParse({
      ...command,
      input: { ...command.input, cashflowHorizonYears: 0 },
    }).success).toBe(false);
    expect(economicsSettingsCommandV1Schema.safeParse({
      ...command,
      input: { ...command.input, cashflowHorizonYears: 51 },
    }).success).toBe(false);
    // Werte an den Rändern sind gültig
    expect(economicsSettingsCommandV1Schema.safeParse({
      ...command,
      input: {
        ...command.input,
        electricityPriceNetCentsPerKwh: MAX_PRICE_NET_CENTS,
        escalationRateBps: MAX_ESCALATION_RATE_BPS,
        cashflowHorizonYears: 50,
      },
    }).success).toBe(true);
  });

  it("F406-CON-01: DTO validiert — Kimi-P1-1/P1-2 (Leerstand, hasAnyDefaults-Teilmengen)", () => {
    const base = {
      schemaVersion: WORKSPACE_ECONOMICS_SETTINGS_VERSION,
      revision: 0,
      electricityPriceNetCentsPerKwh: null,
      escalationRateBps: null,
      oilPriceNetCentsPerLiter: null,
      gasPriceNetCentsPerKwh: null,
      cashflowHorizonYears: CASHFLOW_HORIZON_DEFAULT_YEARS,
      hasAnyDefaults: false,
      permissions: { canWrite: false },
    };
    expect(economicsSettingsV1Schema.safeParse(base).success).toBe(true);
    // Nur Eskalation gesetzt → hasAnyDefaults true
    expect(economicsSettingsV1Schema.safeParse({
      ...base, revision: 1, escalationRateBps: 100, hasAnyDefaults: true,
    }).success).toBe(true);
    // Nur ein Preis gesetzt → hasAnyDefaults true
    expect(economicsSettingsV1Schema.safeParse({
      ...base, revision: 1, gasPriceNetCentsPerKwh: 12, hasAnyDefaults: true,
    }).success).toBe(true);
    // Inkonsistenter Marker wird abgelehnt (alle null, aber hasAnyDefaults)
    // — Kimi-Code-P2-2: Konsistenz ist im Schema erzwungen.
    expect(economicsSettingsV1Schema.safeParse({
      ...base, hasAnyDefaults: true,
    }).success).toBe(false);
    // Umgekehrt: Werte gesetzt, Marker false → ebenfalls abgelehnt.
    expect(economicsSettingsV1Schema.safeParse({
      ...base, revision: 1, electricityPriceNetCentsPerKwh: 30, hasAnyDefaults: false,
    }).success).toBe(false);
  });
});
