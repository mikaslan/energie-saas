"use client";

import { useEffect, useRef, useState } from "react";
import { idleState } from "@/lib/time-tracking-idle";

// F9-10 Idle-Hinweis: Inaktivitäts-Anstoß zur Pause bei laufendem Eintrag.
// Reine Erinnerung (nie automatische Buchung). Ereignisse setzen die Uhr
// zurück; der 5-s-Takt prüft idleState (deterministisch, E2E via
// page.clock). „Weiter arbeiten" blendet aus (nächster Hinweis nach neuer
// Schwelle), „Pause starten" nutzt die bestehende startBreakAction
// (Eintrag-ID per Hidden-Feld).
//
// Sticky: Einmal gezeigt, bleibt der Banner bis zur expliziten Aktion
// gemountet — Aktivität beim Hingreifen (pointerdown/Enter) darf die
// laufende Submit-Aktion nicht durch Unmount abbrechen (A11y). State wird
// nur in Event-/Timer-Callbacks gesetzt (kein setState im Effekt-Body).
const ACTIVITY_EVENTS = [
  "pointerdown",
  "keydown",
  "scroll",
  "touchstart",
] as const;

function formatBerlinTime(ms: number): string {
  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  }).format(new Date(ms));
}

export function IdleHint({
  workspaceId,
  projectId,
  entryId,
  startDispatch,
}: {
  workspaceId: string;
  projectId: string;
  entryId: string;
  startDispatch: (formData: FormData) => void;
}) {
  // Ref-Start im Effekt (Date.now ist impure und gehört nicht in den Render).
  const lastActivityRef = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [idleSinceMs, setIdleSinceMs] = useState<number | null>(null);

  useEffect(() => {
    lastActivityRef.current = Date.now();
    const check = () => {
      const state = idleState(lastActivityRef.current, Date.now());
      if (state.idle && state.idleSinceMs !== null) {
        setIdleSinceMs(state.idleSinceMs);
        setVisible(true);
      }
    };
    const mark = () => {
      lastActivityRef.current = Date.now();
    };
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, mark, { passive: true });
    }
    const timer = window.setInterval(check, 5_000);
    return () => {
      for (const name of ACTIVITY_EVENTS) {
        window.removeEventListener(name, mark);
      }
      window.clearInterval(timer);
    };
  }, []);

  if (!visible || idleSinceMs === null) return null;
  return (
    <div
      data-testid="idle-hint"
      role="status"
      className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4"
    >
      <p className="text-sm font-semibold text-slate-900">
        Keine Aktivität seit {formatBerlinTime(idleSinceMs)} — Pause vergessen?
      </p>
      <p className="mt-1 text-sm text-slate-600">
        Die Stoppuhr läuft weiter. Trage eine Pause ein oder arbeite weiter —
        automatisch wird nichts gebucht.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <form action={startDispatch}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="id" value={entryId} />
          <button
            type="submit"
            data-testid="idle-hint-start-break"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            Pause starten
          </button>
        </form>
        <button
          type="button"
          data-testid="idle-hint-dismiss"
          onClick={() => {
            lastActivityRef.current = Date.now();
            setVisible(false);
          }}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          Weiter arbeiten
        </button>
      </div>
    </div>
  );
}
