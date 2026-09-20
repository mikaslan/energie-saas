# F2-01c — Direkte Angebotsanlage ohne Anfrage-Pfad (STUDIE)

Status: **STUDIE — kein Bau ohne Leitstand-Entscheid.**

## 1. Ausgangslage

M2-01 kennt nur den Pfad `aktuelle Anfrage → Angebotsentwurf`
(`createOfferFromRequest`): 1 Offer pro Project, Phase `request/open`
auf Lead-Spalte, Seed der Basisvariante aus der aktuellen M1-08-Resolution.
„Direkte Angebotsanlage ohne bestehendes Projekt" ist dort explizites
Nicht-Ziel. Die Studie prüft, ob und wie ein Direktpfad ergänzt werden kann.

## 2. M2-01-Offer-Create-Vertrag (Pflichtbindungen, heute)

Offer-Create bindet serverseitig, alles in einer Tenant-Transaktion:

1. **Project**: `request/open`, Lead-Spalte, Default-Residential-Board.
2. **Resolution**: `current`, vollständig, aktive preisvollständige Revisionen.
3. **Requirement + Calculation**: aktuell, erfolgreich, revisionsgepinnt
   (`expectedRequirementRevision`, `expectedCalculationRevision`,
   `expectedResolutionRevision`).
4. **Site**: `selected`, hausgenau, pinbestätigt, gleiche `addressRevision`.
5. **Contact**: `deleted_at IS NULL`, Kette Project→Contact→Site exakt.
6. **Inbound-Receipt**: `source_key='wmee-rechner-v3'`,
   `privacy_purpose='offer_request'`, vollständige Rechner→Requirement→
   Calculation→Resolution-Bindung.
7. **Preiszielgruppe**: `priceAudience='b2c'` + strukturierte
   Operatorbestätigung (Actor + DB-Zeit); `residential` ≠ B2C-Nachweis.

Service-Guards (`modules/offers/service.ts`): `project.write` +
`phase.convert` + `price.edit` (fail-closed für `external_only`);
Blocker-Codes u. a. `project_not_request`, `calculation_not_current`,
`inbound_binding_missing`, `address_not_confirmed`,
`offer_number_exhausted`; Nummernserie `ANG-{YYYY}-{seq:6}` per Row-Lock.
F1-Begriff: **Request** = Intake-Ereignis (Rechner/Broker/REST, F1-15/18);
**Project** = qualifizierte Projektakte auf dem Board.

## 3. Varianten

### A — Minimal-Project-Autoanlage (empfohlene Richtung, noch zu entscheiden)

Direkt-Command legt zuerst ein Minimal-Project (neue Herkunft, z. B.
`source_key='offer-direct'`) mit Contact+Site an, dann läuft der
unveränderte M2-01-Create. Berührte Vertragspunkte: §2 Nr. 1 (neue
zulässige Herkunft), Nr. 6 (Receipt-Pflicht braucht Ersatz: Direktnachweis
statt Inbound-Receipt), Nr. 2/3 (Seed aus Resolution entfällt → leere
Basisvariante aus Custom-Zeilen). Migrationsskizze 0330: `project.source_key`
um `'offer-direct'` erweitern (Check-Constraint), `offer.origin` o. ä.
Flag für Direkt-Herkunft, Pflichtfelder für Direkt-Seed lockern —
NUR Skizze. Risiken: RLS (neue Herkunft in Tenant-Isolation aufnehmen);
Erasuregraph (Direkt-Projects brauchen eigene Lock-/Tombstone-Regel);
Nummernserie (unverändert, weiter pro Workspace/Jahr); Events
(neue Eventtypen `project.created_from_offer` o. ä. + Audit).
Aufwand: **M**.

### B — Offer ohne Project (nullable FKs)

`offer.project_id` wird nullable; Offer hängt direkt an Contact+Site
oder an einer losen Referenz. Berührte Vertragspunkte: §2 Nr. 1–3 und 6
entfallen faktisch; Nr. 4/5 bleiben; Nr. 7 bleibt. Größter Eingriff:
1-Offer-pro-Project-Unique, `readExistingOfferForProject`, Replay-Digest,
Outdated-Logik und alle `project_id`-JOINs (Listen, Dashboards, Erasure)
brauchen einen projektlosen Zweig. Migrationsskizze 0330: `project_id`
nullable, Check (`project_id NOT NULL OR direct_origin NOT NULL`),
partielle Uniques, Deferred-Trigger für beide Äste — NUR Skizze.
Risiken: RLS (projektlose Offers brauchen eigene Policy-Äste);
Erasuregraph (zweiter Löschanker neben Project); Nummernserie
(unverändert); Events (doppelte Semantik: mit/ohne Projekt).
Aufwand: **L**.

### C — Verwerfen (kein Direktpfad)

M2-01 bleibt einziger Pfad; Direktwünsche laufen über manuelle Anfrage
(F1-11/F1-16) und normale Konvertierung. Keine Vertragsänderung, keine
Migration, keine neuen Risiken. Aufwand: **S** (nur Doku: Verweis aus
F2-Doku auf F1-11/F1-16). Nachteil: zwei Schritte für den Operator,
keine echte „Direktanlage".

## 4. Offene Fragen an den Leitstand

1. Ist Variante A (Minimal-Project) die gewünschte Richtung, oder B, oder C?
2. Welche Mindestdaten muss ein Direkt-Offer haben (Contact-Pflicht?
   Site-Pflicht oder Rechnungsadresse später)?
3. Darf die Basisvariante eines Direkt-Offers leer starten (nur
   Custom-Zeilen), oder ist ein Katalog-Seed Pflicht?
4. Braucht der Direktpfad einen eigenen Inbound-Nachweis statt
   `privacy_purpose='offer_request'` — wenn ja, welchen?
5. Gilt `priceAudience='b2c'`-Bestätigung unverändert auch für Direkt-Offers?
6. Sollen Direkt-Projects auf einer eigenen Board-Spalte starten?
7. Neue Events/Audit-Codes für Direkt-Herkunft freigegeben?
8. Darf 0330 additive Check-/Spalten-Änderungen bringen, oder ist ein
   separates Nummern-/Serienkonzept für Direkt-Offers gewünscht?
