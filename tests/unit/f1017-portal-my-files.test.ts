import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/action", () => ({
  publicTokenCapsule: vi.fn(),
}));
vi.mock("@/modules/project-files", () => ({
  PROJECT_FILE_CONTENT_TYPES: {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
  },
  PROJECT_FILE_NAME_MAX: 180,
  ProjectFileIntegrityError: class ProjectFileIntegrityError extends Error {},
  ProjectFileNotFoundError: class ProjectFileNotFoundError extends Error {},
  ProjectFilePersistenceError: class ProjectFilePersistenceError extends Error {},
  readPortalProjectFileByToken: vi.fn(),
}));

import {
  parsePortalPublicView,
  portalProjectFileSchema,
} from "@/lib/integrations/portal/portal-contract";
import {
  isPortalProjectFilenameSafe,
  portalProjectFileDisposition,
} from "@/app/p/[token]/dateien/[fileId]/route";

/**
 * F10-17 Portal My-Files — Contract-Units C-01..C-03 (rein, kein DB).
 * projectFiles-Projektion: strikter 5-Felder-Shape, Alt-Projektion leer,
 * deformiert fail-closed (F10-14-statusVisibility-Muster).
 */

const INVITE = "33333333-3333-4333-8333-333333333333";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const FILE_A = "44444444-4444-4444-8444-444444444444";
const FILE_B = "55555555-5555-4555-8555-555555555555";

function baseView(): Record<string, unknown> {
  return {
    status: "ok",
    inviteId: INVITE,
    expiresAt: "2026-10-01T00:00:00.000Z",
    viewCount: 2,
    project: { id: PROJECT, name: "P", phase: "offer", outcome: "open", scope: "residential" },
    documents: [],
    appointments: [],
  };
}

function fileEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FILE_A,
    originalFilename: "freigabe.pdf",
    contentType: "application/pdf",
    byteSize: 128,
    createdAt: "2026-09-06T08:00:00.000Z",
    ...overrides,
  };
}

describe("F10-17 Portal My-Files Contract (rein)", () => {
  it("C-01: projectFiles parst den 5-Felder-Shape (ohne Key/Hash)", () => {
    const view = parsePortalPublicView({
      ...baseView(),
      projectFiles: [
        fileEntry(),
        fileEntry({ id: FILE_B, originalFilename: "zweite.png", contentType: "image/png", byteSize: 70 }),
      ],
    });
    expect(view).not.toBeNull();
    expect(view?.projectFiles).toHaveLength(2);
    expect(view?.projectFiles[0]).toEqual({
      id: FILE_A,
      originalFilename: "freigabe.pdf",
      contentType: "application/pdf",
      byteSize: 128,
      createdAt: "2026-09-06T08:00:00.000Z",
    });
    expect(Object.keys(view?.projectFiles[0] ?? {}).sort()).toEqual([
      "byteSize",
      "contentType",
      "createdAt",
      "id",
      "originalFilename",
    ]);
    // Schema-Pin direkt: strikt, exakt 5 Felder.
    const parsed = portalProjectFileSchema.safeParse(fileEntry());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data).sort()).toEqual([
        "byteSize",
        "contentType",
        "createdAt",
        "id",
        "originalFilename",
      ]);
    }
  });

  it("C-02: ohne Key (Alt-Projektion) → ehrlich leer", () => {
    const view = parsePortalPublicView(baseView());
    expect(view).not.toBeNull();
    expect(view?.projectFiles).toEqual([]);
  });

  it("C-03: deformiert → null fail-closed (kein Teil-Render)", () => {
    const cases: Array<{ name: string; projectFiles: unknown }> = [
      { name: "kein Array", projectFiles: { id: FILE_A } },
      { name: "kein Objekt", projectFiles: ["freigabe.pdf"] },
      { name: "fremder Key", projectFiles: [fileEntry({ extra: true })] },
      { name: "storage_key drin", projectFiles: [fileEntry({ storageKey: "immutable/x" })] },
      { name: "sha drin", projectFiles: [fileEntry({ fileSha256: "0".repeat(64) })] },
      { name: "byteSize 0", projectFiles: [fileEntry({ byteSize: 0 })] },
      { name: "byteSize negativ", projectFiles: [fileEntry({ byteSize: -5 })] },
      { name: "byteSize Bruch", projectFiles: [fileEntry({ byteSize: 1.5 })] },
      { name: "id keine UUID", projectFiles: [fileEntry({ id: "keine-uuid" })] },
      { name: "createdAt deformiert", projectFiles: [fileEntry({ createdAt: "bald" })] },
      { name: "originalFilename fehlt", projectFiles: [{ ...fileEntry(), originalFilename: undefined }] },
      { name: "contentType Zahl", projectFiles: [fileEntry({ contentType: 42 })] },
      {
        name: "zweiter Eintrag deformiert",
        projectFiles: [fileEntry(), fileEntry({ id: FILE_B, byteSize: 0 })],
      },
    ];
    for (const entry of cases) {
      expect(
        parsePortalPublicView({ ...baseView(), projectFiles: entry.projectFiles }),
        `fail-closed: ${entry.name}`,
      ).toBeNull();
    }
  });
});

describe("F10-17 Portal-Download Dateinamen-Guard (rein, Review-Fund)", () => {
  it("C-04: echte Upload-Namen passieren (Leerzeichen, Umlaute, Gross-Endung)", () => {
    // Upload prueft nur Laenge+Endung (case-insensitiv) — diese Namen sind
    // alle DB-legal und muessen im Portal ladbar sein (kein 503).
    for (const name of [
      "freigabe.pdf",
      "Freigabe Angebot.PDF",
      "Rechnung März.pdf",
      "Foto vom Dach.JPG",
      "a.png",
      `${"n".repeat(176)}.pdf`,
    ]) {
      expect(isPortalProjectFilenameSafe(name), `erlaubt: ${name}`).toBe(true);
    }
  });

  it("C-05: gefaehrliche/fremde Namen fallen fail-closed heraus", () => {
    for (const name of [
      "",
      "   ",
      "keine-endung",
      "plan.pdf ",
      " plan.pdf",
      " setup.exe",
      "rechnung.pdf.exe",
      `x${"n".repeat(180)}.pdf`,
      "boese\".pdf",
      "zeilen\numbruch.pdf",
      "tab\tname.pdf",
      "null\0byte.pdf",
    ]) {
      expect(isPortalProjectFilenameSafe(name), `verworfen: ${JSON.stringify(name)}`).toBe(false);
    }
  });

  it("C-06: Disposition neutralisiert Anführungszeichen/Steuerzeichen (intern-Muster)", () => {
    const disposition = portalProjectFileDisposition("Angebot \"final\"\r\n.pdf");
    expect(disposition.startsWith("attachment;")).toBe(true);
    const fallback = disposition.split(";")[1] ?? "";
    expect(fallback).not.toContain("\"final\"");
    expect(fallback).not.toMatch(/[\r\n]/u);
    expect(disposition).toContain("filename*=UTF-8''");
    expect(portalProjectFileDisposition("Freigabe Angebot.PDF")).toContain(
      "filename*=UTF-8''Freigabe%20Angebot.PDF",
    );
  });
});
