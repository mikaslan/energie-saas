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
    title: "KfW-Nachweis",
    description: null,
    status: "offen",
    createdAt: "2026-09-01T10:00:00.000Z",
    uploadedAt: null,
    originalFilename: null,
    allowMany: false,
    uploadCount: 0,
    filenames: [],
    fileType: "any",
    ...patch,
  };
}

describe("F10-15 KfW-Upload-Kontext (Portal-Contract)", () => {
  it("F1015-CONTRACT-01: subsidyLinked gesetzt/fehlend/deformiert", () => {
    for (const subsidyLinked of [true, false]) {
      const view = parsePortalPublicView({
        ...BASE_VIEW,
        fileRequests: [fileRequestEntry({ subsidyLinked })],
      });
      expect(view?.fileRequests).toEqual([expect.objectContaining({ subsidyLinked })]);
    }

    // Alt-Projektion ohne Schlüssel → ehrlich false (Muster fileType).
    const legacy = parsePortalPublicView({
      ...BASE_VIEW,
      fileRequests: [fileRequestEntry()],
    });
    expect(legacy?.fileRequests).toEqual([expect.objectContaining({ subsidyLinked: false })]);

    // Deformiert bricht fail-closed ab.
    for (const subsidyLinked of ["ja", 1, null, { linked: true }]) {
      expect(
        parsePortalPublicView({
          ...BASE_VIEW,
          fileRequests: [fileRequestEntry({ subsidyLinked })],
        }),
      ).toBeNull();
    }
  });

  it("F1015-CONTRACT-02: striktes Schema kennt nur Boolean", () => {
    const valid = fileRequestEntry({ subsidyLinked: true });
    expect(portalFileRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      portalFileRequestSchema.safeParse({ ...valid, subsidyLinked: "ja" }).success,
    ).toBe(false);
  });
});
