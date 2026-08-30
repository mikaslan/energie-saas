import { describe, expect, it } from "vitest";
import {
  buildOfferCreateView,
  euroForecastToCents,
} from "@/app/w/[workspaceId]/anfragen/[projectId]/offer-create-view";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";

function baseInput() {
  return {
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    detailPath: `/w/${WORKSPACE_ID}/anfragen/${PROJECT_ID}`,
    detail: {
      phase: "request",
      outcome: "open",
      sourceLabel: "Solarrechner",
      submittedAt: "2026-08-30T10:00:00.000Z",
      customerDisplayName: "Mia Müller",
      installationSiteLabel: "Solstraße 8, 10115 Berlin",
      blockers: {
        dedupeReviewRequired: false,
        addressFollowUpRequired: false,
        pinConfirmationRequired: false,
        catalogResolutionPending: false,
      },
    },
    gate: {
      canCreate: true,
      configurationBlockers: [],
      catalog: {
        state: "current",
        blocker: null,
        expectedRequirementRevision: 3,
        expectedCalculationRevision: 4,
        expectedResolutionRevision: 5,
      },
    },
  } as const;
}

describe("M2-01 Offer-Create-Projektion", () => {
  it("gibt ausschließlich für den aktuellen serverseitigen Revisionssatz ready frei", () => {
    expect(buildOfferCreateView(baseInput())).toEqual({
      state: "ready",
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      customerDisplayName: "Mia Müller",
      installationSiteLabel: "Solstraße 8, 10115 Berlin",
      input: {
        expectedRequirementRevision: 3,
        expectedCalculationRevision: 4,
        expectedResolutionRevision: 5,
      },
    });
  });

  it("rendert Viewer strukturell read-only und priorisiert keine vertraulichen Blocker", () => {
    const input = baseInput();
    const view = buildOfferCreateView({
      ...input,
      gate: { ...input.gate, canCreate: false },
    });
    expect(view).toEqual({
      state: "read_only",
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
    });
  });

  it("liefert für jede fehlende Voraussetzung einen konkreten Rücksprung", () => {
    const input = baseInput();
    const view = buildOfferCreateView({
      ...input,
      detail: {
        ...input.detail,
        blockers: {
          ...input.detail.blockers,
          addressFollowUpRequired: true,
        },
      },
      gate: {
        ...input.gate,
        configurationBlockers: [{
          code: "offer_column",
          label: "Angebotsspalte fehlt",
        }],
        catalog: {
          state: "stale",
          blocker: null,
          expectedRequirementRevision: 3,
          expectedCalculationRevision: 4,
          expectedResolutionRevision: 5,
        },
      },
    });

    expect(view.state).toBe("blocked");
    if (view.state !== "blocked") throw new Error("expected blocked view");
    expect(view.blockers.map((blocker) => blocker.code)).toEqual([
      "address_follow_up",
      "offer_column",
      "catalog_stale",
    ]);
    expect(view.blockers.every((blocker) => blocker.href.startsWith("/w/"))).toBe(true);
  });

  it("blockiert historische/fehlende Revisionen und bereits konvertierte Projekte", () => {
    const input = baseInput();
    const missingRevision = buildOfferCreateView({
      ...input,
      gate: {
        ...input.gate,
        catalog: {
          ...input.gate.catalog,
          expectedCalculationRevision: null,
        },
      },
    });
    expect(missingRevision.state).toBe("blocked");

    const converted = buildOfferCreateView({
      ...input,
      detail: { ...input.detail, phase: "offer" },
    });
    expect(converted.state).toBe("converted");
  });

  it("wandelt optionale deutsche Forecast-Eingaben deterministisch in Cent um", () => {
    expect(euroForecastToCents("")).toBe("");
    expect(euroForecastToCents("12500")).toBe("1250000");
    expect(euroForecastToCents("12.500,25")).toBe("1250025");
    expect(euroForecastToCents("12500.25")).toBe("1250025");
    expect(euroForecastToCents("12,345")).toBeNull();
    expect(euroForecastToCents("-1")).toBeNull();
    expect(euroForecastToCents("90000000000000,01")).toBeNull();
  });
});
