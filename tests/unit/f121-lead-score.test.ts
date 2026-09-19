import { describe, expect, it } from "vitest";

import {
  computeLeadScore,
  isLeadScoreStale,
  leadScoreSnapshotFromStored,
  LEAD_SCORE_STALE_AFTER_MS,
  LEAD_SCORE_WEIGHTS,
  scoreBandForValue,
  type LeadScoreInput,
} from "@/lib/lead-score";

const EMPTY: LeadScoreInput = {
  hasEmail: false,
  hasPhone: false,
  hasAddress: false,
  hasGeo: false,
  hasProfile: false,
  profileConfirmed: false,
  hasRequirements: false,
  hasKeyAccount: false,
  hasSource: false,
  hasIntent: false,
};

const NOW = new Date("2026-09-19T12:00:00.000Z");

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

describe("F1-21 Lead-Score-Vertiefung (Unit)", () => {
  it("F121-U-01: Intent ist das 10. Signal mit Gewicht 10", () => {
    expect(LEAD_SCORE_WEIGHTS.intent).toBe(10);
    const without = computeLeadScore(EMPTY);
    const withIntent = computeLeadScore({ ...EMPTY, hasIntent: true });
    expect(without.value).toBe(0);
    expect(withIntent.value).toBe(10);
    expect(withIntent.band).toBe("cold");
    expect(withIntent.signals).toEqual(["intent"]);
  });

  it("F121-U-02: Summe über 100 klemmt auf 100 (Clamp, Bänder fix)", () => {
    const score = computeLeadScore({
      ...EMPTY,
      hasEmail: true,
      hasPhone: true,
      hasAddress: true,
      hasGeo: true,
      hasProfile: true,
      profileConfirmed: true,
      hasRequirements: true,
      hasKeyAccount: true,
      hasSource: true,
      hasIntent: true,
    });
    expect(score.value).toBe(100);
    expect(score.band).toBe("hot");
    expect(score.signals).toHaveLength(10);
    // Bänder unverändert trotz Clamp.
    expect(scoreBandForValue(100)).toBe("hot");
    expect(scoreBandForValue(70)).toBe("hot");
    expect(scoreBandForValue(69)).toBe("warm");
    expect(scoreBandForValue(40)).toBe("warm");
    expect(scoreBandForValue(39)).toBe("cold");
  });

  it("F121-U-03: 95 + Intent = 100 (Clamp greift erst über 100)", () => {
    // 10+10+10+10+20+10+15+10+0+0 = 95 ohne Quelle/Intent.
    const base = computeLeadScore({
      ...EMPTY,
      hasEmail: true,
      hasPhone: true,
      hasAddress: true,
      hasGeo: true,
      hasProfile: true,
      profileConfirmed: true,
      hasRequirements: true,
      hasKeyAccount: true,
    });
    expect(base.value).toBe(95);
    const withIntent = computeLeadScore({ ...EMPTY,
      hasEmail: true,
      hasPhone: true,
      hasAddress: true,
      hasGeo: true,
      hasProfile: true,
      profileConfirmed: true,
      hasRequirements: true,
      hasKeyAccount: true,
      hasIntent: true,
    });
    expect(withIntent.value).toBe(100);
    expect(withIntent.signals).toContain("intent");
  });

  it("F121-U-04: Stale-Regel — pending/fehlend/TTL-15-min", () => {
    expect(LEAD_SCORE_STALE_AFTER_MS).toBe(15 * 60_000);
    // pending ist immer stale (auch frisch).
    expect(isLeadScoreStale("pending", NOW.toISOString(), NOW)).toBe(true);
    // Nie berechnet (null) ist stale.
    expect(isLeadScoreStale(null, null, NOW)).toBe(true);
    expect(isLeadScoreStale(undefined, undefined, NOW)).toBe(true);
    // ready ohne/fehlerhaftes computed_at ist stale.
    expect(isLeadScoreStale("ready", null, NOW)).toBe(true);
    expect(isLeadScoreStale("ready", "kein-datum", NOW)).toBe(true);
    // ready + frisch ist nicht stale; älter als TTL ist stale.
    expect(isLeadScoreStale("ready", minutesAgo(14), NOW)).toBe(false);
    expect(isLeadScoreStale("ready", minutesAgo(16), NOW)).toBe(true);
  });

  it("F121-U-05: gespeicherte Zeile → Snapshot (frisch/pending)", () => {
    const fresh = leadScoreSnapshotFromStored({
      value: 85,
      band: "hot",
      signals: ["email", "phone"],
      computedAt: minutesAgo(5),
      status: "ready",
    }, NOW);
    expect(fresh).toEqual({
      value: 85,
      band: "hot",
      signals: ["email", "phone"],
      stale: false,
      computedAt: minutesAgo(5),
    });
    const pending = leadScoreSnapshotFromStored({
      value: 85,
      band: "hot",
      signals: ["email", "phone"],
      computedAt: minutesAgo(5),
      status: "pending",
    }, NOW);
    expect(pending?.stale).toBe(true);
    const expired = leadScoreSnapshotFromStored({
      value: 50,
      band: "warm",
      signals: ["email"],
      computedAt: minutesAgo(30),
      status: "ready",
    }, NOW);
    expect(expired?.stale).toBe(true);
  });

  it("F121-U-06: gespeicherte Zeile fail-closed (null statt korrupt)", () => {
    const valid = {
      value: 85,
      band: "hot",
      signals: ["email", "phone"],
      computedAt: minutesAgo(5),
      status: "ready",
    } as const;
    // Wert außerhalb 0..100.
    expect(leadScoreSnapshotFromStored({ ...valid, value: 101 }, NOW)).toBeNull();
    expect(leadScoreSnapshotFromStored({ ...valid, value: -1 }, NOW)).toBeNull();
    // Unbekanntes Band.
    expect(leadScoreSnapshotFromStored({ ...valid, band: "lava" }, NOW)).toBeNull();
    // Band/Wert-Widerspruch (85 ist hot, nicht warm).
    expect(leadScoreSnapshotFromStored({ ...valid, band: "warm" }, NOW)).toBeNull();
    // Fremde Signale.
    expect(leadScoreSnapshotFromStored({ ...valid, signals: ["email", "tracking"] }, NOW)).toBeNull();
    // Unbekannter Status / fehlendes computed_at.
    expect(leadScoreSnapshotFromStored({ ...valid, status: "crunching" }, NOW)).toBeNull();
    expect(leadScoreSnapshotFromStored({ ...valid, computedAt: "kaputt" }, NOW)).toBeNull();
    // NULL-Zeile (Cold-Start).
    expect(leadScoreSnapshotFromStored({
      value: null,
      band: null,
      signals: null,
      computedAt: null,
      status: null,
    }, NOW)).toBeNull();
  });
});
