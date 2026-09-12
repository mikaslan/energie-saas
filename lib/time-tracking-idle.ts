// F9-10 Idle-Hinweis: reine Inaktivitäts-Entscheidung (kein I/O, kein
// DOM-Zugriff — client- und serverseitig nutzbar, Muster lib/follow-up.ts:
// geteilte Datei ohne Modul-Barrel).
//
// Schwelle 5 Minuten = Inaktivitäts-Volumen (ESTIMATE, reversibel, keine
// Reonic-Referenz). Der Hinweis ist Erinnerung, kein Abwesenheitsnachweis;
// gebucht wird nie automatisch (F9-06-Prinzip).
export const IDLE_AFTER_MS = 5 * 60 * 1_000;

export type IdleState = {
  idle: boolean;
  idleSinceMs: number | null;
};

export function idleState(lastActivityMs: unknown, nowMs: unknown): IdleState {
  if (
    typeof lastActivityMs !== "number" ||
    !Number.isFinite(lastActivityMs) ||
    typeof nowMs !== "number" ||
    !Number.isFinite(nowMs)
  ) {
    return { idle: false, idleSinceMs: null };
  }
  // Zukunfts-Stempel (Uhrversatz/Manipulation): fail-closed, nie idle.
  if (lastActivityMs > nowMs) return { idle: false, idleSinceMs: null };
  if (nowMs - lastActivityMs < IDLE_AFTER_MS) {
    return { idle: false, idleSinceMs: null };
  }
  return { idle: true, idleSinceMs: lastActivityMs };
}
