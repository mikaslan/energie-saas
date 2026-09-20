import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// F5-03 LiDAR-Adapter (Katalog F5.2: iPhone 12 Pro+/iPad Pro 2020+,
// Apple RoomPlan, Raum-für-Raum, Türdurchgangs-Stitching,
// Tracking-Warnungen, Android-Parität, Portal-Tracing).
// Spec: docs/spec/F5-03-lidar-adapter.md
//
// RED-Stand: Der Adapter ist auf diesem Branch SPECIFIED, aber nicht
// implementiert. Jeder Test fordert einen Adapter-Bestandteil ein und
// muss heute FEHLschlagen (fehlende Dateien). Aktivierung erst nach
// Plattform-Entscheid Q-M5-LIDAR-PLATTFORM (siehe Spec §7).
//
// Abgrenzung: Der F1-19-roomwise-Shape (energyRoomSchema,
// lib/integrations/calculation/contract.ts:189-197 — Name/Fläche/
// Nutzung/Heizkörper) ist KEIN LiDAR-Ziel und wird hier nicht
// umgedeutet; LiDAR-Provenance heißt `lidar_scan` (§1), Android-Ziel
// ist das F5.3-Modell (§4).

const LIDAR_DIR = path.resolve(process.cwd(), "lib/integrations/lidar");

function lidarFile(name: string): string {
  return path.resolve(LIDAR_DIR, name);
}

describe.skip("RED F5-03: LiDAR-Adapter SPECIFIED, nicht implementiert (5/5 ROT belegt) — Spec: docs/spec/F5-03-lidar-adapter.md", () => {
  it("scan-session-Contract-Modul existiert (scan-session/scan-result)", () => {
    expect(existsSync(lidarFile("scan-session.ts"))).toBe(true);
  });

  it("scan-result-Modul existiert (Provenance lidar_scan, Polygone/Wandflächen/Öffnungen)", () => {
    expect(existsSync(lidarFile("scan-result.ts"))).toBe(true);
  });

  it("Device-Gate exportiert isLidarCapable (nativer Capability-Check)", () => {
    const gate = lidarFile("device-gate.ts");
    expect(existsSync(gate)).toBe(true);
    expect(readFileSync(gate, "utf8")).toMatch(/isLidarCapable/u);
  });

  it("Device-Gate enthält kein UA-Parsing (Verbot aus Spec §2)", () => {
    const gate = lidarFile("device-gate.ts");
    expect(existsSync(gate)).toBe(true);
    const source = readFileSync(gate, "utf8");
    expect(source).not.toMatch(/userAgent/u);
    expect(source).not.toMatch(/navigator\.platform/u);
  });

  it("Portal-Tracing-Slice-Marker existiert (eigener Editor-Folgeslice)", () => {
    expect(existsSync(lidarFile("portal-tracing.ts"))).toBe(true);
  });
});
