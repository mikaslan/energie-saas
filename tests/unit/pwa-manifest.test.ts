import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// F11-01 PWA-Skeleton: Manifest-Felder pinnen, Icon-Dateien + PNG-Maße prüfen.

function publicFile(name: string): string {
  return join(__dirname, "..", "..", "public", name);
}

function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  // PNG-Signatur + IHDR: Breite/Höhe als Big-Endian-UInt32 ab Offset 16.
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("pwa manifest skeleton", () => {
  it("pinnt Name, Display, Farben und Icon-Ziele", () => {
    const manifest = JSON.parse(readFileSync(publicFile("manifest.webmanifest"), "utf8")) as {
      name: string;
      short_name: string;
      lang: string;
      start_url: string;
      display: string;
      background_color: string;
      theme_color: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    };
    expect(manifest.name).toBe("WMEE Vertrieb");
    expect(manifest.short_name).toBe("WMEE");
    expect(manifest.lang).toBe("de");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.background_color).toBe("#ffffff");
    expect(manifest.theme_color).toBe("#1d4ed8");
    const sizes = new Map(manifest.icons.map((icon) => [`${icon.sizes}:${icon.purpose ?? "any"}`, icon.src]));
    expect(sizes.get("192x192:any")).toBe("/icons/icon-192.png");
    expect(sizes.get("512x512:any")).toBe("/icons/icon-512.png");
    expect(sizes.get("512x512:maskable")).toBe("/icons/icon-maskable-512.png");
  });

  it.each([
    ["icons/icon-192.png", 192, 192],
    ["icons/icon-512.png", 512, 512],
    ["icons/icon-maskable-512.png", 512, 512],
    ["icons/apple-touch-icon.png", 180, 180],
  ] as const)("liefert %s als echtes PNG in %sx%s", (file, width, height) => {
    const path = publicFile(file);
    expect(statSync(path).size).toBeGreaterThan(500);
    expect(pngDimensions(path)).toEqual({ width, height });
  });
});
