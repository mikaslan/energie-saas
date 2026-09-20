"use client";

import { useEffect, useState } from "react";

// F11-07b: SW-Update-UI. Meldet einen wartenden Worker (Update gefunden,
// alter steuert noch) und aktiviert ihn benutzergetrieben per
// SKIP_WAITING + Reload. Erstinstallation aktiviert weiter sofort
// (kein Waiting ohne aktiven Worker) — F11-02 bleibt grün.
export function SwUpdateNotice() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let cancelled = false;
    let registrationRef: ServiceWorkerRegistration | null = null;
    const onUpdateFound = () => {
      watchInstalling(registrationRef?.installing ?? null);
    };
    const showIfWaiting = () => {
      if (!cancelled && registrationRef?.waiting) setWaiting(registrationRef.waiting);
    };
    // Beobachten ab JETZT: deckt updatefound-vor-Listener (Mount mit
    // laufendem Install) und installierte-vor-Anhang (schneller Cache).
    // Der bekannte Worker wird direkt übernommen (kein .waiting-Race).
    const watchInstalling = (worker: ServiceWorker | null) => {
      if (!worker || worker.state === "redundant") return;
      if (worker.state === "installed") {
        if (!cancelled && navigator.serviceWorker.controller) setWaiting(worker);
        return;
      }
      worker.addEventListener("statechange", () => {
        if (cancelled) return;
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          setWaiting(worker);
        }
      });
    };
    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((registration) => {
        if (cancelled) return;
        registrationRef = registration;
        showIfWaiting();
        watchInstalling(registration.installing);
        registration.addEventListener("updatefound", onUpdateFound);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      registrationRef?.removeEventListener("updatefound", onUpdateFound);
    };
  }, []);

  // Redundant gewordener Warte-Worker (ersetzt/entfernt) → Notice weg.
  useEffect(() => {
    if (!waiting) return;
    if (waiting.state === "redundant") {
      setWaiting(null);
      return;
    }
    const onStateChange = () => {
      if (waiting.state === "redundant") setWaiting(null);
    };
    waiting.addEventListener("statechange", onStateChange);
    return () => waiting.removeEventListener("statechange", onStateChange);
  }, [waiting]);

  useEffect(() => {
    if (!waiting) return;
    window.dispatchEvent(new Event("sw-update:visible"));
    const reloadOnce = () => window.location.reload();
    navigator.serviceWorker.addEventListener("controllerchange", reloadOnce, { once: true });
    return () => navigator.serviceWorker.removeEventListener("controllerchange", reloadOnce);
  }, [waiting]);

  if (!waiting) return null;

  const applyUpdate = () => {
    setApplying(true);
    waiting.postMessage({ type: "SKIP_WAITING" });
  };

  return (
    <div
      role="status"
      data-testid="sw-update-notice"
      className="fixed inset-x-0 bottom-[calc(var(--f11-tabbar-h,0px)+max(0.75rem,env(safe-area-inset-bottom)))] z-40 px-4"
    >
      <div className="mx-auto flex w-full max-w-xl flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white/95 p-4 shadow-lg backdrop-blur">
        <p className="text-sm font-medium text-slate-900">Eine neue Version ist verfügbar.</p>
        <button
          type="button"
          disabled={applying}
          aria-busy={applying || undefined}
          onClick={applyUpdate}
          className="min-h-11 rounded-md bg-brand-700 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400"
        >
          {applying ? "Wird aktualisiert …" : "Aktualisieren"}
        </button>
      </div>
    </div>
  );
}
