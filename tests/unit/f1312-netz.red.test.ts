import { describe, expect, it } from "vitest";

import * as gridModule from "@/modules/grid-registration";
import {
  GRID_REGISTRATION_STATUS_LABEL,
  gridRegistrationStatuses,
  nextGridRegistrationStatuses,
  type GridRegistrationStatus,
} from "@/modules/grid-registration";
import { portalGridSchema } from "@/lib/integrations/portal/portal-contract";

// F13-12 Netzanmeldung-Vertiefung (RED-Spec, Ref
// docs/spec/F13-12-netzanmeldung-vertiefung.md): NUR existierende Imports —
// kein Import aus noch nicht geschriebenem Code. ROT-Beleg per
// `npx vitest run tests/unit/f1312-netz.red.test.ts` (6 rote Tests, Auszug in
// der Spec); danach describe.skip bis zur Umsetzung.

// F13-12 GREEN-Slice (Migration 0261): entskippt 2026-09-20, muss GRÜN werden.
// Spec: docs/spec/F13-12-netzanmeldung-vertiefung.md.
describe("F13-12 Netzanmeldung-Vertiefung (GREEN-Slice 0261)", () => {
  it("Rückfrage-Loop: eingereicht ↔ rueckfrage ist begehbar", () => {
    expect(gridRegistrationStatuses as readonly string[]).toContain("rueckfrage");
    expect(nextGridRegistrationStatuses("eingereicht")).toContain("rueckfrage");
    expect(nextGridRegistrationStatuses("rueckfrage" as GridRegistrationStatus)).toContain(
      "eingereicht",
    );
  });

  it("Einspeisezusage steht zwischen genehmigt und fertiggemeldet", () => {
    expect(gridRegistrationStatuses as readonly string[]).toContain("einspeisezusage");
    expect(GRID_REGISTRATION_STATUS_LABEL).toHaveProperty("einspeisezusage");
    expect(nextGridRegistrationStatuses("genehmigt")).toContain("einspeisezusage");
    expect(portalGridSchema.shape.status.safeParse("einspeisezusage").success).toBe(true);
  });

  it("Fertigmeldung ohne Zählernummer ist abgewiesen (Guard-Export)", () => {
    expect("GRID_REGISTRATION_FERTIGMELDUNG_REQUIRES_METER" in gridModule).toBe(true);
  });

  it("Foto-Mindestzahl 16 ist als Konstante exportiert", () => {
    expect("GRID_REGISTRATION_FERTIGMELDUNG_MIN_PHOTOS" in gridModule).toBe(true);
    expect(
      (gridModule as unknown as Record<string, unknown>)
        .GRID_REGISTRATION_FERTIGMELDUNG_MIN_PHOTOS,
    ).toBe(16);
  });

  it("Add-on-Flags MaStR + Wallbox mit Preis-Snapshot sind vorgesehen", () => {
    expect("GRID_REGISTRATION_ADDONS" in gridModule).toBe(true);
  });

  it("Details-Sperre: Edit nur in vorbereitung/rueckfrage", () => {
    expect("GRID_REGISTRATION_EDITABLE_STATUSES" in gridModule).toBe(true);
    expect(
      (gridModule as unknown as Record<string, unknown>).GRID_REGISTRATION_EDITABLE_STATUSES,
    ).toEqual(["vorbereitung", "rueckfrage"]);
  });
});
