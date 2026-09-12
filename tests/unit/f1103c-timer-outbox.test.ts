import { describe, expect, it } from "vitest";

import {
  buildTimerPairCreate,
  timerStartKey,
} from "@/app/w/[workspaceId]/anfragen/[projectId]/zeiterfassung/time-timer-outbox";

// F11-03c Stoppuhr-Outbox: Paar-Mapping (rein, deterministisch).
describe("F11-03c Stoppuhr-Outbox", () => {
  const base = {
    clientKey: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    typeId: null,
    comment: null,
    queuedAt: "2026-01-15T08:02:00.000Z",
  };

  it("F1103C-U-01: Paar wird Eintrag mit Berlin-Zeiten und gerundeten Minuten", () => {
    const result = buildTimerPairCreate({
      ...base,
      startAt: "2026-01-15T08:00:00.000Z",
      // 90 s = 1,5 Minuten → 2 (halb auf), mindestens 1.
      endAt: "2026-01-15T08:01:30.000Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Januar = UTC+1: 08:00Z → 09:00 Berlin.
    expect(result.entry.startAt).toBe("2026-01-15T09:00");
    expect(result.entry.endAt).toBe("2026-01-15T09:01");
    expect(result.entry.workingTimeMinutes).toBe(2);
    expect(result.entry.breakDurationMinutes).toBe(0);
    expect(result.entry.clientKey).toBe(base.clientKey);
  });

  it("F1103C-U-02: 59 s geben mindestens 1 Minute", () => {
    const result = buildTimerPairCreate({
      ...base,
      startAt: "2026-01-15T08:00:00.000Z",
      endAt: "2026-01-15T08:00:59.000Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.workingTimeMinutes).toBe(1);
  });

  it("F1103C-U-03: Ende ≤ Beginn ist fail-closed (Start bleibt wartend)", () => {
    for (const endAt of ["2026-01-15T08:00:00.000Z", "2026-01-15T07:59:59.000Z", "kein-datum"]) {
      expect(buildTimerPairCreate({
        ...base,
        startAt: "2026-01-15T08:00:00.000Z",
        endAt,
      })).toEqual({ ok: false, reason: "negative" });
    }
  });

  it("F1103C-U-04: Paar über 1440 Minuten ist fail-closed (Server-Cap)", () => {
    // 1441 Minuten → über TIME_MINUTES_MAX.
    expect(buildTimerPairCreate({
      ...base,
      startAt: "2026-01-15T08:00:00.000Z",
      endAt: "2026-01-16T08:01:00.000Z",
    })).toEqual({ ok: false, reason: "too-long" });
    // Genau 1440 Minuten bleibt zulässig.
    const exact = buildTimerPairCreate({
      ...base,
      startAt: "2026-01-15T08:00:00.000Z",
      endAt: "2026-01-16T08:00:00.000Z",
    });
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(exact.entry.workingTimeMinutes).toBe(1440);
  });

  it("F1103C-U-05: Typ/Kommentar laufen durch, Schlüssel je Projekt", () => {
    const result = buildTimerPairCreate({
      ...base,
      typeId: "44444444-4444-4444-8444-444444444444",
      comment: "Nachteinsatz",
      startAt: "2026-01-15T08:00:00.000Z",
      endAt: "2026-01-15T08:10:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.typeId).toBe("44444444-4444-4444-8444-444444444444");
    expect(result.entry.comment).toBe("Nachteinsatz");
    expect(timerStartKey("ws", "p1")).toBe("ws:p1");
    expect(timerStartKey("ws", "p1")).not.toBe(timerStartKey("ws", "p2"));
  });
});
