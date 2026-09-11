import { describe, expect, it } from "vitest";

import {
  computeLeadScore,
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
};

const FULL: LeadScoreInput = {
  hasEmail: true,
  hasPhone: true,
  hasAddress: true,
  hasGeo: true,
  hasProfile: true,
  profileConfirmed: true,
  hasRequirements: true,
  hasKeyAccount: true,
  hasSource: true,
};

describe("F1-07 Lead-Score (Unit)", () => {
  it("F107-U-01: leerer Lead = 0, kalt, keine Signale", () => {
    expect(computeLeadScore(EMPTY)).toEqual({ value: 0, band: "cold", signals: [] });
  });

  it("F107-U-02: vollständiger Lead = 100, heiß, alle Signale", () => {
    const score = computeLeadScore(FULL);
    const total = Object.values(LEAD_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
    expect(score.value).toBe(100);
    expect(score.band).toBe("hot");
    expect(score.signals).toHaveLength(9);
  });

  it("F107-U-03: Schwellen 70/40 (heiß ab 70, warm ab 40)", () => {
    expect(scoreBandForValue(100)).toBe("hot");
    expect(scoreBandForValue(70)).toBe("hot");
    expect(scoreBandForValue(69)).toBe("warm");
    expect(scoreBandForValue(40)).toBe("warm");
    expect(scoreBandForValue(39)).toBe("cold");
    expect(scoreBandForValue(0)).toBe("cold");
  });

  it("F107-U-04: bestätigt ohne Profil zählt nicht (kein Phantom-Signal)", () => {
    const score = computeLeadScore({ ...EMPTY, profileConfirmed: true });
    expect(score.value).toBe(0);
    expect(score.signals).not.toContain("profileConfirmed");
  });

  it("F107-U-05: Kontakt+Adresse ohne Profil bleibt kalt", () => {
    const score = computeLeadScore({
      ...EMPTY,
      hasEmail: true,
      hasPhone: true,
      hasAddress: true,
    });
    expect(score.value).toBe(
      LEAD_SCORE_WEIGHTS.email + LEAD_SCORE_WEIGHTS.phone + LEAD_SCORE_WEIGHTS.address,
    );
    expect(score.value).toBeLessThan(40);
    expect(score.band).toBe("cold");
  });

  it("F107-U-06: 85 Punkte ohne Bestätigung/Quelle sind heiß (Schwelle 70)", () => {
    const score = computeLeadScore({
      ...EMPTY,
      hasEmail: true,
      hasPhone: true,
      hasAddress: true,
      hasGeo: true,
      hasProfile: true,
      hasRequirements: true,
      hasKeyAccount: true,
    });
    expect(score.value).toBe(85);
    expect(score.band).toBe("hot");
    expect(score.signals).not.toContain("profileConfirmed");
    expect(score.signals).not.toContain("source");
  });
});
