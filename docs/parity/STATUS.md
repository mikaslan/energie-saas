# Reonic-Parität — belastbarer Liefer- und Fortschrittsstand

Stand: 2026-08-30 · kanonische Abnahmequelle:
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
| Gesamtmission einschließlich F1–F16 | ca. 20 % | Fundament sowie Rechner→Lead→Adresse→Planung→eigener Katalog→Produktauflösung→Angebotsentwurf→interner PDF-Draft→geprüfter, aber nicht ausgestellter Freigabekandidat sind lokal technisch verifiziert; Ausstellung, Signatur und operative Breite bleiben offen |
| Technisches Fundament M0/M1 plus lokale M2-Basis | ca. 95–97 % | Auth-, Tenant-, DB-, Worker-, Intake-, Rechen-, Katalog-, Angebots-, Freigabe- und geschützte Webgrenzen sind lokal weitgehend real. Die hohe Zahl beschreibt das Fundament, nicht die Produktbreite; externe Provider-/Pilotgates bleiben offen |
| Nutzerseitige F1–F16-Funktionsparität | ca. 11–13 % | Login, Intake-Triage, Projektakte, Adresse, Energieprofil, Planungsschätzung, eigener Katalog, Produktzuordnung, Angebotsentwurf mit Varianten/BOM, interner PDF-Draft und der interne Freigabekandidaten-Workflow sind real und lokal technisch verifiziert; Ausführung, Abrechnung und die meisten F1–F16-Flows bleiben offen |

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
| M2-02 interner Angebots-PDF-Entwurf | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO | Exakt eine immutable Variantenrevision wird serverseitig in einen minimierten, gehashten Input gebunden; der ID-only-Job durchläuft `queued`/`running`/`retry_wait`/`succeeded`/`failed_final`, wird mit offline/sandboxed Chromium unter einem auf `linux/amd64`, Playwright 1.62.1 und OCI-Digest gepinnten Rezept gerendert, bis 8 MiB tenantgeschützt in Postgres gestaged und nach Reauth privat heruntergeladen. Viewer darf lesen/downloaden, Editor/Admin mit `project.write` anfordern/replayen, External nie und `app_worker` nur least-privilege claimen/finalisieren. 96/96 Vitest-Dateien mit 949 bestandenen Tests, 88/88 Rollen- plus 5/5 PG18-Proben, 16/16 aktive Chromium-E2E, gepinnter Container-Smoke und unabhängiges P0–P2-Review sind grün. Kein Rollout-Flag by design; kein `issued`, Versand, Signatur, öffentlicher Link, Rechnung, WORM oder produktiver Deploy. `M202-VISUAL-01` bleibt menschlich `INCONCLUSIVE` |
| M2-03a Angebotsprofil/Freigabekandidat | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO | Versionierte und aktivierte Dokumentprofile, append-only Empfänger-/Rechnungsstände, strikte Readiness, versiegelter Candidate-Input, ID-only-Worker, Byte-/Hash-Prüfung, append-only Abschlussfreigabe und privater Download bis zum abgeleiteten Zustand `approved_not_issued` sind lokal real. 111/111 Vitest-Dateien mit 1.078 bestandenen und 1 übersprungenen Test, 17 bestandene plus 1 opt-in übersprungene Chromium-E2E, 88/88 Rollen- plus 5/5 PG18-Proben, Build/Lint/Typecheck/Dependency-Cruiser, gepinnter `linux/amd64`-Container-Smoke mit Status auf 11/11 PDF-Seiten sowie Security-, Regression-, Navigation- und lokaler Claude-Code-Opus-Max-Review sind grün und ohne offene P0–P2. Die E2E-Kette synthetisiert Claim/Finalize in der DB; der echte Renderer ist separat im Container belegt. Menschliches Visual bleibt `INCONCLUSIVE`; Deploy, echte Rechtstexte, WORM/Object Lock, Ausstellung, Versand und Signatur sind `NOT RUN` beziehungsweise offen |
| Rechner V3 | CONTRACTED (Clone) / BLOCKED (Provider) | read-only Baseline `rechner/v3@2b00f6b`; Provider-Wiring erst nach veröffentlichtem korrektem Datenschutzhinweis und Secret-Provisioning |

## F1–F16-Matrix auf Capability-Ebene

Der Modulkatalog ist vollständig spezifiziert. Die folgende Matrix behauptet bewusst
keine Implementierung aufgrund bloßer Infrastrukturarbeit.

| Bereich | Höchster belastbarer Stand | Nächster echte Slice |
|---|---|---|
| F1 CRM & Leads | PARTIAL VERIFIED | Rechner-V3-Intake → Kontakt → Standort/Adresskorrektur → Anfrage → Kanban/Projektakte → Energieprofil ist lokal real; als Nächstes Zuweisung und weitere CRM-Capabilities |
| F2 Angebote | PARTIAL VERIFIED | M1-08 liefert verifizierte Produkt-/Preissnapshots; M2-01 liefert daraus Draft-Offers, Varianten, Snapshot-BOM sowie Preis-/Rabatt-/Steuerentwurf. M2-02 ergänzt den geschützten internen PDF-Draft. M2-03a ergänzt versionierte Aussteller-/Rechtstextprofile, bestätigte Empfängerdaten, einen kundentauglichen Renderkandidaten und die bytegebundene interne Freigabe `approved_not_issued`. Die menschlichen Visual-Baselines bleiben `INCONCLUSIVE`; echte Rechtstexte, Ausstellung, WORM, Versand und Signatur folgen in getrennten Gates |
| F3 PV-Planung | PARTIAL VERIFIED | Hausbezogene, serverseitig reproduzierbare Planungsschätzung lokal real; rechtmäßige Dachdatenadapter und tiefere Planungswerkzeuge folgen capabilityweise |
| F4 Simulation | SPECIFIED | deterministischer Rechenkern mit fachlichem Güte- und Haftungsgate |
| F5 Wärmepumpe | SPECIFIED | Schätzverfahren klar von zertifizierter Normrechnung trennen |
| F6 Schaltplan | SPECIFIED | eigener Editor-/Exportvertrag |
| F7 Installation | SPECIFIED | Signatur → Installation → Checkliste/Disposition/Handover |
| F8 Rechnungen | SPECIFIED | unveränderliche Belegkette und Teil-/Schlussrechnung |
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
4. `M202-VISUAL-01` bis zur menschlichen Baseline-Freigabe getrennt
   `INCONCLUSIVE` lassen. Der produktive Worker-Deploy und Object Lock bleiben
   ausdrücklich außerhalb des lokal grünen Draft-Gates.
5. `M203A-VISUAL-01` sowie echte Firmen-/Rechtstexte separat fachlich,
   juristisch und menschlich freigeben; die lokale technische Verifikation
   nicht als Rechts- oder Brandfreigabe umdeuten.
6. M2-03b als getrennten Issuance-Slice bauen: neue Ausstellungsbytes aus dem
   freigegebenen Candidate-Input, erneute Bytefreigabe und erst nach echtem
   Object-Lock-/Retention-/Hash-Readback einen `issued`-Status erlauben.
7. Golden Path ab dem verifizierten Freigabekandidaten real weiterbauen:
   `Rechner → Lead → Kontakt → Standort/Adresskorrektur → Energieprofil/Kalkulation → Katalog/Speicher → Produktauflösung →`
   `Angebot → Variante → PDF-Draft → Freigabekandidat → Ausstellung → Signatur → Installation → Rechnung → Kundenportal`.
8. Danach F1–F16 capabilityweise bis VERIFIED schließen.
