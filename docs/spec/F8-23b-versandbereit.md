# F8-23b — Versandbereit-Ansicht (Filter-Preset + Badge)

Zweiter F8-23-Folgeslice: Arbeitsliste „zu versenden“ — Dokumente, die
alle Versand-Voraussetzungen erfüllen, aber noch nicht versendet sind.
Baut auf F8-19-Gating (`markSentWithDelivery`) als Read-Spiegel auf.

## Umfang

- Filter-Preset `versandbereit` (boolean, Default `false`) in
  `commercialDocumentListCommandV1Schema` (additiv, kein Bump).
- `listDocuments`-Condition bei `versandbereit=true`: `status='issued'`
  AND `sent_at is null` AND EXISTS `succeeded`-Rechnungs-PDF-Job
  (`invoice-pdf-template.v1`, SQL-Pattern aus
  `delivery-service.ts` Gating-Spiegel).
- Typ-Gate (DECIDED — wie Versand-Action): nur `invoice`/`credit_note`;
  andere Typen liefern leere Menge.
- UI `[type]/page.tsx`: Preset-Checkbox „Nur versandbereite“
  (Query-Key `versandbereit`) + „Versandbereit“-Badge in Status-Spalte
  (`data-testid="document-ready-badge"`); Badge verlinkt aufs Detail
  (dort Versand-Button, kein Listen-Versand).
- Keine Migration (nur Reads auf existierende Tabellen/Jobs).

## Nicht-Umfang

- Kein Versand-Button in Liste (Gating bleibt Detail-Action).
- Kein Auto-Versand, kein Provider-Versand (STOPP-Zone).
- Kein Zahlungs-PDF-Gating im Preset (F8-19-Differenzierung
  Rechnung-ohne-Beleg bleibt Detail-Sache).

## Akzeptanzmatrix

| ID | Anspruch | Beleg |
|---|---|---|
| F823B-CT-01 | Schema: `versandbereit`-Boolean, Default false | Contract-Tests |
| F823B-DB-01 | Nur issued + unversendet + succeeded-Job enthalten | DB-Tests |
| F823B-DB-02 | Versendete / ohne Job / letter-Typ ausgeschlossen | DB-Tests |
| F823B-E2E-01 | Preset + Badge + Detail-Link im Browser | E2E-Test |
