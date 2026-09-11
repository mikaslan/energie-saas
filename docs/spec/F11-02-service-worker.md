# F11-02 Service Worker (Offline-Hülle, lesend)

Erster Folge-Slice nach F11-01 (dort ausdrücklich offengelassen):
reine Offline-Hülle ohne Sync/Push/Outbox (bleiben F11-03+). Kein
Reonic-Referenzbeleg; Verhalten ist reversible eigene Näherung
(ESTIMATE).

## Umfang

- `public/sw.js` (Version `f11-02-v1`, versionierte Caches, alte Stände
  werden aufgeräumt): Navigation network-first mit Fallback auf
  `/offline.html` (statisch, ohne Next-Abhängigkeit); gleichartige
  GET-Anfragen (kein `/api/*`, nur lesbare Asset-Ziele) stale-while-
  revalidate; Nicht-GET/fremde Ziele nie angefasst.
- `app/sw-register.tsx`: Registrierung per `useEffect` im Root-Layout,
  fehlerstill (ohne SW-Support bleibt die App nutzbar).
- Keine neuen Permissions, keine Persistenz, kein Versand.

## Tests

- E2E (`F11-02-E2E-01`): `/login` registriert (Poll bis `activated`),
  Offline-Reload zeigt „Keine Verbindung“, online wieder das Formular;
  keine Browser-Fehler.
