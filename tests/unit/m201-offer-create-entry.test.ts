import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/w/[workspaceId]/angebote/actions", () => ({
  createOfferFromRequestAction: vi.fn(),
}));

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";

type TestComponent = ComponentType<Record<string, unknown>>;

async function loadEntry(): Promise<TestComponent> {
  const importedModule = await import(
    "@/app/w/[workspaceId]/anfragen/[projectId]/offer-create-entry"
  );
  return importedModule.OfferCreateEntry as TestComponent;
}

async function loadFeedback(): Promise<TestComponent> {
  const importedModule = await import(
    "@/app/w/[workspaceId]/anfragen/[projectId]/offer-create-entry"
  );
  return importedModule.OfferCreateFeedback as TestComponent;
}

function readyView() {
  return {
    state: "ready",
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    customerDisplayName: "Mia Müller",
    installationSiteLabel: "Solstraße 8, 10115 Berlin",
    input: {
      expectedRequirementRevision: 7,
      expectedCalculationRevision: 8,
      expectedResolutionRevision: 9,
    },
  };
}

describe("M2-01 Projektakte → Angebotsentwurf", () => {
  it("rendert für einen bereiten Editor den echten Create-Command ohne Clientpreise", async () => {
    const OfferCreateEntry = await loadEntry();
    const html = renderToStaticMarkup(createElement(OfferCreateEntry, {
      view: readyView(),
    }));

    expect(html).toContain('data-offer-create-state="ready"');
    expect(html).toContain("Angebotsentwurf erstellen");
    expect(html).toContain("Mia Müller");
    expect(html).toContain("Solstraße 8, 10115 Berlin");
    expect(html).toContain('name="expectedRequirementRevision" value="7"');
    expect(html).toContain('name="expectedCalculationRevision" value="8"');
    expect(html).toContain('name="expectedResolutionRevision" value="9"');
    expect(html).toContain('name="priceAudience" value="b2c"');
    expect(html).toContain('name="priceAudienceConfirmation.code" value="b2c_operator_confirmed"');
    expect(html).toContain("B2C-Preiszielgruppe ausdrücklich bestätigen");
    expect(html).toContain("Forecast netto in Euro (optional)");
    expect(html).toContain('name="forecastValueNetCents"');
    expect(html).toContain("Steuerentwurf");
    expect(html).toContain('value="standard_19"');
    expect(html).toContain('value="zero_operator_confirmed"');
    expect(html).toContain("0-%-Steuerentwurf");
    expect(html).not.toContain("purchasePrice");
    expect(html).not.toContain("salesPriceNetCents");
    expect(html).not.toContain("resolutionSha256");
  });

  it("entfernt den Create-Command für Read-only und zeigt konkrete Blocker mit Rücksprung", async () => {
    const OfferCreateEntry = await loadEntry();
    const readOnly = renderToStaticMarkup(createElement(OfferCreateEntry, {
      view: {
        state: "read_only",
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
      },
    }));
    expect(readOnly).toContain('data-offer-create-state="read_only"');
    expect(readOnly).toContain("Nur Lesezugriff");
    expect(readOnly).not.toContain("<form");
    expect(readOnly).not.toContain('type="submit"');

    const blocked = renderToStaticMarkup(createElement(OfferCreateEntry, {
      view: {
        state: "blocked",
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        blockers: [{
          code: "catalog_stale",
          label: "Die Produktauflösung ist nicht mehr aktuell.",
          href: `/w/${WORKSPACE_ID}/anfragen/${PROJECT_ID}/produkte`,
          actionLabel: "Produktauflösung aktualisieren",
        }],
      },
    }));
    expect(blocked).toContain('data-offer-create-state="blocked"');
    expect(blocked).toContain('role="alert"');
    expect(blocked).toContain("Die Produktauflösung ist nicht mehr aktuell.");
    expect(blocked).toContain("Produktauflösung aktualisieren");
    expect(blocked).not.toContain("<form");
  });

  it("bildet invalid, denied, blocked, conflict, unavailable und unauthenticated verständlich ab", async () => {
    const OfferCreateFeedback = await loadFeedback();
    const renderState = (state: Record<string, unknown>) => renderToStaticMarkup(
      createElement(OfferCreateFeedback, {
        state,
      }),
    );

    expect(renderState({ status: "pending" })).toContain("serverseitig erstellt");
    expect(renderState({ status: "invalid" })).toContain("Eingaben prüfen");
    expect(renderState({ status: "denied" })).toContain("Berechtigung");
    const blocked = renderState({ status: "blocked", code: "catalog_pricing_missing" });
    expect(blocked).toMatch(/Produktpreise|Katalogpreise/iu);
    expect(blocked).not.toContain("catalog_pricing_missing");
    expect(blocked).not.toContain("Sitzung ist abgelaufen");
    expect(renderState({ status: "conflict" })).toContain("Projektstand hat sich geändert");
    expect(renderState({
      status: "unavailable",
      retryAfter: "2026-08-30T12:15:00.000Z",
    })).toContain("vorübergehend ausgeschöpft");
    const unauthenticated = renderState({ status: "unauthenticated" });
    expect(unauthenticated).toContain("Sitzung ist abgelaufen");
    expect(unauthenticated).toContain("Erneut anmelden");
    expect(unauthenticated).toContain('href="/login"');
    expect(unauthenticated).not.toContain(WORKSPACE_ID);
  });
});
