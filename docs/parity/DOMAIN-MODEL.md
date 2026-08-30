# Domain Model

Stand: 2026-08-30 · M2-01, M2-02 und M2-03a lokal verifiziert

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
 │                              └─ optionale OfferReleaseCandidateApproval
 ├─ CatalogComponent
 │    └─ CatalogComponentRevision (n, append-only)
 ├─ OfferNumberSeries (per year)
 └─ OfferMutationRateWindow (Actor/Workspace fixed windows)
```

## Aggregate-Verantwortung

| Entität | Identität / Lebensdauer | Wahrheit / Grenze |
|---|---|---|
| `Project` | bestehende Workspace-/Contact-/Site-Bindung | Phase und Boardposition; nicht die Preiswahrheit |
| `ProjectCatalogResolution` | immutable Planungs-/Produktauswahlrevision | zulässige Seed-Quelle, ausdrücklich keine BOM |
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
| `OfferMutationRateWindow` | Workspace + optional Actor + DB-Zeitfenster | atomare 15-Minuten-Zähler für 120 Actor-/1200 Workspace-Versuche; keine Fachdaten |

## Kritische Invarianten

- Jede Tenant-Relation besitzt Workspace-ID, zusammengesetzte FKs und FORCE RLS.
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
- Privilegierte Contact-Erasure löscht den Draft-Offer-Aggregat und kopierte
  PII; Offer-/Variant-/Revision-Zeiten gehören zur Inaktivitätsuhr,
  Nummernserie und verbrauchte Nummer bleiben, Project/Site/Contact werden nach
  dem bestehenden Vertrag pseudonymisiert erhalten.
- `issued`, Versand, Annahme, Signatur, öffentlicher Link, Rechnung und
  Object-Lock-Artefakte existieren in diesem Modell noch nicht. Der technisch
  verifizierte Freigabekandidat darf nicht als Reonic-1:1-Parität oder
  rechtswirksames Angebot ausgegeben werden.
