import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  PROJECT_FILE_CONTENT_TYPES,
  PROJECT_FILE_KEY_PATTERN,
  PROJECT_FILE_MAX_BYTES,
  PROJECT_FILE_NAME_MAX,
} from "@/modules/project-files";

/**
 * F7-16 Projekt-Dateien — U-01 (reiner Contract-Test, kein DB-Zugriff).
 * Key-Muster: immutable/<projektId>/project-files/<dateiId>_<sha8>.<ext>.
 */
describe("F7-16 Projekt-Dateien Key-Contract (Unit)", () => {
  const projectId = "11111111-1111-1111-8111-111111111111";
  const fileId = "22222222-2222-2222-8222-222222222222";
  const key = (ext: string): string =>
    `immutable/${projectId}/project-files/${fileId}_a1b2c3d4.${ext}`;

  it("U-01: Key-Pattern akzeptiert alle 4 Endungen", () => {
    expect(PROJECT_FILE_KEY_PATTERN.test(key("pdf"))).toBe(true);
    expect(PROJECT_FILE_KEY_PATTERN.test(key("jpg"))).toBe(true);
    expect(PROJECT_FILE_KEY_PATTERN.test(key("jpeg"))).toBe(true);
    expect(PROJECT_FILE_KEY_PATTERN.test(key("png"))).toBe(true);
  });

  it("U-01: Key-Pattern lehnt Traversal, fremde Domain und Grossbuchstaben ab", () => {
    expect(PROJECT_FILE_KEY_PATTERN.test(
      `immutable/${projectId}/project-files/${fileId}_a1b2c3d4.pdf`,
    )).toBe(true);
    // Traversal im Dateinamen
    expect(PROJECT_FILE_KEY_PATTERN.test(
      `immutable/${projectId}/project-files/../x_a1b2c3d4.pdf`,
    )).toBe(false);
    // Fremde Domain
    expect(PROJECT_FILE_KEY_PATTERN.test(
      `immutable/${projectId}/checklist-photos/${fileId}_a1b2c3d4.jpg`,
    )).toBe(false);
    // Grossbuchstaben in Endung und Hash
    expect(PROJECT_FILE_KEY_PATTERN.test(
      `immutable/${projectId}/project-files/${fileId}_a1b2c3d4.PDF`,
    )).toBe(false);
    expect(PROJECT_FILE_KEY_PATTERN.test(
      `immutable/${projectId}/project-files/${fileId}_A1B2C3D4.pdf`,
    )).toBe(false);
    // Falsche Endung / fehlender Hash / Mutable-Praefix
    expect(PROJECT_FILE_KEY_PATTERN.test(
      `immutable/${projectId}/project-files/${fileId}_a1b2c3d4.txt`,
    )).toBe(false);
    expect(PROJECT_FILE_KEY_PATTERN.test(
      `immutable/${projectId}/project-files/${fileId}.pdf`,
    )).toBe(false);
    expect(PROJECT_FILE_KEY_PATTERN.test(
      `uploads/${projectId}/project-files/${fileId}_a1b2c3d4.pdf`,
    )).toBe(false);
  });

  it("U-01: Contract-Konstanten sind SPEC-gepinnt", () => {
    expect(PROJECT_FILE_MAX_BYTES).toBe(26_214_400);
    expect(PROJECT_FILE_NAME_MAX).toBe(180);
    expect(PROJECT_FILE_CONTENT_TYPES).toEqual({
      "application/pdf": "pdf",
      "image/jpeg": "jpg",
      "image/png": "png",
    });
  });
});
