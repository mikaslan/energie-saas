import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const DETAIL = "app/w/[workspaceId]/angebote/[offerId]";
const SETTINGS = "app/w/[workspaceId]/einstellungen/angebotsprofile";
const ACTIONS = "app/w/[workspaceId]/angebote/release-actions.ts";
const PANEL = `${DETAIL}/offer-release-candidate-panel.tsx`;
const EDITOR = `${DETAIL}/offer-editor.tsx`;
const PDF_PANEL = `${DETAIL}/offer-pdf-draft-panel.tsx`;
const DIRTY_GUARD = `${DETAIL}/dirty-navigation-guard.tsx`;
const DOWNLOAD = `${DETAIL}/freigabekandidaten/[candidateId]/pdf/route.ts`;

describe("M2-03a Offer-Release-Portalvertrag", () => {
  it("projiziert nur sichere Status- und Revisionsfelder im bestehenden autorisierten Read", async () => {
    const page = await readFile(`${DETAIL}/page.tsx`, "utf8");
    expect(page).toContain("authorizedQuery");
    expect(page).toContain("readCurrentOfferReleaseProfile");
    expect(page).toContain("readCurrentOfferRecipient");
    expect(page).toContain("listOfferReleaseCandidates");
    expect(page).toContain("canPrepareRelease");
    expect(page).toContain("canApproveRelease");
    expect(page).toContain("requiresZeroTaxReview");
    expect(page).toContain("recipientPresence");
    expect(page).toContain("!editorCapabilities.canPrepareRelease");
    expect(page).toContain("statement_timestamp() at time zone 'Europe/Berlin'");
    expect(page).toContain("releaseValidityWindowSchema");
    const releaseReadStart = page.indexOf("if (view !== null && !externalOnly)");
    const releaseReadEnd = page.indexOf("return {", releaseReadStart);
    expect(releaseReadStart).toBeGreaterThan(-1);
    expect(releaseReadEnd).toBeGreaterThan(releaseReadStart);
    expect(page.slice(releaseReadStart, releaseReadEnd)).not.toContain("Promise.all");
    expect(page).toContain("pg@9");
    expect(page).not.toContain("artifactSha256");
    expect(page).not.toContain("inputSnapshot");
    expect(page).not.toContain("recipientSnapshotSha256");
  });

  it("hält alle drei Server Actions exact, admission-gated und erneut fachautorisiert", async () => {
    const actions = await readFile(ACTIONS, "utf8");
    expect(actions).toContain("exactStringEntries");
    expect(actions).toContain("authorizedOfferMutationAction");
    expect(actions).toContain('["offer.release.prepare"]');
    expect(actions).toContain('["offer.release.approve"]');
    expect(actions).toContain("reviseOfferRecipient");
    expect(actions).toContain("submittedRecipientRevision");
    expect(actions).toContain("bindSubmittedRecipientRevision");
    expect(actions).toContain("requestOfferReleaseCandidate");
    expect(actions).toContain("approveOfferReleaseCandidate");
    expect(actions).toContain("APPROVAL_REQUIRED_FIELDS");
    expect(actions).toContain("APPROVAL_OPTIONAL_FIELDS");
    expect(actions).not.toContain("redirect(");
    expect(actions).not.toMatch(/export\s+(?:const|let|var|class)\s+/u);
  });

  it("zeigt drei zugängliche Stufen ohne zweiten Sticky-Bereich und ohne Issuance-Claim", async () => {
    const [view, panel, editor, pdfPanel, dirtyGuard] = await Promise.all([
      readFile(`${DETAIL}/offer-detail-view.tsx`, "utf8"),
      readFile(PANEL, "utf8"),
      readFile(EDITOR, "utf8"),
      readFile(PDF_PANEL, "utf8"),
      readFile(DIRTY_GUARD, "utf8"),
    ]);
    expect(view).toContain("OfferReleaseCandidatePanel");
    expect(view).toContain("showReleaseSkipLink={offerReleasePanel !== null}");
    expect(view).toContain("showIssuanceSkipLink={offerIssuancePanel !== null}");
    expect(view).toContain("afterEditor={<div");
    expect(editor).toContain('href="#offer-release-candidate"');
    expect(editor).toContain("{afterEditor}");
    expect(editor.indexOf("{afterEditor}")).toBeLessThan(editor.indexOf("</main>"));
    expect(pdfPanel).toContain('id="offer-pdf-draft"');
    expect(pdfPanel).toContain("tabIndex={-1}");
    expect(pdfPanel).toContain("OfferDirtyNavigationLink");
    expect(pdfPanel).toContain("aria-disabled={pending || undefined}");
    expect(pdfPanel).toContain("aria-busy={pending || undefined}");
    expect(pdfPanel).toContain('pending ? "cursor-wait bg-slate-700"');
    expect(pdfPanel).not.toContain("disabled={pending}");
    expect(editor).toContain("OfferDirtyNavigationProvider");
    expect(editor).toContain('if (kind === "refresh")');
    expect(editor).toContain("router.refresh()");
    expect(dirtyGuard).toContain("OfferDirtyNavigationProvider");
    expect(dirtyGuard).toContain("requestNavigation");
    expect(dirtyGuard).toContain('kind?: "link" | "refresh"');
    expect(dirtyGuard).toContain("aria-busy={pending || undefined}");
    expect(dirtyGuard).toContain("event.preventDefault()");
    expect(panel).toContain('<section id="offer-release-candidate" tabIndex={-1}');
    expect(panel).toContain('<ol role="list"');
    expect(panel).toContain("OfferDirtyNavigationLink");
    expect(panel).toContain("const recipientBaselineKey = recipient");
    expect(panel).toContain("const recipientStateMatchesBaseline");
    expect(panel).toContain("const visibleRecipientState");
    expect(panel).toContain("<form key={recipientBaselineKey}");
    expect(panel).toContain("Schritt 1 von 3");
    expect(panel).toContain("Schritt 2 von 3");
    expect(panel).toContain("Schritt 3 von 3");
    expect(panel).toContain("Freigabekandidat · nicht ausgestellt · nicht versendet");
    expect(panel).toContain("<fieldset");
    expect(panel).toContain('role={isError ? "alert" : "status"}');
    expect(panel).toContain('aria-live={isError ? "assertive" : "polite"}');
    expect(panel).toContain("requiresZeroTaxReview");
    expect(panel).toContain("CandidateApprovalItem");
    expect(panel).toContain("approval-action-feedback-${candidate.candidateId}");
    expect(panel).toContain("aria-disabled={pending || undefined}");
    expect(panel).toContain('pending ? "cursor-wait bg-slate-700"');
    expect(panel).toContain("successFocusTargetId");
    expect(panel).toContain("resetNotice=");
    expect(panel).toContain("value={validThrough}");
    expect(panel).toContain("setValidThrough(event.currentTarget.value)");
    expect(panel).toContain("aria-invalid={effectiveInvalid || undefined}");
    expect(panel).toContain("aria-invalid={effectiveValidThroughInvalid || undefined}");
    expect(panel).toContain("Betroffene Felder:");
    expect(panel).toContain("validityWindow.min");
    expect(panel).toContain("validityWindow.max");
    expect(panel).toContain("1 bis 60 Kalendertage");
    expect(panel).not.toContain("zuerst oben");
    expect(panel).not.toContain("sticky");
    expect(panel).not.toContain("Angebot versenden");
    expect(panel).not.toContain("Öffentlicher Link");
    expect(panel).not.toContain("Signatur starten");
  });

  it("liefert Kandidaten nur über eine dynamische, reautorisierte und hashgeprüfte Privatroute", async () => {
    const route = await readFile(DOWNLOAD, "utf8");
    expect(route).toContain('dynamic = "force-dynamic"');
    expect(route).toContain("params: Promise<");
    expect(route).toMatch(/await\s+context\.params/u);
    expect(route).toContain("authorizedQuery");
    expect(route).toContain("readOfferReleaseCandidateArtifact");
    expect(route).toContain("timingSafeEqual");
    expect(route).toContain("private, no-store");
    expect(route).toContain("nosniff");
    expect(route).toContain("no-referrer");
    expect(route).toContain("sandbox; default-src 'none'");
  });

  it("bietet die Profilverwaltung ohne erfundene Defaulttexte und mit getrennter Aktivierung", async () => {
    const [page, actions, form] = await Promise.all([
      readFile(`${SETTINGS}/page.tsx`, "utf8"),
      readFile(`${SETTINGS}/actions.ts`, "utf8"),
      readFile(`${SETTINGS}/offer-release-profile-form.tsx`, "utf8"),
    ]);
    expect(page).toContain("authorizedQuery");
    expect(page).toContain("settings.manage");
    expect(page).not.toContain("current: current.current");
    expect(page).not.toContain("snapshotSha256");
    expect(actions).toContain("authorizedAction");
    expect(actions).toContain("reviseOfferReleaseProfile");
    expect(actions).toContain("activateOfferReleaseProfile");
    expect(form).toContain("Es gibt keine Standardtexte");
    expect(form).toContain("Speichern aktiviert den Stand noch nicht");
    expect(form).toContain("Getrennte Betreiberprüfung");
    expect(form).toContain('name="operatorReviewed"');
    expect(form).toContain("übernehme die Betreiberverantwortung");
    expect(form).toContain("Betroffene Felder:");
    expect(form).toContain('pending ? "cursor-wait bg-slate-700"');
    expect(form).toContain("const profileBaselineKey = current?.profileRevisionId");
    expect(form).toContain("<form key={profileBaselineKey}");
    expect(actions).toContain('"operatorReviewed"');
    expect(form).not.toContain("WMEE Solar & Energie GmbH");
  });

  it("ordnet das schreibgeschützte Freigabepanel erst hinter Angebotsinhalt und Summen an", async () => {
    const view = await readFile(`${DETAIL}/offer-detail-view.tsx`, "utf8");
    const readonlyContent = view.indexOf("<TotalsCard");
    const readonlyRelease = view.lastIndexOf("{offerReleasePanel ?");
    expect(readonlyContent).toBeGreaterThan(-1);
    expect(readonlyRelease).toBeGreaterThan(readonlyContent);
    expect(view).toContain('<div className="mt-6">{offerReleasePanel}</div>');
  });
});
