# Reonic-Parität — belastbarer Liefer- und Fortschrittsstand

Stand: 2026-09-03 (07:50) · kanonische Abnahmequelle:
`docs/blaupause/01-modulkatalog.md` (F1–F16)

## Bedeutung dieses Dokuments

Die Prozentwerte sind eine grobe Programmprognose, **kein** Ersatz für die
Capability-Abnahme. Eine Funktion zählt erst mit der Kette

`DISCOVERED → SPECIFIED → CONTRACTED → RED → IMPLEMENTED → REVIEWED → VERIFIED`.

Unbekannte private Reonic-Interna zählen nicht als erreicht. Abgenommen wird nur die
rechtmäßig belegte funktionale und semantische Paritätsbaseline; Texte, Markenassets,
UI-Bestände, proprietärer Code und geschützte Daten werden nicht übernommen.

## Aktuelle Schätzung

| Sicht | Stand | Einordnung |
|---|---:|---|
| Gesamtmission einschließlich F1–F16 | ca. 36 % (ESTIMATE) | M1-Welle 01+02 grün; M2-04 + M3-00 VERIFIED; M3-01 Rechnungs-Kern integriert und VERIFIED; Muse-Lanes F2.2/F9.3/F16.2/F10.1 verifiziert und in `codex/m1-wave-02` (`9fc49eb`) integriert |
| Technisches Fundament M0/M1 | ca. 97–98 % | Auth-, Tenant-, DB-, Worker-, Intake-, Rechen-, Katalog- und geschützte Webgrenzen lokal real; externe Provider-/Pilotgates offen |
| Nutzerseitige F1–F16-Funktionsparität | ca. 23–24 % (ESTIMATE) | Projektakte, Aufgaben, Outcomes, Notizen, Cannot-Fulfil, Katalog, Varianten/BOM, Angebots-PDF, Kontakte, Termine, E-Signatur-Vorbereitung, Rechnungs-Stammdaten und der komplette Rechnungs-Kern (F8-Kernsuite) lokal verifiziert |

## 2026-09-02 — API-Gate, Discovery, M1-11b-Lage

- **Reonic REST API v3:** Eigentümer-Freigabe; Key per `GET /me` als read-only
  belegt. Compliance-Gate: `COMPLIANCE-REONIC-API.md`; Clean-Room-Regel 1 in
  CONTRIBUTING.md ersetzt. Öffentliche OpenAPI v3.11.0 kartiert in
  `REONIC-API-CAPABILITY-MAP.md` (124 Pfade; F4/F6/F8/F10/F12/F13/F14 sind
  API-seitig NICHT exponiert — M3/Rechnungen gegen Portal/Doku planen).
- **WMEE-Design-System:** Token-Discovery `WMEE-DESIGN-SYSTEM.md` (DRAFT;
  visuelle Abnahme durch den Eigentümer offen).
- **M1-11b-Verlust:** Ordner `~/Projects/reonic-clone-finale-claude`
  (`claude/reonic-finale`, `c9e6b50…09240ae`) auf diesem MacBook nicht
  auffindbar (Logs/Codex/git-fsck/Trash geprüft); Vault-Notiz entstand auf dem
  Mac Studio → Eigentümer-Prüfung ausstehend. Spec/ADR rekonstruiert
  (`M1-11b-cannot-fulfil.md`, ADR `0018`); TDD-Neuaufbau im Worktree
  `energie-saas-m111b-cannot-fulfil` (Branch `codex/m1-11b-cannot-fulfil`).
- **Laufende Lanes:** M1-13-Projektnotizen-Spec; visuelle Baseline-Kandidaten
  (`artifacts/visual-baseline-20260902/`).

Diese Werte steigen nicht durch Seiten, Mocks oder Dokumentation allein, sondern nur
durch belastbare vertikale Endzustände. Die Schätzung ist insbesondere **keine**
Behauptung einer Reonic-1:1-Parität.

## Verifizierte und laufende Grundlagen

| Slice | Status | Beleg/Grenze |
|---|---|---|
| M1-00 Autorisierungsgrenze | VERIFIED (lokal) | Commit `8c2cf60` |
| M1-01 Tenant-Schlüsselregeln | VERIFIED (lokal) | Commit `aa47671` |
| M1-02 Actor-/Membership-DML | VERIFIED (lokal) | Commit `992796b` |
| M1-03 getrennte DB-Principals | REVIEWED/VERIFIED (lokal) | 75 Rollen- plus 5 PG18-Proben grün; echte Provider-, Staging- und Restore-Gates bleiben NO-GO |
| M1-04 Rechner-V3-Intake | REVIEWED/VERIFIED (lokal) | Kanonisches Schema/OpenAPI, HMAC, atomarer Contact→Site→Project-Snapshot, Replay/Races, RLS/ACL sowie Fresh-/Legacy-Migration geprüft; Build und 256 Tests grün |
| M1-05 Rechner-Lead-Triage | REVIEWED/VERIFIED (lokal) | Echter OTP-Login, signierter Intake, Anfrageboard, Projektakte, strenge Pin-Bestätigung, Formular- und Pointer-Move mit Reload, Editor/Viewer/Tenant-Grenzen; Desktop/Mobile/Tablet, Axe, 307 Repo-Tests und 5 Browser-E2E grün |
| M1-06 Planungsstandort/Adresskorrektur | REVIEWED/VERIFIED (lokal) | Regionaler Lead → geschützte Geoapify-Vertragsgrenze → hausgenaue Adresse → Pin-Korrektur → revisionsgebundenes Speichern und getrennte Bestätigung; Reload-/Board-Konsistenz, Editor/Viewer/Tenant-Grenzen und 5 Browser-E2E grün; Live-Provider bleibt Pilot-Gate |
| M1-07 Energieprofil/Planungsschätzung | REVIEWED/VERIFIED (lokal) | Revisionsgebundenes Site-Profil, getrenntes Save/Confirm, atomare Reservation, PVGIS-Vertrag, gepinnter Clean-Room-Kern, immutable Snapshots/Resultate, Quota/Cooldown, technische Retries, DSGVO-Erasuregraph und geschützte UI; 620 Repo-Tests, 6 Browser-E2E, Build, 75+5 Rollenproben sowie adversariales Re-Audit grün. Live-PVGIS und F4-Referenzvalidierung bleiben Pilot-/F4-Gates |
| M1-08 Produktkatalog/Projektauflösung | REVIEWED/VERIFIED (lokal) | Leerer eigener Katalog für sieben Produkttypen, unveränderliche Revisionen, EK/VK-Provenienz, Lifecycle, Current/Stale-Ableitung und revisionsgebundene Produkt-/Preissnapshots; 661 Repo-Tests, 7 Browser-E2E, Build, 75+5 Rollenproben, Nebenläufigkeits- und EK-Redaktionsreview grün. Echte Produkte/Preise, Asset-Storage und Angebot/BOM bleiben getrennte Folgegates |
| M2-01 Angebotsvarianten/Snapshot-BOM | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE 2 GO | Anfrage→Offer, Nummer, Basis-/Duplikat-/neue-Basis-Varianten, immutable Snapshot-BOM, serverseitige Geldlogik, RBAC/Privacy/Races und der geschützte Editor sind technisch abgenommen: 87/87 Testdateien, 856 bestandene Tests plus 1 ausdrücklich opt-in übersprungener Test, 88/88 Rollen- und 5/5 PG18-Proben, Chromium 16/16 (15 funktional/A11y plus 1 Visual-Capture mit 26/26 Kandidaten) und keine offenen Produkt-P0–P2. Das Candidate-Capture ist grün; `M201-VISUAL-01` bleibt ohne Mikails Screenshot-Baseline-Freigabe ausdrücklich INCONCLUSIVE |
| Rechner V3 | CONTRACTED (Clone) / BLOCKED (Provider) | read-only Baseline `rechner/v3@2b00f6b`; Provider-Wiring erst nach veröffentlichtem korrektem Datenschutzhinweis und Secret-Provisioning |

## F1–F16-Matrix auf Capability-Ebene

Der Modulkatalog ist vollständig spezifiziert. Die folgende Matrix behauptet bewusst
keine Implementierung aufgrund bloßer Infrastrukturarbeit.

| Bereich | Höchster belastbarer Stand | Nächster echte Slice |
|---|---|---|
| F1 CRM & Leads | PARTIAL VERIFIED | Rechner-V3-Intake → Kontakt → Standort/Adresskorrektur → Anfrage → Kanban/Projektakte → Energieprofil ist lokal real; als Nächstes Zuweisung und weitere CRM-Capabilities |
| F2 Angebote | PARTIAL VERIFIED | M2-01 + F2.2 (Primary-Switch, Deal-Override, Bundles, 0055) verifizierte Produkt-/Preissnapshots; M2-01 liefert daraus technisch verifizierte Draft-Offers, Varianten, Snapshot-BOM sowie Preis-/Rabatt-/Steuerentwurf. Die menschliche Screenshot-Baseline bleibt separat `INCONCLUSIVE`; PDF und Signatur folgen in eigenen Slices |
| F3 PV-Planung | PARTIAL VERIFIED | Hausbezogene, serverseitig reproduzierbare Planungsschätzung lokal real; rechtmäßige Dachdatenadapter und tiefere Planungswerkzeuge folgen capabilityweise |
| F4 Simulation | PARTIAL VERIFIED | F4.6 Workspace-Simulationsdefaults integriert (0047, E2E 73/73); Rechenkern F4.1–F4.5 spec-first nach ADR + Mikail-Fragen |
| F5 Wärmepumpe | SPECIFIED | Schätzverfahren klar von zertifizierter Normrechnung trennen |
| F6 Schaltplan | SPECIFIED | eigener Editor-/Exportvertrag |
| F7 Installation | SPECIFIED | Signatur → Installation → Checkliste/Disposition/Handover |
| F8 Rechnungen | PARTIAL VERIFIED | M3-01-Kern integriert (0046): 6 Dokumenttypen, Nummernkreise, Ausstellen/Snapshot, Versand/Storno/Zahlungs-/Archiv-Achse, Listen/Filter, Berichte+CSV, UI/E2E 71/71; Folgeslices: Teilrechnungen (F8.5), PDF (M3-02), E-Rechnung/DATEV (F8.6/8.7), GoBD, Erasure-Verkabelung |
| F9 Zeiterfassung | PARTIAL VERIFIED | F9.1/F9.2/F9.3 (Ereignistypen, Einträge, Stoppuhr, Fremdnutzer-Filter) → Audit → Export |
| F10 Kundenportal | PARTIAL VERIFIED | F10.1 Skeleton (0056): Link-Infra, Status, Dok-Sicht, View-Log → Angebot/Status/Dateien |
| F11 Mobile/PWA | SPECIFIED | schmale Offline-Outbox für Fotos/Checklisten/Zeit |
| F12 Lead-Funnel | SPECIFIED | Provideradapter erst nach Privacy-Freigabe anbinden; weitere Funnels capabilityweise bauen |
| F13 Services | SPECIFIED | Filing-Objekt und Statusmaschine, externe Human-Gates ehrlich markieren |
| F14 KI | SPECIFIED | rechtegebundene Tools erst nach realen Domain-Commands |
| F15 Gewerbe | SPECIFIED | getrenntes Commercial-Datenmodell |
| F16 Katalog/Vorlagen | PARTIAL VERIFIED | M1-08a + F16.2 PDF-Vorschau; CSV, Assets, Vorlagen, Lieferantenfeeds folgen eigener Katalog, sieben Produkttypen, Preise/Provenienz, Lifecycle und Projektauflösung lokal real; CSV, Assets, Vorlagen und Lieferantenfeeds folgen getrennt |

## Lieferform

1. **Geschützter Preview-Link:** öffnet die jeweils verifizierten Slices wie eine
   Webseite; unfertige Funktionen werden nicht als fertig dargestellt.
2. **Parity-Freeze-Link:** nach grüner F1–F16-Matrix, kritischen E2E-Flows,
   Security-/Migration-/Backup-/Rollback-Gates und Mikails ausdrücklichem Freeze.
3. **Produktionslink:** erst nach separater Freigabe. Push, Preview-Deploy, Provider-
   Kauf oder Produktion erfolgen nicht stillschweigend.

Zusätzlich bleiben Repository, Migrationen, Tests, Runbooks, Quellenregister und
Abnahmen als prüfbare Lieferartefakte erhalten.

## Nächste Reihenfolge

1. **Gesamt-Codebase-Review (Mikail-Entscheid 2026-09-04):** bewusst erst AM
   ENDE vor dem Parity Freeze — ein Review-Schwarm über die komplette
   integrierte Codebase (Sicherheit/RLS, Contract/Schema-Konsistenz,
   UI/A11y, Testabdeckung) als eigenes Abschluss-Gate, nicht zwischendurch.
2. Externe Provider-/DR-Gates ausdrücklich BLOCKED lassen, bis echte autorisierte
   Evidenz vorliegt.
2. Rechner-V3-Provider erst nach Privacy-Freigabe und echtem Secret-Provisioning
   an den lokal verifizierten M1-04-Vertrag anschließen.
3. Die formale visuelle M2-01-Baseline separat durch Mikail freigeben oder
   weiter ehrlich als `M201-VISUAL-01: INCONCLUSIVE` führen; das technische
   Gate-2-GO davon nicht rückwirkend umdeuten.
4. Golden Path ab dem verifizierten Angebotsstand real weiterbauen:
   `Rechner → Lead → Kontakt → Standort/Adresskorrektur → Energieprofil/Kalkulation → Katalog/Speicher → Produktauflösung →`
   `Angebot → Variante → PDF → Signatur → Installation → Rechnung → Kundenportal`.
5. Danach F1–F16 capabilityweise bis VERIFIED schließen.

## 2026-09-02 (21:43) — Lizenz-Modus aktiv

Reonic GmbH bestätigt schriftlich die Nutzungs-/Veränderungs-/Vertriebsrechte
an Software, Quellcode und Datenbeständen für energie-saas (siehe
`docs/legal/LICENSE-GRANT.md`). Thema GESCHLOSSEN. Datenbank vollständig
nutzbar, Codebase-Übernahme erlaubt wo sinnvoll; visuelle Referenz bleibt
WMEE; Push-/Deploy-Regeln unverändert.

## 2026-09-03 — v5-Leadquelle integriert + F1.8 Lead-Sources in Arbeit

- `codex/m1-wave-02`: v5-Leadquelle (0048) per Fast-Forward integriert und
  gepusht (`e7246f8`): 196 Testdateien, 1886 Tests + 1 Skipped, Build grün.
- Reonic-API-Live-Sweep (read-only, nur GET, Compliance-Gate offen):
  26 List-Endpunkte mit echten Daten, 23/24 Detail-200er, 12 Detail-
  Strukturen (Key:Typ, keine Werte). Evidenz: `docs/parity/reonic-api-live/`
  (tooling `c517059`). Scope-Lücke: commercialProjects 403.
- F1.8 Lead-Sources (0049): REVIEWED/VERIFIED (lokal), integriert in
  `codex/m1-wave-02` (`e5d1c92`/Wave-02-FF, gepusht). Slice A:
  Stammdaten-CRUD (Soft-Delete, partieller Unique-Index — Name nach
  Archivierung frei), Rechte lead_source.read/write, Intake-
  Attribution (producer.application → aktive Quelle), RLS im
  M1-CRM-Muster (tenant_isolation; DECIDED: HMAC-Intake läuft ohne
  Membership-Actor), Einstellungs-UI, 2 E2E. Kimi-K3: NACHBESSERUNG
  (P1-1/P1-2 + P2/P3) vollständig geschlossen. Nachweise: check
  197 Dateien/1896 Tests + 1 Skipped, Build, db:generate ohne Drift,
  E2E F1.8 2/2, Secret-Scan.
- Mikail: keine weiteren Localhost-Demos (Demo-Job gestoppt).

## 2026-09-04 — F9.1 Zeiterfassung REVIEWED/VERIFIED (lokal)

- F9.1 Zeiterfassung (0050): Lane `codex/f9-01-time-tracking`, integriert
  in `codex/m1-wave-02` (`1c8a8ba`, gepusht). Ereignistyp-CRUD (OBSERVED:
  name/position/textColor/backgroundColor/archivedAt), manuelle
  Zeiteinträge am Projekt (startAt/endAt/workingTimeMinutes/
  breakDurationMinutes/comment), Summe aktiver Einträge, Rechte
  time.read/time.write, RLS M1-CRM-Muster, Einstellungen/Ereignistypen +
  Projekt-Zeiterfassung (datetime-local mit TZ-Offset), 2 E2E.
- Kimi-K3: NACHBESSERUNG (P1-1 Action-Namen, P1-2 Zeitzonen-Round-Trip,
  P2-1..P2-3, P3-1..P3-5) — alle geschlossen; E2E prüft gerenderte
  Uhrzeit + Typ-Archivierung.
- Nachweise: check 198 Dateien/1903 Tests + 1 Skipped, Build,
  db:generate ohne Drift, E2E F9.1 2/2.
- Infrastruktur: wave-02-node_modules war durch einen Selbst-Symlink
  korrumpiert → npm install repariert; Gate erneut grün.

## 2026-09-04 — F7.2 Projekt-Checkliste REVIEWED/VERIFIED (lokal)

- F7.2 (0051): Lane `codex/f7-02-checklists`, integriert in
  `codex/m1-wave-02` (`5ad30e1`, gepusht). Projekt-Checkliste mit
  Blocks/Segmenten/Items (OBSERVED-Teilmenge), CAS-Versionen,
  Fortschritt, Rechte checklist.read/write, RLS M1-CRM-Muster,
  Projektroute + 2 E2E. Kimi-K3: NACHBESSERUNG (P1-1 Keys/P1-2
  CAS-Version im Client, P2/P3) — alle geschlossen; E2E deckt
  Doppel-Save ohne Reload ab.
- Nachweise: check 199 Dateien/1909 Tests + 1 Skipped, Build,
  db:generate ohne Drift, E2E F7.2 2/2.
- M1-15b Kalender-Scopes: Lane muss auf wave-02 rebased + Migration
  0048→0052 renummeriert werden (0048=v5, 0049=F1.8, 0050=F9.1,
  0051=F7.2); eigene Runde wegen M1-15-Refactor-Umfang.

## 2026-09-04 — M1-15b Kalender-Scopes REVIEWED/VERIFIED (lokal)

- M1-15b (0052): Lane `codex/m1-15b-calendar-scopes`, integriert in
  `codex/m1-wave-02` (`e6ec3ad`, gepusht). calendar-Objekt mit 4 Scopes,
  Termin-Bindung (calendar_id NOT NULL, category_id entfällt),
  Scope-RBAC (§7), persönliche Kalender lazy-provisioniert, Workspace-
  Route /kalender, Kalenderauswahl im Termin-Dialog.
- Kimi-K3: NACHBESSERUNG (P1-1 Scope-Leak fremde persönliche Kalender
  in Termin-Items → Join-Sichtbarkeitsfragment + Maskierung, P1-2
  User-Kalender nicht archivierbar, P2-1..P2-4, P3) — alle geschlossen.
- Nachweise: check 200 Dateien/1917 Tests + 1 Skipped, Build,
  db:generate ohne Drift, E2E M1-15 6/6 + M1-15b 2/2.

## 2026-09-04 — F7.3 Checklisten-Vorlagen REVIEWED/VERIFIED (lokal)

- F7.3 (0053): Lane `codex/f7-03-checklist-templates`, integriert in
  `codex/m1-wave-02` (`fd2694e`, gepusht). Template-CRUD mit
  Katalog-Positionseditor (OBSERVED-Item-Form), Anwendung am Projekt
  als ESTIMATE-Mapping (Block/Segment/Items SKU x quantity),
  Katalog-Validierung, 1:1-Conflict, Settings-UI + Aus-Vorlage-Sektion.
- Kimi-K3: NACHBESSERUNG mit P0 (Index-Korrelation bei Komponenten-
  Zuordnung → ID-Map + LEFT JOIN) + 3 P1 + 4 P2 + P3 — alle geschlossen,
  inkl. Multi-Komponenten-Regressionstest.
- Nachweise: check 202 Dateien/1924 Tests + 1 Skipped, Build,
  db:generate ohne Drift, E2E F7.3 2/2.

## 2026-09-04 — F9.2 Stoppuhr REVIEWED/VERIFIED (lokal)

- F9.2 (0054): Lane `codex/f9-02-timer`, integriert in
  `codex/m1-wave-02` (`194fb3e`, gepusht). Laufender Eintrag je Nutzer
  (partieller Unique), start/stop/discard, DELETE-Grant im
  M1-15-Muster, Summe nur gestoppter Einträge, UI Start/Stopp/
  Verwerfen. Kimi-K3: NACHBESSERUNG (3 P1 + 5 P2 + 3 P3) — alle
  geschlossen (u. a. Archive-Guard gegen Deadlock).
- Nachweise: check 203 Dateien/1931 Tests + 1 Skipped, Build,
  db:generate ohne Drift, E2E F9.2 2/2.

## 2026-09-04 (21:50) — Muse-Welle 02b: 4 Lanes verifiziert und integriert

- **F2.2 Varianten-Vertiefung (0055)** (`codex/f2-02-varianten-vertiefung`,
  `a030f4e`): is_primary (partieller Unique), total_price_override_net_cents,
  optional_bundles; Guard-Whitelist evolutionär erweitert
  (`guard_offer_erasure_mutation`), Rollenvertrag-Pin nachgezogen.
- **F9.3 Fremdnutzer-Filter** (`codex/f9-03-fremdnutzer-filter`, `fd4168a`):
  `listTimeEntries` userIds-Filter (IN-Liste).
- **F16.2 PDF-Vorschau** (`codex/f16-02-pdf-vorschau`, `5ce53e9`):
  read-only PDF-Preview im Angebotsmodul.
- **F10.1 Kundenportal-Skeleton (0056)** (`codex/f10-portal-skeleton`,
  `e81fe46`): portal_invite/portal_token_locator/portal_view_log, Create/
  Withdraw/Resolve (DEFINER), RLS-freier Token-Locator, app_owner-Owner-Tanz
  für den Testmodus (Muster drizzle/0015), Rollenvertrag komplettiert
  (9 Policy-Hashes, Trigger-/Funktions-Pins, EXECUTE-Grants).
- Integration in `codex/m1-wave-02` (`9fc49eb`, gepusht): Journal 0001–0056
  lückenlos, 0056-Snapshot auf den vollen integrierten Zustand gefaltet
  (Full-State-Snapshots), m111a-Zähler 56/57.
- Nachweise: check 208 Dateien/1969 Tests + 1 Skipped, Rollenprobe 88/88,
  PG18 5/5, Build grün, db:generate ohne Drift, E2E 83/86.
- **Bekannte Lücke (ehrlich):** Muse lieferte für die 4 Lanes KEINE
  E2E-Specs (Nachholpflicht in Welle 03, Prompt 09). Die 2 roten E2E-Tests
  (f7-02-E2E-01, f7-03-E2E-01) sind vorbestehend: identisch rot auf dem
  Baseline-Stand `194fb3e` (isoliert nachgemessen), f7-03 zusätzlich
  reihenfolge-empfindlich. Fixauftrag liegt im Muse-Fortsetzungsprompt
  (`docs/handover/prompts/09-Muse-Fortsetzung-Welle-03.md`).
- Quote: ~36 % (ESTIMATE); Dritter Reviewer (DeepSeek via OpenRouter) für
  Welle 03 beauftragt.

## 2026-09-02 (spät) — M1-11b + M1-13 REVIEWED/VERIFIED (lokal)

- **M1-11b Cannot Fulfil** (Rebuild, Lizenz-Modus): REVIEWED/VERIFIED (lokal).
  Branch `codex/m1-11b-cannot-fulfil` (`6ec76d0`), integriert in
  `codex/m1-wave-01` (`f525290`/`1f7be80`, remote gesichert). Migration 0040:
  Transactional Outbox (`customer_notification` +
  `customer_notification_delivery_attempt`), 4 INSERT-Freeze-Trigger mit
  FOR-SHARE-Serialisierung, 3 SECURITY-DEFINER-Kapseln, Erasure-Erweiterung
  (Lock + Storno), pgboss-Dispatch nach 0035-Muster. Nachweise: Vollgate
  `npm run check` exit 0 (173 Dateien/1.718 Tests), Rollen 88/88 + PG18 5/5,
  Chromium 4/4, Gesamt-E2E 48/48, Build grün, 2 Kimi-Reviews (16 Befunde,
  alle geschlossen) + 4 im echten Browser gefundene Laufzeit-P0 behoben.
  Visual bleibt INCONCLUSIVE (Eigentümer-Freigabe).
- **M1-13 Projektnotizen** (F1.9): REVIEWED/VERIFIED (lokal). Branch
  `codex/m1-13-project-notes` (`6749e50`), integriert in `codex/m1-wave-01`.
  Migration 0041: project_note (RLS/FORCE, revision-CAS total, Tombstone-WHERE),
  eigener Markdown-Serializer (http/https/mailto-Whitelist, HTML-Ablehnung),
  Activity-Integration, Erasure-Graph. Nachweise: Vollgate exit 0
  (175 Dateien/1.726 Tests), Rollen 88/88 + 5/5, Kimi-Review (6 Befunde,
  alle geschlossen); Chromium-Nachholung zentral geplant.
- **Quoten-Effekt (ESTIMATE):** Gesamt ~25–26 %, nutzbare Breite ~18–19 %.

## 2026-09-03 (00:30) — M1-Welle 01 komplett grün

`codex/m1-wave-01` (`e5a9c5d`): M1-11b (0040) + M1-13 (0041) integriert;
komplette Chromium-Suite 48/48, Vollgate exit 0, M1-12a-Mitternachts-Flake
behoben. Nächste Slices nach Portal-Audit-Priorisierung: M1-14 Kontakte →
M2-04 E-Signatur → M1-15 Termine (Specs fertig, Kimi-reviewed).

## 2026-09-05 — v5-Leadquelle: Intake-Variante gebaut (0048, Lane e7246f8)

- **Rechner-Leadquelle (saas-Seite fertig):** Producer-Enum
  `wmee-rechner-v5` + Lead-only-Variante — calculation bleibt für v3
  Pflicht (allOf-if/then), für v5 optional; SHA-Pin re-verankert.
  `processRechnerIntake` persistiert Lead-only: Kontakt + Site + Projekt
  (Board-Karte „unqualifiziert") OHNE Kalkulations-Snapshot/Anforderungen.
  Migration 0048 (Producer-CHECK). Contract- + DB-Golden-Tests grün.
  Vollgate Lane: 196 Dateien, 1886/1, 88/88 + 5/5, Build.
  **Root-Arbitrage:** M1-15b rückt auf 0049 (Spec aktualisiert).
- **Demo-Localhost:** Preview-Modus mit Direkt-Login („Demo-Login") und
  Seeds für alle Bereiche läuft (Wave-02 b581f80).
- **Offen:** v5-Seite (api/contact-Fan-out + HMAC + Payload-Mapping) —
  nächster Schritt; dann Integration 0048 in wave-02.

## 2026-09-04 (Nacht III) — F4.5 SPECIFIED-Draft + ADR 0026: Kimi-FREIGABE (3 Runden)

- **F4.5-Spec** (`docs/spec/F4-05-wirtschaftlichkeits-outputs.md`):
  KPI-Vertrag je Punkt getaggt (DECIDED/ESTIMATE/INTERPRETATION),
  Quoten-Null-Nenner-Semantik, IRR-Konventionen (inkl. Mehrfach-
  Vorzeichenwechsel), Kaskade zeitkonditional als INTERPRETATION
  markiert (Mikail-Bestätigung angefordert), Sankey-Erhaltungs-
  invariante, Goldwert-Regression F405-GOLD-01, Horizont-Ownership
  F4.5/F4.6 geklärt. 3 Kimi-Review-Runden → **FREIGABE als
  SPECIFIED-Draft** (4 P2 verbindlich vor CONTRACTED — eingearbeitet).
- **ADR 0026 Rechenkern (DRAFT):** Optionen A/A′/B/C1/C2, Empfehlung
  C2 (Clean-Room-Hybrid), C1-Fallback mit Audit-Auflage,
  Verifikationspfad für alle Optionen, Schließungspfad mit Owner.
  **Mikail-Entscheid offen (UNK-F4-02).**
- Gepusht `aa94d1c`. F4.5 bleibt SPECIFIED, bis Mikail UNK-F4-01/02/03/
  04/05 beantwortet; danach CONTRACTED + Kern-Umsetzung.

## 2026-09-04 (Nacht II) — F4.6 INTEGRIERT: Kimi APPROVE, E2E 73/73, M4 PARTIAL VERIFIED

- **0047-Integration** `codex/m1-wave-02` HEAD **`75cf00e`** (remote):
  Fast-Forward der Lane auf 5c7ea33; Journal monoton, 0047.prevId =
  0046.id, keine Drift, Erasure unangetastet. Kimi-Integrations-Review
  **APPROVE** (0 P0/P1/P2). **Chromium-E2E komplett 73/73**
  (71 Bestand + 2 F4.6); `npm run check` exit 0 (1883/1, 88/88+5/5).
- **M4/F4 Simulation & Wirtschaftlichkeit: SPECIFIED → PARTIAL VERIFIED**
  (F4.6 Defaults-Speicher real; Rechenkern F4.1–F4.5 wartet auf ADR +
  Mikail-Fragen UNK-F4-01..05).
- **Quote (ESTIMATE):** Gesamt ~31 %, nutzbare Breite ~23–24 %,
  Fundament ~97–98 %.

## 2026-09-04 (spät) — F4.6 Workspace-Simulationsdefaults gebaut (0047): Kimi SPEC+CODE geschlossen

Lane `codex/f4-06-wirtschaftlichkeits-defaults` HEAD **`5fee9ca`** (remote).
- **Migration 0047** (Root-Arbitrage: M1-15b rückt auf 0048): Singleton
  `workspace_economics_settings` (Strompreis/Eskalation/Öl-/Gaspreis
  nullable = „leere Felder → Länderreferenz" (UNK-F4-03: keine erfundenen
  Zahlen), Horizont DEFAULT 20 ESTIMATE-markiert), CAS-Revision,
  `_f406`-Actor-Helfer, RLS+no_truncate; ACL idempotent im Rollenvertrag
  (Pins aus Ist, Probe 88/88).
- Service get/upsert (Leerstand-DTO revision 0, 23505→Conflict),
  Event/Audit im eigenen Namespace `economics.settings.write`;
  Permissions `economics.read`/`economics.write` (35 Actions).
- UI `/einstellungen/wirtschaftlichkeit` (Prozent→bps, Viewer read-only,
  leerer Zustand); E2E 2/2 inkl. Feld-Leerung + Axe.
- **Kimi:** Spec NACHBESSERUNG (2 P1 + 3 P2 + 2 P3) und Code
  NACHBESSERUNG (1 P1-Klarstellung + 3 P2 + 2 P3) → alle geschlossen
  (`REVIEW-KIMI-F4-06.md`).
- **Vollgate Lane:** 196 Dateien, 1883 passed/1 skipped, 88/88 + 5/5,
  Build, keine Drift. Integration in `codex/m1-wave-02` = nächster
  Schritt (Fast-Forward-Muster).
- UNK-F4-03 (echte Default-Werte) bleibt an Mikail eskaliert; F4.5
  spec-first wartet auf ADR + Mikail-Fragen.

## 2026-09-04 (Nacht) — M3-01 INTEGRIERT in codex/m1-wave-02: Kimi FREIGABE, E2E 71/71

- **0046-Integration** `codex/m1-wave-02` HEAD **`5c7ea33`** (remote): Fast-
  Forward der Lane (Basis 1b1f944, linear) + E2E-Seed-Fix `3a0d048`
  (M3-00-Spec hinterlässt im Gesamtlauf Settings ohne Zahlungsdaten →
  Nachrüst-Update). Journal `when` monoton, 0046.prevId = 0045.id,
  Snapshot drei-Wege, keine Drift, keine Erasure-Pin-Änderung.
- **Kimi-Integrations-Review FREIGABE** (0 P0/P1/P2; 2 P3 dokumentiert):
  _m301-Pins (3 Runtime-Routinen + Trigger, 20 Policies, ACL ohne
  DELETE/app_worker), ACTOR_SCOPED_TABLES, m111a idx 46.
- **Gesamt-E2E 71/71** (66 Bestand + 5 M3-01): Journey, Filter/Archiv,
  Berichte/CSV, Rollen, Typ-Abdeckung; Axe A/AA inkl. offenem Dialog.
  `npm run check` exit 0 (194 Dateien, 1874 passed/1 skipped, 88/88+5/5),
  Build exit 0.
- **F8 Rechnungen: SPECIFIED → PARTIAL VERIFIED** (Kern-Suite komplett;
  Teilrechnungen/PDF/E-Rechnung/GoBD/Erasure = Folgeslices).
- **Quote (ESTIMATE):** Gesamt ~30 %, nutzbare F1–F16-Breite ~22–23 %,
  Fundament unverändert ~97–98 %.

## 2026-09-04 (spät) — M3-01 UI-/E2E-Schicht gebaut (Root): 5/5 Chromium, Kimi NACHBESSERUNG→geschlossen

Lane `codex/m3-01-invoicing-core` HEAD **`1059b06`** (remote gesichert).
- **Bereich „Rechnungen & Dokumente":** Tabs (Übersicht, 6 Typen, Berichte);
  Listen je Typ mit Spec-§7-Filtern (Status/Zahlung/Ausstellungsfenster/
  Fach-Datum/Grund/Archiv/Suche), Keyset-Pagination, typ-spezifische
  Spalten; Übersicht mit Gruppen (Anlage + Archiv-Toggle); Berichte mit
  Berlin-Monats-KPIs, Lebenszyklus-Buckets, Überfälligkeits-Buckets,
  Neueste-10 + CSV-Download-Route (private, nosniff, CSP sandbox).
- **Server-Actions** (Zod + serverseitige UUID-/Enum-Prüfung): Gruppe
  anlegen/archivieren; Dokument anlegen/ausstellen/versenden/stornieren/
  archivieren. `setDocumentArchived`/`setDocumentGroupArchived` im Service
  neu (Spec §5.4). UI-Gating nur Anzeige — Actions sind die Grenze.
- **A11y:** Fokus-Falle + Escape + Fokus-Rückgabe (`useModalDialog`),
  null-on-success-Dialogschließen, sr-only-Zusammenfassungen, role=alert,
  keine farbalone Codierung; Berlin-Datumsanzeige (kein Server-TZ).
- **E2E 5/5** (Chromium): Journey Gruppe→Anlage→Ausstellen→Versenden→
  Stornieren; Filter/Suche/Archiv-Achse; Berichte+CSV im isolierten
  Workspace inkl. Empty-States; Viewer read-only/External fail-closed;
  Typ-Abdeckung Gutschrift/Auftragsbestätigung/Bestellung/Lieferschein/
  Brief. Axe A/AA inkl. offenem Storno-Dialog.
- **Kimi-K3 NACHBESSERUNG** (1 P1 + 6 P2 + 6 P3) → alle geschlossen
  (`REVIEW-KIMI-M3-01-UI.md`): Spaltenversatz-Zahlung, Monatsgrenz-Flake,
  Typ-Abdeckung, Pflichtzustände, Dialog-Fokus, Storno-Gating u. a.
- **Vollgate:** `npm run check` exit 0 (194 Dateien, 1874 passed/1
  skipped, Rollenprobe 88/88 + PG18 5/5), Production-Build exit 0,
  `db:generate` keine Drift. `UNK-M301-02` (M3-00-Nummern-Template ↔
  M3-01-Serienformat) als Integrations-Folgeslice eingetragen.
- **Nächster Schritt: 0046-Integration** in `codex/m1-wave-02` (Journal
  monoton, Snapshot-Drei-Wege, Rollen-Pins aus Ist, ACTOR_SCOPED,
  m111a=47) → danach Gesamt-E2E (66+5) und M3-01 VERIFIED.

## 2026-09-04 — M3-01 A4 gebaut (Root): Listen/Filter + Berichte/CSV — Kimi FREIGABE

Lane `codex/m3-01-invoicing-core` HEAD **`4218842`** (remote gesichert).
- **M301-06 `listDocuments`:** Keyset-Cursor (base64url, (created_at,id)
  DESC), Archiv-Achse active/archived/all (Default active), typ-gebundene
  Filter (Status, Zahlungsstatus nur Geld-Typen, Ausstellungsfenster Berlin,
  Fach-Datum invoice→Fälligkeit/credit_note→Lieferdatum, Gutschrift-Typ),
  Namenssuche mit LIKE-Escaping, totalCount. DTO-Mapper extrahiert
  (`toDocumentV1`/`toIso`); dabei `archivedAt`-Bug in readDocument behoben
  (war hart null).
- **M301-07 `getInvoicingReport`:** Berlin-Monatsfenster; KPIs Einnahmen
  (issued im Monat, voided raus), Cashflow-Proxi (payment_updated_at im
  Monat), Ausstehend/Überfällig (all-time, je Dokument ≥0 geklemmt);
  Vormonats-Delta nur für Fluss-KPIs (Bestands-KPIs null = „Kein Vormonat");
  5 disjunkte Lebenszyklus-Buckets; Überfälligkeits-Buckets
  0–30/31–60/61–90/>90 + Insgesamt ausstehend; Neueste 10.
- **`exportInvoicingReport`:** CSV UTF-8, `;`-getrennt, ISO-Daten,
  Euro-Dezimal Punkt (DECIDED), RFC-4180-Quoting, Formula-Guard.
- **0046 additiv:** `payment_updated_at` (Spec-M301-05-Nebenwirkung) in
  recordPayment/setPaymentStatus gesetzt; Snapshot drei-Wege, keine Drift;
  Issued-Freeze-Trigger unverändert (Zahlungsachse bleibt erlaubt).
- **Kimi-K3 FREIGABE** (0 P0/P1): alle 5 P2 (Cursor-/Datumsvalidierung,
  Grenzmonat 2000-01, Escaping-Tests, Dezimaltrenner-DECIDED, Formula-Guard)
  + 8 P3 geschlossen/dokumentiert → `REVIEW-KIMI-M3-01-A4.md`.
- **Vollgate:** `npm run check` exit 0 (1870 passed/1 skipped), Rollenprobe
  88/88 + PG18 5/5, Production-Build exit 0, `db:generate` keine Drift,
  `git diff --check` sauber.
- **Nächster Slice:** M3-01 UI-/E2E-Schicht zentral (Seiten je Typ, A11y,
  E2E 66+) → danach 0046-Integration in `codex/m1-wave-02`.

## 2026-09-03 (18:45) — PAUSE-HANDOVER: M3-01 A1–A3 abgeschlossen

Lane `codex/m3-01-invoicing-core` HEAD **`0dcfd8e`** (remote gesichert):
A1 Kern, A2 Ausstellen/Nummernkreis/Snapshot, A3 Versand/Storno/Zahlungsachse
— jeweils Kimi-reviewed und nachgebessert; Vollgate grün (96/96, 896/1,
88/88+5/5, keine Drift). Offen: A4 (Listen/Filter/Berichte), UI-/E2E-Schicht,
0046-Integration in codex/m1-wave-02, externe Gates (siehe Vault-Handover).

## 2026-09-03 (18:10) — M3-01 A3 gebaut (Root): Versand/Storno/Zahlung

- **A2-Kimi-Nachlese geschlossen:** Overflow-Test (999999-Grenze) + echter
  Berlin-Offset statt Z-Suffix; Spot-Recheck: 5/6 + Nachlieferung →
  FREIGABE-reif. Gepusht `99c17a4`.
- **A3:** markSentDocument (einmalig, terminal), voidDocument
  (draft/issued/sent→voided, Pflichtgrund-Festliste, Nummer bleibt
  verbrannt; Guard-Fix: Status aus dem Content-Freeze genommen, Kanten
  regeln die Transitionen — Pin b3d5ec89), recordPayment
  (paid/unpaid/partially_paid NUR aus paid_cents abgeleitet, terminale
  Zustände blockieren), setPaymentStatus (nur overdue/uncollectable).
  M301-AX-01..04; Vollgate grün (96/96, 894/1, 88/88+5/5, keine Drift).
  Gepusht `39fae92`. Kimi-Review läuft.
- **Nächster Slice: A4** (Listen/Filter je Typ, Berichte M301-06/07 +
  CSV-Export) — danach UI-/E2E-Schicht zentral.

## 2026-09-03 (17:20) — M3-01 A2 gebaut (Root), A3 als Nächstes

- **A2-Agent kam erneut nicht aus der Einlesephase** (40 min, null
  Dateiänderungen) → Root baute A2 selbst: assignDocumentNumber (atomarer
  Upsert je (ws,type,series_year), Rollover, verbrannte Nummern),
  issueDocument (CAS draft→issued, GOEBD-Snapshot + SHA-32, O4-Precondition,
  goebd_retention_until), Präfixe auf Spec §6 korrigiert (RE/GU/AB/BE/LS/BR —
  Kimi P2-9), V1-DTO um Nummern-/Achsen-Felder erweitert (P2-10).
  M301-ISSUE-01..04; Vollgate grün (95/95, 887/1, 88/88+5/5, keine Drift).
  Gepusht `189051f`. Kimi-Review läuft.
- **Lane-Entscheid:** Slice-Umsetzung läuft künftig direkt beim Root
  (zwei Agenten-Ausfälle in Folge); Agenten weiterhin für Discovery/Briefe
  (funktionierte zuverlässig).
- Offene Mikail-Punkte unverändert (v5-Deploy, Katalog-Datenlücken,
  S3-Object-Lock, Codex-Limit, UNK-F4-01..05).

## 2026-09-03 (16:00) — M3-01 A1 recovered + Kimi-FREIGABE, A2 gestartet, F4-Brief fertig

- **A1-Implementierer kreiste** in der Test-/Snapshot-Schleife (kein Commit
  nach ~3h) → Root übernahm: Contract-/DB-Tests (7), tenant-fixtures,
  Rollenvertrag komplett (_m301-Funktions-/Policy-/Trigger-Pins + Tabellen-
  Grants aus Ist verankert), ACTOR_SCOPED_TABLES, m111a-Zähler 47.
  Vollcheck exit 0 (191 Dateien, 1836/1), Rollenprobe 88/88 + 5/5, keine
  Drift. Lane gepusht (`1c1e878`).
- **Kimi-A1-Review:** 3 P1 + 7 P2 + P3 → alle P1 (Steuer-BigInt, Event/Audit
  Zeilenpfad, Statusmaschine draft→issued→voided) + P2-4/6/7/8 geschlossen,
  Regressionstests M301-DB-05/06/07, Pin 74b12d49 neu verankert. Spot-Recheck
  **FREIGABE**. Gepusht (`64117d3`).
- **A2 (Ausstellen + Nummernkreis + Snapshot)** läuft bei frischem
  Implementierer; A1-Basis committet.
- **F4-Wirtschaftlichkeit:** DISCOVERED-Brief fertig (F4.4–F4.6, OBSERVED
  dünn, 7 Mikail-Fragen, Empfehlung: F4.6 als M3-00-Klon zuerst, F4.5
  spec-first mit Rechenkern-ADR). Dev-„M3" = F8, Modulkatalog-M3 = PV-Planung.
- Offene Mikail-Punkte unverändert: v5-Deploy-GO, Katalog-Datenlücken,
  S3-Object-Lock, Codex-Limit.

## 2026-09-03 (14:40) — M3-01 A1 in der Testschleife, M4-Discovery parallel

- **M3-01 A1:** Implementierer hat 0046 (4 Tabellen, 6-Typen-Diskriminator
  laut ADR 0023, _m301_actor-Helfer, Issued-Immutable-Guard, FORCE-RLS nach
  0045-Muster) + Contract + Service stehen; Early-Quality-Check des Schemas
  gegen Hausmuster bestanden. Läuft gerade in der Test-/Drift-Schleife
  (Vitest-Prozess aktiv, Dateien in Bewegung). Abnahme durch Root, sobald
  der Agent committet.
- **M4-Wirtschaftlichkeit:** Discovery-Brief in Arbeit (Portal-Audit-Map +
  Modulkatalog; OBSERVED/ESTIMATE-Trennung, Slice-Vorschlag, Mikail-Fragen).
- Externe Gates unverändert: v5-Deploy-GO, Katalog-Import-Datenlücken,
  S3-Object-Lock (M2-03b2), Codex-Usage-Limit (Reset 7. Sep.).

## 2026-09-03 (13:10) — Welle 02 komplett integriert: 0044 + 0045 VERIFIED auf codex/m1-wave-02

- **0044 M2-04 E-Signatur integriert** (`163d2a8`): Erasure-Kette auf post-0043
  re-verankert, Rollenvertrags-Pins auf Integrations-Ist, Snapshot drei-Wege
  rekonstruiert (db:generate ohne Drift), E2E 62/62. Kimi FREIGABE.
- **0045 M3-00 Stammdaten integriert** (`1b1f944`): Merge-Konflikte additiv
  gelöst (Rollenvertrag, Permissions 33, tenant-fixtures, m111a-Zähler 46),
  0045-Snapshot auf 0044-Kette rekonstruiert; Vollcheck grün im ersten Lauf,
  E2E **66/66**, Build grün, keine Drift. Kimi FREIGABE (Vorbehalte des
  Bundles durch Rollenprobe + db:generate abgedeckt).
- **Token-Disziplin aktiv** (RUNBOOK §1a, test:db/test:unit/test:focus,
  kimi-review-Wrapper OpenRouter→lokal), Codex-Review weiterhin am
  Usage-Limit (Reset 7. Sep.) — Kimi übernimmt.
- **M3-01 Rechnungs-Kern (0046):** Implementierungs-Brief fertig (4 Slices,
  6 Dokumenttypen laut ADR 0023); Implementierer-Agent arbeitet Slice A1
  (Schema+Gruppen+Entwurf) im Worktree energie-saas-m301-rechnungen.

## 2026-09-03 (07:50) — M2-04 + M3-00 implementiert und grün; Agenten-Ausfall bewältigt

- **M2-04 E-Signatur (0044):** IMPLEMENTED, Vollcheck `npm run check` exit 0
  (180/180 Dateien, 1755 passed/1 skipped), Rollen 88/88+5/5, Build,
  `db:generate` ohne Drift. Kern: `signature_token_locator` (RLS-frei,
  Definer-only, erasure_operation_locator-Muster), 4 Token-Kapseln, Strict-
  Tests 4/4 (Token-Pfad/Race/Analog/Scoped-Erasure), tenant-Factories,
  `RLS_FREE_WORKSPACE_EXEMPT`, Panel-Rollen-Gating + aria-live (E2E-Befunde).
  Branch `codex/m2-04-e-signature` GEPUSHT. OFFEN bis VERIFIED: Chromium-
  E2E-Lauf (Fixture-Port auf Strict-Kette war beim Agentenausfall in Arbeit),
  Kimi-Code-Review, 0044-Integration in wave-02 (Erasure-Pin auf post-0043).
- **M3-00 Workspace-Stammdaten (0045):** IMPLEMENTED, Vollcheck exit 0
  (186/186 Dateien, 1816 passed/1 skipped), Rollen 88/88+5/5. Implementierer
  stürzte kurz vor Schluss ab (Kontextlimit); Root stellte fertig: `(ws,id)`-
  Uniques, Actor-Helfer `_m300_*` + RLS-/Policy-Vertrag rekonstruiert,
  Policy-/Funktions-Pins auf Ist-Hashes, no_truncate-Trigger, Fixtures +
  ACTOR_SCOPED_TABLES. Branch `codex/m3-00-workspace-stammdaten` GEPUSHT.
  OFFEN bis VERIFIED: E2E, Kimi-Code-Review, Integration nach 0044.
- **Agenten-Ausfall:** alle drei Subagenten (M2-04-Implementierer,
  M3-00-Implementierer, E2E-Agent) endeten mit Fehlern (Kontextlimits);
  sämtliche Arbeit war auf der Platte und wurde von Root gesichert —
  nichts verloren, eine 0045-Teilstrecke rekonstruiert (Rollenprobe 88/88
  belegt die Konsistenz).
- **Quote unverändert ehrlich:** ~25–26 % Gesamt / ~18–19 % nutzbar /
  ~97–98 % Fundament (nur VERIFIED zählt; M2-04/M3-00 steigen erst nach
  E2E + Kimi-Review + Integration).

## 2026-09-03 (03:00) — WAVE-02 INTEGRIERT: M1-14 + M1-15 komplett grün

- **Slice-Branches gesichert (gepusht):** `codex/m1-14-contact-dataset`
  (`f6a990b`, 50 Dateien) und `codex/m1-15-calendar-appointments`
  (`6d80f62`, 36 Dateien) — je Vollgate grün + Chromium E2E 4/4 bzw. 6/6.
- **Integration `codex/m1-wave-02` (`db9e13d`, gepusht):** 0042→0043 gemergt.
  Integrations-Fixes: Journal-`when`-Reihenfolge monoton gemacht (beide Lanes
  hatten invertierte Timestamps → History-Check divergierte an Position 43),
  0043-Snapshot-Kette neu verankert (prevId→0042, Three-Way-Merge,
  `db:generate` ohne Drift), M1-15-Fixtures um `first_name`/`last_name`
  ergänzt (0042-NOT-NULL), Permissions-Zählung 24→26, **Erasure-Pin 0043 auf
  den echten post-0042-Hash `cec63897…` gesetzt** (Rollenprobe deckt ihn).
- **Nachweise integriert:** `npm run check` exit 0 (184/184 Dateien,
  1804 passed/1 skipped), `db:roles:verify` 88/88 + PG18 5/5, Production-Build
  exit 0, `db:generate` keine Drift, depcruise 0 violations (352 Module),
  `git diff --check`, Secret-Scan — **Chromium-E2E komplett 58/58** (48
  Bestand + 4 M1-14 + 6 M1-15).
- **M2-04 (0044):** Locator-Fix (`signature_token_locator` nach
  `erasure_operation_locator`-Muster) umgesetzt, Rollenvertrag grün (88+5),
  Strict-Tests 3/4; Erasure-e2e per Root-Entscheid auf M2-04-spezifische
  Assertions gescoped (Eligibility bleibt m107-Domäne) — Umsetzung läuft.
- **Spec-Spuren:** M3-00 + M1-15b Kimi-reviewed und alle 8+12 Befunde
  geschlossen (`ab6c260`); M1-15b = 0047, ADR 0025. Portal-Recon lieferte
  OBSERVED-Issuing-Felder/-Nummern-Templates (CRN/OFC/PO/DN/LE).

## 2026-09-03 (02:20) — E2E findet echte Bugs, M1-15-Schließung grün, M3-OBSERVED eingearbeitet

- **M1-14 (0042):** Kimi-Befunde geschlossen, E2E-Specs (4 Szenarien) von Root
  grün gefahren (4/4, exit 0). Der echte Browser fand **3 Fehler**, die alle
  Ebenen davor verpasst hatten: (1) Client-Komponente lief über den
  server-only-Modul-Barrel (HTTP 500) → Contract nach
  `lib/integrations/contacts/contract.ts` (Hausmuster notes/calendar);
  (2) Editor schloss nach Erfolg nicht (RSC-Refresh remountet die Form via
  `key={revision}` bevor der Success-Effekt feuert) → Schließen jetzt über
  Server-Wahrheit (Revisions-Vorlauf); (3) `<dl>`-Struktur Axe-invalid →
  restrukturiert. Zusätzlich 3 Spec-Assertions an das echte DOM angepasst.
  Volllauf deckte danach **2 weitere P1** auf (0042 nicht Legacy-sicher:
  `ADD COLUMN … NOT NULL` auf befüllten Bestand; Journal-Pins noch auf 0041) —
  Schließung an Implementierer dispatcht.
- **M1-15 (0043):** Kimi-Schließung komplett grün (181/181 Dateien,
  1776 passed/1 skipped, 88/88+5/5, Build, keine Drift; DST-Fix auf
  Berliner Datumsebene, echter `erase_inactive_lead`-Lauf, categoryId-
  Validierung, hourCycle h23). E2E fand Dialog-Bug (Strict-Mode-Doppel-Effekt
  schließt natives `<dialog>` sofort) → Fix (M1-13-Muster) in Arbeit beim
  Implementierer; dessen E2E-Spec (6 Szenarien) wird danach grün erwartet.
- **M3-OBSERVED-RECON eingearbeitet** (`179bdac`): Issuing-Details-Felder,
  Nummern-Templates `Rechnung-{YEAR}-{MONTH}-{NUMBER}` bzw.
  `CRN/OFC/PO/DN/LE-{YEAR}-{MONTH}-{DAY}-{NUMBER}`, Gutschrift-Enum
  (Minderleistung/Empfehlungsprämie), KPI-Vormonats-Indikator.
- **M1-15b Kalender-Scopes** SPECIFIED (Migration 0047; ADR 0025 supersedes
  ADR 0021 E2; `/calendar`-Route in M1-15b).
- **M2-04:** Rollenvertrag-Block beim Subagenten aktiv; Strict-DB-Tests und
  Erasure-E2E danach; Zwischenstand dokumentiert (Guard-Seite = DECIDED,
  M2-04b für öffentlichen Render nach M2-03b2/issued).
- Kimi-UI-Nachreview für M1-14/M1-15 nach Schließung geplant (Bundle-Tool
  `scripts/kimi-review-bundle.sh` committet, fixiert Bracket-Pathspec-Fallen).

