import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const DETAIL_ROUTE = "app/w/[workspaceId]/angebote/[offerId]";
const ACTIONS = "app/w/[workspaceId]/angebote/pdf-actions.ts";
const PANEL = `${DETAIL_ROUTE}/offer-pdf-draft-panel.tsx`;
const DOWNLOAD = `${DETAIL_ROUTE}/pdf/[pdfDraftId]/route.ts`;

describe("M2-02 offer PDF portal contract", () => {
  it("lädt den minimierten Status im bestehenden autorisierten Page-Read", async () => {
    const page = await readFile(`${DETAIL_ROUTE}/page.tsx`, "utf8");

    expect(page).toContain("listOfferPdfDrafts");
    expect(page).toContain('from "@/modules/offers"');
    expect(page).not.toContain("@/modules/offers/pdf-service");
    expect(page).toContain("authorizedQuery");
    expect(page.indexOf("listOfferPdfDrafts")).toBeGreaterThan(
      page.indexOf("authorizedQuery"),
    );
    expect(page).toContain("pdfDrafts");
    expect(page).toContain("draft.variantId === snapshot.variantId");
    expect(page).toContain("canGeneratePdf");
    expect(page).not.toContain("artifactSha256");
    expect(page).not.toContain("inputSnapshot");
  });

  it("hält den Erzeugen-Entrypoint strikt, erneut autorisiert und statusbasiert", async () => {
    const actions = await readFile(ACTIONS, "utf8");

    for (const field of [
      "workspaceId",
      "offerId",
      "variantId",
      "expectedVariantRevision",
    ]) {
      expect(actions).toContain(`"${field}"`);
    }
    expect(actions).toContain("parseExactForm");
    expect(actions).toContain("authorizedOfferMutationAction");
    expect(actions).toContain('["project.write"]');
    expect(actions).toContain("requestOfferPdfDraft");
    expect(actions).toContain("revalidatePath");
    expect(actions).not.toContain("redirect(");
    expect(actions).not.toMatch(/export\s+(?:const|let|var|class)\s+/u);
  });

  it("zeigt internen Revisionsbezug, echte Zustände und ausschließlich berechtigte Aktionen", async () => {
    const [view, panel] = await Promise.all([
      readFile(`${DETAIL_ROUTE}/offer-detail-view.tsx`, "utf8"),
      readFile(PANEL, "utf8"),
    ]);
    const surface = `${view}\n${panel}`;

    expect(view).toContain("OfferPdfDraftPanel");
    expect(view).toMatch(/data-wmee-scope="offer"[\s\S]{0,160}offerThemeStyles\.offerTheme/u);
    expect(panel).toMatch(/^\s*["']use client["']/u);
    expect(panel).toContain("useActionState");
    expect(panel).toContain("generateOfferPdfDraftAction");
    expect(panel).toContain("Interner, nicht verbindlicher PDF-Entwurf");
    expect(panel).toContain("gespeicherte Revision");
    expect(panel).toContain("Ungespeicherte Änderungen");
    expect(panel).toContain("canGenerate");
    expect(panel).toContain("Nur Lesezugriff");
    expect(panel).toContain('role={feedbackIsError ? "alert" : "status"}');
    expect(panel).toContain('aria-live={feedbackIsError ? "assertive" : "polite"}');
    for (const state of [
      "queued",
      "running",
      "retry_wait",
      "succeeded",
      "failed_final",
    ]) {
      expect(panel).toContain(`"${state}"`);
    }
    expect(panel).toContain("attemptCount");
    expect(panel).toContain("canDownload");
    expect(panel).toContain("pdfDraftId");
    expect(surface).not.toContain("Angebot versenden");
    expect(surface).not.toContain("Öffentlicher Link");
    expect(surface).not.toContain("Signatur starten");
    expect(surface).not.toContain("artifactSha256");
  });

  it("behandelt den Download als dynamischen privaten HTTP-Endpunkt mit Promise-Params", async () => {
    const route = await readFile(DOWNLOAD, "utf8");

    expect(route).toContain('dynamic = "force-dynamic"');
    expect(route).toContain("params: Promise<");
    expect(route).toMatch(/await\s+context\.params/u);
    expect(route).toContain("safeParse");
    expect(route).toContain("authorizedQuery");
    expect(route).toContain('"project.read"');
    expect(route).toContain("readOfferPdfDraftArtifact");
    expect(route).toContain("Content-Disposition");
    expect(route).toContain("attachment;");
    expect(route).toContain("private, no-store");
    expect(route).toContain('Pragma: "no-cache"');
    expect(route).toContain("nosniff");
    expect(route).toContain("no-referrer");
  });
});
