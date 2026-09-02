# ADR 0020 — Kontakt-Datensatz: Datenmodell für F1.1

- Status: VORGESCHLAGEN (im Rahmen der M1-14-Spec DISCOVERED→SPECIFIED)
- Datum: 2026-09-02
- Betroffene Slice-Spec: `docs/spec/M1-14-kontaktdatensatz.md`
- Basis: `01b52e9` (M1-12a)

## Kontext

F1.1 macht den Contact zur zentralen Datenachse. Die bestehende
`contact`-Tabelle (M1-04/M1-05) trägt nur den Intake-Mindeststand:
`display_name`, eine E-Mail, ein Telefon, einen Consent-Boolean und
`deleted_at`. Die Reonic-OpenAPI v3.11.0 (`SRC-API-SPEC`, DOCUMENTED) modelliert
den Kontakt als flache Struktur mit zwei E-Mails, Mobile/Festnetz, Anrede,
Erreichbarkeitsfenster, einer Kontaktadresse, Marketing-Consent, UTM und
Integrations-IDs. Der Modulkatalog F1.1 verlangt zusätzlich ein explizites
B2B-Flag und eine Consent-Policy-Version — beides ist in der API **nicht** als
eigenes Feld vorhanden.

Dieses ADR legt die Datenmodell-Entscheidungen fest, damit M1-14 einen
Implementierer ohne Rückfragen starten kann. Es wiederholt keine bereits
verifizierten Muster (Tenant-Schlüssel, RLS/FORCE-RLS, additive Migration,
Outbox), sondern verweist darauf.

## Entscheidung 1 — Kontaktwege: flache Spalten statt eigene Tabelle/JSONB

**Gewählt:** Die Kontaktwege bleiben flache Spalten am `contact`-Aggregat:

- `email_primary` (+ abgeleitet `email_normalized`) — vorhanden
- `phone_raw`/`phone_e164` — vorhanden (Festnetz/Bestandstelefon)
- `email_secondary` — NEU (Alternative E-Mail)
- `phone_mobile` — NEU (Mobil, API `mobile`)

**Verworfen:**

1. **Eigene `contact_channel`-Tabelle** (typ + value + Rang + Verifikation).
   Bietet beliebig viele Kanäle, verdoppelt aber den Erasure-Aufwand (neue
   Zeilen im Graphen, eigene Scrub-Logik), zwingt den API-Abgleich in eine
   Mapping-Schicht und übererfüllt den F1.1-Scope („mind. E-Mail + Telefon +
   optional weitere“). Der einzige fachliche Vorteil — unbeschränkt viele
   Kanäle — ist in der funktionalen Referenz nicht vorhanden: die API ist
   bewusst auf vier benannte Felder begrenzt.
2. **JSONB-Array `channels`.** Kaum typisierbar, schwächt DB-Checks
   (E.164-/E-Mail-Normalform), erschwert die Sortier-/Filterlogik und
   versteckt Semantik, die die API explizit benennt.

**Begründung:** 1:1-funktionale Parität zur API ist bei flachen, benannten
Spalten am einfachsten nachweisbar. Das bestehende Schema ist bereits flach
(`email_primary`, `phone_raw`), die Migration bleibt additiv. „Optional weitere“
interpretiert M1-14 als die vier API-benannten Wege; ein generischer Kanaltyp
ist bewusst NICHTZIEL.

## Entscheidung 2 — B2B-Markierung: eigenes Flag plus Anrede-Enum

**Gewählt:** Der Contact erhält ein erstklassiges `is_business boolean` und die
Anrede als `salutation`-Enum inklusive `Business`:

- `salutation` ∈ `female | male | diverse | family | business` (nullable) —
  API-Werte `Female/Male/Diverse/Family/Business` werden intern snake_case
  geführt und an der (späteren) API-Grenze gemappt.
- `is_business boolean not null default false`.
- Invariante (DB-CHECK): `salutation = 'business' ⇒ is_business = true`.

**Verworfen:** B2B allein aus `salutation = 'Business'` abzuleiten. Die
Modulkatalog-Formulierung „B2B-Flag“ (F1.1) und der Goal-Prompt listen die
B2B-Markierung als eigenes Konzept neben der Anrede; B2C/B2B steuert später
Routing (Residential vs. Commercial, F15) und darf nicht von einer reinen
Anrede-Notation abhängen.

**Begründung:** Die API kennt kein separates B2B-Feld; `Business` im
Anrede-Enum ist der einzige beobachtbare Träger. Das eigene Flag macht die
Absicht explizit und testbar, die Invariante hält beide Sichten kohärent.

## Entscheidung 3 — Kontaktadresse: flache Spalten, Site unangetastet

**Gewählt:** `contact` erhält fünf flache Adressspalten
(`address_street`, `address_house_number`, `address_postal_code`,
`address_city`, `address_country`), alle nullable. Die bestehende
`site`-Tabelle (Projekt-/Planungsadresse, Pin, Geocoding) wird **nicht**
angefasst.

**Verworfen:** JSONB `address` (wie die API es als Objekt führt) oder
Wiederverwendung der `site`-Zeile. JSONB schwächt Check-Constraints
(PLZ-Muster, Längen) und die spätere Suche; `site` trägt Geocoding-/Pin-Semantik
(`address_mode`, `address_revision`, `pin_confirmed`), die eine reine
Postadresse nicht hat.

**Begründung:** F1.1/F1.3 verlangen explizit „Projektadresse ≠ Kontaktadresse“.
Fünf nullable Spalten bilden die API-Adressform (`street, houseNumber, city,
postcode, country`) exakt ab, erlauben DB-seitige Validierung und sind über die
Contact-Zeilen-Scrub-Erweiterung (Entscheidung 6) sauber löschbar.

## Entscheidung 4 — Marketing-Consent: flacher Ist-Stand + Policy-Version, Historie über Events

**Gewählt:**

- `marketing_consent boolean not null default false` — vorhanden
- `marketing_consent_at`, `marketing_consent_source` — vorhanden
- `marketing_consent_policy_version text` — NEU (WMEE-Erweiterung, die API
  kennt keine Version)
- `marketing_consent_text text`, `marketing_consent_data_protection_link text`
  — NEU (API-Felder `marketingConsentText`/`marketingConsentDataProtectionLink`)
- Historie über die vorhandenen append-only `domain_events`
  (`contact.marketing_consent_changed`) und `audit_log`; **keine** eigene
  Consent-Historie-Tabelle.

**Verworfen:** Eine `contact_consent_revision`-Tabelle. Sie wäre fachlich
sauber, aber für M1-14 Scope-Creep: Sie bräuchte Graphen-Registrierung im
Erasure (Entscheidung 6), eigene RLS/Guards und eine zweite UI-Sicht, ohne dass
die funktionale Referenz eine Consent-Historie exponiert. Die
Policy-Version-Anforderung ist durch das Version-Feld am Ist-Stand plus den
WORM-Event-/Audit-Trail erfüllt (Payload ohne Kontakt-PII).

**Begründung:** DSGVO verlangt Nachweisbarkeit, welche Policy-Version wann galt.
Das Version-Feld + append-only Event/Audit (ID-only, keine PII) liefert diesen
Nachweis; eine zusätzliche Tabelle ist entbehrlich, bis echte Re-Consent-
Workflows existieren.

## Entscheidung 5 — Edit mit Revision/CAS

**Gewählt:** `contact` erhält `revision integer not null default 1`; jede
Mutation trägt `expected_revision` im WHERE (CAS) und schreibt
`revision = revision + 1`. Muster identisch zu `site.address_revision`
(M1-06) und `project.outcome_revision` (M1-11a).

**Verworfen:** Eine `contact_revision`-Snapshot-Tabelle (Vollhistorie). Für
Kontaktstammdaten reicht der CAS + Event/Audit-Trail; die API exponiert keine
Kontakt-Revisionshistorie, der F1.1-Scope verlangt nur „Edit mit
Revisionen/CAS wie bestehende Muster“.

## Entscheidung 6 — Erasure: quellgepinnte Scrub-Erweiterung

**Gewählt:** Die bestehende `erase_inactive_lead()` (Migration 0027) scrubbt den
Contact über eine **explizite Spaltenliste** (UPDATE, keine Zeilen-DELETE).
M1-14 erweitert diese Liste **quellgepinnt** um alle neuen PII-Spalten
(`first_name`, `last_name`, `salutation`, `email_secondary`, `phone_mobile`,
die fünf Adressspalten, `marketing_consent_policy_version`,
`marketing_consent_text`, `marketing_consent_data_protection_link`, UTM-Spalten,
`is_business`, `revision` wird auf 0/neutral zurückgesetzt, `deleted_at` bleibt
`erase_time`).

**Begründung:** Ohne diese Erweiterung blieben neue PII-Spalten nach einem
Erasure-Lauf stehen — ein DSGVO-Verstoß. Da M1-14 keine neue Tabelle einführt
(Entscheidungen 1 und 4), entsteht kein neuer Graphen-Knoten; die bestehenden
`graph_ids` bleiben gültig. Die Erweiterung folgt dem Muster aus M1-11b
(ADR 0018): SHA-256-Prüfung des Ist-Standes plus eindeutiger Anker, sonst
Abbruch der Migration.

## Konsequenzen

- Migration `0042_m1_14_contact_dataset.sql` (additiv, Nummer vor Lane-Merge
  gegen parallele Lanes M1-11b/M1-13 abzugleichen).
- Neue PII-Spalten leben ausschließlich am `contact`-Aggregat → Erasure bleibt
  eine Spaltenlisten-Erweiterung, kein neuer Graphen-Knoten.
- `display_name` bleibt kanonisches Label und wird serverseitig auf
  `btrim(first_name || ' ' || last_name)` gehalten (kein DB-Trigger); der
  bestehende `contact_active_identity_ck`-Guard bleibt gültig.
- Keine öffentliche REST-API in M1-14; die API-Felder sind funktionale
  Referenz für Datenmodell und Semantik, nicht ein zu bauender Endpunkt.
