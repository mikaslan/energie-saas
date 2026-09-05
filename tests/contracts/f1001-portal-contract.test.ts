import { describe, expect, it } from "vitest";

import {
  derivePortalNextStep,
  generatePortalToken,
  hashPortalToken,
  parsePortalPublicView,
  portalInviteCreateV1Schema,
  portalInviteWithdrawV1Schema,
  PORTAL_INVITE_CREATE_VERSION,
  PORTAL_INVITE_WITHDRAW_VERSION,
  PORTAL_PUBLIC_VIEW_VERSION,
} from "@/lib/integrations/portal/portal-contract";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const INVITE = "33333333-3333-4333-8333-333333333333";

describe("F10.1 portal command contracts", () => {
  it("validiert create mit TTL 1..60 und lehnt 0/61 ab", () => {
    const base = {
      schemaVersion: PORTAL_INVITE_CREATE_VERSION,
      workspaceId: WORKSPACE,
      projectId: PROJECT,
    };
    expect(portalInviteCreateV1Schema.safeParse({ ...base, ttlDays: 1 }).success).toBe(true);
    expect(portalInviteCreateV1Schema.safeParse({ ...base, ttlDays: 60 }).success).toBe(true);
    expect(portalInviteCreateV1Schema.safeParse({ ...base, ttlDays: 0 }).success).toBe(false);
    expect(portalInviteCreateV1Schema.safeParse({ ...base, ttlDays: 61 }).success).toBe(false);
  });

  it("validiert withdraw-Reason-Enum", () => {
    expect(portalInviteWithdrawV1Schema.safeParse({
      schemaVersion: PORTAL_INVITE_WITHDRAW_VERSION,
      workspaceId: WORKSPACE,
      inviteId: INVITE,
      reason: "user_request",
    }).success).toBe(true);
    expect(portalInviteWithdrawV1Schema.safeParse({
      schemaVersion: PORTAL_INVITE_WITHDRAW_VERSION,
      workspaceId: WORKSPACE,
      inviteId: INVITE,
      reason: "superseded",
    }).success).toBe(true);
    expect(portalInviteWithdrawV1Schema.safeParse({
      schemaVersion: PORTAL_INVITE_WITHDRAW_VERSION,
      workspaceId: WORKSPACE,
      inviteId: INVITE,
      reason: "gehackt",
    }).success).toBe(false);
  });

  it("generiert 32-Byte-Token mit unsalted SHA-256-Roundtrip", () => {
    const first = generatePortalToken();
    const second = generatePortalToken();
    expect(first.token).not.toBe(second.token);
    const raw = Buffer.from(first.token, "base64url");
    expect(raw.length).toBe(32);
    const hash = hashPortalToken(first.token);
    expect(hash).not.toBeNull();
    expect(hash?.equals(first.tokenHash)).toBe(true);
    expect(hash?.length).toBe(32);
  });

  it("mappt deformierte Token auf null (kein Throw, kein Orakel)", () => {
    expect(hashPortalToken("")).toBeNull();
    expect(hashPortalToken("!!!kein-base64url!!!")).toBeNull();
    expect(hashPortalToken(Buffer.alloc(31).toString("base64url"))).toBeNull();
    expect(hashPortalToken(Buffer.alloc(33).toString("base64url"))).toBeNull();
    // Wohlgeformt, aber fremd -> Hash (DB antwortet not_found, kein Unterschied).
    const foreign = generatePortalToken();
    expect(hashPortalToken(foreign.token)).not.toBeNull();
  });

  it("leitet Next-Step aus Outcome vor Phase ab", () => {
    expect(derivePortalNextStep("request", "open")).toBe("Anfrage in Prüfung");
    expect(derivePortalNextStep("offer", "open")).toBe("Angebot liegt vor");
    expect(derivePortalNextStep("installation", "open")).toBe("Installation läuft");
    expect(derivePortalNextStep("offer", "won")).toBe("Auftrag bestätigt");
    expect(derivePortalNextStep("request", "lost")).toBe("Vorgang abgeschlossen");
    expect(derivePortalNextStep("offer", "cannot_fulfill")).toBe("Vorgang abgeschlossen");
    expect(derivePortalNextStep("unbekannt", "open")).toBe("Stand in Klärung");
  });

  it("parst ok-Projektion und mappt not_found auf null", () => {
    expect(parsePortalPublicView({ status: "not_found" })).toBeNull();
    expect(parsePortalPublicView(null)).toBeNull();
    expect(parsePortalPublicView({ status: "ok" })).toBeNull();
    const view = parsePortalPublicView({
      status: "ok",
      inviteId: INVITE,
      expiresAt: "2026-10-01T00:00:00.000Z",
      viewCount: 2,
      project: { id: PROJECT, name: "P", phase: "offer", outcome: "open" },
      documents: [{
        id: INVITE,
        offerNumber: "A-1",
        documentDate: "2026-09-01",
        issuedAt: "2026-09-02T00:00:00.000Z",
        // F10.2 Slice B: kanonische Resolve-Form enthält Signatur-Felder.
        signatureStatus: "none",
        signedAt: null,
      }],
      appointments: [{
        id: INVITE,
        title: "Vor-Ort-Termin",
        startAt: "2026-09-10T10:00:00.000Z",
        endAt: "2026-09-10T11:00:00.000Z",
        allDay: false,
        appointmentType: "on_site",
        location: "Musterstraße 1",
      }],
    });
    expect(view?.schemaVersion).toBe(PORTAL_PUBLIC_VIEW_VERSION);
    expect(view?.documents).toHaveLength(1);
    expect(view?.appointments).toHaveLength(1);
    expect(view?.appointments[0]).not.toHaveProperty("description");
  });
});
