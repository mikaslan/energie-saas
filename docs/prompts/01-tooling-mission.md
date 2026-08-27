# Mission: Tooling-Arsenal für energie-saas auf Reonic-Niveau

Du übernimmst die **Tooling- und Einkaufs-Recherche plus Installation** für das Projekt
energie-saas — einen funktionalen Nachbau von Reonic (SaaS für Installateure erneuerbarer
Energien: PV, Wärmepumpe, Wallbox, Speicher). Ziel dieser Mission: Wenn du fertig bist,
ist **alles installiert, was ohne Mikail geht**, und Mikail bekommt eine **präzise
Einkaufsliste** für alles, was Zugangsdaten oder Geld braucht. Danach beginnt der Bau von
M1–M8 ohne Werkzeug-Unterbrechungen.

## Kontext — zuerst vollständig lesen

Projektwurzel: `~/Downloads/Projects/energie-saas/repo` (Haupt-Repo, Branch main).
Der Meilenstein M0 wurde im Worktree `~/Downloads/Projects/energie-saas/m0-wt`
(Branch `m0-fundament`) gebaut. **Prüfe zuerst mit `git log --oneline -5` in beiden
Verzeichnissen, ob m0-fundament inzwischen nach main gemerged ist — arbeite auf dem
aktuellsten Stand.**

Pflichtlektüre (in dieser Reihenfolge):
1. `docs/PLAN.md` — genehmigter Gesamtplan (Architektur, Roadmap M0–M8, Leitplanken)
2. `docs/blaupause/01-modulkatalog.md` — der komplette Funktionskatalog (F-Nummern) = was gebaut werden muss
3. `docs/blaupause/03-integrationskarte.md` — Pflicht/Kür je Integrationsfeld MIT bereits recherchierten Datenquellen/APIs (DATANORM, IDS-Connect, PVGIS, MaStR, KfW …) — deine Recherche baut darauf AUF, wiederhole sie nicht, sondern vertiefe zur Kaufentscheidung
4. `docs/blaupause/04-architektur.md` — Stack-Entscheidungen (Next.js 16, Neon/Drizzle, Vercel, Hetzner-Worker, pg-boss, pvlib-Sidecar)
5. `docs/blaupause/05-roadmap.md` — Baureihenfolge M1–M8
6. `CONTRIBUTING.md` — **Clean-Room-Regeln: NIEMALS einen Reonic-Test-/Demozugang anlegen oder Reonic-Daten verwenden. Recherchiert wird nur öffentlich.**

Bereits vorhanden (nicht neu evaluieren, nur ggf. Lücken schließen): Next.js 16 + TS +
Tailwind + shadcn, Drizzle + Neon, better-auth (Magic Link/OTP), pg-boss v12,
@aws-sdk/client-s3, Vitest + embedded-postgres, dependency-cruiser, Chrome-PDF-Pipeline
(als Muster in anderen Projekten erprobt), Resend, Vercel CLI, Codex CLI (Reviews),
context7-MCP (Doku), Playwright-MCP.

## Phase A — Bedarfslandkarte

Leite aus Modulkatalog + Roadmap eine Bedarfsliste ab: Welche Fähigkeit braucht welches
Modul (M1–M8), und ist sie build/buy/lib? Priorisiere hart: **P1 = für M1–M4 (bis
Pilotkunde) nötig, P2 = M5–M8, P3 = nice-to-have.** Gekauft/installiert wird jetzt nur P1;
P2/P3 werden dokumentiert.

## Phase B — Recherche (parallelisiere mit Subagenten, wo verfügbar)

Recherchiere je Feld die 2–3 besten Optionen (Open Source / GitHub / SaaS / kostenpflichtig)
mit: Reifegrad (Stars, letzte Commits, Maintainer), Lizenz, Kosten (konkret €/Monat oder
einmalig), DSGVO-/EU-Tauglichkeit, Integrationsaufwand in unseren Stack. Felder:

**UI/Frontend (M1–M2):** Kanban-Drag&Drop (dnd-kit vs. Alternativen), Kalender/Plantafel
(Schedule-X, FullCalendar [Lizenzkosten prüfen], react-big-calendar), Data-Grid (TanStack
Table vs. AG Grid [paid]), Formulare (react-hook-form + zod), Karten mit Pin-Bestätigung
(MapLibre + welcher Tile-/Geocoding-Anbieter? Kosten!), Datei-Upload/Dropzone,
Rich-Text (Notizen), Charts (Recharts o. ä.), PDF-Viewer.

**Dokumente (M2–M3):** Angebots-/Rechnungs-PDF (unsere Chrome-Pipeline vs. Typst vs.
react-pdf — Empfehlung mit Begründung), E-Signatur-Pad (signature_pad), E-Rechnung
(node-zugferd vs. Mustang-Container, KoSIT-Validator-Setup für CI), DATEV-EXTF-Generator.

**Energie-Fachkern (M4/M6):** pvlib + PVGIS + DWD (Setup-Aufwand Sidecar), hplib,
**Google Solar API** (Preise, EEA-Nutzungsbedingungen!), Geocoding (Preise), 3D/2.5D
Dach-Editor-Grundlage (three.js/react-three-fiber vs. 2D-Canvas-Ansatz für M6-Start),
simshady, LOD2-Datenzugänge NRW/Bayern.

**Daten-Zukäufe (P1/P2 klären):** Förderdatenbanken (co2online FördermittelCheck, febis —
Kontakt/Preise anfragen dokumentieren), Komponenten-Stammdaten (ETIM-Zugang,
Hersteller-Datenblatt-Quellen), DATANORM-Beispieldateien, Normen (DIN EN 12831 —
Bezugsquelle/Preis, erst P2).

**Betrieb/Infra (P1):** Hetzner-Server fürs Worker-Setup (welches Produkt, €/Monat),
Object Storage (ADR 0002 offen: Hetzner Object Storage vs. AWS S3 — **prüfe konkret
Object-Lock- und If-None-Match-Support**, entscheide, dokumentiere im ADR),
Neon-Plan (reicht Free für Dev? Wann Launch-Plan?), Vercel-Plan, Sentry o. Alternative
(Fehler-Monitoring, EU-Region), Uptime-Monitoring (Healthcheck-Alarm des Workers),
Backup-Automatisierung (pg_dump-Cron nach docs/konzepte/backup-dr.md).

**KI-Schicht (P1 klein, P2 groß):** Anthropic-API-Key (Bill Reading, Angebotstexte ab
M4/M8), OCR-Fallback, Transkription (später). Kosten je Nutzung schätzen.

**Kommunikation:** Resend-Plan (Produktionsvolumen, Domain-Setup), WhatsApp Business API
(P2 — Anbieter + Preise nur dokumentieren).

**Claude-Code-Ausrüstung:** Welche Plugins/MCPs/Skills fehlen für M1–M8? (z. B. Neon-MCP
verbinden, GitHub-Repo + `gh`-Flow, Stripe erst bei eigenem Billing). Prüfe die installierte
Plugin-Liste und empfiehl konkret.

**GitHub:** Privates Repo unter dem Account `mikaslan` anlegen (gh CLI ist eingeloggt),
Remote setzen, pushen — dann wird die vorbereitete CI (`.github/workflows/ci.yml`) scharf.
Prüfe den ersten CI-Lauf und fixe Umgebungslücken (der Workflow bootstrapt eine
non-superuser-Rolle; weitere Env-Vars ggf. nötig).

## Phase C — Entscheiden und installieren (ohne Mikail)

Für jede P1-Entscheidung: kurze Begründung (2–3 Sätze) in `docs/tooling/entscheidungen.md`
(eine Sektion pro Feld, Verlierer-Optionen mit einem Satz warum nicht). Dann installieren:
- npm-Pakete auf einem neuen Branch `tooling` (von aktuellem Stand), in sinnvollen Commits
- `npm run check` muss nach JEDEM Commit grün bleiben
- GitHub-Repo + Push + CI-Verifikation
- Konfigurationsgerüste (z. B. Sentry-Init hinter Env-Flag) nur, wo ohne Key sinnvoll möglich

**Nicht ohne Rückfrage:** nichts kaufen, keine Accounts anlegen, die E-Mail/Zahlung
brauchen, keine Secrets erfinden, keine Architektur-Entscheidungen aus
docs/blaupause/04 umwerfen. Bei echtem Architektur-Konflikt: dokumentieren + fragen.

## Phase D — Einkaufsliste für Mikail

`docs/tooling/einkaufsliste.md` als Tabelle, sortiert nach Priorität:

| # | Tool/Dienst | Wofür (Modul) | Kosten | Wo kaufen/registrieren (URL) | Was Mikail liefert (exakte Env-Var-Namen) | Prio |

Darunter: Schritt-für-Schritt-Anleitung je Kauf (max. 5 Schritte), damit Mikail in einer
Sitzung alles durchklicken kann. Gesamtkosten-Summe €/Monat für P1 ausweisen.

## Phase E — Übergabe

Abschlussbericht in `docs/tooling/STATUS.md`: was installiert (mit Commits), was gekauft
werden muss (Verweis Einkaufsliste), was nach Erhalt der Zugangsdaten zu tun ist
(`.env.local`-Vorlage aktualisieren, `vercel env`-Kommandos vorbereiten,
Verifikations-Kommandos je Dienst). Zum Schluss: kurze Zusammenfassung im Chat +
die 3 wichtigsten offenen Entscheidungen, falls welche bleiben.

## Regeln

- Deutsch dokumentieren, englisch benennen. Kostenbewusst: bei gleicher Qualität gewinnt
  Open Source; Gekauftes muss einen klaren P1-Grund haben.
- Jede Kostenangabe mit Quelle (Pricing-URL) und Datum.
- Clean-Room strikt (CONTRIBUTING.md). Reonic wird nur als öffentliche Messlatte zitiert.
- Web-Recherche great, aber Entscheidungen gegen UNSEREN Stack prüfen (Integrationskarte
  + Architektur sind bindend).
