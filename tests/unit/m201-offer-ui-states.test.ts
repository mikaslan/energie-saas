import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { formatOfferCents, formatOfferCentsTotal } from "@/app/w/[workspaceId]/angebote/[offerId]/offer-format";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock("@/app/w/[workspaceId]/angebote/actions", () => ({
  saveOfferVariantDraftAction: vi.fn(),
  duplicateOfferVariantEditorAction: vi.fn(),
  createVariantFromCurrentResolutionEditorAction: vi.fn(),
}));

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";
const OFFER_ID = "30000000-0000-4000-8000-000000000003";
const VARIANT_ID = "40000000-0000-4000-8000-000000000004";
const SECTION_ID = "50000000-0000-4000-8000-000000000005";
const LINE_ID = "60000000-0000-4000-8000-000000000006";

type TestComponent = ComponentType<Record<string, unknown>>;

async function loadOfferListView(): Promise<TestComponent> {
  const importedModule = await import("@/app/w/[workspaceId]/angebote/offer-list-view");
  return importedModule.OfferListView as TestComponent;
}

async function loadOfferDetailView(): Promise<TestComponent> {
  const importedModule = await import(
    "@/app/w/[workspaceId]/angebote/[offerId]/offer-detail-view"
  );
  return importedModule.OfferDetailView as TestComponent;
}

async function loadDirtyNavigationDialog(): Promise<TestComponent> {
  const importedModule = await import(
    "@/app/w/[workspaceId]/angebote/[offerId]/dirty-navigation-guard"
  );
  return importedModule.DirtyNavigationDialog as TestComponent;
}

function render(Component: TestComponent, props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(Component, props));
}

function expectNoFutureControls(html: string): void {
  for (const label of [
    "PDF erstellen",
    "PDF herunterladen",
    "Angebot versenden",
    "Zur Signatur",
    "Signatur starten",
    "Jetzt signieren",
  ]) {
    expect(html).not.toContain(label);
  }
}

function listView(state: "loaded" | "empty" | "blocked" | "read_only") {
  return {
    state,
    workspaceId: WORKSPACE_ID,
    permissions: { canCreate: state !== "read_only" },
    blockers: state === "blocked"
      ? [{ code: "offer_column", label: "Angebotsspalte fehlt" }]
      : [],
    columns: state === "empty" || state === "blocked"
      ? []
      : [{
          id: "70000000-0000-4000-8000-000000000007",
          title: "Angebote",
          offers: [{
            id: OFFER_ID,
            href: `/w/${WORKSPACE_ID}/angebote/${OFFER_ID}?variante=${VARIANT_ID}`,
            offerNumber: "ANG-2026-000001",
            customerDisplayName: "Mia Müller",
            installationSiteLabel: "Solstraße 8, 10115 Berlin",
            variantCount: 2,
            updatedAtLabel: "30.08.2026, 12:00",
            outdated: false,
          }],
        }],
  };
}

function variantView(includePrivateValues = false): Record<string, unknown> {
  const line: Record<string, unknown> = {
    lineDomainId: LINE_ID,
    position: 1,
    positionType: "required",
    isHidden: false,
    quantityMilli: 10_000,
    componentCategory: "module",
    source: { kind: "catalog" },
    product: {
      kind: "catalog",
      internalSku: "SYNTHETIC-PV-001",
      displayName: "Synthetisches PV-Modul",
      description: null,
      manufacturer: "WMEE Testwerk",
      model: "T-440",
      unit: "piece",
    },
    salesPricing: {
      originalUnitNetCents: 10_000,
      effectiveUnitNetCents: 10_000,
      provenance: { kind: "catalog_seed" },
    },
    lineDiscountBps: 0,
    taxTreatment: "standard_19",
    taxRateBps: 1_900,
    computed: {
      lineBaseNetCents: 100_000,
      lineDiscountedNetCents: 100_000,
      sectionDiscountedNetCents: 100_000,
      finalSalesNetCents: 100_000,
      salesTaxCents: 19_000,
      salesGrossCents: 119_000,
    },
  };
  if (includePrivateValues) {
    line.purchasePricing = {
      originalUnitNetCents: 4_321,
      effectiveUnitNetCents: 4_321,
      provenance: {
        kind: "manual_override",
        reasonCode: "negotiated",
        originalProvenance: { kind: "catalog_seed" },
      },
    };
    (line.computed as Record<string, unknown>).purchaseNetCents = 43_210;
    (line.computed as Record<string, unknown>).marginNetCents = 56_790;
  }

  const snapshot: Record<string, unknown> = {
    workspaceId: WORKSPACE_ID,
    offerId: OFFER_ID,
    variantId: VARIANT_ID,
    revision: 3,
    variantName: "Basis",
    description: "Synthetischer Angebotsentwurf",
    globalDiscountBps: 0,
    customDealNetCents: null,
    contactContext: { displayName: "Mia Müller" },
    installationSiteContext: {
      formattedAddress: "Solstraße 8, 10115 Berlin",
    },
    currency: "EUR",
    priceBasis: "net",
    sections: [{
      sectionDomainId: SECTION_ID,
      position: 1,
      title: "PV-Anlage",
      category: "module",
      discountBps: 0,
      lines: [line],
    }],
    totals: {
      basisNetCents: 100_000,
      basisTaxCents: 19_000,
      basisGrossCents: 119_000,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
  };
  if (includePrivateValues) {
    snapshot.snapshotSha256 = "PRIVATE-FULL-HASH-SENTINEL";
  }
  return { schemaVersion: "offer-variant-view.v1", snapshot };
}

function detailView(input: {
  state?: string;
  readOnly?: boolean;
  outdated?: boolean;
  includePrivateValues?: boolean;
  actionState?: Record<string, unknown>;
} = {}) {
  const readOnly = input.readOnly ?? false;
  return {
    state: input.state ?? (readOnly ? "read_only" : "loaded"),
    workspaceId: WORKSPACE_ID,
    recoveryScope: "a".repeat(64),
    offer: {
      id: OFFER_ID,
      projectId: PROJECT_ID,
      offerNumber: "ANG-2026-000001",
      status: "draft",
      outdated: input.outdated ?? false,
      forecastValueNetCents: 250_000,
    },
    variants: [{
      id: VARIANT_ID,
      name: "Basis",
      revision: 3,
      active: true,
      href: `/w/${WORKSPACE_ID}/angebote/${OFFER_ID}?variante=${VARIANT_ID}`,
    }],
    activeVariant: variantView(input.includePrivateValues),
    permissions: {
      canEdit: !readOnly,
      canDuplicate: !readOnly,
      canCreateBasis: !readOnly,
      canReadPurchasePrice: !readOnly && (input.includePrivateValues ?? false),
      canEditPrice: !readOnly,
      canApplyDiscount: !readOnly,
      canEditPurchasePrice: !readOnly && (input.includePrivateValues ?? false),
    },
    basisInput: readOnly ? undefined : {
      expectedRequirementRevision: 1,
      expectedCalculationRevision: 1,
      expectedResolutionRevision: 1,
    },
    actionState: input.actionState ?? { status: "idle" },
  };
}

describe("M2-01 Offer-UI-Zustände", () => {
  it("formatiert große und negative Centwerte ohne Float-Rundungsverlust", () => {
    expect(formatOfferCents(8_999_999_999_999_999)).toBe("89.999.999.999.999,99\u00a0€");
    expect(formatOfferCents(8_999_999_999_999_998)).toBe("89.999.999.999.999,98\u00a0€");
    expect(formatOfferCents(-56_790)).toBe("−567,90\u00a0€");
    expect(formatOfferCentsTotal([
      8_999_999_999_999_999,
      8_999_999_999_999_998,
    ])).toBe("179.999.999.999.999,97\u00a0€");
  });
  it("rendert befüllte, leere, blockierte und schreibgeschützte Angebotslisten ehrlich", async () => {
    const OfferListView = await loadOfferListView();

    const loaded = render(OfferListView, { view: listView("loaded") });
    expect(loaded).toContain('data-offer-list-state="loaded"');
    expect(loaded).toContain("ANG-2026-000001");
    expect(loaded).toContain("Mia Müller");
    expect(loaded).toContain("2 Varianten");

    const empty = render(OfferListView, { view: listView("empty") });
    expect(empty).toContain('data-offer-list-state="empty"');
    expect(empty).toContain("Noch keine Angebote");
    expect(empty).toContain("Anfragen öffnen");

    const blocked = render(OfferListView, { view: listView("blocked") });
    expect(blocked).toContain('data-offer-list-state="blocked"');
    expect(blocked).toContain("Angebotsspalte fehlt");
    expect(blocked).toContain('role="alert"');

    const readOnly = render(OfferListView, { view: listView("read_only") });
    expect(readOnly).toContain('data-offer-list-state="read_only"');
    expect(readOnly).not.toContain("Angebot erstellen");
    expectNoFutureControls(loaded + empty + blocked + readOnly);
  });

  it("zeigt den serverautoritativen Angebotsstand und Outdated ohne Snapshot-Propagation", async () => {
    const OfferDetailView = await loadOfferDetailView();

    const loaded = render(OfferDetailView, { view: detailView() });
    expect(loaded).toContain('data-offer-detail-state="loaded"');
    expect(loaded).toContain("ANG-2026-000001");
    expect(loaded).toContain("Basis");
    expect(loaded).toContain("Synthetisches PV-Modul");
    expect(loaded).toContain("Netto");
    expect(loaded).toContain("Brutto");

    const outdated = render(OfferDetailView, {
      view: detailView({ state: "outdated", outdated: true }),
    });
    expect(outdated).toContain('data-offer-detail-state="outdated"');
    expect(outdated).toMatch(/veraltet|nicht mehr aktuell/iu);
    expect(outdated).toContain('role="alert"');
    expect(outdated).toMatch(/Snapshot|gespeicherter Stand/iu);
    expectNoFutureControls(loaded + outdated);
  });

  it("rendert für Editoren echte Draftfelder, Reorder, Save und mobile Auswahl", async () => {
    const OfferDetailView = await loadOfferDetailView();
    const html = render(OfferDetailView, { view: detailView({ includePrivateValues: true }) });

    expect(html).toContain("Angebotsentwurf speichern");
    expect(html).toContain("Gespeichert");
    expect(html).toContain("Menge");
    expect(html).toContain("VK je Einheit");
    expect(html).toContain("Zeilenrabatt");
    expect(html).toContain("Positionsart");
    expect(html).toContain("Im Kundenangebot ausblenden");
    expect(html).toContain("Hoch");
    expect(html).toContain("Runter");
    expect(html).toContain("Globaler Rabatt %");
    expect(html).toContain("Custom Deal netto €");
    expect(html).toContain("In Sektion verschieben");
    expect(html).toContain("Freie Sektion hinzufügen");
    expect(html).toContain("Freie Position hinzufügen");
    expect(html).toContain("Steuer je Position");
    expect(html).toContain("Vertriebsprognose");
    expect(html).toContain("2.500,00");
    expect(html).toContain('name="mobile-variant"');
    expect(html).toContain("Variante öffnen");
    expect(html).toMatch(/Gespeicherter Serverstand|serverberechnet/iu);
    expect(html).toMatch(new RegExp(`id="line-${LINE_ID}-sales-reason"[^>]*disabled`, "u"));
  });

  it("erlaubt reinen Struktureditoren freie Sektionen, aber keine EK-pflichtigen freien Positionen", async () => {
    const OfferDetailView = await loadOfferDetailView();
    const view = detailView();
    view.permissions.canEditPrice = false;
    view.permissions.canApplyDiscount = false;
    view.permissions.canReadPurchasePrice = false;
    view.permissions.canEditPurchasePrice = false;

    const html = render(OfferDetailView, { view });

    expect(html).toContain("Freie Sektion hinzufügen");
    expect(html).not.toContain("Freie Position hinzufügen");
    expect(html).not.toContain("EK je Einheit €");
  });

  it("hält bestehende freie Metadaten nach Reload ohne Preis- oder EK-Recht editierbar", async () => {
    const OfferDetailView = await loadOfferDetailView();
    const view = detailView();
    view.permissions.canEditPrice = false;
    view.permissions.canApplyDiscount = false;
    view.permissions.canReadPurchasePrice = false;
    view.permissions.canEditPurchasePrice = false;
    const snapshot = view.activeVariant.snapshot as Record<string, unknown>;
    const sections = snapshot.sections as Array<Record<string, unknown>>;
    const line = (sections[0]?.lines as Array<Record<string, unknown>>)[0];
    if (!line) throw new Error("synthetische Offer-Zeile fehlt");
    line.source = { kind: "custom" };
    line.product = {
      kind: "custom",
      displayName: "Bestehende freie Position",
      description: "Bleibt editierbar",
      unit: "set",
    };

    const html = render(OfferDetailView, { view });

    expect(html).toContain(`id="line-${LINE_ID}-name"`);
    expect(html).toContain(`id="line-${LINE_ID}-description"`);
    expect(html).toContain(`id="line-${LINE_ID}-unit"`);
    expect(html).not.toContain("EK je Einheit €");
  });

  it("entfernt beim Viewer Mutation, EK, Marge, Einkaufsprovenienz und private Vollhashes", async () => {
    const OfferDetailView = await loadOfferDetailView();
    const html = render(OfferDetailView, {
      view: detailView({ readOnly: true, includePrivateValues: true }),
    });

    expect(html).toContain('data-offer-detail-state="read_only"');
    expect(html).toContain("Nur Lesezugriff");
    expect(html).toContain("Synthetisches PV-Modul");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Speichern");
    expect(html).not.toContain("Duplizieren");
    expect(html).not.toContain("Neue Basis");
    expect(html).not.toContain("Einkaufspreis");
    expect(html).not.toContain("Marge");
    expect(html).not.toMatch(/>EK</u);
    expect(html).not.toContain("PRIVATE-SUPPLIER-SENTINEL");
    expect(html).not.toContain("PRIVATE-FULL-HASH-SENTINEL");
    expect(html).toContain("VK-Preisprovenienz");
    expect(html).toContain("Katalogpreis");
    expect(html).toContain("Globaler Rabatt");
    expect(html).toContain("Kein Custom Deal");
    expectNoFutureControls(html);
  });

  it("erhält den Draft bei Conflict, Unavailable und Unauthenticated und sperrt Pending", async () => {
    const OfferDetailView = await loadOfferDetailView();
    const retryAfter = "2026-08-30T14:15:00.000Z";

    const conflict = render(OfferDetailView, {
      view: detailView({
        state: "conflict",
        actionState: { status: "conflict", currentRevision: 4 },
      }),
    });
    expect(conflict).toContain('data-offer-detail-state="conflict"');
    expect(conflict).toContain('role="alert"');
    expect(conflict).toMatch(/Revision 4/u);
    expect(conflict).toMatch(/Entwurf|Eingaben/iu);
    expect(conflict).not.toContain("Auf Revision 4 erneut anwenden");
    expect(conflict).toContain("Serverstand bewusst neu laden");
    expect(conflict).toMatch(/nicht.{0,30}(erneut|blind)|bewusst neu laden/iu);

    const unavailable = render(OfferDetailView, {
      view: detailView({
        state: "unavailable",
        actionState: { status: "unavailable", retryAfter },
      }),
    });
    expect(unavailable).toContain('data-offer-detail-state="unavailable"');
    expect(unavailable).toMatch(new RegExp(`dateTime="${retryAfter}"`, "iu"));
    expect(unavailable).toMatch(/Entwurf|Eingaben/iu);
    expect(unavailable).not.toMatch(/automatisch.{0,20}(erneut|wiederholen)/iu);

    const unauthenticated = render(OfferDetailView, {
      view: detailView({
        state: "unauthenticated",
        actionState: { status: "unauthenticated" },
      }),
    });
    expect(unauthenticated).toContain('data-offer-detail-state="unauthenticated"');
    expect(unauthenticated).toMatch(/Sitzung|Anmeldung/iu);
    expect(unauthenticated).toMatch(/Entwurf|Eingaben/iu);
    expect(unauthenticated).toMatch(/<button[^>]*>Zur Anmeldung<\/button>/iu);
    expect(unauthenticated).not.toContain('href="/login"');

    const pending = render(OfferDetailView, {
      view: detailView({ state: "pending", actionState: { status: "pending" } }),
    });
    expect(pending).toContain('data-offer-detail-state="pending"');
    expect(pending).toMatch(/<fieldset[^>]*disabled/iu);
    expect(pending).toContain('aria-live="polite"');
  });

  it("zeigt EK, Marge und Preisprovenienz nur dem dafür berechtigten Editor", async () => {
    const OfferDetailView = await loadOfferDetailView();
    const authorized = detailView({ includePrivateValues: true });
    authorized.permissions.canReadPurchasePrice = true;
    authorized.permissions.canEditPurchasePrice = true;
    const snapshot = authorized.activeVariant.snapshot as Record<string, unknown>;
    const sections = snapshot.sections as Array<Record<string, unknown>>;
    const line = (sections[0]?.lines as Array<Record<string, unknown>>)[0];
    if (!line) throw new Error("synthetische Offer-Zeile fehlt");
    line.source = { kind: "custom" };
    line.product = {
      kind: "custom",
      displayName: "Freie Sonderleistung",
      description: "Dokumentiert",
      unit: "piece",
    };
    const html = render(OfferDetailView, { view: authorized });

    expect(html).toContain("Einkaufspreis");
    expect(html).toContain("Marge");
    expect(html).toContain("Preisprovenienz");
    expect(html).toMatch(/Manuell|Katalog/iu);
    expect(html).toContain("EK je Einheit €");
    expect(html).toContain("Gespeicherter EK gesamt");
    expect(html).toContain("Gespeicherte Marge");
    expect(html).toMatch(/id="line-[^"]+-purchase-reason"[^>]*disabled/u);
  });

  it("zeigt bei gespeichertem manuellem VK-Override den tatsächlichen Grund", async () => {
    const OfferDetailView = await loadOfferDetailView();
    const view = detailView();
    const snapshot = view.activeVariant.snapshot as Record<string, unknown>;
    const sections = snapshot.sections as Array<Record<string, unknown>>;
    const line = (sections[0]?.lines as Array<Record<string, unknown>>)[0];
    if (!line) throw new Error("synthetische Offer-Zeile fehlt");
    const salesPricing = line.salesPricing as Record<string, unknown>;
    salesPricing.provenance = { kind: "manual_override", reasonCode: "negotiated" };

    const html = render(OfferDetailView, { view });

    expect(html).toContain("VK-Preisprovenienz: Manueller Override · Verhandelt");
  });

  it("rendert Steuer ohne price.edit strukturell nur lesbar", async () => {
    const OfferDetailView = await loadOfferDetailView();
    const view = detailView();
    view.permissions.canEditPrice = false;
    const html = render(OfferDetailView, { view });

    expect(html).toContain("Steuer je Position");
    expect(html).toContain("19 % USt.");
    expect(html).not.toContain(`id="line-${LINE_ID}-tax"`);
    expect(html).not.toContain("0-%-Steuerentwurf für diese Position frisch bestätigen");
  });

  it("trennt die lokale Money-Vorschau deutlich vom gespeicherten Serverstand", async () => {
    const OfferDetailView = await loadOfferDetailView();
    const html = render(OfferDetailView, { view: detailView() });

    expect(html).toContain("Lokale Preisvorschau · noch nicht gespeichert");
    expect(html).toContain("Preiswahrheit bleibt ausschließlich die erfolgreiche Serverrevision");
  });

  it("zeigt blockierte Mutationen redigiert und nur mit bewusster Aktualisierung", async () => {
    const OfferDetailView = await loadOfferDetailView();
    const html = render(OfferDetailView, {
      view: detailView({
        state: "blocked",
        actionState: { status: "blocked", code: "catalog_pricing_missing" },
      }),
    });

    expect(html).toContain('data-offer-detail-state="blocked"');
    expect(html).toMatch(/Produktpreise|Grundlage/iu);
    expect(html).toContain("Serverstand bewusst neu laden");
    expect(html).not.toContain("catalog_pricing_missing");
    expect(html).toMatch(/<fieldset[^>]*disabled/iu);
  });

  it("startet Neue Basis steuerlich leer und macht die Auswahl ausdrücklich", async () => {
    const OfferDetailView = await loadOfferDetailView();
    const html = render(OfferDetailView, { view: detailView() });

    expect(html).toContain('<option value="" selected="">Bitte ausdrücklich auswählen</option>');
    expect(html).toContain("0-%-Steuerentwurf für diese neue Basis bestätigen");
  });

  it("rendert den Dirty-Dialog benannt und lässt den Effect den sicheren Anfangs- und Rückfokus steuern", async () => {
    const DirtyNavigationDialog = await loadDirtyNavigationDialog();
    const html = render(DirtyNavigationDialog, {
      open: true,
      destinationLabel: "Angebotsliste",
      pending: false,
      onStay: vi.fn(),
      onDiscard: vi.fn(),
      onSaveAndContinue: vi.fn(),
    });

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("aria-labelledby=");
    expect(html).toContain("aria-describedby=");
    expect(html).not.toContain("autofocus");
    expect(html).toMatch(/<button[^>]*>Bleiben<\/button>/iu);
    expect(html).toContain("Verwerfen");
    expect(html).toContain("Speichern und fortfahren");
    expect(html).toContain("Ungespeicherte Änderungen");
    expectNoFutureControls(html);
  });

  it("rendert Loading, Unexpected Error und Not Found ohne interne Details", async () => {
    const [listLoadingModule, listErrorModule, detailLoadingModule, detailErrorModule,
      detailNotFoundModule] = await Promise.all([
      import("@/app/w/[workspaceId]/angebote/loading"),
      import("@/app/w/[workspaceId]/angebote/error"),
      import("@/app/w/[workspaceId]/angebote/[offerId]/loading"),
      import("@/app/w/[workspaceId]/angebote/[offerId]/error"),
      import("@/app/w/[workspaceId]/angebote/[offerId]/not-found"),
    ]);

    const listLoading = render(listLoadingModule.default as TestComponent, {});
    const detailLoading = render(detailLoadingModule.default as TestComponent, {});
    expect(listLoading).toContain('aria-busy="true"');
    expect(detailLoading).toContain('aria-busy="true"');

    const privateMessage = "PRIVATE-OFFER-ERROR-SENTINEL";
    const privateDigest = "PRIVATE-OFFER-DIGEST-SENTINEL";
    const error = Object.assign(new Error(privateMessage), { digest: privateDigest });
    for (const ErrorComponent of [listErrorModule.default, detailErrorModule.default]) {
      const html = render(ErrorComponent as TestComponent, { error, retry: vi.fn() });
      expect(html).toContain('role="alert"');
      expect(html).toContain("Erneut versuchen");
      expect(html).not.toContain(privateMessage);
      expect(html).not.toContain(privateDigest);
    }

    const notFound = render(detailNotFoundModule.default as TestComponent, {});
    expect(notFound).toContain("404");
    expect(notFound).not.toContain(OFFER_ID);
    expectNoFutureControls(listLoading + detailLoading + notFound);
  });
});
