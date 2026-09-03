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
| Gesamtmission einschließlich F1–F16 | ca. 27–28 % (ESTIMATE) | M1-Welle 01+02 komplett grün; M2-04 + M3-00 integriert und VERIFIED (E2E 66/66, `codex/m1-wave-02` `1b1f944`); M3-01 (0046) in Implementierung |
| Technisches Fundament M0/M1 | ca. 97–98 % | Auth-, Tenant-, DB-, Worker-, Intake-, Rechen-, Katalog- und geschützte Webgrenzen lokal real; externe Provider-/Pilotgates offen |
| Nutzerseitige F1–F16-Funktionsparität | ca. 20–21 % (ESTIMATE) | Projektakte, Aufgaben, Outcomes, Notizen, Cannot-Fulfil, Katalog, Varianten/BOM, Angebots-PDF, Kontakte, Termine, E-Signatur-Vorbereitung, Rechnungs-Stammdaten lokal verifiziert; Rechnungs-Kern in Arbeit |

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
| F2 Angebote | PARTIAL VERIFIED | M1-08 liefert verifizierte Produkt-/Preissnapshots; M2-01 liefert daraus technisch verifizierte Draft-Offers, Varianten, Snapshot-BOM sowie Preis-/Rabatt-/Steuerentwurf. Die menschliche Screenshot-Baseline bleibt separat `INCONCLUSIVE`; PDF und Signatur folgen in eigenen Slices |
| F3 PV-Planung | PARTIAL VERIFIED | Hausbezogene, serverseitig reproduzierbare Planungsschätzung lokal real; rechtmäßige Dachdatenadapter und tiefere Planungswerkzeuge folgen capabilityweise |
| F4 Simulation | SPECIFIED | deterministischer Rechenkern mit fachlichem Güte- und Haftungsgate |
| F5 Wärmepumpe | SPECIFIED | Schätzverfahren klar von zertifizierter Normrechnung trennen |
| F6 Schaltplan | SPECIFIED | eigener Editor-/Exportvertrag |
| F7 Installation | SPECIFIED | Signatur → Installation → Checkliste/Disposition/Handover |
| F8 Rechnungen | SPECIFIED (M3-01 final, O1–O5 resolvt) | generisches `commercial_document`-Modell (ADR 0023), Migration 0046; M3-00 Stammdaten (0045) davor |
| F9 Zeiterfassung | SPECIFIED | Timer/Eintrag → Audit → Export |
| F10 Kundenportal | SPECIFIED | geschützter Projektlink → Angebot/Status/Dateien |
| F11 Mobile/PWA | SPECIFIED | schmale Offline-Outbox für Fotos/Checklisten/Zeit |
| F12 Lead-Funnel | SPECIFIED | Provideradapter erst nach Privacy-Freigabe anbinden; weitere Funnels capabilityweise bauen |
| F13 Services | SPECIFIED | Filing-Objekt und Statusmaschine, externe Human-Gates ehrlich markieren |
| F14 KI | SPECIFIED | rechtegebundene Tools erst nach realen Domain-Commands |
| F15 Gewerbe | SPECIFIED | getrenntes Commercial-Datenmodell |
| F16 Katalog/Vorlagen | PARTIAL VERIFIED | M1-08a: eigener Katalog, sieben Produkttypen, Preise/Provenienz, Lifecycle und Projektauflösung lokal real; CSV, Assets, Vorlagen und Lieferantenfeeds folgen getrennt |

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

1. Externe Provider-/DR-Gates ausdrücklich BLOCKED lassen, bis echte autorisierte
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

