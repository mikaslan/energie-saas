# Domain Model

Stand: 2026-08-31 · M1-08b, M2-01, M2-02, M2-03a und M2-03b1 lokal verifiziert

## Bestehender Spine und neue kommerzielle Grenze

```text
Workspace
 ├─ OfferReleaseProfile (genau ein stabiler Head)
 │    ├─ OfferReleaseProfileRevision (n, append-only)
 │    └─ OfferReleaseProfileActivation (n, append-only)
 ├─ Contact ── Site ── Project
 │                    ├─ Requirement revisions
 │                    ├─ Calculation revisions
 │                    ├─ Catalog resolution revisions
 │                    └─ Offer (max. 1 in v1)
 │                         ├─ immutable B2C qualification
 │                         ├─ minimized Contact/installation-Site context
 │                         ├─ OfferRecipientRevision (n, append-only)
 │                         ├─ OfferVariant (n)
 │                         │    └─ OfferVariantRevision (n, append-only)
 │                         │         ├─ OfferVariantSection (n)
 │                         │         ├─ OfferBOMLine (n)
 │                         │         └─ OfferPdfDraft (n; exakt revisionsgebunden)
 │                         │              ├─ versiegelter kundensicherer Renderinput
 │                         │              └─ optionales erfolgreiches PDF-Artefakt
 │                         └─ OfferReleaseCandidate (n; exakt quellengebunden)
 │                              ├─ versiegelter Candidate-Input
 │                              ├─ optionales PDF-Artefakt
 │                              ├─ optionale OfferReleaseCandidateApproval
 │                              └─ OfferIssuance (n; exakt Candidate-gebunden)
 │                                   ├─ versiegelter Issuance-Input
 │                                   ├─ optionales finales PDF-Artefakt
 │                                   ├─ OfferIssuanceApproval (0..2)
 │                                   └─ optionale OfferIssuanceWithdrawal
 ├─ CatalogComponent
 │    └─ CatalogComponentRevision (n, append-only)
 ├─ CatalogImportJob (n; Preview und asynchroner Lauf)
 │    ├─ CatalogImportRow (1..1000; versiegelter Zeilencommand)
 │    │    └─ optionales CatalogImportRowResult (append-only)
 │    └─ CatalogImportDispatchReceipt (idempotenter Runtime-Dispatch)
 ├─ OfferNumberSeries (per year)
 └─ OfferMutationRateWindow (Actor/Workspace fixed windows)
```

## Aggregate-Verantwortung

| Entität | Identität / Lebensdauer | Wahrheit / Grenze |
|---|---|---|
| `Project` | bestehende Workspace-/Contact-/Site-Bindung | Phase und Boardposition; nicht die Preiswahrheit |
| `ProjectCatalogResolution` | immutable Planungs-/Produktauswahlrevision | zulässige Seed-Quelle, ausdrücklich keine BOM |
| `CatalogImportJob` | stabiler Workspace-Job, unique je Intent-/Datei-/Mapping-Reservation | persistierte Vorschau, Rechteattestation, Counts, geschlossene Zustandsmaschine, Lease/CAS sowie Preview-/Redaction-Due; keine gespeicherte Rohdatei |
| `CatalogImportRow` | genau eine Datenzeile 2..1001 pro Import | unveränderlicher, vollständig validierter create/revise/unchanged-Command samt Datei-/Mapping-/Zeilenhash und versiegeltem Zielstand; freie Quellen werden zur Due-Grenze redigiert |
| `CatalogImportRowResult` | höchstens ein append-only Ergebnis pro Importzeile | Erfolg bindet Component und Revision; Konflikt/Fehler ausschließlich mit stabilen Codes. Produktmutation, Event, Audit und Ergebnis committen gemeinsam |
| `CatalogImportDispatchReceipt` | idempotente Antwort je Runtime-Dispatch | bindet Actor, Intent und Reservation ohne Rohzeile/Preise; verhindert doppelte Preview-/Start-Nebenwirkungen |
| `OfferNumberSeries` | Workspace + Kalenderjahr | race-safe nächste Nummer und Formatversion |
| `Offer` | stabil, im v1 unique pro Project | Nummer, Anlagenart, Draft-Status, Forecast, operatorbestätigtes B2C, exakt erlaubter Contact-/Anlagenstandort-Snapshot und private Quellbindungen an Requirement/Calculation/Resolution samt Revision/Hash; keine Rohpayload-Kopie |
| `OfferVariant` | stabil pro Offer, eindeutige Ordinalzahl | aktueller Revisionszeiger, keine mutable BOM |
| `OfferVariantRevision` | append-only N pro Variant | kanonischer vollständiger kommerzieller Snapshot und Totals |
| `OfferVariantSection` | stabile `section_domain_id`, neue Row-ID je Revision | Mirror von Position, Titel und Sektionsrabatt innerhalb genau einer Revision |
| `OfferBOMLine` | stabile `line_domain_id`, neue Row-ID je Revision | Mirror von Herkunft, Menge, effektivem Preis samt Override-Provenienz, Typ, `is_hidden`, Steuer und Rabatt |
| `OfferPdfDraft` | stabiler fachlicher Job, unique je Workspace + Variante + Revision + Template + Renderer-Rezept | exakte Offer-/Project-/Variantenrevisions-/Snapshotbindung; DB-abgeleiteter minimierter Input samt SHA-256; Zustandsmaschine `queued`/`running`/`retry_wait`/`succeeded`/`failed_final`; bei Erfolg unveränderliche PDF-Bytes, MIME, Bytezahl und Artefakt-SHA bis 8 MiB. Kein ausgestelltes oder signiertes Dokument |
| `OfferReleaseProfile` | genau ein stabiler Head pro Workspace | aktueller Revisionszeiger und optional die exakte aktive Revision/Aktivierung; keine Rechtstexte im Head und keine produktiven Defaults |
| `OfferReleaseProfileRevision` | append-only N pro Profil | kanonischer, gehashter Aussteller-/Rechtstextstand mit Schema-/Canonicalization-Version; keine nachträgliche Mutation |
| `OfferReleaseProfileActivation` | append-only Attestation je aktivierter Profilrevision | bindet `operator_reviewed`, Actor, DB-Zeit, Revision und exakten Snapshot-SHA; interne Betreiberprüfung, keine Rechtswirksamkeitsgarantie |
| `OfferRecipientRevision` | append-only N pro Offer | bestätigter Empfänger, optionale Firma, E-Mail und strukturierte Rechnungsadresse; vollständig vom Anlagenstandort getrennt und gehasht |
| `OfferReleaseCandidate` | stabiler fachlicher Job, unique je Workspace + Reservation-Key | bindet Offer/Project, exakte Variantenrevision, erfolgreichen M2-02-Quelldraft, aktive Profilrevision/-aktivierung, aktuelle Empfängerrevision, Gültigkeitsdatum sowie Input-/Template-/Renderer-Versionen; Zustände `queued`/`running`/`retry_wait`/`ready_for_approval`/`failed_final`; Artefakt bis 8 MiB, Publication-State ausschließlich `not_issued` |
| `OfferReleaseCandidateApproval` | höchstens eine append-only Attestation pro Candidate | bindet tatsächlichen Artifact-SHA und -Länge, Input-, Varianten-, Profil-, Empfänger-, Template- und Rendererstand plus feste menschliche Bestätigungen; erzeugt nur den abgeleiteten Lesestatus `approved_not_issued` |
| `OfferIssuance` | stabiler fachlicher Job, unique je Workspace + vollständigem Reservation-Key | bindet den freigegebenen Candidate, dessen Approval und echte Bytes sowie alle Quell-/Rezeptstände; besitzt einen eigenen versiegelten Input und eine neue finale PDF-Bytefolge. Renderzustände bis `ready_for_approval`; Freigabestatus wird aus Approvals/Withdrawal abgeleitet, maximal `approved_for_archive_not_issued` |
| `OfferIssuanceApproval` | höchstens eine append-only Attestation je Issuance + Actor, maximal zwei wirksame Actors | bindet erneut tatsächliche Issuance-Bytes, Input und alle Quellen samt festen Bestätigungen. Zwei verschiedene aktive Personen sind nötig; mindestens eine ist vom Candidate-Freigeber verschieden |
| `OfferIssuanceWithdrawal` | höchstens eine append-only Attestation pro Issuance | strukturierter sicherer Ursachencode vor Archivierung; leitet terminal `withdrawn_before_archive` ab, mutiert keine Approval und erlaubt keine Reaktivierung |
| `OfferMutationRateWindow` | Workspace + optional Actor + DB-Zeitfenster | atomare 15-Minuten-Zähler für 120 Actor-/1200 Workspace-Versuche; keine Fachdaten |

## Kritische Invarianten

- Jede Tenant-Relation besitzt Workspace-ID, zusammengesetzte FKs und FORCE RLS.
- Ein CSV-Import speichert niemals die Rohdatei. Preview und Zeilencommands
  sind streng begrenzt, gehasht und bis zur Due-Grenze geschützt; danach
  werden Dateiname, SKU, Mapping, Command, versiegeltes Ziel und freie
  Fehlerquellen atomar und idempotent redigiert.
- Jede Importzeile verwendet dieselben Component-/Revision-Seals,
  Sperrordnungen, Append-only- und Event-/Audit-Invarianten wie die manuelle
  Katalogpflege. Runtime und Worker besitzen keine direkten Importtabellen-
  beziehungsweise Worker-Katalog-DML-Rechte, sondern nur benannte enge
  `SECURITY DEFINER`-Gateways.
- Neue und geänderte Importstände bleiben `draft`. Aktivierung,
  Projektauflösung und Angebots-BOM sind getrennte autorisierte Schritte;
  Reimport mutiert keine historische Resolution oder BOM.
- Ein Offer kann niemals Project, Contact, Site oder Resolution eines anderen
  Workspace referenzieren.
- Ein Variantenstand wird nicht aktualisiert; jede Änderung erzeugt N+1.
- Relationale Mirrors und versiegelter Snapshot müssen vollständig und
  hashgleich zusammenpassen; deferred Trigger sperren fehlende, zusätzliche,
  vertauschte oder manipulierte Rows und falsche Revisionszeiger.
- Ein katalogbasierter BOM-Stand bleibt ohne Katalog-Live-Read berechenbar.
- Forecast-Wert und Kundenpreis sind unabhängige Felder.
- B2C wird explizit bestätigt und nicht aus Wohngebäude oder Website inferiert;
  B2B/unklar ist in M2-01 unzulässig.
- Der kopierte Kontaktkontext besteht nur aus `displayName`, `emailPrimary` und
  `phoneE164`; der Anlagenstandort nur aus `addressRevision`, formatierter
  Adresse, Straße, Hausnummer, PLZ, Ort und Land. Andere PII, Geodaten,
  Consent-, Acquisition- und Rechnerfelder werden nicht kopiert.
- Ein Offer hat höchstens zwölf Varianten und jede Variantenrevision höchstens
  500 Zeilen; Revisionen werden nie still beschnitten.
- Ein PDF-Job wird immer an genau eine bereits versiegelte Variantenrevision
  gebunden. Weder Client noch Queue dürfen Renderinhalt oder Hash vorgeben; die
  Datenbank leitet den minimierten Input und dessen kanonischen SHA aus der
  gebundenen Revision ab.
- Quellbindung, Input, Vorbereitungszeit und Rezept eines PDF-Jobs sind
  immutable. Erfolgreiche Artefaktbytes werden atomar mit MIME, Länge und
  SHA-256 gesetzt und danach nicht überschrieben; terminale Jobs werden nicht
  reaktiviert.
- Das Renderer-Rezept bindet die Produktionsplattform `linux/amd64`,
  Playwright 1.62.1 und den vollständigen OCI-Child-Digest. Ein anderer
  Architektur-, Browser- oder Image-Stand ist eine neue Rezeptidentität und
  damit ein neuer fachlicher Job, keine Mutation eines vorhandenen Drafts.
- PDF-Bytes sind tenantgeschütztes, löschbares Draft-Staging in Postgres, kein
  WORM-/Object-Lock-Archiv. Eine aktive Worker-Lease blockiert die Erasure;
  danach löscht der bestehende Offer-Erasuregraph Job und Bytes kaskadierend.
- Eine ausdrückliche Nutzeranforderung bzw. ein autorisierter Replay zählt als
  Offer-Aktivität. Autonome Worker-, Retry- und Recovery-Zeiten verlängern die
  fachliche Inaktivitätsfrist nicht.
- Profilrevisionen sind unveränderlich. Eine Aktivierung bindet genau deren
  kanonischen Hash; Kandidaten dürfen ausschließlich den weiterhin hashvaliden
  aktivierten Stand verwenden. Echte Firmen- und Rechtstexte werden nicht vom
  System erfunden.
- Empfänger-/Rechnungsdaten sind ein eigener bestätigter Offer-Stand. Der
  Anlagenstandort ist keine Rechnungsadress-Vorgabe und wird niemals als
  stiller Fallback kopiert.
- Ein Freigabekandidat bindet exakt eine aktuelle Variantenrevision, einen
  erfolgreichen validen M2-02-Quelldraft, eine Profilaktivierung und die
  aktuelle Empfängerrevision. Hidden-Zeilen, Hashabweichungen oder veraltete
  Quellen blockieren die Erzeugung ohne Teilstand.
- Candidate-Input, Quellbindungen, Publication-State und erfolgreiche
  Artefaktbytes sind unveränderlich. Queue und Worker transportieren nur IDs;
  Inhalte, Zeiten und Hashes werden server- beziehungsweise DB-autoritativ
  geladen und abgeleitet.
- Eine Candidate-Approval-Attestation rehashiert die gespeicherten echten
  Bytes und bindet alle vier fachlichen Bestätigungen sowie gegebenenfalls die
  0-%-Steuerbestätigung. `approved_not_issued` ist daraus abgeleitet, kein
  gespeicherter Issuance- oder Vertragsstatus.
- Unfreigegebene Candidate-Bytes erfordern `offer.release.approve`; nach
  Freigabe reicht internes `project.read`. Jeder Download prüft Tenantgraph,
  MIME, Länge und SHA erneut und bleibt privat; External erhält nie Zugriff.
- Profilstände bleiben Workspace-Historie; Offer-lokale Empfängerrevisionen,
  Candidates, Approvals und Bytes gehören zum Offer-Erasuregraphen. Eine aktive
  Candidate-Lease blockiert die Löschung bis zu ihrem sicheren Ende.
- Eine Ausstellungsfassung ist eine neue Bytefolge aus dem exakt versiegelten
  Candidate-Stand; Candidate-PDF-Bytes werden nie umetikettiert oder promotet.
  Issuance-Input, Candidate-/Approval-/Quellbindungen, Template und
  Rendererrezept müssen vollständig hashgleich bleiben.
- Der Freigabestand ist aus append-only Attestations abgeleitet: 0/2
  `ready_for_approval`, 1/2 `approval_pending`, 2/2
  `approved_for_archive_not_issued`. Zwei verschiedene aktive Actors geben
  dieselben rehashten Bytes frei; mindestens einer unterscheidet sich vom
  Candidate-Approver.
- Withdrawal ist append-only und terminal. Ein exakter Request replayt den
  zurückgezogenen Stand; nur neuer Candidate plus neue Quellbindung darf eine
  neue Issuance erzeugen.
- Erfolgreiche Issuance-Bytes sind append-only, tenantgeschützt, höchstens
  8 MiB und bis zur echten Archivierung Teil des Offer-Erasuregraphen. Sie sind
  kein WORM-/Object-Lock-Artefakt.
- Privilegierte Contact-Erasure löscht den Draft-Offer-Aggregat und kopierte
  PII; Offer-/Variant-/Revision-Zeiten gehören zur Inaktivitätsuhr,
  Nummernserie und verbrauchte Nummer bleiben, Project/Site/Contact werden nach
  dem bestehenden Vertrag pseudonymisiert erhalten.
- Finale Ausstellungsbytes existieren lokal und intern; nicht vorhanden sind
  weiterhin Object-Lock-Objekt, Archivevidence, `issued`, Versand, Annahme,
  Signatur, öffentlicher Link und Rechnung. Weder Candidate noch
  `approved_for_archive_not_issued` dürfen als Reonic-1:1-Parität oder
  rechtswirksam ausgestelltes Angebot ausgegeben werden.
