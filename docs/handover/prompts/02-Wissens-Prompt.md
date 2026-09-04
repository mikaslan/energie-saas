# Prompt 2 — Wissens-Prompt (kompletter Umsetzungsstand)

Du übernimmst die B2B-Energie-SaaS „energie-saas" — ein Clean-Room-Nachbau
mit funktionaler 1:1-Parität zu Reonic (funktionale Referenz) im visuellen
WMEE.de-Design. Hier ist alles, was bereits umgesetzt und VERIFIED ist
(Stand 2026-09-04, Branch `codex/m1-wave-02`, HEAD `194fb3e`).

## Architektur

- Next.js 16.3.3 (Turbopack) + React 19, TypeScript strict, Drizzle ORM mit
  handgeschriebenen Migrationen + Snapshots (aktuelle Kette 0001–0054),
  echtes PostgreSQL mit strikter Rollentrennung (app_owner/app_runtime/
  app_worker/app_erasure/identity_reconciler, RLS FORCE auf allen
  Mandantentabellen), better-auth (Email-OTP/Magic-Link), Vitest (203
  Testdateien, 1931 Tests + 1 Skipped), Playwright-E2E (Chromium, echte
  OTP-Mails aus Serverlog), embedded-postgres für Tests, Kimi-K3
  (OpenRouter) als unabhängige Review-Stimme.
- Rollenvertrag: `scripts/db-role-contract.mts` pinnt Relationen, RLS/FORCE,
  Policy-Hashes (SHA-256) und ACLs; Rollenproben 88/88 + PG18 5/5.
- RLS-Muster: CRM-/Arbeitsdaten = tenant_isolation + FORCE + Service-Rechte;
  Geld-/Settings-Tabellen (0045/0047) = zusätzlich restriktive Actor-Policies.

## Was funktioniert (alle Slices VERIFIED, gepusht)

**Fundament (M1-Welle):** Autorisierungsgrenze, Tenant-Schlüsselregeln,
Actor-/Membership-DML mit Self-Mutation-Guard, DB-Rollentrennung,
Rechner-V3-Intake (HMAC-signiert, idempotent, rate-limited, atomarer
Contact→Site→Project-Snapshot), Lead-Triage (OTP-Login, Anfrageboard,
Projektakte), Adresskorrektur (Geoapify-Vertragsgrenze, Pin-Korrektur,
revisionsgebunden), Energieprofil (PVGIS-Vertrag, Reservierung,
Quota/Cooldown, immutable Snapshots), Produktkatalog (7 Typen, Revisionen,
EK/VK-Provenienz, Lifecycle), Projektzuweisung, Projekt-Aufgaben mit
Labels/Checklisten-Items/Assignee, Outcomes (won/lost/cannot_fulfill/reopen),
Task-Inbox, Projekt-Notizen (Markdown), Kontakte (M1-14: 2 E-Mails, Telefon,
DSGVO-Löschzeitstempel), Termine/Kalender (M1-15).

**Angebote (M2-01):** Anfrage→Offer, Nummernkreise, Varianten (Basis/
Duplikat/neue Basis), immutable Snapshot-BOM, serverseitige Geldlogik
(netto/brutto/MwSt, Rabatt-Stack), RBAC/Privacy/Races, Editor-UI.
M2-04 E-Signatur: Spec + ADR 0022 fertig (Implementierung offen).

**Rechnungen (M3):** M3-00 Workspace-Stammdaten, M3-01 Kern: 6
Dokumenttypen, Nummernkreise, Ausstellen/Snapshot, Versand/Storno/
Zahlungs-/Archiv-Achse, Listen/Filter, Berichte+CSV.

**Wirtschaftlichkeit (F4):** F4.6 Workspace-Simulationsdefaults
(Strompreis/Eskalation/Öl/Gas/Horizont, CAS-Revision, leer = Länderreferenz).
F4.5-Outputs-Spec + ADR 0026 (Rechenkern) als Draft — wartet auf Mikail.

**Session 2026-09-04 — sieben Slices:**
1. **0048 v5-Leadquelle**: Rechner-v5 (wmee-rechner-v5) sendet Kontakt-
   formular-Leads OHNE Berechnung; Producer-Enum im Intake-Vertrag
   (SHA-gepinnt), Lead-only-Persistenz (kein Kalkulations-Snapshot).
2. **0049 F1.8 Lead-Sources**: Quellen-CRUD (Name, Bereich, Farbe,
   Soft-Archivierung, partieller Unique-Index), Intake ordnet
   producer.application automatisch der aktiven Quelle zu
   (project.lead_source_id), Einstellungs-UI.
3. **0050 F9.1 Zeiterfassung**: Ereignistypen (Name, Position, Farben,
   archivierbar — OBSERVED-Schema) + manuelle Zeiteinträge am Projekt
   (Intervall/Minuten/Pause/Kommentar-CHECKs, Summe aktiver Einträge,
   datetime-local mit Browser-TZ-Offset).
4. **0051 F7.2 Projekt-Checkliste**: Blocks→Segmente→Items {title, done}
   (OBSERVED-Teilmenge), CAS-Versionen, Fortschritt, Editor-UI.
5. **0052 M1-15b Kalender-Scopes**: calendar-Objekt mit 4 Scopes
   (tenancy/user/team/client), Termin-Bindung (calendar_id Pflicht,
   category_id entfällt), Scope-RBAC (persönliche nur Owner+Admin,
   fremde persönliche Kalender MASKiert — kein PII-Leak), persönliche
   Kalender lazy-provisioniert (race-sicher), /kalender-Route,
   Kalenderauswahl im Termin-Dialog.
6. **0053 F7.3 Checklisten-Vorlagen**: Template-CRUD mit Katalog-
   Positionen (componentId/quantity/position/visibleToCustomer/
   priceOverridesComponent — OBSERVED), Katalog-Validierung,
   applyTemplate als ESTIMATE-Mapping (Block/Segment „Material"/Items
   „SKU × quantity", ID-basierte Lookup-Map), 1:1-Conflict.
7. **0054 F9.2 Stoppuhr**: laufender Eintrag je Nutzer (partieller
   Unique WHERE end_at IS NULL), start/stop/discard (Hard-Delete mit
   DELETE-Grant im M1-15-Muster), Summe nur gestoppter Einträge,
   Archive-Guard gegen Deadlock, UI mit Lauf-Banner.

**Reonic-API-Evidenz (read-only, Compliance-Gate offen):**
`docs/parity/reonic-api-live/` — Live-Sweep: 26 Listen- + 23 Detail-Endpunkte
mit echten Strukturen (Kontakte, Projekte, Komponenten, Kalender,
Zeiterfassung, Checklisten, Vorlagen, Kanban). Scope-Lücke:
commercialProjects = 403.

## Offene Punkte (nicht selbst entscheiden — Mikail fragen)

- UNK-F4-01..05 (KPI-Liste, Rechenkern-ADR, Preis-/Länder-Defaults,
  TOU-Umfang, Cashflow-Defaults)
- Browser-Login-Sweep (Portal-UI), S3-Object-Lock, Live-PVGIS, Resend,
  Neon, Hetzner-Worker, v5-Deploy-GO, Codex-Usage-Limit
- Visuelle Gates: INCONCLUSIVE bis Mikail-Screenshot-Freigabe

## Nächste Kandidaten

F2.2 Varianten-Vertiefung (isPrimary, totalPriceOverride netto/brutto,
optionalBundles — Live-evidenziert) · M2-04 E-Signatur (Spec fertig) ·
F16.2 Offer-/Planning-Templates · F10 Kundenportal · F4-Rechenkern.
