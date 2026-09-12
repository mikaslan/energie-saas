// F11-03c Stoppuhr-Outbox (rein, ohne DOM/IDB): wartender Offline-Start
// plus Paar-Mapping auf QueuedTimeCreate. Das Replay läuft über die
// bestehende F11-03b-Bahn (createTimeEntryAction + clientKey-Guard) —
// der Server parst Beginn/Ende wie online. IDB-CRUD liegt bei
// time-outbox.ts (gleiche Datenbank, Version 2).
import { isoToBerlinLocalInput } from "@/lib/integrations/time-tracking/berlin-wall-clock";
import { TIME_MINUTES_MAX } from "@/lib/integrations/time-tracking/contract";
import type { QueuedTimeCreate, QueuedTimerStartRecord } from "./time-outbox";

// Gemessener Start als ISO-Instant (Geräte-Wanduhr, ESTIMATE).
export type QueuedTimerStart = QueuedTimerStartRecord;

export function timerStartKey(workspaceId: string, projectId: string): string {
  return `${workspaceId}:${projectId}`;
}

export type TimerPairInput = {
  clientKey: string;
  workspaceId: string;
  projectId: string;
  typeId: string | null;
  comment: string | null;
  startAt: string;
  endAt: string;
  queuedAt: string;
};

export type TimerPairResult =
  | { ok: true; entry: QueuedTimeCreate }
  | { ok: false; reason: "negative" | "too-long" };

/**
 * Übersetzt ein offline gemessenes Start/Stop-Paar in einen
 * manuellen Zeiteintrag-Entwurf. Arbeitszeit = gerundete Paar-Minuten
 * (mindestens 1, höchstens TIME_MINUTES_MAX wie online); längere oder
 * nicht-positive Paare werden fail-closed abgelehnt — kein stilles
 * Kappen, der wartende Start bleibt erhalten.
 */
export function buildTimerPairCreate(input: TimerPairInput): TimerPairResult {
  const startMs = new Date(input.startAt).getTime();
  const endMs = new Date(input.endAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { ok: false, reason: "negative" };
  }
  const workingTimeMinutes = Math.max(1, Math.round((endMs - startMs) / 60000));
  if (workingTimeMinutes > TIME_MINUTES_MAX) {
    return { ok: false, reason: "too-long" };
  }
  return {
    ok: true,
    entry: {
      clientKey: input.clientKey,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      typeId: input.typeId,
      startAt: isoToBerlinLocalInput(input.startAt),
      endAt: isoToBerlinLocalInput(input.endAt),
      workingTimeMinutes,
      breakDurationMinutes: 0,
      comment: input.comment,
      queuedAt: input.queuedAt,
    },
  };
}
