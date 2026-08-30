import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const LIST_ROUTE = "app/w/[workspaceId]/angebote";
const DETAIL_ROUTE = `${LIST_ROUTE}/[offerId]`;
const PROJECT_ROUTE = "app/w/[workspaceId]/anfragen/[projectId]";
const REQUEST_BOARD_ROUTE = "app/w/[workspaceId]/anfragen";

function expectAwaited(source: string, property: "params" | "searchParams"): void {
  expect(source).toMatch(new RegExp(`await\\s+(?:props\\.)?${property}\\b`, "u"));
}

function expectNoFutureControls(...sources: string[]): void {
  const combined = sources.join("\n");
  for (const label of [
    "PDF erstellen",
    "PDF herunterladen",
    "Angebot versenden",
    "Zur Signatur",
    "Signatur starten",
    "Jetzt signieren",
  ]) {
    expect(combined).not.toContain(label);
  }
}

describe("M2-01 Offer-UI-/Build-Vertrag", () => {
  it("verteilt das vierstufige Anfrageboard und sein Skeleton responsiv auf 1/2/4 Spalten", async () => {
    const [board, loading] = await Promise.all([
      readFile(`${REQUEST_BOARD_ROUTE}/page.tsx`, "utf8"),
      readFile(`${REQUEST_BOARD_ROUTE}/loading.tsx`, "utf8"),
    ]);

    for (const source of [board, loading]) {
      expect(source).toContain("md:grid-cols-2");
      expect(source).toContain("xl:grid-cols-4");
      expect(source).not.toContain("md:grid-cols-3");
    }
    expect(loading).toContain("[0, 1, 2, 3]");
  });

  it("verdrahtet die Projektakte serverautoritativ mit dem readiness-gegateten Create-Form", async () => {
    const [page, entry, projection] = await Promise.all([
      readFile(`${PROJECT_ROUTE}/page.tsx`, "utf8"),
      readFile(`${PROJECT_ROUTE}/offer-create-entry.tsx`, "utf8"),
      readFile(`${PROJECT_ROUTE}/offer-create-view.ts`, "utf8"),
    ]);

    expect(page).toContain("getProjectCatalogResolutionContext");
    expect(page).toContain("listOffers");
    expect(page).toContain("buildOfferCreateView");
    expect(page).toContain("OfferCreateEntry");
    expect(page).toContain("expectedRequirementRevision");
    expect(page).toContain("expectedCalculationRevision");
    expect(page).toContain("expectedResolutionRevision");
    expect(entry).toContain("createOfferFromRequestAction");
    expect(entry).toContain('priceAudienceConfirmation.code');
    expect(entry).toContain('zeroConfirmation.code');
    expect(entry).toContain("0-%-Steuerentwurf ausdrücklich bestätigen");
    expect(entry).toContain('taxTreatment');
    expect(entry).toContain("b2cConfirmed");
    expect(entry).toContain("zeroConfirmed");
    expect(entry).toContain('aria-live="polite"');
    expect(projection).not.toContain("salesPriceNetCents");
    expect(projection).not.toContain("purchasePriceNetCents");
    expect(projection).not.toContain("resolutionSha256");
  });

  it("hält Liste und Detail als Next-16-Server-Pages mit awaited Route-Props", async () => {
    const listPage = await readFile(`${LIST_ROUTE}/page.tsx`, "utf8");
    const detailPage = await readFile(`${DETAIL_ROUTE}/page.tsx`, "utf8");

    expect(listPage).toContain('PageProps<"/w/[workspaceId]/angebote">');
    expect(detailPage).toContain('PageProps<"/w/[workspaceId]/angebote/[offerId]">');
    expectAwaited(listPage, "params");
    expectAwaited(detailPage, "params");
    expectAwaited(detailPage, "searchParams");
    expect(listPage).not.toMatch(/^\s*["']use client["']/u);
    expect(detailPage).not.toMatch(/^\s*["']use client["']/u);
    expect(detailPage).not.toContain("useSearchParams");

    expect(detailPage).toContain("variante");
    expect(detailPage).toContain("Array.isArray");
    expect(detailPage).toContain("safeParse");
    expect(detailPage.toLowerCase()).toContain("uuid");
    expect(detailPage).toContain("notFound");
  });

  it("macht Listen- und Detailzustände explizit und rendert keine Zukunfts-Placebos", async () => {
    const [listPage, listView, detailPage, detailView] = await Promise.all([
      readFile(`${LIST_ROUTE}/page.tsx`, "utf8"),
      readFile(`${LIST_ROUTE}/offer-list-view.tsx`, "utf8"),
      readFile(`${DETAIL_ROUTE}/page.tsx`, "utf8"),
      readFile(`${DETAIL_ROUTE}/offer-detail-view.tsx`, "utf8"),
    ]);
    const listSurface = `${listPage}\n${listView}`;
    const detailSurface = `${detailPage}\n${detailView}`;

    expect(listSurface).toContain("data-offer-list-state");
    for (const state of ["loaded", "empty", "blocked", "read_only"]) {
      expect(listSurface).toContain(`"${state}"`);
    }
    expect(listPage).toContain("DeniedState");

    expect(detailSurface).toContain("data-offer-detail-state");
    for (const state of [
      "loaded",
      "blocked",
      "outdated",
      "dirty",
      "pending",
      "conflict",
      "validation",
      "unavailable",
      "unauthenticated",
      "success",
      "read_only",
    ]) {
      expect(detailSurface).toContain(`"${state}"`);
    }
    expect(detailSurface).toContain("retryAfter");
    expect(detailSurface).toContain("aria-live");
    expectNoFutureControls(listSurface, detailSurface);
  });

  it("hält Viewer-Redaktion strukturell und private Hashes aus der UI", async () => {
    const detailView = await readFile(`${DETAIL_ROUTE}/offer-detail-view.tsx`, "utf8");

    expect(detailView).toContain("canEdit");
    expect(detailView).toContain("canReadPurchasePrice");
    expect(detailView).toMatch(/canEdit\s*\?/u);
    expect(detailView).toMatch(/canReadPurchasePrice\s*\?/u);
    expect(detailView).not.toContain("snapshotSha256");
    expect(detailView).not.toContain("sourceDocumentSha256");
    expect(detailView).not.toContain("resolutionSha256");
    expect(detailView).not.toContain("JSON.stringify");
  });

  it("bereitet den Dirty-Guard für Link, History, Reload und Logout barrierefrei vor", async () => {
    const guard = await readFile(`${DETAIL_ROUTE}/dirty-navigation-guard.tsx`, "utf8");

    expect(guard).toMatch(/^\s*["']use client["']/u);
    expect(guard).toContain("onNavigate");
    expect(guard).toContain("preventDefault");
    expect(guard).toContain('"beforeunload"');
    expect(guard).toContain('"popstate"');
    expect(guard).toContain("hydrating: boolean");
    expect(guard).toContain("if (hydrating) return");
    expect(guard).toContain("dirtyRef.current = dirty || hydrating");
    expect(guard).toContain("useRef(dirty || hydrating)");
    expect(guard).toContain("signOut");
    expect(guard).toContain("window.location.replace");
    expect(guard).toContain('role="dialog"');
    expect(guard).not.toContain("autoFocus");
    expect(guard).toContain('aria-modal="true"');
    expect(guard).toContain("aria-labelledby");
    expect(guard).toContain("aria-describedby");
    expect(guard).toContain("Bleiben");
    expect(guard).toContain("Verwerfen");
    expect(guard).toContain("Speichern und fortfahren");
    expect(guard).toContain('event.key === "Escape"');
    expect(guard).toContain('event.key === "Tab"');
    expect(guard).toContain(".focus()");
  });

  it("verdrahtet einen kleinen gebündelten Editor mit mobiler Variantenauswahl und echten Mutationen", async () => {
    const [detailView, editor, model, actions] = await Promise.all([
      readFile(`${DETAIL_ROUTE}/offer-detail-view.tsx`, "utf8"),
      readFile(`${DETAIL_ROUTE}/offer-editor.tsx`, "utf8"),
      readFile(`${DETAIL_ROUTE}/offer-editor-model.ts`, "utf8"),
      readFile(`${LIST_ROUTE}/actions.ts`, "utf8"),
    ]);

    expect(detailView).toContain("OfferVariantEditor");
    expect(editor).toContain('name="mobile-variant"');
    expect(editor).toContain("Variante öffnen");
    expect(editor).toContain("expectedRevision");
    expect(editor).toContain("operations");
    expect(editor).toContain("saveOfferVariantDraftAction");
    expect(editor).toContain("duplicateOfferVariantEditorAction");
    expect(editor).toContain("createVariantFromCurrentResolutionEditorAction");
    expect(editor).toContain("DirtyNavigationDialog");
    expect(editor).toContain("onNavigate");
    expect(editor).toContain("Hoch");
    expect(editor).toContain("Runter");
    expect(editor).toContain('aria-current');
    expect(editor).toContain("safe-area-inset-bottom");
    expect(editor).not.toContain("Auf Revision");
    expect(editor).toContain("Serverstand bewusst neu laden");
    expect(editor).toContain('label: "Anmeldung"');
    expect(editor).toContain('execute: () => window.location.replace("/login")');
    expect(editor).not.toContain('<Link href="/login"');
    expect(editor).toContain('aria-live="polite"');
    expect(editor).toContain('setFeedback({ status: "noop" })');
    expect(editor).toContain("setDraft(createOfferEditorDraft(source))");
    expect(editor).not.toContain("setSavedDraft(draft);\n      setFeedback({ status: \"success\"");
    expect(editor).toContain("disabled={!salesPriceChanged}");
    expect(editor).toContain("disabled={!purchasePriceChanged}");
    expect(editor).toContain("canRemoveOfferDraftSection");
    expect(editor).toContain("draftSection.lines.length <= 1");
    expect(editor).toContain("&& envelope.recoveryScope === view.recoveryScope");
    expect(editor).toContain("prepareOfferEditorRecoveryDrafts");
    expect(editor).toContain("createOfferEditorRecoveryEnvelope");
    expect(editor).toContain("hydrating={recoveryHydrating}");
    expect(editor).toContain("|| recoveryHydrating");
    expect(editor).toContain("requestAnimationFrame(() => {");
    expect(editor).toContain('data-offer-recovery-purchase-omitted="true"');
    expect(model).toContain("redactOfferEditorPurchaseDraft");
    expect(model).toContain("Session Storage is same-origin browser state");
    expect(editor).toContain("view.permissions.canReadPurchasePrice");
    expect(model).toContain('operation: "set_line_quantity"');
    expect(model).toContain('operation: "set_line_sales_price"');
    expect(model).toContain('operation: "set_line_discount"');
    expect(model).toContain('operation: "set_line_position_type"');
    expect(model).toContain('operation: "set_line_visibility"');
    expect(model).toContain('operation: "move_line"');
    for (const operation of [
      "set_global_discount",
      "set_custom_deal",
      "move_section",
      "set_line_purchase_price",
      "set_line_tax",
      "remove_custom_line",
      "add_custom_section",
      "remove_custom_section",
      "add_custom_line",
    ]) {
      expect(model).toContain(`operation: "${operation}"`);
    }
    expect(actions).toContain("saveOfferVariantDraftAction");
  });

  it("projiziert nur editorrelevante BOM-/Provenienzfelder und übernimmt keine Steuer in Neue Basis", async () => {
    const [page, detail, editor] = await Promise.all([
      readFile(`${DETAIL_ROUTE}/page.tsx`, "utf8"),
      readFile(`${DETAIL_ROUTE}/offer-detail-view.tsx`, "utf8"),
      readFile(`${DETAIL_ROUTE}/offer-editor.tsx`, "utf8"),
    ]);

    for (const field of [
      "globalDiscountBps",
      "customDealNetCents",
      "componentCategory",
      "source",
      "category",
      "description",
      "taxTreatment",
      "purchasePricing",
      "marginNetCents",
      "forecastValueNetCents",
      "canEditPurchasePrice",
    ]) {
      expect(page).toContain(field);
    }
    expect(page).not.toContain("editorTaxTreatmentSchema");
    expect(page).toContain('createHmac("sha256"');
    expect(page).toContain("offerRecoveryScope(workspaceId, ctx.actor)");
    expect(detail).toContain("Vertriebsprognose");
    expect(editor).toContain('useState<"" | "standard_19" | "zero_operator_confirmed">("")');
    expect(editor).toContain('option value=""');
  });

  it("hält den vollständigen, exakt gescopten WMEE-Offer-Tokenvertrag ohne Kontrast-Opacity", async () => {
    const [theme, editor, detail, guard, list] = await Promise.all([
      readFile(`${LIST_ROUTE}/offer-theme.module.css`, "utf8"),
      readFile(`${DETAIL_ROUTE}/offer-editor.tsx`, "utf8"),
      readFile(`${DETAIL_ROUTE}/offer-detail-view.tsx`, "utf8"),
      readFile(`${DETAIL_ROUTE}/dirty-navigation-guard.tsx`, "utf8"),
      readFile(`${LIST_ROUTE}/offer-list-view.tsx`, "utf8"),
    ]);

    expect(theme).toContain('.offerTheme[data-wmee-scope="offer"]');
    for (const [token, value] of [
      ["--offer-brand-600", "#0f7550"],
      ["--offer-brand-hover", "#0b5e40"],
      ["--offer-brand-ink", "#0a4a33"],
      ["--offer-fg", "#0b1b15"],
      ["--offer-fg-muted", "#47564f"],
      ["--offer-fg-subtle", "#5e6e66"],
      ["--offer-fg-inverse", "#ffffff"],
      ["--offer-canvas", "#f4f7f5"],
      ["--offer-surface-1", "#ffffff"],
      ["--offer-surface-2", "#f7faf8"],
      ["--offer-surface-3", "#eef3f0"],
      ["--offer-surface-4", "#ffffff"],
      ["--offer-border", "#d3ddd8"],
      ["--offer-border-strong", "#6e7f77"],
      ["--offer-accent", "#0e6e7a"],
      ["--offer-hover", "#e6f3ec"],
      ["--offer-focus", "#0b3b29"],
      ["--offer-selected", "#dcefe5"],
      ["--offer-success", "#0b5a32"],
      ["--offer-success-bg", "#e8f5ec"],
      ["--offer-warning", "#6b4708"],
      ["--offer-warning-bg", "#fff4d6"],
      ["--offer-error", "#8c1d1d"],
      ["--offer-error-bg", "#fdecec"],
      ["--offer-info", "#123f73"],
      ["--offer-info-bg", "#eaf2fb"],
      ["--offer-overlay", "rgba(5, 20, 14, 0.62)"],
    ] as const) {
      expect(theme).toContain(`${token}: ${value}`);
    }
    for (const token of [
      "chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6",
      "font-sans", "text-0", "text-1", "text-2", "text-3", "text-4", "text-5", "text-6",
      "leading-tight", "leading-body", "leading-relaxed",
      "weight-regular", "weight-medium", "weight-semibold", "weight-bold",
      "space-0", "space-1", "space-2", "space-3", "space-4", "space-5",
      "space-6", "space-7", "space-8", "space-9", "space-10", "touch-min",
      "radius-1", "radius-2", "radius-3", "radius-4", "radius-pill",
      "shadow-1", "shadow-2", "shadow-3", "shadow-4",
      "z-base", "z-rail", "z-sticky", "z-popover", "z-dialog", "z-toast", "z-critical",
      "duration-1", "duration-2", "duration-3", "duration-4", "ease",
      "bp-stress", "bp-mobile", "bp-mobile-wide", "bp-tablet", "bp-workspace", "bp-wide", "bp-xwide",
    ]) {
      expect(theme).toContain(`--offer-${token}:`);
    }
    expect(theme).toMatch(/\.priceSummary[\s\S]*max-height[\s\S]*overflow-y/u);
    expect(theme).toContain("outline: 2px solid var(--offer-focus)");
    expect(theme).toMatch(
      /\.offerTheme :global\(p\.text-sm\)[\s\S]*font-size: var\(--offer-text-2\)[\s\S]*line-height: var\(--offer-leading-body\)/u,
    );
    expect(`${editor}\n${detail}\n${guard}`).not.toContain("disabled:opacity");
    for (const surface of [editor, detail, list]) {
      expect(surface).toContain("offerThemeStyles.offerTheme");
      expect(surface).toContain('data-wmee-scope="offer"');
    }
    for (const bodyCopy of [
      "Die Vorschau nutzt denselben ganzzahligen Money-Code",
      "Separater gespeicherter Vertriebswert",
      "Wird erst bei einer echten VK-Änderung aktiv",
      "Mindestens eine Position muss in dieser Sektion verbleiben",
      "Erzeugt eine unabhängige Revision-1-Kopie",
      "Kopiert eine ausdrücklich geprüfte Projekt-/Kataloggrundlage",
      "Deine Eingaben bleiben sichtbar",
    ]) {
      const index = editor.indexOf(bodyCopy);
      expect(index).toBeGreaterThan(0);
      expect(editor.slice(Math.max(0, index - 320), index)).toContain("text-base leading-6");
    }
    for (const bodyCopy of [
      "Unverbindlicher interner Entwurf",
      "Separater Vertriebswert aus dem Angebot",
      "Der gespeicherte Angebotsstand kann geprüft",
      "Deine Eingaben im lokalen Entwurf bleiben erhalten",
    ]) {
      const index = detail.indexOf(bodyCopy);
      expect(index).toBeGreaterThan(0);
      expect(detail.slice(Math.max(0, index - 320), index)).toContain("text-base leading-6");
    }
    expect(editor).toContain("px-4 py-3 text-base leading-6");
  });

  it("liefert ehrliche Loading-, Error- und Not-found-Segmente mit Next-16-retry", async () => {
    const [listLoading, listError, detailLoading, detailError, detailNotFound] =
      await Promise.all([
        readFile(`${LIST_ROUTE}/loading.tsx`, "utf8"),
        readFile(`${LIST_ROUTE}/error.tsx`, "utf8"),
        readFile(`${DETAIL_ROUTE}/loading.tsx`, "utf8"),
        readFile(`${DETAIL_ROUTE}/error.tsx`, "utf8"),
        readFile(`${DETAIL_ROUTE}/not-found.tsx`, "utf8"),
      ]);

    for (const loading of [listLoading, detailLoading]) {
      expect(loading).toContain('aria-busy="true"');
      expect(loading).toContain("motion-reduce:animate-none");
    }
    for (const error of [listError, detailError]) {
      expect(error).toContain("retry");
      expect(error).not.toContain("reset");
      expect(error).toContain('role="alert"');
      expect(error).not.toContain("error.message");
      expect(error).not.toContain("error.digest");
    }
    expect(detailNotFound).toContain("404");
    expect(detailNotFound).not.toContain("offerId");
    expectNoFutureControls(listLoading, listError, detailLoading, detailError, detailNotFound);
  });
});
