# F11-01 PWA-Skeleton (installierbar, lesend)

Ziel: Die App ist als PWA installierbar (Manifest + Icons + Theme-Farbe) —
rein statisch, keine Service-Worker-/Sync-Logik, keine neuen Permissions.

## Umfang (bewusst schmal)

- `public/manifest.webmanifest`: Name, Kurzname, Start-URL, Display
  standalone, Sprache Deutsch, Theme-/Hintergrundfarbe, Icons 192 + 512
  (any + maskable).
- Icons als generierte PNGs (blaues Rundquadrat + weißes „W“, Maskable mit
  Safe-Zone); Quelle/Generator im Spec-Protokoll unten, keine
  Fremd-Assets.
- `app/layout.tsx`: Manifest-Verknüpfung, Theme-Color, iOS-Touch-Icon,
  Apple-Web-App-Titel.
- Offline-Outbox (Fotos/Checklisten/Zeit-Sync), Service Worker und
  Push bleiben ausdrücklich Folge-Slices (F11-02+).

## ESTIMATE (reversibel)

- Icon-Gestalt und Theme-Farbton sind Hausmittel (kein Reonic-Asset,
  keine Brand-Freigabe); exaktes Reonic-App-Icon UNKNOWN.
