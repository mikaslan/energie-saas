"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";

const ACTIVE_STATES = new Set(["queued", "running", "retry_wait"]);

export function StatusRefresh({ state }: { state: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!ACTIVE_STATES.has(state)) return;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      startTransition(() => router.refresh());
    };
    const interval = window.setInterval(refresh, 2_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router, state]);

  if (!ACTIVE_STATES.has(state)) return null;
  return (
    <div className="flex flex-wrap items-center gap-3" role="status" aria-live="polite">
      <span className="text-sm text-slate-600">{pending ? "Status wird aktualisiert …" : "Der Status wird automatisch aktualisiert."}</span>
      <button type="button" onClick={() => startTransition(() => router.refresh())} aria-disabled={pending || undefined} disabled={pending} className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-wait">
        Jetzt aktualisieren
      </button>
    </div>
  );
}
