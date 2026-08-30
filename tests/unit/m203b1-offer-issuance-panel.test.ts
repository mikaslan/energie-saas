import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/w/[workspaceId]/angebote/issuance-actions", () => ({
  requestOfferIssuanceAction: vi.fn(),
  approveOfferIssuanceAction: vi.fn(),
  withdrawOfferIssuanceAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => `/w/${WORKSPACE_ID}/angebote/${OFFER_ID}`,
  useSearchParams: () => new URLSearchParams("variante=90000000-0000-4000-8000-000000000009"),
}));

import {
  OfferIssuancePanel,
  type OfferIssuanceSurfaceView,
} from "@/app/w/[workspaceId]/angebote/[offerId]/offer-issuance-panel";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const OFFER_ID = "20000000-0000-4000-8000-000000000002";
const CANDIDATE_ID = "30000000-0000-4000-8000-000000000003";
const ISSUANCE_ID = "40000000-0000-4000-8000-000000000004";
const CANDIDATE_REFERENCE = "FK-0011223344556677";
const ISSUANCE_REFERENCE = "AF-8899AABBCCDDEEFF";
const UNBOUND_CANDIDATE_ID = "60000000-0000-4000-8000-000000000006";
const REPAIR_CANDIDATE_ID = "70000000-0000-4000-8000-000000000007";

function issuance(
  state: OfferIssuanceSurfaceView["state"],
  approvalCount: number,
  overrides: Partial<OfferIssuanceSurfaceView> = {},
): OfferIssuanceSurfaceView {
  return {
    issuanceId: ISSUANCE_ID,
    issuanceReference: ISSUANCE_REFERENCE,
    candidateId: CANDIDATE_ID,
    candidateReference: CANDIDATE_REFERENCE,
    variantName: "Photovoltaik mit Speicher",
    variantRevision: 7,
    state,
    renderState: "ready_for_approval",
    approvalCount,
    publicationStatus: "not_issued",
    requiresZeroTaxReview: true,
    attemptCount: 1,
    nextAttemptAt: "2026-08-30T12:00:00.000Z",
    createdAt: "2026-08-30T11:59:00.000Z",
    viewerHasApproved: false,
    canCurrentActorApprove: approvalCount < 2,
    withdrawal: null,
    canDownload: true,
    ...overrides,
  };
}

function renderPanel(overrides: Partial<Parameters<typeof OfferIssuancePanel>[0]> = {}) {
  return renderToStaticMarkup(createElement(OfferIssuancePanel, {
    workspaceId: WORKSPACE_ID,
    offerId: OFFER_ID,
    canPrepare: true,
    canApprove: true,
    canWithdraw: true,
    approvedCandidates: [{
      candidateId: CANDIDATE_ID,
      candidateReference: CANDIDATE_REFERENCE,
      variantName: "Photovoltaik mit Speicher",
      variantRevision: 7,
      approvedAt: "2026-08-30T11:55:00.000Z",
    }],
    issuances: [issuance("ready_for_approval", 0)],
    ...overrides,
  }));
}

describe("M2-03b1 Ausstellungsfassungs-Panel", () => {
  it("zeigt 0/2 mit eindeutiger Variante, sicherer Referenz, normalem Download und ehrlichem Archivblocker", () => {
    const html = renderPanel();
    expect(html).toContain("Ausstellungsfassung wartet auf Freigabe (0 von 2)");
    expect(html).toContain(`Referenz ${ISSUANCE_REFERENCE}`);
    expect(html).toContain(`Freigabekandidat ${CANDIDATE_REFERENCE}`);
    expect(html).toContain("Variante Photovoltaik mit Speicher, Revision 7");
    expect(html).toContain("Bytefreigaben: 0 von 2 verschiedenen Personen");
    expect(html).toContain("recipientAndScopeReviewed");
    expect(html).toContain("commercialTotalsReviewed");
    expect(html).toContain("legalProfileReviewed");
    expect(html).toContain("finalPdfForArchiveUnderstood");
    expect(html).toContain("zeroTaxTreatmentReviewed");
    expect(html).toContain(`/ausstellungsfassungen/${ISSUANCE_ID}/pdf`);
    expect(html).toContain("Finale PDF intern prüfen");
    expect(html).toContain(`Ausstellungsfassung ${ISSUANCE_REFERENCE}`);
    expect(html).not.toContain('aria-label="Finale PDF');
    expect(html).toContain('aria-labelledby="offer-issuance-title"');
    expect(html).toContain(`?variante=90000000-0000-4000-8000-000000000009`);
    expect(html).toContain("Live-Object-Lock und Retention-Policy sind noch nicht verifiziert");
    expect(html).toContain("Render-Versuche:");
    expect(html).toContain("Nicht ausgestellt · nicht versendet");
    expect(html).not.toContain("Ausgestellt</");
  });

  it("zeigt 1/2 und 2/2 ohne eine Ausstellung oder Archivierung zu behaupten", () => {
    const html = renderPanel({
      issuances: [
        issuance("approval_pending", 1, { canCurrentActorApprove: true }),
        issuance("approved_for_archive_not_issued", 2, {
          issuanceId: "50000000-0000-4000-8000-000000000005",
          issuanceReference: "AF-1122334455667788",
          canCurrentActorApprove: false,
        }),
      ],
    });
    expect(html).toContain("Ausstellungsfassung wartet auf Zweitfreigabe (1 von 2)");
    expect(html).toContain("Für Archivierung freigegeben · noch nicht ausgestellt");
    expect(html).toContain("2 von 2");
    expect(html).not.toContain("Angebot versenden");
    expect(html).not.toContain("Signatur starten");
  });

  it("entfernt die Zweitfreigabe für dieselbe Person und erklärt den echten 1-von-2-Endzustand", () => {
    const html = renderPanel({
      issuances: [issuance("approval_pending", 1, {
        viewerHasApproved: true,
        canCurrentActorApprove: false,
      })],
    });
    expect(html).toContain("Deine Bytefreigabe zählt bereits als 1 von 2");
    expect(html).toContain("andere berechtigte Person");
    expect(html).not.toContain("Zweite Bytefreigabe speichern");
  });

  it("bietet einer anderen berechtigten Person genau die eindeutig benannte Zweitfreigabe", () => {
    const html = renderPanel({
      issuances: [issuance("approval_pending", 1, {
        viewerHasApproved: false,
        canCurrentActorApprove: true,
      })],
    });
    expect(html).toContain("Zweite Bytefreigabe speichern");
    expect(html).toContain(`für Ausstellungsfassung ${ISSUANCE_REFERENCE}`);
    expect(html).not.toContain("Deine Bytefreigabe zählt bereits");
  });

  it("gibt Viewern vor 2/2 keinen Download und danach nur den privaten Download, aber nie Mutationen", () => {
    const before = renderPanel({
      canPrepare: false,
      canApprove: false,
      canWithdraw: false,
      issuances: [issuance("approval_pending", 1, {
        canDownload: false,
        canCurrentActorApprove: false,
      })],
    });
    expect(before).toContain("Nur Lesezugriff");
    expect(before).toContain("Der Freigabekandidat wird niemals ausgestellt");
    expect(before).toContain("Aus demselben versiegelten Datenstand entsteht eine neue finale PDF-Datei");
    expect(before).not.toContain(`/ausstellungsfassungen/${ISSUANCE_ID}/pdf`);
    expect(before).not.toContain("<form");

    const after = renderPanel({
      canPrepare: false,
      canApprove: false,
      canWithdraw: false,
      issuances: [issuance("approved_for_archive_not_issued", 2, {
        canCurrentActorApprove: false,
      })],
    });
    expect(after).toContain("Nur Lesezugriff");
    expect(after).toContain(`/ausstellungsfassungen/${ISSUANCE_ID}/pdf`);
    expect(after).not.toContain("<form");
  });

  it("zeigt die Freigabezahl erst ab prüfbereiten Bytes", () => {
    const queued = renderPanel({
      issuances: [issuance("queued", 0, {
        renderState: "queued",
        canDownload: false,
        canCurrentActorApprove: false,
      })],
    });
    expect(queued).toContain("Ausstellungsfassung wartet auf Erstellung");
    expect(queued).not.toContain("Bytefreigaben:");

    const failed = renderPanel({
      issuances: [issuance("failed_final", 0, {
        renderState: "failed_final",
        canDownload: false,
        canCurrentActorApprove: false,
      })],
    });
    expect(failed).not.toContain("Bytefreigaben:");

    const retry = renderPanel({
      issuances: [issuance("retry_wait", 0, {
        renderState: "retry_wait",
        attemptCount: 2,
        canDownload: false,
        canCurrentActorApprove: false,
      })],
    });
    expect(retry).toContain("Render-Versuche:");
    expect(retry).toContain(">2</dd>");
    expect(retry).toContain("Nächster Versuch:");
  });

  it("lässt ungebundene und laufende Reparaturaufträge auswählbar, filtert aber prüfbereite Bindungen", () => {
    const html = renderPanel({
      approvedCandidates: [
        {
          candidateId: CANDIDATE_ID,
          candidateReference: CANDIDATE_REFERENCE,
          variantName: "Photovoltaik mit Speicher",
          variantRevision: 7,
          approvedAt: "2026-08-30T11:55:00.000Z",
        },
        {
          candidateId: UNBOUND_CANDIDATE_ID,
          candidateReference: "FK-1111222233334444",
          variantName: "Nur Photovoltaik",
          variantRevision: 3,
          approvedAt: "2026-08-30T11:56:00.000Z",
        },
        {
          candidateId: REPAIR_CANDIDATE_ID,
          candidateReference: "FK-AAAABBBBCCCCDDDD",
          variantName: "Photovoltaik Plus",
          variantRevision: 4,
          approvedAt: "2026-08-30T11:57:00.000Z",
        },
      ],
      issuances: [
        issuance("ready_for_approval", 0),
        issuance("retry_wait", 0, {
          issuanceId: "80000000-0000-4000-8000-000000000008",
          issuanceReference: "AF-A1A2A3A4A5A6A7A8",
          candidateId: REPAIR_CANDIDATE_ID,
          candidateReference: "FK-AAAABBBBCCCCDDDD",
          variantName: "Photovoltaik Plus",
          variantRevision: 4,
          renderState: "retry_wait",
          canDownload: false,
          canCurrentActorApprove: false,
        }),
      ],
    });
    expect(html).not.toMatch(new RegExp(`<input[^>]+type="radio"[^>]+value="${CANDIDATE_ID}"`, "u"));
    expect(html).toMatch(new RegExp(`<input[^>]+type="radio"[^>]+value="${UNBOUND_CANDIDATE_ID}"`, "u"));
    expect(html).toMatch(new RegExp(`<input[^>]+type="radio"[^>]+value="${REPAIR_CANDIDATE_ID}"`, "u"));
    expect(html).toContain("Laufende Erstellung erneut anstoßen");
    expect(html).toContain("Neue Fassung erstellen");
    expect(html).toContain("Warteschlangen-Reparatur");
    expect(html).toContain("#offer-release-candidate");
  });

  it("kennzeichnet Withdrawal terminal und bietet weder Download noch weitere Freigabe", () => {
    const html = renderPanel({
      approvedCandidates: [],
      issuances: [issuance("withdrawn_before_archive", 1, {
        canDownload: false,
        withdrawal: {
          reasonCode: "content_error",
          withdrawnAt: "2026-08-30T12:10:00.000Z",
        },
      })],
    });
    expect(html).toContain("Vor Archivierung zurückgezogen · nicht ausgestellt");
    expect(html).toContain("Rücknahmegrund");
    expect(html).toContain("Inhaltlicher Fehler");
    expect(html).not.toContain(`/ausstellungsfassungen/${ISSUANCE_ID}/pdf`);
    expect(html).not.toContain("recipientAndScopeReviewed");
    expect(html).not.toContain("withdrawalReasonCode");
    expect(html).toContain("#offer-release-candidate");
  });

  it("bietet eine frueh zurueckgezogene laufende Fassung nicht als Reparaturauftrag an", () => {
    const html = renderPanel({
      issuances: [issuance("withdrawn_before_archive", 0, {
        renderState: "queued",
        canDownload: false,
        canCurrentActorApprove: false,
        withdrawal: {
          reasonCode: "content_error",
          withdrawnAt: "2026-08-30T12:10:00.000Z",
        },
      })],
    });
    expect(html).not.toMatch(new RegExp(`<input[^>]+type="radio"[^>]+value="${CANDIDATE_ID}"`, "u"));
    expect(html).not.toContain("laufende Erstellung erneut anstoßen");
    expect(html).toContain("Nach endgültigem Fehler oder Rücknahme ist ein neuer Freigabekandidat");
  });

  it("verlangt vor einer Rücknahme Grund und ausdrückliche irreversible Bestätigung", () => {
    const html = renderPanel();
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("Ausstellungsfassung zurücknehmen");
    expect(html).toContain(`Rücknahmegrund für Ausstellungsfassung ${ISSUANCE_REFERENCE}`);
    expect(html).toContain(`Ich bestätige die endgültige Rücknahme von ${ISSUANCE_REFERENCE}`);
    expect(html).toContain("Rücknahme endgültig speichern");
    expect(html).toContain(`für Ausstellungsfassung ${ISSUANCE_REFERENCE}`);
    expect(html).toContain("border-rose-700 bg-white text-rose-800");
    expect(html).not.toContain('aria-label="Ausstellungsfassung');
  });
});
