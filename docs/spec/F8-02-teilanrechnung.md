# F8-02 Teilanrechnung (Beträge statt Voll-Brutto)

Ziel: Eine ausgestellte Anzahlung nur teilweise auf der
Schlussrechnung anrechnen und den offenen Restbetrag centgenau
zeigen — aus eigenen Daten, ohne neue Belegtypen (keine
Nummernserien-/Filter-/CSV-Umbauten). Folgt auf F8-01 (dort als
„bewusst offen" gelistet).

## ESTIMATE (reversibel, Referenzfrage offen)
- Modell: Spalte `applied_cents` auf `commercial_document_link`
  (Migration 0090, Backfill = volles Anzahlungs-Brutto, daher
  F8-01-Bestand unverändert). Eine Anzahlung gehört weiter zu
  höchstens einer Schlussrechnung (kein Split über mehrere
  Schlussrechnungen in diesem Slice); pro Link ist der Betrag frei
  wählbar.
- Anrechenbar: nur `invoice` mit Status `issued` (Entwürfe und
  Stornierte nie), gleicher Workspace, X ≠ Y, genau eine Stufe
  (keine Ketten, wie F8-01).
- Betrag: 1 ≤ applied ≤ Brutto(Anzahlung); Σ applied auf der
  Schlussrechnung ≤ Brutto(Schlussrechnung), sonst Conflict
  (fail-closed statt stiller 0-Clamp). Restbetrag = Brutto(X) −
  Σ applied, reine Anzeige, keine Umbuchung. Legacy-Überdeckung
  (F8-01-Bestand) zeigt weiter max(…, 0).
- Exakte Reonic-Darstellung UNKNOWN; Layout ESTIMATE, nur
  gespeicherte Werte.

## Scopes
1. Migration + `linkDeposit` mit optionalem `appliedCents`
   (Default = volles Brutto, rückwärtskompatibel), fail-closed
   (Validierung, Konflikt bei Über-Anrechnung/Status/Kette,
   NotFound ohne Orakel); `unlinkDeposit` unverändert.
2. `getDocumentDetail` erweitert: `linkedDeposits[].appliedCents`
   + `remainingCents` aus Σ applied.
3. Detail-UI: Betragseingabe (EUR) im Anrechnungs-Formular +
   angerechneter Betrag je Zeile + Restbetrag. Listen
   unverändert.
4. Sichtbarkeit: `invoicing.read` (lesen), `invoicing.write`
   (verlinken); keine neue Permission.

## Geschlossene Testmatrix
- `F802-DB-01`: Teilbetrag belegt Restbetrag-Math; Default =
  volles Brutto (F8-01-kompatibel).
- `F802-DB-02`: applied > Brutto(Anzahlung), applied ≤ 0 und
  Σ applied > Brutto(Schluss) fail-closed; Unlink stellt Rest
  wieder her.
- `F802-RBAC-01`: Viewer liest Teilanrechnung read-only;
  Fremdtenant sieht nichts.
- `F802-E2E-01`: Geseedete Belege (Anzahlung 119 €,
  Schluss 238 €) → 119 € teilanrechnen → Restbetrag 119 €
  sichtbar.

## Bewusst offen
- Anzahlungs-Split über mehrere Schlussrechnungen,
  mehrstufige Ketten, Gutschrift-Anrechnung,
  DATEV-/E-Rechnungs-Export, Versand.
