import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const DETAIL = "app/w/[workspaceId]/angebote/[offerId]";
const ACTIONS = "app/w/[workspaceId]/angebote/issuance-actions.ts";
const PANEL = `${DETAIL}/offer-issuance-panel.tsx`;
const DOWNLOAD = `${DETAIL}/ausstellungsfassungen/[issuanceId]/pdf/route.ts`;

describe("M2-03b1 Portalvertrag fuer Ausstellungsfassungen", () => {
  it("liest sichere Issuance-Zustaende im bestehenden autorisierten Tenant-Read", async () => {
    const page = await readFile(`${DETAIL}/page.tsx`, "utf8");
    expect(page).toContain("listOfferIssuances");
    expect(page).toContain("canPrepareIssuance");
    expect(page).toContain("canApproveIssuance");
    expect(page).toContain("canWithdrawIssuance");
    expect(page).toContain("viewerHasApproved: issuance.viewerHasApproved");
    expect(page).toContain("canCurrentActorApprove: issuance.canCurrentActorApprove");
    expect(page).toContain("variantName: variant.name");
    expect(page).toContain("variantRevision: candidate.variantRevision");
    expect(page).toContain("function offerSurfaceReference(");
    expect(page).toContain("offer-surface-reference:v1:");
    expect(page).toContain('.slice(0, 16)');
    expect(page).toContain('"AF" : "FK"');
    expect(page).not.toContain("issuanceInputSnapshot");
    expect(page).not.toContain("issuanceArtifactSha256");
    expect(page).not.toContain("candidateInputSha256");
  });

  it("haelt Request, Approval und Withdrawal exact und serverseitig autorisiert", async () => {
    const actions = await readFile(ACTIONS, "utf8");
    expect(actions).toContain("exactStringEntries");
    expect(actions).toContain("authorizedOfferMutationAction");
    expect(actions).toContain('["offer.issue.prepare"]');
    expect(actions).toContain('["offer.issue.approve"]');
    expect(actions).toContain('["offer.issue.withdraw"]');
    expect(actions).toContain("requestOfferIssuance");
    expect(actions).toContain("approveOfferIssuance");
    expect(actions).toContain("withdrawOfferIssuance");
    expect(actions).not.toContain("redirect(");
    expect(actions).not.toMatch(/export\s+(?:const|let|var|class)\s+/u);
  });

  it("zeigt die Zwei-Personen-Freigabe ohne Issued-, Versand- oder Signaturclaim", async () => {
    const [view, editor, panel] = await Promise.all([
      readFile(`${DETAIL}/offer-detail-view.tsx`, "utf8"),
      readFile(`${DETAIL}/offer-editor.tsx`, "utf8"),
      readFile(PANEL, "utf8"),
    ]);
    expect(view).toContain("OfferIssuancePanel");
    expect(view).toContain("showIssuanceSkipLink={offerIssuancePanel !== null}");
    expect(view).toContain('href="#offer-issuance"');
    expect(editor).toContain("showIssuanceSkipLink");
    expect(editor).toContain('href="#offer-issuance"');
    expect(editor).toContain("Zur Ausstellungsfassung springen");
    expect(panel).toContain('<section id="offer-issuance" tabIndex={-1} aria-labelledby="offer-issuance-title"');
    expect(panel).toContain('className="min-w-0 rounded-xl');
    expect(panel).toContain('<h2 id="offer-issuance-title"');
    expect(panel).toContain("Ausstellungsfassung");
    expect(panel).toContain("0 von 2");
    expect(panel).toContain("1 von 2");
    expect(panel).toContain("2 von 2");
    expect(panel).toContain("Für Archivierung freigegeben · noch nicht ausgestellt");
    expect(panel).toContain("Live-Object-Lock und Retention-Policy sind noch nicht verifiziert");
    expect(panel).toContain("Der Freigabekandidat wird niemals ausgestellt");
    expect(panel).toContain("Aus demselben versiegelten Datenstand entsteht eine neue finale PDF-Datei");
    expect(panel).not.toContain("wird nicht umetikettiert");
    expect(panel).toContain("recipientAndScopeReviewed");
    expect(panel).toContain("commercialTotalsReviewed");
    expect(panel).toContain("legalProfileReviewed");
    expect(panel).toContain("finalPdfForArchiveUnderstood");
    expect(panel).toContain("zeroTaxTreatmentReviewed");
    expect(panel).toContain("withdrawalReasonCode");
    expect(panel).toContain("viewerHasApproved");
    expect(panel).toContain("canCurrentActorApprove");
    expect(panel).toContain("issuance.canCurrentActorApprove");
    expect(panel).toContain("issuance.viewerHasApproved");
    expect(panel).toContain("OfferDirtyNavigationLink");
    expect(panel).toContain('kind="refresh"');
    expect(panel).toContain('<span className="sr-only">Ausstellungsfassungen: </span>Status aktualisieren');
    expect(panel).toContain("#offer-release-candidate");
    expect(panel).toContain("repairableCandidateIds");
    expect(panel).toContain('issuance.state === "queued"');
    expect(panel).toContain('issuance.state === "running"');
    expect(panel).toContain('issuance.state === "retry_wait"');
    expect(panel).toContain('issuance.state !== "queued"');
    expect(panel).toContain("terminalOrReviewCandidateIds");
    expect(panel).toContain('issuance.renderState === "ready_for_approval" ? (');
    expect(panel).toContain("Warteschlangen-Reparatur");
    expect(panel).toContain("bei Bedarf erneut in die Warteschlange gestellt");
    expect(panel).toContain("Rücknahmegrund für Ausstellungsfassung");
    expect(panel).toContain("Ich bestätige die endgültige Rücknahme");
    expect(panel).toContain("<details");
    expect(panel).toContain("<summary");
    expect(panel).toContain('tone="danger"');
    expect(panel).toContain('type="radio"');
    expect(panel).toContain("Render-Versuche:");
    expect(panel).not.toContain("startedAt:");
    expect(panel).not.toContain("finishedAt:");
    expect(panel).toMatch(/\{issuance\.canDownload \? \(\s*<a\s/u);
    expect(panel).not.toContain('import Link from "next/link"');
    expect(panel).not.toContain("prefetch={false}");
    expect(panel).toContain('role={isError ? "alert" : "status"}');
    expect(panel).toContain('aria-live={isError ? "assertive" : "polite"}');
    expect(panel).toContain("feedbackRef.current?.focus()");
    expect(panel).toContain('state.status === "idle" ? undefined : -1');
    expect(panel).toContain("aria-disabled={pending || undefined}");
    expect(panel).toContain("accessibleContext");
    expect(panel).toContain("resetNotice=");
    expect(panel).toContain("Betroffene Felder:");
    expect(panel).toContain("aria-invalid=");
    expect(panel).not.toContain("aria-label={accessibleName}");
    expect(panel).not.toContain("Grund für Withdrawal");
    expect(panel).not.toContain("Withdrawal wird gespeichert");
    expect(panel).not.toContain("Angebot versenden");
    expect(panel).not.toContain("Öffentlicher Link");
    expect(panel).not.toContain("Signatur starten");
    expect(panel).not.toMatch(/>\s*Ausgestellt\s*</u);
  });

  it("bewahrt lokale Zod-Pfade fuer gezielte Feldfehler", async () => {
    const actions = await readFile(ACTIONS, "utf8");
    expect(actions).toContain("function issuePaths(error: z.ZodError)");
    expect(actions).toContain("new services.OfferIssuanceValidationError(issuePaths(parsed.error))");
  });

  it("liefert Ausstellungsbytes nur ueber eine reautorisierte Privatroute", async () => {
    const route = await readFile(DOWNLOAD, "utf8");
    expect(route).toContain('dynamic = "force-dynamic"');
    expect(route).toContain("params: Promise<");
    expect(route).toMatch(/await\s+context\.params/u);
    expect(route).toContain("authorizedQuery");
    expect(route).toContain("readOfferIssuanceArtifact");
    expect(route).toContain("timingSafeEqual");
    expect(route).toContain("private, no-store");
    expect(route).toContain("nosniff");
    expect(route).toContain("no-referrer");
    expect(route).toContain("sandbox; default-src 'none'");
  });
});
