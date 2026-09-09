# Reonic-Parität — belastbarer Liefer- und Fortschrittsstand

Stand: 2026-09-06 · kanonische Abnahmequelle:
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
| Gesamtmission einschließlich F1–F16 | ca. 38 % **(ESTIMATE)** | Mehrere belastbare vertikale Slices reichen inzwischen von CRM/Lead über Angebot, Planungsmodus und Simulationseinstellungen bis Installation, Zeiterfassung, Rechnungs-Kern, Portal-Skeleton und Vorlagen. Die Schätzung ist keine Abnahmequote: Kein F1–F16-Bereich und erst recht nicht die Gesamtmission ist bereits vollständig 1:1 zu Reonic |
| Technisches Fundament M0/M1 plus lokale M2/M3-Basis | lokal weit fortgeschritten | Auth-, Tenant-, DB-, Worker-, Intake-, Rechen-, Katalog-, Task-/Aktivitäts-, Angebots-, Signatur- und Rechnungsgrenzen sind in überprüften Teilslices real. Produktbreite, rechtmäßige Live-Referenznachweise sowie Object Lock, Retention, Provider-Readback und weitere externe Gates bleiben davon unberührt |
| Nutzerseitige F1–F16-Funktionsparität | **PARTIAL** | Die unten aufgeführten Bereiche sind nur capabilityweise eröffnet. Nicht genannte Details aus dem Modulkatalog bleiben offen; Seiten, Skeletons, Specs oder lokale Infrastruktur werden nicht zu vollständiger Bereichsparität hochgerechnet |

Diese Werte steigen nicht durch Seiten, Mocks oder Dokumentation allein, sondern nur
durch belastbare vertikale Endzustände. Die Schätzung ist insbesondere **keine**
Behauptung einer Reonic-1:1-Parität.

## Aktuelle lokale Gatebasis

Der Arbeitsstand vom 2026-09-06 ist lokal mit **240/240 Testdateien**
(**2.179 bestanden, 1 ausdrücklich übersprungen**), **88/88 Rollenproben**,
**5/5 PG18-Proben**, grünem Production-Build und **113 bestandenen plus 1
ausdrücklich übersprungenen Chromium-E2E** belegt. Das ist weder ein
Provider-/Deploy-Nachweis noch eine Aussage über fremde oder noch laufende CI.

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
| M1-08b autorisierter Katalog-CSV-Import | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO | Persistierte Vorschau ohne Katalogmutation, explizites Mapping und Rechteattestation, create/revise/unchanged, ID-only-Worker in maximal 25 Zeilen je Claim, Teilerfolg/Fehlerreport, Replay/Recovery/Redaction sowie Aktivierung→Projektauflösung→neue immutable Angebots-BOM sind lokal real. Feature-Commit `d632f3d`; in der gemeinsamen Folge über `bdaf952` und `e631814` integriert. Reale Produktdateien, Lieferantenfeeds, Assets und produktiver Worker-Deploy bleiben getrennte Gates |
| M1-09 Projektzuweisung/zugewiesene Request-Sicht | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE 2 GO | Direkte `0..1`-Hauptverantwortung, weitere Personen, eigenes `project.assign`, optimistische Revisionen, race-sichere Lockreihenfolge, restriktive RLS und minimierte read-only External-Sicht auf direkt zugewiesene offene Requests. Feature-Commit `af8f297`; kombiniert mit M1-08b in `e631814`. Teams, Auto-Routing und External-Schreiben bleiben offen |
| M1-08b → M1-09 Integrationsgate | REVIEWED/VERIFIED (lokal) · GO | Migrationsfolge `0035 → 0036 → 0037`, 51 Tabellen ohne Generator-Drift, 150/150 Testdateien mit 1.432 bestandenen und 1 opt-in übersprungenen Test, 88/88 Rollen- plus 5/5 PG18-Proben, Dependency-Cruiser 282/975, Production-Build sowie Chromium 27 bestanden/1 opt-in übersprungen. Drei unabhängige Abschlussreviews melden keine offenen P0–P2. Integrationscommit `e631814`; Push/Deploy weiterhin nicht ausgeführt |
| M1-10 Projektaufgaben/interne Projektaktivität | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE 2 GO | Quick-/Full-Create, sichere Rich-Text-Beschreibung, Fälligkeit, interne Assignees, task-eigene Labels und Checkliste, CAS-Edit, Complete/Reopen, einwegiges Archive und redigierte Projektaktivität sind in der internen Projektakte real. External bleibt vollständig fail-closed. `npm run check`: 157/157 Dateien, 1.528 bestanden/1 opt-in übersprungen; Rollen 88/88 plus PG18 5/5; Dependency-Cruiser 296/1.026; Build und 55-Tabellen-Generator grün; Chromium 32 bestanden/1 opt-in übersprungen, davon M1-10 5/5. Unabhängige Reviews: keine offenen P0–P2; kein Push/Deploy |
| M1-11a Projektergebnis/Verlustgründe | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE 2 GO | Interne Editor/Admin schließen Requests revisionssicher als Won/Lost und öffnen sie wieder; Lost verlangt einen aktiven administrierbaren Workspace-Grund. Offene Pipeline und stabil paginierte geschlossene Liste bleiben getrennt, Viewer read-only, External/Worker/revoked/cross-tenant fail-closed. `npm run check`: 166/166 Dateien, 1.608 bestanden/1 opt-in übersprungen; Rollen 88/88 plus PG18 5/5; Dependency-Cruiser 305/1.077; Build und 56-Tabellen-Generator grün; fokussiert 86/86, Strict-Runtime 3/3, Chromium 4/4. Keine offenen P0–P2; kein Push/Deploy |
| M1-12a globale Aufgaben-Inbox | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO | Projektübergreifende, ausschließlich interne read-only Projektion über bestehende aktive `project_task`-Aggregate: geschlossene Scope-/Status-/Fälligkeitsfilter, NFKC-kanonisierte Suche über Titel und sicher extrahierten Beschreibungstext, vollständig gebundener Keysetcursor und minimiertes DTO. Kein zweiter Aggregate- oder Mutationstyp; jede Mutation bleibt in der Projektakte. `npm run check`: 171/171 Dateien, 1.701 bestanden/1 opt-in übersprungen; Rollen 88/88 plus PG18 5/5; Dependency-Cruiser 311/1.096; Build und Generator ohne Drift; Chromium 44 bestanden/1 opt-in übersprungen, davon M1-12a 8/8; fokussiert 93/93. Ein P0 (nicht idempotentes Queryschema) und acht weitere Defekte wurden vor der Abnahme geschlossen. Kein Push/Deploy; `M112A-VISUAL-01` bleibt INCONCLUSIVE, Indexbedarf als `M112A-PERF-01` benannt |
| M2-01 Angebotsvarianten/Snapshot-BOM | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE 2 GO | Anfrage→Offer, Nummer, Basis-/Duplikat-/neue-Basis-Varianten, immutable Snapshot-BOM, serverseitige Geldlogik, RBAC/Privacy/Races und der geschützte Editor sind technisch abgenommen: 87/87 Testdateien, 856 bestandene Tests plus 1 ausdrücklich opt-in übersprungener Test, 88/88 Rollen- und 5/5 PG18-Proben, Chromium 16/16 (15 funktional/A11y plus 1 Visual-Capture mit 26/26 Kandidaten) und keine offenen Produkt-P0–P2. Das Candidate-Capture ist grün; `M201-VISUAL-01` bleibt ohne Mikails Screenshot-Baseline-Freigabe ausdrücklich INCONCLUSIVE |
| M2-02 interner Angebots-PDF-Entwurf | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO | Exakt eine immutable Variantenrevision wird serverseitig in einen minimierten, gehashten Input gebunden; der ID-only-Job durchläuft `queued`/`running`/`retry_wait`/`succeeded`/`failed_final`, wird mit offline/sandboxed Chromium unter einem auf `linux/amd64`, Playwright 1.62.1 und OCI-Digest gepinnten Rezept gerendert, bis 8 MiB tenantgeschützt in Postgres gestaged und nach Reauth privat heruntergeladen. Viewer darf lesen/downloaden, Editor/Admin mit `project.write` anfordern/replayen, External nie und `app_worker` nur least-privilege claimen/finalisieren. 96/96 Vitest-Dateien mit 949 bestandenen Tests, 88/88 Rollen- plus 5/5 PG18-Proben, 16/16 aktive Chromium-E2E, gepinnter Container-Smoke und unabhängiges P0–P2-Review sind grün. Kein Rollout-Flag by design; kein `issued`, Versand, Signatur, öffentlicher Link, Rechnung, WORM oder produktiver Deploy. `M202-VISUAL-01` bleibt menschlich `INCONCLUSIVE` |
| M2-03a Angebotsprofil/Freigabekandidat | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO | Versionierte und aktivierte Dokumentprofile, append-only Empfänger-/Rechnungsstände, strikte Readiness, versiegelter Candidate-Input, ID-only-Worker, Byte-/Hash-Prüfung, append-only Abschlussfreigabe und privater Download bis zum abgeleiteten Zustand `approved_not_issued` sind lokal real. 111/111 Vitest-Dateien mit 1.078 bestandenen und 1 übersprungenen Test, 17 bestandene plus 1 opt-in übersprungene Chromium-E2E, 88/88 Rollen- plus 5/5 PG18-Proben, Build/Lint/Typecheck/Dependency-Cruiser, gepinnter `linux/amd64`-Container-Smoke mit Status auf 11/11 PDF-Seiten sowie Security-, Regression-, Navigation- und lokaler Claude-Code-Opus-Max-Review sind grün und ohne offene P0–P2. Die E2E-Kette synthetisiert Claim/Finalize in der DB; der echte Renderer ist separat im Container belegt. Menschliches Visual bleibt `INCONCLUSIVE`; Deploy, echte Rechtstexte, WORM/Object Lock, Ausstellung, Versand und Signatur sind `NOT RUN` beziehungsweise offen |
| M2-03b1 Angebots-Ausstellungsfassung | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO | Aus dem exakt freigegebenen Candidate-Input entstehen neue finale PDF-Bytes; Candidate-Bytes werden nie promotet. Zwei verschiedene aktive interne Personen geben exakt diese Bytes frei, mindestens eine verschieden vom Candidate-Approver. Private Downloads, 0/2→1/2→2/2 und terminale Rücknahme sind real; der Maximalstand bleibt `approved_for_archive_not_issued`. 126/126 Vitest-Dateien mit 1.184 bestandenen und 1 übersprungenen Test, 88/88 Rollen- plus 5/5 PG18-Proben, Chromium 17 bestanden plus 1 opt-in übersprungen, Build/Lint/Typecheck/Dependency-Cruiser sowie deterministischer 11-seitiger Container-Render sind grün. Code-, Security- und Claude-Code-Opus-5-Max-Review: GO ohne offene P0–P2. Human Visual bleibt `INCONCLUSIVE`; Object Lock, Archivevidence, `issued`, Versand und Signatur sind nicht geliefert |
| F2.8b / M204-I1 Signaturakzeptanz → Won | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO | Digitale und analoge Annahme setzen ein offenes Offer-/Installationsprojekt atomar auf `Won`; exakte Activity-Labels, mehrere Pending-Links, idempotente weitere Annahmen, Kunden-Widerruf mit anschließendem manuellen Lost, unveränderte Signaturakte und keine erfundene Installation sind belegt. Migration `0076` bringt Legacy-Bestand nur mit exakt gebundener Attestierung nach, schneidet ACLs atomar um und schützt gegen halbe Direktpfade, Lock-Deadlocks und zyklische Reopen-Bypässe. `npm run check`: 239/239 Dateien, 2.170 bestanden/1 übersprungen; Rollen 88/88 plus PG18 5/5; Dependency-Cruiser 481/1.847; 89 Tabellen ohne Generator-Drift; Production-Build und Chromium 111 bestanden/1 übersprungen. Unabhängiges Security-/Qualitätsreview: keine offenen P0–P2. Automatische Installation bleibt mangels eindeutiger Live-Evidenz `ESTIMATE`; kein Push/Deploy |
| F3.1 Planungsmodi je Angebotsvariante | REVIEWED/VERIFIED (lokal) | Migration `0075` liefert Workspace-Default sowie `quick`/`2d`/`3d` im Snapshot-v4; v1/v2/v3 bleiben byte-, JSON- und hashstabil und werden nur im RAM als Quick normalisiert. Settings- und Varianten-CAS, Signatur-Content-Lock samt sicheren Unlock-/Fork-Pfaden sowie Quick-PDF-Unterdrückung sind geprüft. Das fokussierte Browser-Gate ist 4/4, der vollständige aktuelle Chromium-Lauf 110 bestanden plus 1 ausdrücklich übersprungen. Die exakte Moduswechselregel bleibt mangels autorisierter Live-Bestätigung `ESTIMATE` |
| F7.4 Segmentabschluss/Admin-Unlock | REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO | Migration `0077` liefert stabile Baum-IDs, mehrere phasenfähige Checklisten, sichtbares Required-Gate, DB-Actor/-Zeit, idempotenten Complete und Admin-only Unlock mit vollständigem Werterhalt. Runtime ist SELECT-only; drei SECURITY-DEFINER-Kapseln, kanonische/wohlgeformte Unicode- und int32-Positionsgrenzen, 500-Knoten-/900-KB-Limit unter einer expliziten 1-MiB-Action-Grenze, O(n)-Identitätsprüfung, verborgene Antworten, Template-Apply-Race sowie vollständige Schema-/ACL-Metadaten sind adversarial geprüft. Gesamtgates: 240/240 Dateien, 2.179 bestanden/1 übersprungen, Rollen 88/88 plus PG18 5/5, 90 Tabellen ohne Drift, Build und Chromium 113 bestanden/1 übersprungen; unabhängiges Review ohne P0–P2. Öffentliche Reonic-Doku/OpenAPI belegen die Semantik; exakte Write-Payloads, Replayantworten und die Schutzlimits bleiben `ESTIMATE`. Kein Push/Deploy |
| Rechner V3 | CONTRACTED (Clone) / BLOCKED (Provider) | read-only Baseline `rechner/v3@2b00f6b`; Provider-Wiring erst nach veröffentlichtem korrektem Datenschutzhinweis und Secret-Provisioning |

## F1–F16-Matrix auf Capability-Ebene

Der Modulkatalog ist vollständig spezifiziert. Die folgende Matrix behauptet bewusst
keine Implementierung aufgrund bloßer Infrastrukturarbeit.

| Bereich | Höchster belastbarer Stand | Belegter Umfang / nächste Lücke |
|---|---|---|
| F1 CRM & Leads | PARTIAL VERIFIED | Rechner-Intake → Kontakt/Standort → Anfrage/Projektakte, Adresskorrektur, Energieprofil, Zuweisung, Aufgaben/Outcomes/Inbox, Projektnotizen, Kontakte und Kalender sind in Teilslices lokal real. F1.8 ergänzt Lead-Source-Stammdaten und Intake-Attribution, F1.09 sichere `@`-Mentions. Teams, vollständiges Auto-Routing, Kommunikations-/Funnelbreite und weitere CRM-Details bleiben offen |
| F2 Angebote | PARTIAL VERIFIED | Produkt-/Preissnapshots, Draft-Offers, Snapshot-BOM, PDF-/Release-Kette und E-Signaturvertrag sind capabilityweise belegt. F2.2 ergänzt Primärvariante, Deal-Override und optionale Bundles; F2.5 providerfreie Zahlarten-Stammdaten samt Variantenwahl. F2.8b koppelt digitale/analoge Annahme atomar an `Won`, bewahrt mehrere Links und Signaturakte und erlaubt nach Kundenwiderruf nur die manuelle Lost-Entscheidung; automatische Installation bleibt als `ESTIMATE` offen. Vollständige Finanzierungs-/Leasing-Providerflüsse, rechtliche/visuelle Freigaben, Object Lock, Versand und übrige Angebotsdetails bleiben getrennte Gates |
| F3 PV-Planung | PARTIAL VERIFIED | F3.1 liefert Workspace-Default und je Variante Quick/2D/3D samt Snapshot-/Lock-Vertrag; die bestehende hausbezogene Planungsschätzung ist lokal real. Dachgeometrie, Belegung, Strings, Verschattung, Photogrammetrie und weitere Planungswerkzeuge bleiben offen |
| F4 Simulation | PARTIAL VERIFIED | F4.6 liefert revisionssichere Workspace-Wirtschaftlichkeitsdefaults mit Länderfallback. F4.1 liefert auf `codex/m1-wave-02` die v2-Viertelstundenkette (Muneer-Transposition nach JRC/Muneer-1990, Fetch→Run→Persist→Finalize→UI für Neuanlage/Bestand/Gewerbe, E2E m1-11g 4/4, CI grün; Belege s. TEST-EVIDENCE F4.1). Offen: F4.2–F4.5 (Wirtschaftlichkeit/Cashflow/Tarife), COP-Kennlinie/WW-Split/Albedo-Eingaben, fachliches Güte-/Haftungsgate, unabhängiges Review, Human Visual, Deploy |
| F5 Wärmepumpe | SPECIFIED | Schätzverfahren klar von zertifizierter Normrechnung trennen |
| F6 Schaltplan | SPECIFIED | eigener Editor-/Exportvertrag |
| F7 Installation | PARTIAL VERIFIED | F7.1 eröffnet den Installationskern mit direkter/signaturbezogener Anlage und Basisstatus; F7.2/F7.3 liefern Checklistenbaum, Template-CRUD und race-sichere Anwendung. F7.4 ergänzt stabile Identitäten, mehrere Container, sichtbares Required-Gate, Segmentabschluss mit DB-Actor/-Zeit sowie Admin-only Unlock mit Werterhalt. Vollständige Typen-/Konditionslogik, Merge/Reset, Disposition, Handover und operative Tabs bleiben offen |
| F8 Rechnungen | PARTIAL VERIFIED | M3-00/M3-01 liefern Workspace-Grundlagen sowie den lokalen Rechnungs-/Dokumentkern. Vollständige Teil-/Abschlags-/Schlussrechnungs-, Storno-, Zahlungs-, DATEV-/E-Rechnungs- und Versandparität bleibt offen |
| F9 Zeiterfassung | PARTIAL VERIFIED | F9.1 liefert Kategorien, manuelle Einträge und Liste/Summe; F9.2 ergänzt die fortbestehende Stoppuhr. Pausen-/Idle-Details, vollständige Auswertung, Freigabe, Mobile-/Offline-Verhalten und übrige Parität bleiben offen |
| F10 Kundenportal | PARTIAL VERIFIED | Das F10.1-Skeleton liefert aktivierbaren Einladungslink, Status und minimierte Dokumentsicht; dies ist keine vollständige Portalabnahme. Weitere Tabs, Dateien/Requests, Uploads, Statusmapping, Sprachen, Commercial-Abweichungen und operative Kundenflüsse bleiben offen |
| F11 Mobile/PWA | SPECIFIED | schmale Offline-Outbox für Fotos/Checklisten/Zeit |
| F12 Lead-Funnel | SPECIFIED | Provideradapter erst nach Privacy-Freigabe anbinden; weitere Funnels capabilityweise bauen |
| F13 Services | SPECIFIED | Filing-Objekt und Statusmaschine, externe Human-Gates ehrlich markieren |
| F14 KI | SPECIFIED | rechtegebundene Tools erst nach realen Domain-Commands |
| F15 Gewerbe | SPECIFIED | getrenntes Commercial-Datenmodell |
| F16 Katalog/Vorlagen | PARTIAL VERIFIED | Eigener Katalog, sieben Produkttypen, Preise/Provenienz, Lifecycle, Projektauflösung und autorisierter CSV-Massenweg sind lokal real. F16.3 A–E ergänzt Rabatt-/Fördervorlagen sowie Prozent-, Fix- und Cap-Anwendung bis Snapshot/PDF. Weitere Vorlagentypen, echte Produkte, Brand-/Human-Visual-Freigabe, Assets und Lieferantenfeeds folgen getrennt |

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
   `Rechner → Lead → Kontakt → Standort/Adresskorrektur → Energieprofil/Kalkulation → Katalog/Speicher → Produktauflösung → direkte Projektzuweisung → interne Projektaufgabe/Aktivität →`
   `Angebot → Variante → PDF-Draft → Freigabekandidat → Ausstellungsfassung freigegeben · noch nicht ausgestellt → Archivierung → issued → Signatur → Installation → Rechnung → Kundenportal`.
10. Danach F1–F16 capabilityweise bis VERIFIED schließen.
