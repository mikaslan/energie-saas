import { describe, expect, it } from "vitest";

import {
  parsePortalPublicView,
  portalFileRequestSchema,
} from "@/lib/integrations/portal/portal-contract";

const INVITE = "33333333-3333-4333-8333-333333333333";
const PROJECT = "22222222-2222-4222-8222-222222222222";

const BASE_VIEW = {
  status: "ok",
  inviteId: INVITE,
  expiresAt: "2026-10-01T00:00:00.000Z",
  viewCount: 0,
  project: { id: PROJECT, name: "P", phase: "installation", outcome: "open", scope: "residential" },
  documents: [],
  appointments: [],
};

function fileRequestEntry(patch: Record<string, unknown> = {}) {
  return {
    id: INVITE,
    title: "Rechnung",
    description: null,
    status: "offen",
    createdAt: "2026-09-01T10:00:00.000Z",
    uploadedAt: null,
    originalFilename: null,
    allowMany: false,
    uploadCount: 0,
    filenames: [],
    ...patch,
  };
}

describe("F10-13 Datei-Anfragen Dateityp (Portal-Contract)", () => {
  it("F1013-CONTRACT-01: parst any/pdf/image, fehlend = any, fremd = null", () => {
    for (const fileType of ["any", "pdf", "image"]) {
      const view = parsePortalPublicView({
        ...BASE_VIEW,
        fileRequests: [fileRequestEntry({ fileType })],
      });
      expect(view?.fileRequests).toEqual([
        expect.objectContaining({ fileType }),
      ]);
    }

    // Alt-Projektion ohne Schlüssel → ehrlich 'any' (Muster allowMany).
    const legacy = parsePortalPublicView({
      ...BASE_VIEW,
      fileRequests: [fileRequestEntry()],
    });
    expect(legacy?.fileRequests).toEqual([
      expect.objectContaining({ fileType: "any" }),
    ]);

    // Fremde Typen brechen fail-closed ab (kein stiller Fallback).
    for (const fileType of ["exe", "PDF", "", null, 42]) {
      expect(
        parsePortalPublicView({
          ...BASE_VIEW,
          fileRequests: [fileRequestEntry({ fileType })],
        }),
      ).toBeNull();
    }
  });

  it("F1013-CONTRACT-02: striktes Schema kennt nur den geschlossenen Wortschatz", () => {
    const valid = fileRequestEntry({ fileType: "pdf" });
    expect(portalFileRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      portalFileRequestSchema.safeParse({ ...valid, fileType: "video" }).success,
    ).toBe(false);
    // Unbekannte Schlüssel bleiben verboten (Allowlist-Vertrag).
    expect(
      portalFileRequestSchema.safeParse({ ...valid, storageKey: "immutable/x" }).success,
    ).toBe(false);
  });
});
