import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parsePortalPublicView } from "@/lib/integrations/portal/portal-contract";

function viewWithDocument(doc: Record<string, unknown>) {
  return {
    status: "ok",
    inviteId: "11111111-1111-4111-8111-111111111111",
    expiresAt: "2026-09-18T00:00:00.000Z",
    viewCount: 1,
    project: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "F10.2B",
      phase: "offer",
      outcome: "open",
    },
    documents: [doc],
    appointments: [],
  };
}

function docBase() {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    offerNumber: "AN-2026-001",
    documentDate: "2026-09-04",
    issuedAt: "2026-09-04T10:00:00.000Z",
  };
}

describe("F10.2 Slice B parsePortalPublicView Signatur-Status (rein)", () => {
  it("pending ohne Datum, signed mit Datum, none ohne Datum", () => {
    const pending = parsePortalPublicView(viewWithDocument({
      ...docBase(), signatureStatus: "pending", signedAt: null,
    }));
    expect(pending?.documents[0]?.signatureStatus).toBe("pending");
    expect(pending?.documents[0]?.signedAt).toBeNull();

    const signed = parsePortalPublicView(viewWithDocument({
      ...docBase(), signatureStatus: "signed", signedAt: "2026-09-03T08:00:00.000Z",
    }));
    expect(signed?.documents[0]?.signatureStatus).toBe("signed");
    expect(signed?.documents[0]?.signedAt).toBe("2026-09-03T08:00:00.000Z");

    const none = parsePortalPublicView(viewWithDocument({
      ...docBase(), signatureStatus: "none", signedAt: null,
    }));
    expect(none?.documents[0]?.signatureStatus).toBe("none");
  });

  it("unbekannter Status, fehlende Schlüssel, defektes Datum -> null (kein Orakel)", () => {
    expect(parsePortalPublicView(viewWithDocument({
      ...docBase(), signatureStatus: "unterschrieben", signedAt: null,
    }))).toBeNull();
    const missing = docBase() as Record<string, unknown>;
    expect(parsePortalPublicView(viewWithDocument(missing))).toBeNull();
    expect(parsePortalPublicView(viewWithDocument({
      ...docBase(), signatureStatus: "signed", signedAt: "kein-datum",
    }))).toBeNull();
    expect(parsePortalPublicView(viewWithDocument({
      ...docBase(), signatureStatus: "pending", signedAt: "2026-09-03T08:00:00.000Z",
    }))).not.toBeNull();
  });
});
