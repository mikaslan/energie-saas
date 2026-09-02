# Reonic-Parität — belastbarer Liefer- und Fortschrittsstand

Stand: 2026-09-03 (01:30) · kanonische Abnahmequelle:
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
| Gesamtmission einschließlich F1–F16 | ca. 25–26 % | M1-Welle 01 komplett grün (`e5a9c5d`, remote); M3-01-Spec final (`635eb34`); M1-14/M1-15/M2-04 in Implementierung |
| Technisches Fundament M0/M1 | ca. 97–98 % | Auth-, Tenant-, DB-, Worker-, Intake-, Rechen-, Katalog- und geschützte Webgrenzen lokal real; externe Provider-/Pilotgates offen |
| Nutzerseitige F1–F16-Funktionsparität | ca. 18–19 % | Projektakte, Aufgaben, Outcomes, Notizen, Cannot-Fulfil, Katalog, Varianten/BOM, Angebots-PDF-Entwurf lokal verifiziert; Kontakte/Termine/E-Signatur/Rechnungen in Arbeit |

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

## 2026-09-03 (01:30) — M3-01 Spec final, drei Implementierungs-Lanes

- **M3-01 Rechnungs-Kern (F8):** DISCOVERED→SPECIFIED final, committet
  `635eb34` (tooling, gepusht). Root-Arbitrage O1–O5: Migration **0046**
  (M2-04 behält 0044, M3-00 Stammdaten nimmt 0045); Spec-Basis `12c863f`,
  Implementierung zweigt vom Integrationsstand nach 0042/0043/0044/0045 ab;
  „Ausstellen" = Nummer+Snapshot ohne PDF (M3-02 folgt); F8.2 wird eigenes
  Slice **M3-00 (Workspace-Stammdaten „Ausstellungsdetails", 0045)** vor
  M3-01; `goebd_retention_until` wird bereits modelliert, Durchsetzung =
  GoBD-Folge.
- **Lanes in Implementierung (Migrationen reserviert):** M1-14 Kontakte
  (0042), M1-15 Termine/Kalender (0043), M2-04 E-Signatur (0044).
  Integrationsreihenfolge: 0042 → 0043 → 0044 → (M3-Welle: 0045/0046).
- Kimi-K3-Spec-Review für M3-01 läuft; M3-00-Spec delegiert.
