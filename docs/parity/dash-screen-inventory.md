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
- Re-Capture: E2E-Lauf wiederholen, dann
  `npx tsx scripts/dash-measurements-normalize.mts --head <sha>` (validiert
  Boxen, normalisiert Routen, schreibt `v1-*.json`); danach `git diff` sichten.
- Heads: je Artefakt im Feld `head` (angebotdetail: a4fbf2e aus Suite-Lauf;
  Rest: 3437162; Delta seit f6f323f nur Spec-Datei, 0 Box-Drift verifiziert).
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
- Breakpoints (VERIFIZIERT, DASH-VG-01): 375/768/1440 overflow-frei, 12 Karten
  sichtbar (+ Quellenkarte count 0 ohne Daten = 13. Sektion bedingt),
  Axe WCAG A/AA ohne Verletzung, Console/Page/Netz/Hydration sauber.
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
- BEFUND + FIX 2 (RED→GREEN): Portal-Tabs nur 32 px hoch (Skill-Bar: 44 px)
  und aktiver Tab ohne `aria-current` → `tabClass` + `min-h-11 inline-flex
  items-center`, `aria-current="page"` auf aktivem Tab (alle 4 Tabs asserted).
- Angebots-Detail (DASH-VG-06, `z-dash-offer-detail-gates.spec.ts`): Gates
  im Suite-Kontext (Angebot aus M2-01-Browser-Action, jüngstes lesen wie
  `readM201Offer`); fokussiert ehrlich SKIP statt erfundener Daten.
  Offer-Scope-Selektor `[data-wmee-scope="offer"]` asserted.
- VERIFIZIERT im Suite-Lauf 2026-09-17 (265 passed, 0 failed, 12.2 Min):
  VG-06 Gates gruen, Messungen `v1-angebotdetail-*.json` (4 Boxen).

## 5. Roadmap (OFFEN, Rest)

- Loading-/Error-Live-States: GESCHLOSSEN (VG-35..37, §9) — NotFound live,
  RSC-Fallback + Skelett per Fault-Injection belegt.
- Portal Dok-/Rechnungszeilen-Wrap (P2-Risiko): DOKUMENTE-TEIL GESCHLOSSEN
  (VG-38, §9); RECHNUNGEN-TEIL begründet offen (§9, w3-gekoppelt).
- Sites-Palette (zinc statt slate): notiert, kein Redesign (Direktive).

## 6. Review-Entscheidungen (Agent-5-Review, P2 dokumentiert statt gefixt)

- Helper-Duplikation (z-Spec): bleibt — Repo-Konvention (m1-09/m2-01/f10-01
  duplizieren OTP-/Axe-Helfer ebenso); Shared-Modul ohne Fremdnutzen.
- Portal Dokument-/Rechnungszeilen (`:493`, `:549`, flex ohne Wrap): bewusst
  ungeändert — kein RED ohne befüllte Fixtures (BATCH); offenes Risiko für
  Folge-Gates mit Datei-/Rechnungsdaten.
- Repro-Grep/Shared-State: Einwand falsifiziert — VG-03/04/05 laufen fokussiert
  grün (globales Setup seedet grep-unabhängig); nur VG-06 braucht Suite-Kontext.

## 7. VG-07..14 (Rollen + 6 Routen, VERIFIZIERT 2026-09-17)

- VG-07: Unangemeldet → /login-Redirect mit next-Param (Dashboard).
- VG-08: External-Partial-Modell — nur Wiedervorlagen (leer) + Service-Rumpf
  (nur Datei-Anfragen leer; Vorgaenge/Foerderakten absent), Pipeline/
  Rechnungen/Abschluesse denied (count 0). Kein Zahlen-Leck.
- VG-09 Rechnungen (h1 + „Keine Einträge“), VG-10 Aufgaben, VG-11 Kalender,
  VG-12 Katalog („Der Katalog ist noch leer“), VG-13 Plantafel,
  VG-14 Standorte: je 375/768/1440, Axe, Console/Hydration, Messungen
  (main + h1, 2 Boxen je Viewport).
- BEFUND + FIX 3 (P1, RED→GREEN): Sites-Seite ohne Auth lesbar (UUID-Leak,
  Formular; Schreiben war Action-enforced) → Render-Gate im Sibling-Muster
  (project.read + Redirect + DeniedState).
- BEFUND + FIX 4 (RED→GREEN): Plantafel-Eyebrow slate-500 auf slate-100 =
  4.34 (Axe) → slate-600 wie Geschwister-Zeile.
- Evidenz: DASH-VG 13 passed + 1 skipped (21.7s); Mess-JSONs 36 Stk. gesamt.

## 8. VG-15..34 (Einstellungen, VERIFIZIERT 2026-09-17)

- Alle 20 Seiten (Korrektur: 20, nicht 19) datengesteuert gegatet:
  Angebots-Vorlagen, Angebotsprofile, Aufgaben-Vorlagen,
  Checklisten-Vorlagen, Datei-Anfragen-Vorlagen, E-Mail-Vorlagen,
  Ereignistypen, Foerder-Vorlagen, Lead-Quellen, Paket-Vorlagen, Planung,
  Planungs-Vorlagen, Portal-Status, Rabatt-Vorlagen, Rechnungsstellung,
  Teams, Termin-Vorlagen, Verlustgruende, Wirtschaftlichkeit, Zahlarten.
- Je Seite: 375/768/1440, Axe, Console/Hydration, Messungen (main + h1).
- angebotsprofile: In-Place-Auth („Anmeldung erforderlich“) statt Redirect
  → Direkt-Login (Muster VG-06). Keine Layout-/Kontrast-Befunde.
- Evidenz: 25 passed (34.8s, inkl. VG-01/10..14); Mess-JSONs 96 Stk. gesamt.

## 9. VG-35..38 (NotFound, Fault-Injection, Portal befuellt; VERIFIZIERT 2026-09-17)

- VG-35: unbekannte IDs zeigen NotFound-Ansichten (kein Crash).
- VG-36: RSC-Fallback per Fault-Injection (serviceWorkers block,
  eigene Spec-Datei); VG-37: Skelett-Ladezustand ebenso.
- VG-38 (P2-Dokumente GESCHLOSSEN): Portal mit befuellter Dokumentzeile —
  Projekt + Link per UI, freigegebene Issuance per F10-07-Seed (in
  `tests/e2e/f10-07-fixture.ts` extrahiert, F10-07-Regression gruen).
  Zeile voll belegt (Angebot ANG-2026-000071 + Datum + Download-Link);
  Gates 375/768/1440 gruen OHNE Fix (Zeilen-Box 275x152 bei 375, kein
  Overflow) — §6-Risiko falsifiziert, kein Wrap-Fix noetig.
- P2-Rechnungen BEGRUENDET OFFEN: befuellte Rechnungszeilen brauchen die
  w3/f102-Kette (Draft-Seed + Capability-Grant + UI-Ausstellung, F8-15);
  Shared-Fixture-Kopplung ist fuer ein Visual-Gate unverhaeltnismaessig.
  Zeilen-Pattern code-identisch zu Dokumente (`flex justify-between`,
  ein Link weniger) — P3-Restrisiko.
- Evidenz: F10-07 + VG-38 je gruen (fokussiert); Messungen
  `v1-portal-gefuellt-*.json` (main + h1 + Dokumentzeile, 3 Boxen);
  Mess-JSONs 99 Stk. gesamt.
