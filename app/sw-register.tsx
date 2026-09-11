"use client";

import { useEffect } from "react";

// F11-02: Service-Worker-Registrierung (Offline-Hülle). Fehlerfrei
// still (kein SW-Support/kein HTTPS-Loopback → App bleibt nutzbar).
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  return null;
}
