/**
 * F4.1 v2-Planungsannahmen (Weg-2-Upstream, Spec F4-01): versionierte,
 * begruendete ESTIMATE-Parameter fuer den v2-Fetch, transparent und ohne
 * stille Universaldefaults. Jede Annahme traegt ihre Basis; die Version
 * (`wmee-planning-assumptions.v1`) wandert in Quell-Provenienzen
 * (Lastquellen) und wird mit `provider_estimate` im Resultat sichtbar.
 *
 * Belegt (kein ESTIMATE):
 * - pvTechnology/mountingPlace/systemLossPercent: v1-Produktionspins
 *   (`contract.ts`-Literale `crystSi`/`free`/14, live verifizierte Kette).
 *   PVGIS-Semantik: nicht-BIPV-Aufdach = `free`.
 * - Rezept/Achse/Jahr: Spec-gepinnt (provider-v2, axis-v2).
 * - Dachflaeche/Neigung/Azimut: eingefrorene Reservierungs-Provenienz
 *   (preparationV2.profile.roofs).
 * - kWh-Jahreswerte: bestaetigtes Verbrauchsprofil (preparationV2.profile).
 *
 * ESTIMATE (Midpoints, Upgrade-Pfad benannt):
 * - specificPowerWPerM2 = 200: typische Wohnbau-Modulklasse ~400-450 Wp
 *   auf ~2 m² (200-225 W/m²), konservativer Midpoint. Upgrade: dach-
 *   gebundene Modul-Peakleistung aus Katalog/Planung ( Modul-Autofill).
 * - basisShape = uniform: nur noch fuer EV-/Zusatzquellen (formfreie
 *   Zunaechst-Form). Die Haushalts-Basis laeuft als BDEW-H0
 *   (`h0-load-v2`, eigene Version/Provenienz, Upgrade eingelöst).
 * - evKwhPerKm = 0.2: typische 0.15-0.25 kWh/km, Midpoint. Upgrade:
 *   fahrzeug-/profilspezifische Faktoren (F4.2+).
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import { canonicalizeCalculationJson } from "./contract";
import { QUARTER_HOUR_SLOTS } from "./engine-v2";
import {
  loadProfileSourceV2Schema,
  type LoadProfileSourceV2,
} from "./load-v2";
import { F401ProviderError } from "./provider-v2";

export const PLANNING_ASSUMPTIONS_V2_VERSION =
  "wmee-planning-assumptions.v1" as const;

export const PLANNING_ASSUMPTIONS_V2 = Object.freeze({
  version: PLANNING_ASSUMPTIONS_V2_VERSION,
  roof: Object.freeze({
    pvTechnology: "crystSi",
    mountingPlace: "free",
    systemLossPercent: 14,
    specificPowerWPerM2: 200,
  }),
  load: Object.freeze({
    basisShape: "uniform",
    evKwhPerKm: 0.2,
  }),
});

export type PlanningRoofAssumptionsV2 =
  typeof PLANNING_ASSUMPTIONS_V2.roof;

function assumptionsError(detail: string): never {
  throw new F401ProviderError(`Planungsannahme v2 verletzt: ${detail}`);
}

const profileRoofV2Schema = z.object({
  id: z.string().trim().min(1).max(64),
  areaM2: z.number().finite().gt(0),
  tiltDeg: z.number().finite().min(0).max(90),
  // Profil-Konvention: Sued-Null [-180,180], Ost negativ (v1-Schema).
  // Die Geometrie (Nord-Uhrzeigersinn) bedient spaeter den Hay-Slice.
  azimuthDeg: z.number().finite().min(-180).max(180),
});

export type ResolvedRoofV2 = {
  roofId: string;
  tiltDeg: number;
  azimuthDeg: number;
  areaM2: number;
  peakPowerKwp: number;
  pvTechnology: PlanningRoofAssumptionsV2["pvTechnology"];
  mountingPlace: PlanningRoofAssumptionsV2["mountingPlace"];
  systemLossPercent: PlanningRoofAssumptionsV2["systemLossPercent"];
  paramsVersion: typeof PLANNING_ASSUMPTIONS_V2_VERSION;
};

/**
 * Belegte Profildaecher -> Provider-Eingaben mit kWp aus belegter Flaeche.
 * 1..4 Daecher (p-distribute-Grenze); darueber fail-closed statt stiller
 * Auswahl. Keine Katalogbindung noetig: Die Annahmen sind versioniert und
 * wandern als paramsVersion in die Fetch-Provenienz.
 */
export function resolveRoofProviderInputsV2(input: {
  roofs: unknown;
}): ResolvedRoofV2[] {
  if (!Array.isArray(input.roofs) || input.roofs.length === 0) {
    assumptionsError("kein Dach gebunden");
  }
  if (input.roofs.length > 4) {
    assumptionsError(`mehr als 4 Daeche gebunden (${input.roofs.length})`);
  }
  return input.roofs.map((roof, index) => {
    const parsed = profileRoofV2Schema.safeParse(roof);
    if (!parsed.success) {
      assumptionsError(`Dach ${index} verletzt die Profilform`);
    }
    const value = parsed.data;
    return {
      roofId: value.id,
      tiltDeg: value.tiltDeg,
      azimuthDeg: value.azimuthDeg,
      areaM2: value.areaM2,
      peakPowerKwp: value.areaM2
        * PLANNING_ASSUMPTIONS_V2.roof.specificPowerWPerM2 / 1000,
      pvTechnology: PLANNING_ASSUMPTIONS_V2.roof.pvTechnology,
      mountingPlace: PLANNING_ASSUMPTIONS_V2.roof.mountingPlace,
      systemLossPercent: PLANNING_ASSUMPTIONS_V2.roof.systemLossPercent,
      paramsVersion: PLANNING_ASSUMPTIONS_V2_VERSION,
    };
  });
}

const LOAD_SOURCE_ID_PREFIX = "wmee-uniform-load" as const;

function loadSourceSha256(sourceKind: string, annualKwh: number): string {
  return createHash("sha256")
    .update(
      canonicalizeCalculationJson({
        paramsVersion: PLANNING_ASSUMPTIONS_V2_VERSION,
        basisShape: PLANNING_ASSUMPTIONS_V2.load.basisShape,
        sourceKind,
        annualKwh,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Uniforme Zunaechst-Lastquelle aus belegten Jahres-kWh: energieexakt,
 * formfrei, provenance-gebunden (Annahmen-Version + kWh im SHA). Wirft bei
 * nicht-endlichen/negativen kWh (keine erfundenen Verbraeuche).
 */
export function buildUniformLoadSourceV2(input: {
  sourceKind: LoadProfileSourceV2["sourceKind"];
  annualKwh: number;
}): LoadProfileSourceV2 {
  const annualKwh = input.annualKwh;
  if (typeof annualKwh !== "number" || !Number.isFinite(annualKwh) || annualKwh < 0) {
    assumptionsError(`Lastquelle ${input.sourceKind} hat ungueltige kWh`);
  }
  const slotEnergyKwh = new Array<number>(QUARTER_HOUR_SLOTS).fill(
    annualKwh / QUARTER_HOUR_SLOTS,
  );
  const parsed = loadProfileSourceV2Schema.safeParse({
    sourceKind: input.sourceKind,
    sourceId: `${LOAD_SOURCE_ID_PREFIX}-${input.sourceKind}.v1`,
    sourceRevision: PLANNING_ASSUMPTIONS_V2_VERSION,
    sourceSha256: loadSourceSha256(input.sourceKind, annualKwh),
    slotEnergyKwh,
  });
  if (!parsed.success) {
    assumptionsError(`Lastquelle ${input.sourceKind} verletzt das Quellschema`);
  }
  return parsed.data;
}
