import { describe, expect, it } from "vitest";

import { parsePortalPublicView } from "@/lib/integrations/portal/portal-contract";

const INVITE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";

function baseView(scope: unknown) {
  return {
    status: "ok",
    inviteId: INVITE,
    expiresAt: "2026-10-01T00:00:00.000Z",
    viewCount: 1,
    project: { id: PROJECT, name: "F10-03c", phase: "offer", outcome: "open", scope },
    documents: [{
      id: DOC,
      offerNumber: "AN-2026-001",
      documentDate: "2026-09-04",
      issuedAt: "2026-09-04T10:00:00.000Z",
      signatureStatus: "pending",
      signedAt: null,
    }],
    appointments: [],
  };
}

describe("F10-03c Commercial-Strip (rein)", () => {
  it("commercial leert documents, residential behaelt sie", () => {
    const commercial = parsePortalPublicView(baseView("commercial"));
    expect(commercial?.project.scope).toBe("commercial");
    expect(commercial?.documents).toEqual([]);

    const residential = parsePortalPublicView(baseView("residential"));
    expect(residential?.project.scope).toBe("residential");
    expect(residential?.documents).toHaveLength(1);
    expect(residential?.documents[0]?.offerNumber).toBe("AN-2026-001");
  });

  it("fail-closed bleibt: deformiert commercial bricht ab, scope fehlt bricht ab", () => {
    const broken = baseView("commercial") as { documents: Array<Record<string, unknown>> };
    broken.documents[0]!.signatureStatus = "erfunden";
    expect(parsePortalPublicView(broken)).toBeNull();

    const noScope = baseView("commercial") as {
      project: Record<string, unknown>;
    };
    delete noScope.project.scope;
    expect(parsePortalPublicView(noScope)).toBeNull();

    const wrongScope = baseView("gewerbe");
    expect(parsePortalPublicView(wrongScope)).toBeNull();
  });
});
