# WMEE-Theme-Beleg (verbindliche visuelle Vorgabe, 11.09.2026)

## Quelle und Datum

- Quelle: https://wmee.de/ — `:root`-Variablen im SSR-HTML
  (`--primary`, `--accent`, `--ring`), ausgelesen am **2026-09-11**.
- Rohbefund (wörtlich aus dem HTML):
  `--primary:152 60% 32%`, `--accent:152 60% 32%`, `--ring:152 60% 32%`;
  Hero-Gradient `#0e2a1f → #103a2a → #0a1f17` (dunkle Markenfamilie).
- Methode: `curl https://wmee.de/` + Stylesheet `/assets/index-BBLnrcIc.css`;
  kein Grünton geraten.

## Belegter Akzentwert

- `hsl(152 60% 32%)` = **#218355** (HSL→sRGB, gerundet, per Python verifiziert).
- Verwendung: einziger Theme-Akzent (Primäraktionen, Links, Fokus-Ringe) als
  Ersatz für Reonic-Orange. Neutrale Flächen (slate) sowie semantische
  Warn-/Fehler-/Erfolgsfarben (amber/red/emerald) bleiben unangetastet.
- Abgeleitete Stufen (Hover, helle Flächen, Ringe) sind per `color-mix` aus
  #218355 gerechnet und als ESTIMATE markiert — der belegte Wert selbst ist
  nur der 700er-Ton (Button-/Link-Farbe).

## Bewusst behalten

- `#ea580c` in `tou-schedule-chart.tsx`: Datenreihen-Farbe eines Diagramms,
  kein Theme-Akzent (Vorgabe: semantische Farben nicht pauschal umfärben;
  ohne Reonic-Chart-Referenz keine Änderung).
- `#1d4ed8` in `single-line-diagram.tsx` (Leiter-Strich) und
  `appointment-editor-model.ts` (Kalender-Typ-Farbe): Fach-/Kategorie-Farben,
  keine Theme-Akzente — ohne Reonic-Referenz unverändert.
- `amber-*` (z. B. Zugriff-eingeschränkt-Banner), `red-*`, `emerald-*`:
  semantische Zustandsfarben, bleiben.
- `background_color: #ffffff` (Manifest): neutral, bleibt.

## Umgestellt (THEME-01, 2026-09-11)

- `blue-*`-Utilities (1111 Stellen, 142 Dateien) → `brand-*`-Token
  (`app/globals.css`, 700 = #218355 belegt, Rest color-mix-ESTIMATE).
- `themeColor` (`app/layout.tsx`), PWA-`theme_color`
  (`public/manifest.webmanifest`), Offline-`theme-color`
  (`public/offline.html`) → #218355.
- Mitgezogene Wert-Pins (befohlene Vertragsänderung, Assertions exakt):
  `tests/unit/pwa-manifest.test.ts`, `tests/e2e/f11-01-pwa.spec.ts`.
