import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const PROJECT_ROUTE = "app/w/[workspaceId]/anfragen/[projectId]";

describe("M1-06 Adresskorrektur-UI-Vertrag", () => {
  it("rendert Mutationscontrols ausschließlich über die fachliche UI-Berechtigung", async () => {
    const page = await readFile(`${PROJECT_ROUTE}/page.tsx`, "utf8");

    expect(page).toContain("detail.permissions.canCorrectAddress ?");
    expect(page).toContain("<AddressEditor");
    expect(page).toContain("addressRevision={detail.site.addressRevision}");
    expect(page).toContain("Adressrevision");
    expect(page).toContain("detail.site.pinAdjusted");
    expect(page).toContain('title: "Projektakte | Energie-SaaS"');
  });

  it("hält Suche, strukturierte Daten und Save-Action tastatur- und screenreaderfähig", async () => {
    const editor = await readFile(`${PROJECT_ROUTE}/address-editor.tsx`, "utf8");

    expect(editor).toContain('role="combobox"');
    expect(editor).toContain('role="listbox"');
    expect(editor).toContain('role="option"');
    expect(editor).toContain('event.key === "ArrowDown"');
    expect(editor).toContain('event.key === "ArrowUp"');
    expect(editor).toContain('event.key === "Enter"');
    expect(editor).toContain('event.key === "Escape"');
    expect(editor).toContain('event.key === "Tab"');
    expect(editor).toContain("Straße und Hausnummer");
    expect(editor).toContain("PLZ und Ort");
    expect(editor).toContain("Aktueller Planungs-Pin");
    expect(editor).toContain('aria-live="polite"');
    expect(editor).toContain('role={correctionFailed ? "alert" : "status"}');
    expect(editor).toContain("Adresse übernehmen");
    expect(editor).toContain("bestätigt den Planungs-Pin noch nicht");
  });

  it("bietet eine scrollsichere Karte mit sichtbarer Attribution und gleichwertigen Nudge-Controls", async () => {
    const map = await readFile(`${PROJECT_ROUTE}/address-pin-map.tsx`, "utf8");

    expect(map).toContain('mapStyle={MAP_STYLE_URL}');
    expect(map).toContain('scrollZoom={false}');
    expect(map).toContain("cooperativeGestures");
    expect(map).toContain('attributionControl={{ compact: false }}');
    expect(map).toContain('min-h-11 min-w-11');
    expect(map).toContain("nach Norden verschieben");
    expect(map).toContain("nach Westen verschieben");
    expect(map).toContain("nach Süden verschieben");
    expect(map).toContain("nach Osten verschieben");
    expect(map).toContain("Geoapify");
    expect(map).toContain("OpenStreetMap-Mitwirkende");
    expect(map).toContain("OpenFreeMap");
  });

  it("führt Preflight, Provider-I/O und frische Mutation in dieser Reihenfolge aus", async () => {
    const actions = await readFile(
      "app/w/[workspaceId]/anfragen/project-actions.ts",
      "utf8",
    );
    const preflight = actions.indexOf("const context = await authorizedQuery");
    const provider = actions.indexOf("resolvedAddress = await resolveAddressCandidate");
    const mutation = actions.indexOf("const result = await authorizedAction");

    expect(preflight).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(preflight);
    expect(mutation).toBeGreaterThan(provider);
    expect(actions).toContain("getProjectAddressCorrectionContext");
    expect(actions).toContain("correctProjectSiteAddress");
    expect(actions).toContain('return { status: "stale" }');
    expect(actions).toContain('return { status: "shared_site" }');
    expect(actions).toContain('return { status: "pin_out_of_range" }');
  });
});
