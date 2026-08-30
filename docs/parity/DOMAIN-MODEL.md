# Domain Model

Stand: 2026-08-30 · M2-01 implementierter Vertrag

## Bestehender Spine und neue kommerzielle Grenze

```text
Workspace
 ├─ Contact ── Site ── Project
 │                    ├─ Requirement revisions
 │                    ├─ Calculation revisions
 │                    ├─ Catalog resolution revisions
 │                    └─ Offer (max. 1 in v1)
 │                         ├─ immutable B2C qualification
 │                         ├─ minimized Contact/installation-Site context
 │                         └─ OfferVariant (n)
 │                              └─ OfferVariantRevision (n, append-only)
 │                                   ├─ OfferVariantSection (n)
 │                                   └─ OfferBOMLine (n)
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
- Privilegierte Contact-Erasure löscht den Draft-Offer-Aggregat und kopierte
  PII; Offer-/Variant-/Revision-Zeiten gehören zur Inaktivitätsuhr,
  Nummernserie und verbrauchte Nummer bleiben, Project/Site/Contact werden nach
  dem bestehenden Vertrag pseudonymisiert erhalten.
- Issued-/signed-Artefakte existieren in diesem Modell noch nicht.
