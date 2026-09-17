# DASH Screen-Inventory v2 (Agent 5, 2026-09-17)

Live-Inventar pro Route (Entry, Navigation/Breadcrumb/Tabs, Modal/Drawer,
Tabelle/Kanban/Chart, Empty/Loading/Error/Forbidden, Primaeraktionen,
Keyboard/Fokus, Breakpoints). Status je Zeile: VERIFIZIERT (Code gelesen +
E2E) / CODE (nur Code gelesen) / OFFEN.

## 0. Methode und Reproduktion

- E2E: `M1_05_E2E_GREP="DASH-VG" npm run test:e2e` (Chromium, de-DE,
  Europe/Berlin). Spec: `tests/e2e/dash-visual-gates.spec.ts`.
- Mess-Artefakte: `docs/parity/dash-measurements/v1-dashboard-{375,768,1440}.json`
  (11 Boxen je Viewport, Route normalisiert, Laufzeit in `sourceRunCapturedAt`).
- Re-Capture: E2E-Lauf wiederholen, frische JSONs aus
  `test-results/e2e/dash-measurements/` gegen `docs/parity/dash-measurements/`
  diffen (`route`/`sourceRunCapturedAt` ignorieren — Lauf-UUID/Datum).
- Zeitstempel in Agent-5-Berichten vor 2026-09-17 10:00 UTC waren lokale
  Maschinenzeit (UTC+3), ab hier echte UTC.

## 1. Navigations-Shell (CODE, partiell)

- Kein globales Sidebar-Menue: jede Seite rendert eigenen Minimal-Header.
- Dashboard-Header (VERIFIZIERT, `dashboard/page.tsx:605-632`): Brand-Kachel „W“,
  „WMEE Vertrieb / Geschuetzter Arbeitsbereich“, Links Anfragen + Aufgaben
  (min-h-11, focus-visible-Ring), SignOut-Button.
- Root `/` (CODE): nur Login-CTA, kein Menue.
- Forbidden-Muster (VERIFIZIERT): `AccessDenied` („Kein Zugriff“, Zurueck-Link),
  wenn alle Dashboard-Loader `denied` melden (`dashboard/page.tsx:585-601`).
- Breadcrumb-/Tab-Befund je Route: OFFEN (folgt pro Route).

## 2. Route: /w/:id/dashboard — Uebersicht (VERIFIZIERT)

- Entry: Login (`/login`, OTP) → Redirect mit `next`; Workspace-UUID validiert
  (ungültig → `notFound()`).
- Tabs/Modals/Drawer: keine (eine Seite, 13 Sektionen mit `aria-label`).
- Sektionen (Reihenfolge fix): Anfrage-Pipeline, Pipeline nach Quelle,
  Ueberfaellige Aufgaben, Heute faellige Aufgaben, Wiedervorlagen, Abschluesse,
  Abschlusstrend, Conversion-Funnel, Rechnungen, Unterschriftsdauer,
  Angebotsdauer, Naechste Termine, Service und Foerderung.
- Darstellung: Zaehl-/Wert-Kacheln, Listen (max. 5), Trend-Balken, Funnel-Stufen;
  Diagramme sind SSR-HTML, keine Canvas-Libs (CODE aus Loader-/Render-Struktur).
- Empty (VERIFIZIERT, DASH-01 + DASH-VG-01): jede Karte mit ehrlichem Leertext
  („Keine offenen Anfragen.“ …), Quellenkarte fehlt ganz ohne Daten.
- Loading: Server-Komponente, keine `loading.tsx` — OFFEN (Skelett-Frage).
- Error: keine `error.tsx` — OFFEN.
- Forbidden: AccessDenied (s. o.); Teil-Rollen: je Karte loaded/denied
  (CODE; Live-Teilrollen-E2E OFFEN).
- Primaeraktionen (VERIFIZIERT): Anfragen-/Aufgaben-Links, „Zum Kalender“,
  Abmelden.
- Keyboard/Fokus (CODE + E2E-Teil): native Links/Buttons mit
  `focus-visible:ring`; volle Tab-Reihenfolge OFFEN.
- Breakpoints (VERIFIZIERT, DASH-VG-01): 375/768/1440 overflow-frei, 10 Karten
  sichtbar, Axe WCAG A/AA ohne Verletzung, Console/Page/Netz/Hydration sauber.
- Klickpfade (VERIFIZIERT, DASH-VG-02): Dashboard → Anfragen → zurueck →
  Aufgaben; Touch-Targets ≥ 44 px bei 375.

## 3. Dashboard-Fachbefund (CODE + E2E-Teil)

- Gewichtete Pipeline (CODE): `PIPELINE_STAGE_WEIGHTS` lead 0.1 / offer 0.5 /
  won 1 / lost 0, als ESTIMATE markiert (Q-DASHBOARD-REFERENZ offen); Werte aus
  `getProjectOfferValues` (Cap 200 Projekte, `valuesCapped`-Flag).
- Rechnungen (CODE): Monatskennzahlen via `loadInvoiceKpis` (Berlin-Monat);
  Leer = `0,00 €` (VERIFIZIERT).
- Zeitraum (CODE): fix verdrahtet (Berlin-Monat, Trend-Fenster im Loader),
  kein Zeitraum-Waehler in der UI.
- Zeitzone (VERIFIZIERT): `Europe/Berlin` in Formatierern + E2E-Laufzeit.
- 6-KPI-/9-Chart-Ziel (Missionsabschnitt X) vs. Bestand: Die Seite sagt selbst
  „ESTIMATE-Layout; Reonic-Referenzfrage Q-DASHBOARD-REFERENZ offen“.
  KPI-artig sind Pipeline-Werte, Abschluesse, Rechnungen, Unterschrifts- und
  Angebotsdauer, Service/Foerderung/Belege; chart-artig nur Abschlusstrend
  (Balken) und Conversion-Funnel (Stufen) — 9 Charts sind im Bestand NICHT
  abgebildet. Kein Redesign (Direktive); Abweichung bleibt als ESTIMATE mit
  offener Referenzfrage bestehen, kein erfundener Chart wird ergänzt.

## 4. Weitere Kernrouten (VERIFIZIERT, DASH-VG-03..06)

- Projektakte `/w/:id/anfragen/:projectId` (DASH-VG-03): Editor,
  Breadcrumb-Nav „Brotkrumen“ + h1 + Projektstatus; 375/768/1440
  overflow-frei, Axe sauber, Console/Hydration sauber. Messungen:
  `v1-projektakte-{375,768,1440}.json` (4 Boxen). Eigene
  `loading.tsx`/`error.tsx`/`not-found.tsx` vorhanden (Live-States OFFEN).
- Angebotsliste `/w/:id/angebote` (DASH-VG-04): isolierter Workspace,
  h1 „Angebote“ + „Noch keine Angebote“; Gates wie oben.
  Messungen: `v1-angebotsliste-*.json` (2 Boxen).
- Portal `/p/:token` (DASH-VG-05): Create → Resolve → Withdraw im
  f101-Projekt (selbstreinigend, f10-01 sieht weiter „Kein aktiver Link“);
  Resolve-Gates bei 375/768/1440; Ungültig-Ansicht mit 404-Consume
  (Muster m1-08b/f10-01). Messungen: `v1-portal-*.json` (3 Boxen).
- BEFUND + FIX (RED→GREEN, kein Test-Relax): Portal-Tab-Nav lief bei 375
  um +39 px über („Dateien“-Link, `flex` ohne Wrap). Fix:
  `app/p/[token]/page.tsx:154` `flex gap-2` → `flex flex-wrap gap-2`
  (Desktop unverändert, Wrap nur bei Bedarf; Muster wie Dashboard-Header).
- Angebots-Detail (DASH-VG-06, `z-dash-offer-detail-gates.spec.ts`): Gates
  im Suite-Kontext (Angebot aus M2-01-Browser-Action, jüngstes lesen wie
  `readM201Offer`); fokussiert ehrlich SKIP statt erfundener Daten.
  Offer-Scope-Selektor `[data-wmee-scope="offer"]` asserted.

## 5. Roadmap (OFFEN)

- Rechnungen, restliche Routen: derselbe Gate-Satz plus Mess-Artefakte.
- Rollenmatrix (Viewer/Editor/Admin/External) pro Route, Loading-/Error-States,
  Screenshot-Sichtung mit stabilen Testdaten.
- VG-06-Suite-Nachweis: volle E2E-Suite (CI-Lane) muss DASH-VG-06 passed zeigen.
