import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EnergyCalculationSection } from "@/app/w/[workspaceId]/anfragen/[projectId]/energy-calculation-section";
import { EnergyProfileSection } from "@/app/w/[workspaceId]/anfragen/[projectId]/energy-profile-section";
import type { ProjectEnergyContext } from "@/modules/energy";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(
    resolve(import.meta.dirname, `../../contracts/examples/${name}`),
    "utf8",
  ));
}

function currentContext(): ProjectEnergyContext {
  const request = fixture("planning-calculation.v1.new.request.json") as {
    energyProfile: NonNullable<ProjectEnergyContext["profile"]>["value"];
    resolvedAssumptions: Extract<
      ProjectEnergyContext["calculation"],
      { status: "current" }
    >["result"]["assumptions"];
  };
  const result = fixture("planning-calculation.v1.new.result.json") as Extract<
    ProjectEnergyContext["calculation"],
    { status: "current" }
  >["result"]["value"];
  return {
    projectId: PROJECT_ID,
    siteId: "30000000-0000-4000-8000-000000000003",
    addressRevision: 3,
    profile: {
      id: "40000000-0000-4000-8000-000000000004",
      revision: 2,
      addressRevision: 3,
      confirmed: true,
      value: request.energyProfile,
    },
    calculation: {
      status: "current",
      jobId: "50000000-0000-4000-8000-000000000005",
      result: {
        id: "60000000-0000-4000-8000-000000000006",
        revision: 1,
        value: result,
        binding: {
          addressRevision: 3,
          profile: { id: "40000000-0000-4000-8000-000000000004", revision: 2 },
          requirement: { id: "70000000-0000-4000-8000-000000000007", revision: 1 },
        },
        assumptions: request.resolvedAssumptions,
        sources: {
          providerRecipeVersion: "pvgis-v5_3-hourly-pvcalc.v1",
          contractVersion: result.contractVersion,
          canonicalizationVersion: result.canonicalizationVersion,
          schemaSha256: "1".repeat(64),
          defaultsVersion: "wmee-planning-defaults.v1",
          modelId: result.model.id,
          modelVersion: result.model.version,
          sourceRevision: result.model.sourceRevision,
        },
      },
    },
    capabilities: { canEdit: true, canConfirm: true, canRetry: false },
  };
}

describe("M1-07 Energie-UI-Zustände", () => {
  it("rendert ein aktuelles Serverresultat mit Monats- und Provenienztabelle ohne Economics oder Provider-Rohdaten", () => {
    const html = renderToStaticMarkup(createElement(EnergyCalculationSection, {
      context: currentContext(),
    }));

    expect(html).toContain('data-energy-calculation-state="current"');
    expect(html).toContain("Serverseitig neu berechnete Schätzung");
    expect(html).toContain("Nicht F4-referenzvalidiert und nicht angebotsreif");
    expect(html).toContain("Monatsergebnisse der serverseitigen Schätzung");
    expect(html).toContain("Annahmen und technische Provenienz");
    expect(html).toContain("Ergebnis-Hash");
    expect(html).not.toContain("market_estimate");
    expect(html).not.toContain("investmentCents");
    expect(html).not.toContain("hourlyPowerWPerKwp");
    expect(html).not.toContain("rawResponseSha256");
  });

  it("bildet Blocker und aktive Zustände ehrlich ab und bietet nur Statusrefresh", () => {
    const blocked = currentContext();
    blocked.calculation = {
      status: "blocked",
      blocker: "address_pin",
      jobId: null,
      result: null,
    };
    const blockedHtml = renderToStaticMarkup(createElement(EnergyCalculationSection, {
      context: blocked,
    }));
    expect(blockedHtml).toContain('data-energy-calculation-state="blocked"');
    expect(blockedHtml).toContain("Planungs-Pin müssen bestätigt sein");
    expect(blockedHtml).not.toContain("Erneut berechnen");

    const running = currentContext();
    running.calculation = {
      status: "retry_wait",
      jobId: "50000000-0000-4000-8000-000000000005",
      attemptCount: 2,
      result: null,
    };
    const runningHtml = renderToStaticMarkup(createElement(EnergyCalculationSection, {
      context: running,
    }));
    expect(runningHtml).toContain('data-energy-calculation-state="retry_wait"');
    expect(runningHtml).toContain("Status aktualisieren");
    expect(runningHtml.match(/aria-live=/gu)).toHaveLength(1);
    expect(runningHtml).not.toContain("Erneut berechnen");
  });

  it("sanitisiert unbekannte Provider-/Enginefehler statt den Rohcode zu rendern", () => {
    const context = currentContext();
    const privateCode = "provider_body_customer-4711-secret";
    context.calculation = {
      status: "failed",
      jobId: "50000000-0000-4000-8000-000000000005",
      attemptCount: 10,
      errorCode: privateCode,
      retryable: false,
      result: null,
    };

    const html = renderToStaticMarkup(createElement(EnergyCalculationSection, { context }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Interne Details werden nicht im Browser angezeigt");
    expect(html).not.toContain(privateCode);
    expect(html).toContain("keine öffentliche Retry-Aktion");
    expect(html).not.toContain("Erneut berechnen");
  });

  it("trennt no_profile und read_only und rendert für Viewer keine Mutation", () => {
    const noProfile = currentContext();
    noProfile.profile = null;
    noProfile.calculation = {
      status: "blocked",
      blocker: "energy_profile",
      jobId: null,
      result: null,
    };
    const noProfileHtml = renderToStaticMarkup(createElement(EnergyProfileSection, {
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      context: noProfile,
    }));
    expect(noProfileHtml).toContain('data-energy-profile-state="no_profile"');
    expect(noProfileHtml).toContain("Energieprofil anlegen");

    const readOnly = currentContext();
    readOnly.capabilities = { canEdit: false, canConfirm: false, canRetry: false };
    const readOnlyHtml = renderToStaticMarkup(createElement(EnergyProfileSection, {
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      context: readOnly,
    }));
    expect(readOnlyHtml).toContain('data-energy-profile-state="read_only"');
    expect(readOnlyHtml).toContain("Nur Lesezugriff");
    expect(readOnlyHtml).not.toContain("<form");
    expect(readOnlyHtml).not.toContain("Energieprofil prüfen und bearbeiten");
  });

  it("bietet bei veralteter Planung eine bewusste neue Bindung statt eines Fake-Retry an", () => {
    const context = currentContext();
    context.calculation = {
      status: "stale",
      jobId: "50000000-0000-4000-8000-000000000005",
      result: null,
    };

    const html = renderToStaticMarkup(createElement(EnergyProfileSection, {
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      context,
    }));

    expect(html).toContain("erneut");
    expect(html).toContain("Eingaben bestätigen");
    expect(html).toContain("expectedProfileRevision");
    expect(html).not.toContain("Erneut berechnen");
  });
});
