"use client";

import { useEffect, useRef, useState } from "react";

const DISMISS_KEY = "wmee:pwa-install-dismissed";

// Minimal-Interface: BeforeInstallPromptEvent fehlt in lib.dom (TS 5.9).
// Nur die vom Hinweis genutzte Oberfläche (prompt + userChoice).
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function setDismissed(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Privater Modus o.ä. — Hinweis bleibt Sitzungs-Einmaligkeit.
  }
}

function updateNoticePresent(): boolean {
  return document.querySelector('[data-testid="sw-update-notice"]') !== null;
}

// F11-07a: Install-Hinweis. Erscheint nur auf das echte Browser-Signal
// `beforeinstallprompt`, nie installiert (standalone), nie nach „Nicht
// jetzt" (Reload-fest) und nie über der Update-Notice (die gewinnt).
// iOS feuert das Event nicht → dort kein Hinweis.
export function PwaInstallHint() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [prompting, setPrompting] = useState(false);
  // Ref (nicht State): schützt auch vor synchronem Doppelklick vor Re-Render.
  const promptingRef = useRef(false);

  useEffect(() => {
    if (isStandalone() || isDismissed()) return;
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      if (updateNoticePresent()) return;
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onUpdateVisible = () => setDeferred(null);
    const onAppInstalled = () => {
      setDismissed();
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("sw-update:visible", onUpdateVisible);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("sw-update:visible", onUpdateVisible);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  if (!deferred) return null;

  const install = async () => {
    if (promptingRef.current) return;
    promptingRef.current = true;
    setPrompting(true);
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === "dismissed") setDismissed();
    } catch {
      // Abgebrochener Prompt — Hinweis bleibt weg.
    } finally {
      promptingRef.current = false;
      setPrompting(false);
      setDeferred(null);
    }
  };
  const dismiss = () => {
    setDismissed();
    setDeferred(null);
  };

  return (
    <div
      role="region"
      aria-label="App-Installation"
      data-testid="pwa-install-hint"
      className="fixed inset-x-0 bottom-[calc(var(--f11-tabbar-h,0px)+max(0.75rem,env(safe-area-inset-bottom)))] z-40 px-4"
    >
      <div className="mx-auto flex w-full max-w-xl flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white/95 p-4 shadow-lg backdrop-blur">
        <p className="text-sm font-medium text-slate-900">WMEE als App installieren?</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={prompting}
            aria-busy={prompting || undefined}
            onClick={() => void install()}
            className="min-h-11 rounded-md bg-brand-700 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400"
          >
            {prompting ? "Wird geöffnet …" : "Installieren"}
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="min-h-11 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Nicht jetzt
          </button>
        </div>
      </div>
    </div>
  );
}
