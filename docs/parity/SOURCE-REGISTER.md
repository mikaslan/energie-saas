# Paritäts-Quellenregister

Stand: 2026-08-31

Dieses Register klassifiziert Quellen; es ersetzt weder die Clean-Room-Regeln
in `CONTRIBUTING.md` noch eine Capability-Abnahme. Reonic-Quellen dürfen nur
beobachtbare Funktionssemantik belegen. UI, Texte, Assets, Code und Daten werden
nicht übernommen.

## Aktive Quellen für M1-08b, M1-09, M2-01, M2-02, M2-03a und M2-03b1

| ID | Quelle | Klasse | Belegt | Confidence / Grenze |
|---|---|---|---|---|
| `SRC-CONSTITUTION-01` | `CONTRIBUTING.md` | DOCUMENTED | Clean-Room, erlaubte Quellen, verbotene Zugänge | hoch; bindend |
| `SRC-M109-SPEC` | `docs/spec/M1-09-projektzuweisung.md` | DOCUMENTED | eigener Assignment-, External-Sicht-, Rollen-, Race- und Abnahmevertrag | hoch für eigene WMEE-Semantik; lokal technisch verifiziert |
| `SRC-ADR-0014` | `docs/adr/0014-projektzuweisung-und-externe-sicht.md` | DECIDED WMEE | direkte Membership-Zuweisung, separate Capability, restriktive RLS und minimierte External-Sicht | hoch für eigene Architektur; keine private Reonic-Wahrheit |
| `SRC-REONIC-PROJECT-ASSIGNMENTS` | [Project assignments](https://docs.reonic.com/docs/en/settings-company-project-assignments) | DOCUMENTED | öffentlich beschriebene Hauptverantwortung, Nutzer, Teams und zuweisungsabhängige Sicht | hoch für beobachtbare Capability; kein Login, Datenmodell/Limit/Locksemantik unbekannt |
| `SRC-REONIC-LEAD-CHARACTERISTICS` | [Lead characteristics](https://docs.reonic.com/docs/en/leads-overview-lead-characteristics) | DOCUMENTED | mehrere Nutzer, eine aktuelle Hauptverantwortung und eingeschränkte Sicht | hoch für öffentlich beschriebene Semantik; private Details unbekannt |
| `SRC-REONIC-USER-TEAMS` | [Users, roles, licenses, and teams](https://docs.reonic.com/docs/en/settings-company-user-teams) | DOCUMENTED | getrenntes Zuweisungsrecht und zuweisungsgebundene eingeschränkte Nutzer | hoch; Teams/Vererbung bleiben außerhalb M1-09 |
| `SRC-BLUEPRINT-F2` | `docs/blaupause/01-modulkatalog.md`, F2.1–F2.4 und F2.7 | INFERRED / sekundär synthetisiert | Arbeits-Hypothesen zu Offer, Varianten, BOM, Rabattstack und PDF als Capability | mittel; keine Primärevidenz und keine Layoutvorlage, Claims müssen an öffentliche Doku/Vault gebunden bleiben |
| `SRC-M108-01` | `docs/spec/M1-08-produktkatalog-projektaufloesung.md` und ADR 0008 | DOCUMENTED | immutable Katalog-/Preissnapshots, EK-Grenze, Current/Stale | hoch; lokal verifiziert |
| `SRC-M108B-SPEC` | `docs/spec/M1-08b-katalog-csv-import.md` | DOCUMENTED WMEE | eigener autorisierter CSV-Vertrag, Mapping, Preview, Zeilenvalidierung, Rechte, Zustände, Retention und Abnahme | hoch für den eigenen lokal verifizierten Vertrag; keine Reonic- oder Lieferantenimport-Evidenz |
| `SRC-ADR-0013` | `docs/adr/0013-katalog-csv-import-worker.md` | DECIDED WMEE | persistierte Preview ohne Rohdatei, ID-only Worker/Queues, maximal 25 Zeilen je Claim, Teilerfolg, Recovery und Due-Redaction | hoch für die eigene Architekturentscheidung; kein produktiver Rollout oder Realimport |
| `SRC-M202-SPEC` | `docs/spec/M2-02-angebots-pdf-entwurf.md` | DOCUMENTED | interner nicht verbindlicher PDF-Draft, exakte Revisionsbindung, minimierter Input, Zustands-/Rollen-/Download-/Testvertrag und harte Nicht-Ziele | hoch für den eigenen WMEE-Vertrag; lokal technisch verifiziert |
| `SRC-ADR-0010` | `docs/adr/0010-pdf-entwurf-worker-und-staging.md` | DECIDED WMEE | isolierter offline/sandboxed Chromium-Worker, gepinntes `linux/amd64`-/Playwright-/OCI-Rezept, tenantgeschütztes Postgres-Staging und spätere separate Object-Lock-Promotion | hoch für die eigene Architekturentscheidung; kein produktiver Deploy-/WORM-Beleg |
| `SRC-M203A-SPEC` | `docs/spec/M2-03a-angebots-freigabekandidat.md` | DOCUMENTED | versioniertes Dokumentprofil, Empfänger-/Rechnungsrevision, Candidate-Readiness, versiegelter Input, Workerzustände, Byte-Approval, Download-/Erasure- und Testvertrag | hoch für den eigenen WMEE-Vertrag; lokal technisch verifiziert, keine Rechts- oder Issuance-Freigabe |
| `SRC-ADR-0011` | `docs/adr/0011-angebots-freigabekandidat.md` | DECIDED WMEE | eigener nicht ausgestellter Candidate-Render, append-only Profile/Recipients/Approvals und zwingend separater M2-03b-Ausstellungsrender | hoch für die eigene Architekturentscheidung; Object Lock, Retention, Ausstellung und Versand nicht ausgeführt |
| `SRC-M203B1-SPEC` | `docs/spec/M2-03b1-angebotsausstellungsfassung.md` | DOCUMENTED | neue finale Bytes aus exakt gebundenem Candidate-Input, Zwei-Personen-Bytefreigabe, terminale Rücknahme, private Reads und maximal `approved_for_archive_not_issued` | hoch für den eigenen WMEE-Vertrag; lokal technisch verifiziert, kein Rechts-, Archiv- oder `issued`-Beleg |
| `SRC-ADR-0012` | `docs/adr/0012-angebotsausstellung-und-archivgate.md` | DECIDED WMEE | getrennte Gates für interne Ausstellungsfassung und spätere reale Object-Lock-Archivierung; `issued` nur nach vollständigem versionsgebundenem Readback | hoch für die eigene Architekturentscheidung; M2-03b2 extern blockiert |
| `SRC-REONIC-CREATE` | [Create an offer](https://docs.reonic.com/docs/en/offers-overview-create-an-offer) | DOCUMENTED | Offer aus Request oder direkt, Workspace-Nummer, Standardvariante | hoch für öffentlich beschriebene Semantik; kein Login |
| `SRC-REONIC-BASIC` | [Offer basic information](https://docs.reonic.com/docs/en/offers-overview-basic-informations) | DOCUMENTED | BOM-Felder, Menge, Preis, Rabatt, VAT, Sektionen | hoch für öffentlich beschriebene Semantik |
| `SRC-REONIC-VARIANTS` | [Variants](https://docs.reonic.com/docs/en/offers-plan-additional-optional-variants) | DOCUMENTED | unabhängige Varianten und Duplizieren | hoch; private Implementierung unbekannt |
| `SRC-REONIC-ADDITIONAL` | [Additional components](https://docs.reonic.com/docs/en/offers-plan-additional-optional-additional-components) | DOCUMENTED | zusätzliche, im Angebotspreis enthaltene Komponenten | hoch |
| `SRC-REONIC-OPTIONAL` | [Optional components](https://docs.reonic.com/docs/en/offers-plan-additional-optional-optional-components) | DOCUMENTED | separat auswählbare optionale Komponenten | hoch; Auswahl selbst ist späterer Signatur-Slice |
| `SRC-REONIC-SECTION-DISCOUNT` | [Discounts per section](https://docs.reonic.com/docs/en/offers-finalise-cat-discounts-per-section) | DOCUMENTED | Sektionsrabatte | hoch; Rundung nicht öffentlich belegt |
| `SRC-REONIC-GLOBAL-DISCOUNT` | [Global discounts](https://docs.reonic.com/docs/en/offers-finalise-cat-global-discounts) | DOCUMENTED | globale Rabatte | hoch; Rundung nicht öffentlich belegt |
| `SRC-REONIC-FINALISE` | [Finalise overview](https://docs.reonic.com/docs/en/offers-finalise-cat-finalise-overview) | DOCUMENTED | Finalisierung als eigener Schritt | hoch für die öffentliche Capability; M2-02 übernimmt daraus weder Layout noch Issuance-/Signatursemantik |
| `SRC-REONIC-PREVIEW` | [Preview an offer and manage link validity](https://docs.reonic.com/docs/en/offers-finalise-cat-preview-variants-legal-texts-offer-link-validity) | DOCUMENTED | öffentlich sichtbare Preview-/Finalise- und Link-Validity-Capability | hoch für diese beobachtbare Capability; kein Beleg für einen WMEE-`issued`-Status, WORM/Object Lock oder private Transaktionsdetails |
| `SRC-REONIC-LIFECYCLE` | [Offer characteristics](https://docs.reonic.com/docs/en/offers-overview-overview-offer-characteristics) | DOCUMENTED | Offer-Lebenszyklus und gesperrter signierter Stand | hoch; Signatur bleibt später |
| `SRC-VAULT-REQ` | eigene WMEE-Strategie-, Rechner- und Feedbacknotizen im Manifest unten | DOCUMENTED | Rechner→Lead→unverbindlicher Angebotsentwurf, menschliche Prüfung, drei Ergebnisrichtungen, Klima-/PV-Ziele | mittel bis hoch; eigene Anforderungen, keine Reonic-Live-Evidenz |
| `SRC-VAULT-INTERVIEW` | Jamie-Meeting und sechs direkt verlinkte Transkripte im Manifest | OBSERVED stakeholder statement | Nutzerwünsche, Reonic-Anwenderaussagen, Text-/Claim-Probleme | mittel; Aussagen nicht als unabhängige Produktbeobachtung ausgeben |
| `SRC-VAULT-BETA` | Design-/Fehlernotizen und zugehörige Transkripte im Manifest | OBSERVED own QA | Rechnerfehler, responsive und Accessibility-Risiken | hoch für geprüfte Beta, keine WMEE-Brandtokens |
| `SRC-VAULT-SESSIONS` | vier historische Session-Markdowns im Manifest | DOCUMENTED / secondary archive | frühere Agent-/Nutzerentscheidungen und Quellenhinweise | niedrig bis mittel; keine Produktbeobachtung, `fc23821a` ist überlappender Frühstand und keine zweite Bestätigung |
| `SRC-NEXT-16-LOCAL` | installierte offizielle Next-16.3.3-Dokumentation in `node_modules/next/dist/docs` | DOCUMENTED | Server-/Client-Grenze, Actions, Forms, Cache, Revalidation, Errors | hoch; exakt installierte Version |
| `SRC-CLAUDE-M201-UI` | lokaler Claude-Code-2.1.251-Leselauf, Modellalias `opus`, Effort `max` | INFERRED / design input | unabhängige UI-/A11y-Gegenprobe für M2-01 | mittel; keine Produktwahrheit, keine Schreibrechte, ausgewählte Punkte bewusst übernommen |
| `SRC-CLAUDE-M202-DESIGN` | lokaler Claude-Code-Opus-Lesereview | INFERRED / design input | unabhängige Gegenprobe für Informationshierarchie, klare Draft-Kennzeichnung und lesbaren A4-Aufbau in M2-02 | mittel; keine Produkt- oder Reonic-Wahrheit, keine Schreibrechte |
| `SRC-CLAUDE-M203A-DESIGN` | finaler lokaler Claude-Code-Lesereview, Modellalias `opus`, Effort `max` | INFERRED / design input | unabhängige Gegenprobe des Profil-/Candidate-Flows, der Landmark-/Fokusführung, Validierungszustände und Statuskommunikation nach A11y-Nacharbeit | mittel; final GO ohne offene P0–P2, aber keine Produkt-, Rechts-, Brand- oder Reonic-Wahrheit und keine Schreibrechte |
| `SRC-CLAUDE-M203B1-DESIGN` | finaler lokaler Claude-Code-Lesereview, Modell `claude-opus-5`, Effort `max` | INFERRED / design input | unabhängige Gegenprobe der Issuance-Informationshierarchie, Label-in-Name-, Fokus-, Fehler-, Reset-, Reflow- und Withdrawal-Nacharbeit | mittel; final GO ohne offene P0–P2, aber keine menschliche Visual-, Produkt-, Rechts-, Brand- oder Reonic-Wahrheit und keine Schreibrechte |

Öffentliche Reonic-Seiten wurden am 2026-08-29, die Preview-/Link-Seite am
2026-08-30 und die drei M1-09-Seiten am 2026-08-31 ohne Account gelesen. Die
Vault-Auswertung war read-only. Keine
Quelle liefert einen autoritativen WMEE-SKU-/Preiskatalog oder exakte private
Reonic-Rundungsregeln.

## Durch Gate 1 freigegebene Eigenentscheidungen

Mikail hat Gate 1 am 30. August 2026 freigegeben. Diese Entscheidungen sind
damit `DECIDED`, bleiben aber eigene WMEE-Produktentscheidungen und werden
nicht als private Reonic-Produktwahrheit ausgegeben.

| ID | Entscheidung | Klasse | Ablage |
|---|---|---|---|
| `DEC-M109-01` | neue Rechner-/manuelle Requests dürfen unzugewiesen mit Revision 0 starten; kein erfundener Default-Owner | DECIDED WMEE | Spec M1-09, ADR 0014 |
| `DEC-M109-02` | M1-09 modelliert nur direkte Memberships; beim KAM-Wechsel bleibt der frühere KAM als `user` erhalten | DECIDED WMEE | Spec M1-09, ADR 0014 |
| `DEC-M109-03` | Zuweisungsmutationen verlangen ein eigenes internal-only `project.assign` und optimistische Revision | DECIDED WMEE | Spec M1-09, ADR 0014, Rollenmatrix |
| `DEC-M109-04` | External sieht ausschließlich direkt zugewiesene `request/open`-Projekte über minimiertes read-only DTO; Offers und Mutationen bleiben gesperrt | DECIDED WMEE | Spec M1-09, ADR 0014 |
| `DEC-M109-05` | Sichtentzug gilt ab der nächsten Transaktion; Membership-Offboarding bleibt bis zur Assignmentbereinigung per FK fail-closed | DECIDED WMEE | Spec M1-09, ADR 0014 |
| `DEC-M201-01` | ein Offer pro Project im v1 | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M108B-01` | CSV-Preview wird persistiert, die Rohdatei selbst nie gespeichert; dieselbe lokale Datei wird für Inspection und Preview erneut übertragen | DECIDED WMEE | Spec M1-08b, ADR 0013 |
| `DEC-M108B-02` | Start verlangt gemeinsam `catalog.manage`, `price.edit`, `price.read_purchase` sowie eine versionierte Rechteattestation | DECIDED WMEE | Spec M1-08b, Rollenmatrix |
| `DEC-M108B-03` | Queue/Worker bleiben ID-only; maximal 25 Zeilen je Lease, Produktmutation und Zeilenergebnis committen gemeinsam | DECIDED WMEE | Spec M1-08b, ADR 0013 |
| `DEC-M108B-04` | create/revise endet immer als Draft, unchanged erzeugt keinen Stand; Aktivierung bleibt getrennte bewusste M1-08-Aktion | DECIDED WMEE | Spec M1-08b, ADR 0013 |
| `DEC-M108B-05` | Preview verfällt nach sieben Tagen; schutzbedürftige Preview-/Commanddaten werden spätestens ab der 30-Tage-Due-Grenze atomar redigiert | DECIDED WMEE | Spec M1-08b, ADR 0013 |
| `DEC-M201-02` | PV-Wohngebäude-Golden-Path zuerst | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-03` | `ANG-{YYYY}-{sequence:6}` als eigener Nummernstandard | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-04` | Cent/Basispunkte/BigInt/half-up/Largest Remainder | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-05` | Required+Additional im Basispreis, Optional separat, Hidden ohne Rechenwirkung | DECIDED WMEE | Spec M2-01 |
| `DEC-M201-06` | 0 % nur operatorbestätigt, nie automatisch inferiert | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-07` | erste Variante heißt `Basis`; alle 1–500 Resolution-Zeilen werden in fester Kategorienreihenfolge vollständig als sichtbare `required`-Positionen ohne Rabatt geseedet | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-08` | M2-01 erlaubt nur ausdrücklich operatorbestätigte B2C-Rechneranfragen; der einzelne Katalog-VK gilt nur in diesem Slice als B2C-Listenpreis | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-09` | jede Steuerwahl/-änderung und neue Basis verlangt `price.edit`; 0 % wird commandgebunden frisch bestätigt | DECIDED WMEE | Spec M2-01, ADR 0009, Rollenmatrix |
| `DEC-M201-10` | Offer kopiert nur Name, primäre E-Mail/E.164-Telefon und sieben bestätigte Anlagenadressfelder; übrige PII und Rechnerpayloads bleiben außen vor | DECIDED WMEE | Spec M2-01, Domain Model |
| `DEC-M201-11` | höchstens 12 Varianten, 500 Zeilen und DB-gebundene 15-Minuten-Mutationsquoten 120/Actor sowie 1200/Workspace | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-12` | vollständige scoped Tokens sowie maskierte Screenshot-Baselines bei 375/390/768/1024/1440/1920; Visual bleibt bis Mikails Freigabe INCONCLUSIVE | DECIDED WMEE / visuelle Baseline ausstehend | Spec M2-01, Goal §13 |
| `DEC-M202-01` | M2-02 erzeugt ausschließlich einen auf jeder Seite als intern, nicht versendet und nicht verbindlich markierten A4-Draft; kein Offer-/Vertragsstatus ändert sich | DECIDED WMEE | Spec M2-02, ADR 0010 |
| `DEC-M202-02` | jeder PDF-Job bindet genau eine immutable Variantenrevision; Datenbank/App-Service leiten einen minimierten kundensicheren Input und kanonischen SHA ab, Client und Queue liefern nur IDs/Revisionserwartung | DECIDED WMEE | Spec M2-02, ADR 0010 |
| `DEC-M202-03` | Zustände sind `queued`, `running`, `retry_wait`, `succeeded`, `failed_final`; Replay repariert denselben fachlichen Dispatch und Lease/CAS schützt Finalisierung und Recovery | DECIDED WMEE | Spec M2-02 |
| `DEC-M202-04` | Produktion bindet das Renderer-Rezept an `linux/amd64`, Playwright 1.62.1 und vollständigen OCI-Child-Digest; offline/sandboxed Chromium erhält keine Worker-Secrets und jeder Plattform-/Rezeptwechsel erzeugt einen neuen Job | DECIDED WMEE | Spec M2-02, ADR 0010 |
| `DEC-M202-05` | erfolgreiche Draft-Bytes bis 8 MiB werden mit MIME, Länge und SHA-256 immutable in Tenant-Postgres gestaged und über einen reautorisierten privaten Download ausgeliefert; kein Object-Lock-/WORM-Claim | DECIDED WMEE | Spec M2-02, ADR 0010 |
| `DEC-M202-06` | Viewer darf Status lesen und erfolgreiche Drafts herunterladen; Editor/Admin darf mit `project.write` anfordern/replayen; External nie; `app_worker` nur least-privilege claimen/finalisieren | DECIDED WMEE | Spec M2-02, Rollenmatrix |
| `DEC-M202-07` | M2-02 besitzt bewusst kein eigenes Rollout-Flag; vorhandene Flags können fehlende Membership, Rolle oder Einzelrechte nicht ersetzen | DECIDED WMEE | Spec M2-02, Rollenmatrix |
| `DEC-M202-08` | Hidden-Zeilen bleiben im rein internen Draft arithmetisch transparent und werden ausdrücklich als intern ausgeblendet markiert; ein späteres Kundendokument braucht erst einen geschlossenen Aggregationsvertrag | DECIDED WMEE | Spec M2-02 |
| `DEC-M202-09` | Technische Portal-/PDF-Prüfungen schließen das menschliche Visual-Gate nicht; `M202-VISUAL-01` bleibt bis zur Baseline-Freigabe `INCONCLUSIVE` | DECIDED WMEE / visuelle Baseline ausstehend | Spec M2-02 |
| `DEC-M203A-01` | genau ein stabiler Workspace-Dokumentprofil-Head mit append-only Revisionen und getrennten Aktivierungen; keine erfundenen Firmen-/Rechtstextdefaults | DECIDED WMEE | Spec M2-03a, ADR 0011 |
| `DEC-M203A-02` | Empfänger-/Rechnungsdaten bilden einen bestätigten append-only Offer-Stand und werden nie still aus dem Anlagenstandort abgeleitet | DECIDED WMEE | Spec M2-03a, ADR 0011 |
| `DEC-M203A-03` | Candidate-Prepare bindet exakt aktuelle Variante, validen M2-02-Draft, aktive Profilrevision, aktuelle Empfängerrevision und 1–60 Tage Gültigkeit; Hidden-Zeilen blockieren | DECIDED WMEE | Spec M2-03a, ADR 0011 |
| `DEC-M203A-04` | eigenes minimiertes `offer-release-candidate-input.v1`; Queue/Worker transportieren nur IDs und laden alle Inhalte unter Tenantkontext neu | DECIDED WMEE | Spec M2-03a, ADR 0011 |
| `DEC-M203A-05` | echte Candidate-Bytes werden separat über feste menschliche Attestations rehashgebunden; Ergebnis ist ausschließlich `approved_not_issued` | DECIDED WMEE | Spec M2-03a, ADR 0011 |
| `DEC-M203A-06` | Selbstfreigabe ist im nicht ausgestellten Candidate-Slice technisch zulässig; M2-03b1 verlangt für die neuen Issuance-Bytes zwei verschiedene Freigeber und mindestens eine vom Candidate-Freigeber verschiedene Person | DECIDED WMEE / in M2-03b1 verifiziert | Spec M2-03a, Spec M2-03b1, ADR 0011/0012 |
| `DEC-M203A-07` | unfreigegebene Bytes sind nur für Approver sichtbar, freigegebene Bytes für interne Nutzer mit `project.read`; External bleibt fail-closed | DECIDED WMEE | Spec M2-03a, Rollenmatrix |
| `DEC-M203A-08` | M2-03b darf Candidate-Bytes mit sichtbarem `nicht ausgestellt` nie umetikettieren; M2-03b1 erzeugt und prüft neue Bytes, M2-03b2 darf `issued` erst nach vollständigem Object-Lock-Readback erzeugen | DECIDED WMEE / M2-03b1 verifiziert, M2-03b2 offen | Spec M2-03a/M2-03b1, ADR 0011/0012 |
| `DEC-M203B1-01` | die finale Ausstellungsfassung ist eine neue Bytefolge aus dem versiegelten Candidate-Input; Candidate-Bytes werden nie promotet | DECIDED WMEE | Spec M2-03b1, ADR 0012 |
| `DEC-M203B1-02` | Reservation und Issuance-Input binden Candidate, Approval, echte Bytes sowie alle fachlichen Quellen und Rezeptversionen exakt | DECIDED WMEE | Spec M2-03b1, ADR 0012 |
| `DEC-M203B1-03` | Queue-Payload und Dispatch bleiben ID-only; der Worker lädt den versiegelten Input unter Tenantkontext, finale Bytes werden bis M2-03b2 tenantgeschützt und löschbar in Postgres gestaged | DECIDED WMEE | Spec M2-03b1, ADR 0012 |
| `DEC-M203B1-04` | finale PDF-Bytes enthalten keine Candidate-, Entwurfs- oder „nicht ausgestellt“-Marker; die interne UI trägt den noch-nicht-ausgestellt-Status | DECIDED WMEE | Spec M2-03b1, ADR 0012 |
| `DEC-M203B1-05` | zwei verschiedene aktive interne Actors geben exakt dieselben Bytes frei; mindestens einer unterscheidet sich vom Candidate-Freigeber | DECIDED WMEE | Spec M2-03b1, ADR 0012 |
| `DEC-M203B1-06` | Withdrawal ist append-only und terminal; Replay reaktiviert nicht, eine Korrektur braucht neuen Candidate und neue Issuance | DECIDED WMEE | Spec M2-03b1, ADR 0012 |
| `DEC-M203B1-07` | private Bytes besitzen gestufte Leserechte: vor 2/2 nur Approver, nach 2/2 interne Nutzer mit `project.read`; jeder GET reautorisiert und rehasht, nach Withdrawal ist jeder Artefaktdownload gesperrt | DECIDED WMEE | Spec M2-03b1, Rollenmatrix |
| `DEC-M203B1-08` | maximaler Zustand ist `approved_for_archive_not_issued`; M2-03b1 besitzt keine Kante zu `issued` | DECIDED WMEE | Spec M2-03b1, ADR 0012 |
| `DEC-M203B1-09` | M2-03b2 darf erst nach echtem Object-Lock-COMPLIANCE-, Retention-, Version- und Hash-Readback umgesetzt beziehungsweise verifiziert werden | DECIDED WMEE / extern blockiert | ADR 0012 |

## Vollständig gelesenes Vault-Manifest

Basis: `/Users/mikail/Downloads/OBSIDIAN/ASLAN FINAL/`.

| Nr. | Relativer Pfad | Klasse / Verwendung |
|---:|---|---|
| 1 | `Wo alles liegt.md` | DOCUMENTED, reine Vault-Navigation |
| 2 | `_START.md` | DOCUMENTED, Vault-Kontext |
| 3 | `20-Bereiche/D-Wmee/_index.md` | DOCUMENTED, Bereichskontext |
| 4 | `20-Bereiche/D-Wmee/Eigener PV-Rechner als Rionic-Alternative Prototyp mit drei Versionen.md` | DOCUMENTED, eigene Rechner-/Prozessanforderung |
| 5 | `20-Bereiche/D-Wmee/Eigener Solarrechner gebaut, reonic zurück auf Produktion, Beta isoliert live.md` | DOCUMENTED / OBSERVED own QA |
| 6 | `20-Bereiche/D-Wmee/Design-Review des Solarrechner-Beta neue Befunde dokumentiert.md` | OBSERVED own QA; keine Brandtokens |
| 7 | `20-Bereiche/D-Wmee/Daniel gibt Feedback zum PV-Rechner Fehler und Anpassungen nötig.md` | OBSERVED stakeholder statement |
| 8 | `20-Bereiche/D-Wmee/Klimaanlagen-Vertrieb ausgebaut, All-in-One-Energierechner geplant.md` | DOCUMENTED, eigene Produktabsicht |
| 9 | `20-Bereiche/D-Wmee/Klimaanlagen-Standbein bei WME startet, KI-Wissensdatenbank geplant.md` | DOCUMENTED, eigene Produktabsicht |
| 10 | `20-Bereiche/D-Wmee/Strategie für Dennis-Partnerschaft Rechner als Köder, Reolink nachbauen.md` | DOCUMENTED, eigene Strategie; keine Reonic-Primärevidenz |
| 11 | `20-Bereiche/D-Wmee/WMEE baut Klimaanlagen-Sparte aus und koppelt sie an PV.md` | DOCUMENTED, eigene Produktabsicht |
| 12 | `Jamie/Meetings/2026-08-26 Optimierung PV-Rechner Rionic-Alternative.md` | DOCUMENTED Meetingzusammenfassung / OBSERVED Aussagen |
| 13 | `00-Inbox/Sessions/Mitschrift/2026-08-28-fc23821a.md` | DOCUMENTED / secondary archive; überlappender Frühstand von Nr. 14 |
| 14 | `00-Inbox/Sessions/Mitschrift/2026-08-28-4e1cc9a9.md` | DOCUMENTED / secondary archive; maßgeblicherer Vollstand |
| 15 | `00-Inbox/Sessions/Mitschrift/2026-08-27-b557f3c7.md` | DOCUMENTED / secondary archive |
| 16 | `00-Inbox/Sessions/Mitschrift/2026-08-27-81f346a3.md` | DOCUMENTED / secondary archive |
| 17 | `40-Ressourcen/Automatik/setup/MacStudio-von-Mikail/gedaechtnis/-Users-mikailaslan/lod2-bw-live-abrufbar.md` | DOCUMENTED internal technical note |
| 18 | `40-Ressourcen/Automatik/setup/MacStudio-von-Mikail/gedaechtnis/-Users-mikailaslan/wmee-rechner-varianten.md` | DOCUMENTED internal technical note |
| 19 | `Jamie/Transcripts/2026-08-26 Optimierung PV-Rechner Rionic-Alternative (transcript).md` | OBSERVED stakeholder statements |
| 20 | `Jamie/Transcripts/2026-08-26 Solarrechner Feedback und Optimierung (transcript).md` | OBSERVED stakeholder statements |
| 21 | `Jamie/Transcripts/2026-08-24 Vertriebsstrategie Klimaanlagen und Solarrechner (transcript).md` | OBSERVED stakeholder statements |
| 22 | `Jamie/Transcripts/2026-08-22 Geschäftsausbau Klimaanlagen & KI-Automatisierung (transcript).md` | OBSERVED stakeholder statements |
| 23 | `Jamie/Transcripts/2026-08-26 Photovoltaik-Geschäftsmodell KI-Strategie mit Dennis (transcript).md` | OBSERVED stakeholder statements |
| 24 | `Jamie/Transcripts/2026-08-26 Strategie für Photovoltaik und Klimatechnik (transcript).md` | OBSERVED stakeholder statements |

Alle 24 Dateien existierten und wurden am 2026-08-29 read-only vollständig
ausgewertet. Nicht sichtbare Roharchive, verschlüsselte Denkblöcke und Anhänge
außerhalb des Goal-Manifests wurden nicht als gelesen oder belegt ausgegeben.

## Nicht zulässige Quellen

- Reonic-Test-, Demo-, Kunden- oder Mitarbeiterzugänge;
- interne Reonic-APIs, Browserstorage oder Netzwerkverkehr hinter Login;
- kopierte Reonic-Texte, Screens, UI-Assets, Komponenten- oder Preisdaten;
- historische Klartext-Credentials aus Mitschriften;
- Rechner-`market_estimate` als Produkt- oder Angebotspreis.
