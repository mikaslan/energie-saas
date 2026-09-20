# F11-06 Quick Actions (Katalog F11.2)

Status: **SPECIFIED** · Lane: `codex/muse-fleet-2c-f11` · Basis `66a0dbe`
Ziel: Die Kontaktwege in der Projektakte (`contact-section.tsx`) werden
von reinem Text zu Aktionen: Anruf, SMS, WhatsApp, E-Mail und
Navigation — genau die Katalogliste aus F11.2. Schließt die Lücke
„Quick Actions ABSENT (`contact-section.tsx:356-359` rendert nur
`<span>`, 0 Treffer `tel:`/`sms:`/`wa.me`)" aus der Discovery-Matrix.

## Evidenz (FACT, Basis 66a0dbe)

- Katalog: `docs/blaupause/01-modulkatalog.md:129` — „F11.2 …
  Quick Actions (Anruf/SMS/WhatsApp/Navigation)". CAPABILITY-MATRIX
  ohne F11-Zeile. `docs/parity/STATUS.md:139` F11 PARTIAL.
- Datenmodell (`lib/integrations/contacts/contract.ts`):
  `contactWaysV1Schema` mit `primaryEmail`/`secondaryEmail` (nullable),
  `phone`/`phoneMobile` (E.164 `+[1-9][0-9]{1,14}`, nullable),
  `phoneReachability`; `contactAddressV1Schema` mit
  street/houseNumber/postalCode/city/country (alle nullable).
- intake-owned: Primär-E-Mail + Festnetz kommen aus dem Lead
  (`manual-lead-service.ts`, `normalizeRechnerPhone` in
  `modules/intake/service.ts`: `0151 45678911` → `+4915145678911`,
  führende 0 → +49). Mobil/Adresse pflegt der Editor über das
  Kontaktformular (`contact-section.tsx:200-221`).
- Anzeige heute: reine `<span>`-Zeilen (`contact-section.tsx:356-364`,
  `:370-378`); Edit-Button „Kontakt bearbeiten" (`:411-418`), nur mit
  `canWrite` und nicht bei `deletedAt`.

## Vertrag

- Reiner Helfer `quickActionsForContact(ways, address)` in
  `lib/mobile/quick-actions.ts` (zod-geprüfte Ausgabe, kein I/O),
  plus `quickActionsForDataset(dataset)` für den Lösch-Guard:
  - Anruf: `tel:` an Mobil, sonst Festnetz.
  - SMS: `sms:` an Mobil, sonst Festnetz.
  - WhatsApp: `https://wa.me/<Ziffern>` (E.164 ohne `+`) an Mobil,
    sonst Festnetz. Extern (`target _blank`, `rel noreferrer`).
  - E-Mail: `mailto:` an Primär-, sonst Sekundär-E-Mail.
  - Navigation: OpenStreetMap-Suche
    `https://www.openstreetmap.org/search?query=<enc>` über
    „Straße Hausnummer, PLZ Ort, Land" (vorhandene Teile, in dieser
    Reihenfolge); nur wenn Ort + (Straße oder PLZ) vorhanden.
    Extern (`target _blank`, `rel noreferrer`). DECIDED: OSM statt
    Google/Apple/`geo:` — schlüssellos, reines https, universell
    (kein Vendor-, kein Plattform-Lock).
- Tote-Links-Verbot: Aktionen ohne Datum entfallen (kein Platzhalter,
  kein deaktivierter Button). Tiefenschutz im Helfer (Review-Runde):
  nur E.164-geformte Rufnummern (`^+[1-9]…`), nur `@`-geformte
  E-Mails, Hausnummer nur mit Straße, `safeParse` statt Wurf
  (Überlänge lässt die Aktion aus, der Render-Pfad crasht nie).
  Erreichbarkeits-Praeferenz (`phoneReachability`) filtert nicht —
  sie ist Information, kein Verbot.
- UI: neue `dt`/`dd`-Zeile „Schnellzugriff" (`data-testid="quick-actions"`)
  direkt nach den Kontaktwegen; Links als Pillen (`min-h-11`), Labels
  Anrufen/SMS/WhatsApp/E-Mail/Navigation; nur rendern bei ≥1 Aktion
  und nicht bei gelöschtem Kontakt (`deletedAt`, der Löschzustand
  bleibt führend). Rest der Sektion unverändert.
- Keine Migration, keine neue Permission, kein Edit-Verhalten neu
  (Formular bleibt Bestand).

## Tests

- Unit (`tests/unit/f1106-quick-actions.test.ts`, rein, keine DB):
  Mobil-bevorzugt, Festnetz-Fallback, alles-null → leer,
  E-Mail-Primaer-vor-Sekundaer, wa.me-Ziffern (ohne `+`, mit
  Länderkennung), OSM-URL + Encoding (Umlaute/Leerzeichen),
  Mindest-Adresse (nur Ort → keine Navigation; Ort+PLZ reicht),
  Schema-Negativfaelle, `external`-Flag je Aktion.
- DB: keine (reine Darstellung vorhandener Daten).
- Chromium-E2E `F11-06-E2E-01` (isolierter Workspace, Muster F11-04):
  Lead mit Name + E-Mail + Telefon `0151 45678911` → Akte zeigt
  `quick-actions` mit exakt `tel:+4915145678911`, `sms:+4915145678911`,
  `https://wa.me/4915145678911`, `mailto:`-Adresse, KEINE Navigation
  (keine Adresse); dann „Kontakt bearbeiten": Mobil `+491702345678` +
  Straße/PLZ/Ort setzen → Speichern → Anruf/SMS/WhatsApp zeigen auf
  Mobil, Navigation erscheint mit OSM-URL (encoded Adresse);
  `target`/`rel` auf Externen; 375/768/1440 ohne Ueberlauf + Axe A/AA;
  0 Console-/Page-Errors; keine 4xx/5xx nach Login.
- Regression: `M1-14` (Kontakt-Sektion Bestand) + F11-05 (Leiste rendert
  auf der Aktenseiten mit).

## Nicht Umfang

- VCF-/Kontakt-Export, Anruf-Protokollierung, Routenplanung mit
  Verkehr, Adress-Autovervollständigung, Share-Sheet-Empfang.
