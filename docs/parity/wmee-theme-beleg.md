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

## Kontrast-Fix (THEME-02, 2026-09-11) — WCAG AA ist blockierendes Gate

Belegter 700er (#218355) ist fix; gemessene Ratios (sRGB, AA normal ≥ 4.5):

- text-700 auf Weiß 4.73 (ok), auf body-slate-100 (#f1f5f9) **4.32 (Fail)** —
  exakt der CI-Befund (`.uppercase`-Eyebrows/Links auf Seiten-BG).
- text-800 auf Weiß 6.49, auf slate-100 5.92 (ok überall hell).
- text-brand-100 auf bg-700 3.95 (Fail) → Weiß (4.73).
- Weiß auf bg-600 (92 %-Mix) 4.09 (Fail) → Hover/Chips auf 700/800.

Fix ohne Wertänderung: `text-brand-700` → `text-brand-800` (140 Stellen),
`hover:bg-brand-600` → `hover:bg-brand-800`, Adress-Tab-Zweitzeile →
`text-white`. Fokus-Ringe bleiben brand-600 (UI-3:1 ≥ 4.09 ok).
Kanban-Punkt bg-brand-600 ist dekorativ (aria-hidden) und bleibt.

## Umgestellt (THEME-01, 2026-09-11)

- `blue-*`-Utilities (1111 Stellen, 142 Dateien) → `brand-*`-Token
  (`app/globals.css`, 700 = #218355 belegt, Rest color-mix-ESTIMATE).
- `themeColor` (`app/layout.tsx`), PWA-`theme_color`
  (`public/manifest.webmanifest`), Offline-`theme-color`
  (`public/offline.html`) → #218355.
- Mitgezogene Wert-Pins (befohlene Vertragsänderung, Assertions exakt):
  `tests/unit/pwa-manifest.test.ts`, `tests/e2e/f11-01-pwa.spec.ts`.
