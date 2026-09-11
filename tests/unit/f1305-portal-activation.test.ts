import { describe, expect, it } from "vitest";

import { isPortalInviteUsable } from "@/lib/subsidy-case";

// Fixer Referenzzeitpunkt: 2026-01-15 12:00 Europe/Berlin.
const NOW = new Date("2026-01-15T12:00:00+01:00").getTime();

describe("F13-05 Aktivierungs-Bestand (Unit)", () => {
  it("F1305-U-01: fehlend, künftig, abgelaufen, exakt-jetzt, Fehlform", () => {
    expect(isPortalInviteUsable(null, NOW)).toBe(false);
    expect(
      isPortalInviteUsable({ expiresAt: "2026-01-29T12:00:00+01:00" }, NOW),
    ).toBe(true);
    // Abgelaufene active-Zeile (nur via Zeitablauf erreichbar, Guard
    // verbietet den Seed) zählt als fehlend und wird abgelöst.
    expect(
      isPortalInviteUsable({ expiresAt: "2026-01-14T12:00:00+01:00" }, NOW),
    ).toBe(false);
    // Grenze: Ablauf exakt jetzt ist kein Bestand mehr (strikt künftig).
    expect(
      isPortalInviteUsable({ expiresAt: "2026-01-15T12:00:00+01:00" }, NOW),
    ).toBe(false);
    // Fehlform fail-closed.
    expect(isPortalInviteUsable({ expiresAt: "kein-datum" }, NOW)).toBe(false);
    expect(isPortalInviteUsable({ expiresAt: "" }, NOW)).toBe(false);
  });
});
