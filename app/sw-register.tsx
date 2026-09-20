"use client";

import { useEffect } from "react";

// F11-02: Service-Worker-Registrierung (Offline-Hülle). Fehlerfrei
// still (kein SW-Support/kein HTTPS-Loopback → App bleibt nutzbar).
// F11-07: updateViaCache 'none' (steht auch in der Update-Notice — wer
// zuerst registriert, setzt die Option; Update-Check umgeht HTTP-Cache).
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => undefined);
  }, []);
  return null;
}
