import { describe, expect, it } from "vitest";

import {
  buildTimerStopIntent,
} from "@/app/w/[workspaceId]/anfragen/[projectId]/zeiterfassung/time-timer-outbox";

// F11-03d Offline-Stopp online gestarteter Timer: Intent-Builder (rein).
describe("F11-03d Offline-Stopp-Intent", () => {
  const base = {
    workspaceId: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-8333-8333-333333333333",
    entryId: "44444444-4444-8444-8444-444444444444",
    serverStartAt: "2026-01-15T08:00:00.000Z",
    queuedAt: "2026-01-15T08:05:00.000Z",
  };

  it("F1103D-U-01: gültiger Stopp wird Intent mit exaktem Instant", () => {
    const result = buildTimerStopIntent({
      ...base,
      endAt: "2026-01-15T08:05:00.000Z",
      workingTimeMinutes: 5,
      breakDurationMinutes: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stop.key).toBe(base.entryId);
    expect(result.stop.entryId).toBe(base.entryId);
    // Exakter Offline-Instant (kein Runden, kein Server-Raten).
    expect(result.stop.endAt).toBe("2026-01-15T08:05:00.000Z");
    expect(result.stop.workingTimeMinutes).toBe(5);
  });

  it("F1103D-U-02: Minuten-Guards sind fail-closed", () => {
    const endAt = "2026-01-15T08:05:00.000Z";
    for (const minutes of [
      { workingTimeMinutes: 0, breakDurationMinutes: 0 },
      { workingTimeMinutes: 1441, breakDurationMinutes: 0 },
      { workingTimeMinutes: 1.5, breakDurationMinutes: 0 },
      { workingTimeMinutes: 5, breakDurationMinutes: 6 },
      { workingTimeMinutes: 5, breakDurationMinutes: -1 },
    ]) {
      expect(buildTimerStopIntent({ ...base, endAt, ...minutes }))
        .toEqual({ ok: false, reason: "invalid" });
    }
    // Pause == Arbeitszeit bleibt zulässig (wie online).
    expect(buildTimerStopIntent({
      ...base,
      endAt,
      workingTimeMinutes: 5,
      breakDurationMinutes: 5,
    }).ok).toBe(true);
  });

  it("F1103D-U-03: Stopp vor Start/defekt ist invalid, >24 h too-long", () => {
    const minutes = { workingTimeMinutes: 5, breakDurationMinutes: 0 };
    expect(buildTimerStopIntent({ ...base, endAt: "2026-01-15T07:59:59.000Z", ...minutes }))
      .toEqual({ ok: false, reason: "invalid" });
    expect(buildTimerStopIntent({ ...base, endAt: "kein-datum", ...minutes }))
      .toEqual({ ok: false, reason: "invalid" });
    // Genau 24 h zulässig, darüber too-long.
    expect(buildTimerStopIntent({ ...base, endAt: "2026-01-16T08:00:00.000Z", ...minutes }).ok)
      .toBe(true);
    expect(buildTimerStopIntent({ ...base, endAt: "2026-01-16T08:00:01.000Z", ...minutes }))
      .toEqual({ ok: false, reason: "too-long" });
  });
});
