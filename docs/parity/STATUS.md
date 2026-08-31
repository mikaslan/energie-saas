# Reonic-Parität — belastbarer Liefer- und Fortschrittsstand

Stand: 2026-08-31 · kanonische Abnahmequelle:
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
| Gesamtmission einschließlich F1–F16 | ca. 21–22 % | Fundament sowie Rechner→Lead→Adresse→Planung→eigener Katalog einschließlich autorisiertem CSV-Massenweg→Produktauflösung→direkte Projektzuweisung→Angebotsentwurf→interner PDF-Draft→Freigabekandidat→neue finale Ausstellungsfassung mit zwei bytegebundenen Freigaben sind lokal technisch verifiziert. Der Maximalstand heißt ausdrücklich `approved_for_archive_not_issued`; Archivierung, Ausstellung, Versand, Signatur und operative Breite bleiben offen |
| Technisches Fundament M0/M1 plus lokale M2-Basis | ca. 96–98 % | Auth-, Tenant-, DB-, Worker-, Intake-, Rechen-, Katalog-, Angebots-, Candidate-, Issuance-Vorbereitungs- und geschützte Webgrenzen sind lokal weitgehend real. Die hohe Zahl beschreibt das Fundament, nicht die Produktbreite; Object Lock, Retention, Provider-Readback und weitere externe Gates bleiben offen |
| Nutzerseitige F1–F16-Funktionsparität | ca. 14–16 % | Login, Intake-Triage, Projektakte, Adresse, Energieprofil, Planungsschätzung, eigener Katalog mit CSV-Vorschau/-Import, Produktzuordnung, direkte Haupt-/Nutzerzuweisung samt minimierter externer Request-Sicht, Angebotsentwurf mit Varianten/BOM, PDF-Draft, Freigabekandidat sowie private finale Ausstellungsfassung inklusive 0/2→1/2→2/2 und terminaler Rücknahme sind lokal real; sie ist noch nicht ausgestellt. Ausführung, Abrechnung und die meisten F1–F16-Flows bleiben offen |

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
| M1-08b autorisierter Katalog-CSV-Import | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO | Persistierte Vorschau ohne Katalogmutation, explizites Mapping und Rechteattestation, create/revise/unchanged, ID-only-Worker in maximal 25 Zeilen je Claim, Teilerfolg/Fehlerreport, Replay/Recovery/Redaction sowie Aktivierung→Projektauflösung→neue immutable Angebots-BOM sind lokal real. `npm run check` ist mit 144/144 Testdateien, 1.371 bestanden/1 opt-in übersprungen, 88/88 Rollen- plus 5/5 PG18-Proben grün; Chromium 24 bestanden/1 opt-in übersprungen, Production-Build und unabhängiges P0–P2-Review ebenfalls grün. Reale Produktdateien, Lieferantenfeeds, Assets und produktiver Worker-Deploy bleiben getrennte Gates |
| M1-09 Projektzuweisung/zugewiesene Request-Sicht | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE 2 GO | Direkte `0..1`-Hauptverantwortung, weitere Personen, eigenes `project.assign`, optimistische Revisionen, race-sichere Lockreihenfolge, restriktive RLS und minimierte read-only External-Sicht auf direkt zugewiesene offene Requests. 132/132 Vitest-Dateien mit 1.245 bestandenen und 1 opt-in übersprungenen Test, 88/88 Rollen- plus 5/5 PG18-Proben, Chromium 20 bestanden/1 opt-in übersprungen, Build/Lint/Typecheck/Dependency-Cruiser und zwei unabhängige Abschlussreviews grün. Teams, Auto-Routing und External-Schreiben bleiben offen |
| M2-01 Angebotsvarianten/Snapshot-BOM | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE 2 GO | Anfrage→Offer, Nummer, Basis-/Duplikat-/neue-Basis-Varianten, immutable Snapshot-BOM, serverseitige Geldlogik, RBAC/Privacy/Races und der geschützte Editor sind technisch abgenommen: 87/87 Testdateien, 856 bestandene Tests plus 1 ausdrücklich opt-in übersprungener Test, 88/88 Rollen- und 5/5 PG18-Proben, Chromium 16/16 (15 funktional/A11y plus 1 Visual-Capture mit 26/26 Kandidaten) und keine offenen Produkt-P0–P2. Das Candidate-Capture ist grün; `M201-VISUAL-01` bleibt ohne Mikails Screenshot-Baseline-Freigabe ausdrücklich INCONCLUSIVE |
| M2-02 interner Angebots-PDF-Entwurf | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO | Exakt eine immutable Variantenrevision wird serverseitig in einen minimierten, gehashten Input gebunden; der ID-only-Job durchläuft `queued`/`running`/`retry_wait`/`succeeded`/`failed_final`, wird mit offline/sandboxed Chromium unter einem auf `linux/amd64`, Playwright 1.62.1 und OCI-Digest gepinnten Rezept gerendert, bis 8 MiB tenantgeschützt in Postgres gestaged und nach Reauth privat heruntergeladen. Viewer darf lesen/downloaden, Editor/Admin mit `project.write` anfordern/replayen, External nie und `app_worker` nur least-privilege claimen/finalisieren. 96/96 Vitest-Dateien mit 949 bestandenen Tests, 88/88 Rollen- plus 5/5 PG18-Proben, 16/16 aktive Chromium-E2E, gepinnter Container-Smoke und unabhängiges P0–P2-Review sind grün. Kein Rollout-Flag by design; kein `issued`, Versand, Signatur, öffentlicher Link, Rechnung, WORM oder produktiver Deploy. `M202-VISUAL-01` bleibt menschlich `INCONCLUSIVE` |
| M2-03a Angebotsprofil/Freigabekandidat | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO | Versionierte und aktivierte Dokumentprofile, append-only Empfänger-/Rechnungsstände, strikte Readiness, versiegelter Candidate-Input, ID-only-Worker, Byte-/Hash-Prüfung, append-only Abschlussfreigabe und privater Download bis zum abgeleiteten Zustand `approved_not_issued` sind lokal real. 111/111 Vitest-Dateien mit 1.078 bestandenen und 1 übersprungenen Test, 17 bestandene plus 1 opt-in übersprungene Chromium-E2E, 88/88 Rollen- plus 5/5 PG18-Proben, Build/Lint/Typecheck/Dependency-Cruiser, gepinnter `linux/amd64`-Container-Smoke mit Status auf 11/11 PDF-Seiten sowie Security-, Regression-, Navigation- und lokaler Claude-Code-Opus-Max-Review sind grün und ohne offene P0–P2. Die E2E-Kette synthetisiert Claim/Finalize in der DB; der echte Renderer ist separat im Container belegt. Menschliches Visual bleibt `INCONCLUSIVE`; Deploy, echte Rechtstexte, WORM/Object Lock, Ausstellung, Versand und Signatur sind `NOT RUN` beziehungsweise offen |
| M2-03b1 Angebots-Ausstellungsfassung | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO | Aus dem exakt freigegebenen Candidate-Input entstehen neue finale PDF-Bytes; Candidate-Bytes werden nie promotet. Zwei verschiedene aktive interne Personen geben exakt diese Bytes frei, mindestens eine verschieden vom Candidate-Approver. Private Downloads, 0/2→1/2→2/2 und terminale Rücknahme sind real; der Maximalstand bleibt `approved_for_archive_not_issued`. 126/126 Vitest-Dateien mit 1.184 bestandenen und 1 übersprungenen Test, 88/88 Rollen- plus 5/5 PG18-Proben, Chromium 17 bestanden plus 1 opt-in übersprungen, Build/Lint/Typecheck/Dependency-Cruiser sowie deterministischer 11-seitiger Container-Render sind grün. Code-, Security- und Claude-Code-Opus-5-Max-Review: GO ohne offene P0–P2. Human Visual bleibt `INCONCLUSIVE`; Object Lock, Archivevidence, `issued`, Versand und Signatur sind nicht geliefert |
| Rechner V3 | CONTRACTED (Clone) / BLOCKED (Provider) | read-only Baseline `rechner/v3@2b00f6b`; Provider-Wiring erst nach veröffentlichtem korrektem Datenschutzhinweis und Secret-Provisioning |

## F1–F16-Matrix auf Capability-Ebene

Der Modulkatalog ist vollständig spezifiziert. Die folgende Matrix behauptet bewusst
keine Implementierung aufgrund bloßer Infrastrukturarbeit.

| Bereich | Höchster belastbarer Stand | Nächster echte Slice |
|---|---|---|
| F1 CRM & Leads | PARTIAL VERIFIED | Rechner-V3-Intake → Kontakt → Standort/Adresskorrektur → Anfrage → Kanban/Projektakte → Energieprofil → direkte Projektzuweisung mit minimierter External-Sicht ist lokal real; als Nächstes Teams, Auto-Routing, Aufgaben, Notizen, Termine und weitere CRM-Capabilities |
| F2 Angebote | PARTIAL VERIFIED | M1-08 liefert verifizierte Produkt-/Preissnapshots; M1-08b belegt deren CSV-Massenweg bis zu einer neuen immutable Basis-BOM; M2-01 Draft-Offers, Varianten und Snapshot-BOM; M2-02 den geschützten internen PDF-Draft; M2-03a Profil, Empfänger und `approved_not_issued`. M2-03b1 rendert daraus neue finale Bytes, bindet zwei verschiedene Approver und bildet 0/2→1/2→2/2 sowie terminale Rücknahme ab. Der Zustand bleibt `approved_for_archive_not_issued`; menschliches Visual, echte Rechtstexte, Object Lock/Archivevidence, `issued`, Versand und Signatur folgen in getrennten Gates |
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
| F16 Katalog/Vorlagen | PARTIAL VERIFIED | M1-08a: eigener Katalog, sieben Produkttypen, Preise/Provenienz, Lifecycle und Projektauflösung lokal real. M1-08b ergänzt den autorisierten CSV-Massenweg mit Preview, Mapping, Teilerfolg, Recovery und getrenntem Aktivierungsschritt. M2-03a ergänzt versionierte Dokumentprofile, M2-03b1 eine eigene finale PDF-Informationsarchitektur. Echte WMEE-Produkte, Brand-/Human-Visual-Freigabe, Assets und Lieferantenfeeds folgen getrennt |

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
6. `M203B1-VISUAL-01` bis zur menschlichen Portal-/PDF-Baseline getrennt
   `INCONCLUSIVE` lassen; technisches GO nicht als Rechts-, Brand- oder
   Reonic-Innenfreigabe umdeuten.
7. M1-08b nur mit einer real autorisierten Produktdatei und dokumentierter
   Rechtekette pilotieren; Lieferantenfeed, Asset-Storage und produktiver
   Worker-Rollout bleiben eigene externe Gates.
8. M2-03b2 erst nach echtem Object-Lock-COMPLIANCE-, Retention-, Version- und
   Hash-Readback-Gate bauen; bis dahin bleiben Archivevidence und `issued`
   `BLOCKED`.
9. Golden Path ab der lokal realen, aber noch nicht ausgestellten
   Ausstellungsfassung weiterbauen:
   `Rechner → Lead → Kontakt → Standort/Adresskorrektur → Energieprofil/Kalkulation → Katalog/Speicher → Produktauflösung → direkte Projektzuweisung →`
   `Angebot → Variante → PDF-Draft → Freigabekandidat → Ausstellungsfassung freigegeben · noch nicht ausgestellt → Archivierung → issued → Signatur → Installation → Rechnung → Kundenportal`.
10. Danach F1–F16 capabilityweise bis VERIFIED schließen.
