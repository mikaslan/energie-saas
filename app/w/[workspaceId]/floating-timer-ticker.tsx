"use client";

import { useEffect, useState } from "react";

function formatElapsed(startAt: string, now: number): string {
  const elapsed = Math.max(0, Math.floor((now - Date.parse(startAt)) / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

// F9-13: tickende Anzeige ab Start. Erst nach Mount rendern — die
// Server-Zeit kennt den Client-Now nicht (kein Hydration-Mismatch).
export function FloatingTimerTicker({ startAt }: { startAt: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // Erster Tick nach 1 s (kein sync setState im Effect —
    // react-hooks/set-state-in-effect); Platzhalter bis dahin.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (now === null) return <span aria-hidden="true">–:––:––</span>;
  return <span aria-label="Verstrichene Zeit">{formatElapsed(startAt, now)}</span>;
}
