import { describe, expect, it } from "vitest";

import { parsePortalPublicView } from "@/lib/integrations/portal/portal-contract";

const INVITE = "33333333-3333-4333-8333-333333333333";
const PROJECT = "22222222-2222-4222-8222-222222222222";

const BASE_VIEW = {
  status: "ok",
  inviteId: INVITE,
  expiresAt: "2026-10-01T00:00:00.000Z",
  viewCount: 0,
  project: { id: PROJECT, name: "P", phase: "installation", outcome: "open", scope: "residential" },
  documents: [],
  appointments: [],
};

function installationEntry(patch: Record<string, unknown> = {}) {
  return {
    status: "active",
    completedAt: null,
    handoverAt: null,
    timeline: [],
    statusLabels: {},
    statusFaq: {},
    ...patch,
  };
}

describe("F10-14 Installations-Sichtbarkeit (Portal-Contract)", () => {
  it("F1014-CONTRACT-01: statusVisibility fehlt={}, gesetzt/fehlend ehrlich, deformiert=null", () => {
    // Alt-Projektion ohne Schlüssel → ehrlich {} (alles sichtbar).
    const legacy = parsePortalPublicView({
      ...BASE_VIEW,
      installation: installationEntry(),
    });
    expect(legacy?.installation?.statusVisibility).toEqual({});

    // Gesetzte Schlüssel ehrlich, fehlende fehlen (kein false-Default).
    const mapped = parsePortalPublicView({
      ...BASE_VIEW,
      installation: installationEntry({ statusVisibility: { active: false, handover: true } }),
    });
    expect(mapped?.installation?.statusVisibility).toEqual({ active: false, handover: true });

    // Deformiert bricht fail-closed ab (kein Teil-Parse).
    for (const statusVisibility of [
      { geheim: true },
      { active: "nein" },
      { active: 0 },
      { active: null },
      "sichtbar",
      42,
      null,
    ]) {
      expect(
        parsePortalPublicView({
          ...BASE_VIEW,
          installation: installationEntry({ statusVisibility }),
        }),
      ).toBeNull();
    }
  });
});
