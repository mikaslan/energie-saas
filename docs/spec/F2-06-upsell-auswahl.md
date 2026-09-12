# F2-06 Upsell-Auswahl auf der Signaturseite (Katalog F2.6)

Status: **SLICE-A IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02`
Ziel: Optionale BOM-Komponenten als Upsell-Checkboxen auf der
Angebotsdetailseite in Signaturnähe, mit Live-Summenupdate, ohne
Simulationseingriff. Belegter Katalogpunkt F2.6: „Optionale Komponenten als
Upsell-Checkboxen auf der Signaturseite (Live-Summenupdate, nie in
Simulation)".

## Slice A (dieser Slice, ohne Migration/Permission)

- Reine Projektion über dem versiegelten Varianten-Snapshot: sichtbare
  (`!isHidden`) Zeilen mit `positionType === "optional"` erscheinen als
  Checkboxen mit Name, Menge und Brutto-Zeilenbetrag.
- Live-Summe (Client-State): `Basis brutto + Summe gewählter Optionaler`.
  Basis = versiegelte Snapshot-Totals (`basisGrossCents`), keine Neuberechnung.
- Auswahl ist pro Seitenaufruf (Client-State, Default: keine Auswahl);
  Persistenz/Bindung an Signaturinhalt ist Slice B (offen, s.u.).
- „Nie in Simulation": Die Auswahl erreicht keinen
  v2-Simulations-/Berechnungseingang (reine Anzeige-Selektion; Test assertet,
  dass der Projektor keine Simulationsfelder berührt — er projiziert nur
  Summen über versiegelte Zeilenbeträge).
- Ehrlichkeit: Nur versiegelte, sichtbare optionale Zeilen sind wählbar;
  unbekannte IDs werden still verworfen (sanitized, dokumentiert im
  Rückgabewert `unknownIds`); keine EK-Preise, keine Rohdaten am Client
  über das hinaus, was die Detail-View ohnehin zeigt.

## Datenquelle (kein Raten, kein ESTIMATE)

- `OfferLineView.computed.salesGrossCents` je Zeile (versiegelt),
  `lineDomainId` als stabiler Schlüssel, Snapshot-Totals `basisGrossCents`.
- Reiner Projektor `resolveUpsellTotal` in
  `lib/integrations/offers/upsell.ts` (Zod-Schemas, keine DB, kein I/O).

## Abgrenzung (Slice B, offen)

- Persistenz der Auswahl + Bindung an Signatur-/Issuance-Inhalt
  (Attestierungsabdeckung) ist Slice B. Offene Produktfrage, kein Raten:
  Selbstwahl durch den Kunden auf der öffentlichen Seite vs. editorgeführte
  Auswahl in der Signaturvorbereitung — Geldfluss-Semantik, gehört in
  `fragen an codex/offen`, bevor sie gebaut wird.
- Keine neuen Spalten, keine Migration, keine neuen Berechtigungen in A.

## Akzeptanz Slice A

- Unit: Sanitierung (unbekannt/versteckt/nicht-optional fallen raus),
  Summen (Basis + Auswahl), Leerzustand, Max-50.
- E2E `F206-E2E-01`: Angebot mit optionaler Zeile → Upsell-Block sichtbar
  mit Checkbox → Toggle ändert die angezeigte Summe nachweisbar, Untoggle
  stellt sie wieder her → Axe sauber. Exakte Summenlogik per Unit
  (`F206-U-01` rechnet Cent-beträge nach).
- Gates: lint/typecheck/test/build grün; keine Migrations-/Rollenänderung.
