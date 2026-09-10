# F8-01 Anzahlung → Schlussrechnung (Anrechnung, read+link)

Ziel: Geleistete Anzahlungen auf der Schlussrechnung anrechnen und den
offenen Restbetrag ehrlich zeigen — aus eigenen Daten, ohne neue
Belegtypen (keine Nummernserien-/Filter-/CSV-Umbauten).

## ESTIMATE (reversibel, Referenzfrage offen)
- Modell: Link `schlussrechnung (invoice, id=X)` → `anzahlung
  (invoice, id=Y)`, additiv, eigene Tabelle `commercial_document_link`.
  Kein Belegtyp-Umbau; Anzahlung bleibt normale `invoice`.
- Anrechenbar: nur `invoice` mit Status `issued` (Entwürfe und
  Stornierte nie), gleicher Workspace, X ≠ Y, kein Zyklus
  (Y darf selbst keine verlinkten Anzahlungen haben — genau eine
  Stufe, keine Ketten).
- Anrechnung = Brutto der Anzahlung in voller Höhe (keine
  Teil-Anrechnung in diesem Slice); Restbetrag = max(Brutto(X) −
  Σ Brutto(Y), 0), reine Anzeige, keine Umbuchung.
- Exakte Reonic-Darstellung UNKNOWN; Layout ESTIMATE, nur
  gespeicherte Werte.

## Scopes
1. Migration + `linkDeposit/unlinkDeposit` (write), fail-closed
   (Validierung, Konflikt bei Doppel/Zyklus/Status, NotFound
   ohne Orakel).
2. `getDocumentDetail` erweitert: `linkedDeposits[]` +
   `remainingCents` (nur bei Typ `invoice` belegt, sonst leer/null).
3. Detail-UI: Abschnitt „Anrechnung" nur bei `invoice` mit Inhalt
   oder Schreibrecht (leerer ehrlicher Hinweis sonst); Listen
   unverändert.
4. Sichtbarkeit: `invoicing.read` (lesen), `invoicing.write`
   (verlinken); keine neue Permission.

## Geschlossene Testmatrix
- `F801-DB-01`: Link-Kette belegt Restbetrag; Doppel/Zyklus/
  Entwurf/Storno/fremder Typ fail-closed.
- `F801-RBAC-01`: Viewer liest Anrechnung read-only; Fremdtenant
  sieht nichts.
- `F801-E2E-01`: Anzahlung ausstellen → Schlussrechnung anlegen →
  verlinken → Restbetrag sichtbar.

## Bewusst offen
- Teil-Anrechnung (Beträge statt Voll-Brutto), mehrstufige Ketten,
  Gutschrift-Anrechnung, DATEV-/E-Rechnungs-Export, Versand.
