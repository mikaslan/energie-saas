import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const ROUTE = "app/w/[workspaceId]/anfragen/[projectId]";

describe("M1-07 Energie-UI-/Build-Vertrag", () => {
  it("autorisiert das Energy-Readmodel sequenziell nach der bestehenden Projektakte", async () => {
    const page = await readFile(`${ROUTE}/page.tsx`, "utf8");
    const detailRead = page.indexOf("await loadProjectDetail");
    const energyRead = page.indexOf("await loadProjectEnergy");

    expect(detailRead).toBeGreaterThan(-1);
    expect(energyRead).toBeGreaterThan(detailRead);
    expect(page).toContain("getProjectEnergyContext");
    expect(page).toContain("<EnergyProfileSection");
    expect(page).toContain("<EnergyCalculationSection");
    expect(page).toContain("Importierte Rechner-Schätzung (ungeprüft)");
  });

  it("hält alle fachlichen Zustände explizit und erfindet keine Retry- oder Economics-Funktion", async () => {
    const calculation = await readFile(`${ROUTE}/energy-calculation-section.tsx`, "utf8");
    const refresh = await readFile(`${ROUTE}/energy-status-refresh.tsx`, "utf8");
    for (const state of [
      "blocked",
      "queued",
      "running",
      "retry_wait",
      "current",
      "stale",
      "failed",
    ]) {
      expect(calculation).toContain(`\"${state}\"`);
    }
    expect(refresh).toContain("Status aktualisieren");
    expect(
      calculation.includes("canRetry: false")
      || calculation.includes("keine öffentliche Retry-Aktion"),
    ).toBe(true);
    expect(calculation).not.toContain("market_estimate");
    expect(calculation).not.toContain("amortization");
    expect(calculation).not.toContain("cashflow");
  });

  it("nutzt im Client nur Energy-Typen und keine node:crypto-Vertragsruntime", async () => {
    const editor = await readFile(`${ROUTE}/energieprofil/energy-profile-editor.tsx`, "utf8");
    const refresh = await readFile(`${ROUTE}/energy-status-refresh.tsx`, "utf8");

    expect(editor).toContain('import type { ProjectEnergyProfileCandidate } from "@/modules/energy"');
    expect(editor).not.toContain("lib/integrations/calculation/contract");
    expect(editor).not.toContain("node:crypto");
    expect(editor).toContain("Default-Dach durch diese neu erfasste Ersatzgeometrie ersetzen?");
    expect(editor).toContain('aria-live={failed ? "assertive" : "polite"}');
    expect(editor).toContain("min-h-11");
    expect(editor).toContain("sm:grid-cols-2");
    expect(refresh).toContain('aria-live="polite"');
  });

  it("parst Actions geschlossen und führt Preflight vor frischer Save-Mutation aus", async () => {
    const actions = await readFile(
      "app/w/[workspaceId]/anfragen/energy-actions.ts",
      "utf8",
    );
    const confirm = await readFile(`${ROUTE}/energy-confirm-form.tsx`, "utf8");
    const preflight = actions.indexOf("candidate = await authorizedQuery");
    const mutation = actions.indexOf("const result = await authorizedAction", preflight);

    expect(actions).toContain("baseProfileFields");
    expect(actions).toContain("roofFieldSuffixes");
    expect(actions).toContain('name.startsWith("$ACTION_")');
    expect(actions).toContain("seen.size !== allowed.size");
    expect(preflight).toBeGreaterThan(-1);
    expect(mutation).toBeGreaterThan(preflight);
    expect(actions).toContain("getProjectEnergyProfileCandidate");
    expect(actions).toContain("saveProjectEnergyProfile");
    expect(actions).not.toContain("reservationKey: result.reservationKey");
    expect(actions).toContain("EnergyProfileRateLimitError");
    expect(actions).toContain('status: "rate_limited"');
    expect(confirm).toContain("Zu viele neue Berechnungen. Bitte in");
    expect(confirm).toContain('role={state.status !== "idle" && !succeeded ? "alert" : "status"}');
  });
});
