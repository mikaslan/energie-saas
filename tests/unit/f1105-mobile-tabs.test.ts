import { describe, expect, it } from "vitest";

import {
  activeMobileTabId,
  isWorkspaceIdForTabs,
  MOBILE_MORE_LINKS,
  mobileTabSchema,
  tabsForWorkspace,
} from "@/lib/mobile/tabs";

const WS = "10000000-0000-4000-8000-000000000001";

describe("F11-05 mobile Tab-Leiste (Vertrag)", () => {
  it("F1105-U-01: liefert genau die 5 Katalog-Tabs mit deutschem Wortlaut", () => {
    const tabs = tabsForWorkspace(WS);
    expect(tabs.map((tab) => tab.label)).toEqual([
      "Home",
      "Projekte",
      "Aufgaben",
      "Kalender",
      "Mehr",
    ]);
    expect(tabs.map((tab) => tab.href)).toEqual([
      `/w/${WS}/dashboard`,
      `/w/${WS}/anfragen`,
      `/w/${WS}/aufgaben`,
      `/w/${WS}/kalender`,
      `/w/${WS}/mehr`,
    ]);
  });

  it("F1105-U-02: jeder Tab erfuellt das zod-Schema", () => {
    for (const tab of tabsForWorkspace(WS)) {
      expect(mobileTabSchema.safeParse(tab).success).toBe(true);
    }
  });

  it("F1105-U-10: Schema weist leere Labels, fremde IDs und Zusatz-Keys ab", () => {
    const valid = tabsForWorkspace(WS)[0]!;
    expect(mobileTabSchema.safeParse({ ...valid, label: "" }).success).toBe(false);
    expect(mobileTabSchema.safeParse({ ...valid, id: "settings" }).success).toBe(false);
    expect(mobileTabSchema.safeParse({ ...valid, segment: "dashboard" }).success).toBe(false);
    expect(mobileTabSchema.safeParse({ ...valid, href: "" }).success).toBe(false);
  });

  it("F1105-U-03: Aktiv-Erkennung trifft per Segment-Praefix", () => {
    expect(activeMobileTabId(`/w/${WS}/dashboard`, WS)).toBe("home");
    expect(activeMobileTabId(`/w/${WS}/anfragen/abc/checkliste`, WS)).toBe("projects");
    expect(activeMobileTabId(`/w/${WS}/aufgaben`, WS)).toBe("tasks");
    expect(activeMobileTabId(`/w/${WS}/kalender`, WS)).toBe("calendar");
    expect(activeMobileTabId(`/w/${WS}/mehr`, WS)).toBe("more");
  });

  it("F1105-U-04: kein Teilstring-Fehlmatch (angebote ist nicht anfragen)", () => {
    expect(activeMobileTabId(`/w/${WS}/angebote`, WS)).toBeNull();
    expect(activeMobileTabId(`/w/${WS}/anfragenarchiv`, WS)).toBeNull();
    expect(activeMobileTabId(`/w/${WS}/kalendertermine`, WS)).toBeNull();
  });

  it("F1105-U-05: fremder Workspace und fremde Pfade sind inaktiv", () => {
    expect(activeMobileTabId("/w/anderer-workspace/dashboard", WS)).toBeNull();
    expect(activeMobileTabId("/login", WS)).toBeNull();
    expect(activeMobileTabId(`/w/${WS}`, WS)).toBeNull();
    expect(activeMobileTabId(`/w/${WS}/`, WS)).toBeNull();
  });

  it("F1105-U-08: Trailing-Slash aendert die Aktiv-Erkennung nicht", () => {
    expect(activeMobileTabId(`/w/${WS}/dashboard/`, WS)).toBe("home");
    expect(activeMobileTabId(`/w/${WS}/mehr/`, WS)).toBe("more");
    expect(activeMobileTabId(`/w/${WS}/angebote/`, WS)).toBeNull();
  });

  it("F1105-U-09: Leisten-Guard akzeptiert nur UUID-foermige IDs", () => {
    expect(isWorkspaceIdForTabs(WS)).toBe(true);
    expect(isWorkspaceIdForTabs("keine-uuid")).toBe(false);
    expect(isWorkspaceIdForTabs("")).toBe(false);
  });

  it("F1105-U-06: Mehr-Seite verlinkt genau die 5 Bereiche mit Root-Seite", () => {
    expect(MOBILE_MORE_LINKS.map((link) => link.label)).toEqual([
      "Angebote",
      "Plantafel",
      "Rechnungen",
      "Sites",
      "Katalog",
    ]);
    expect(MOBILE_MORE_LINKS.map((link) => link.segment)).toEqual([
      "angebote",
      "plantafel",
      "rechnungen",
      "sites",
      "katalog",
    ]);
  });

  it("F1105-U-07: kein Link ohne Root-Seite (einstellungen hat keine)", () => {
    expect(MOBILE_MORE_LINKS.map((link) => link.segment)).not.toContain("einstellungen");
  });
});
