# F8-23a — Sent-Sichtbarkeit Typ-Liste (Filter + Badge)

Erster F8-23-Folgeslice (F8-23 UI-Folge, außerhalb F8-EPIC): Sent-Achse
(`issued` + `sent_at`, M301-04) in der Typ-Liste sichtbar und filterbar
machen. Baut auf `listDocuments` (Service) und `[type]/page.tsx` auf.

## Umfang

- `sent`-Filter (`"all" | "sent" | "unsent"`, optional,
  `undefined` = alle) in `commercialDocumentListCommandV1Schema`
  (`lib/integrations/invoicing/contract.ts`, DECIDED additiv ohne
  Versionsbump — optionales Feld, Producer = derselbe Service).
- `listDocuments`-Condition (Spiegel Status-Pattern): `sent` → `sent_at
  is not null`, `unsent` → `sent_at is null`. Reine `sent_at`-Achse,
  unabhängig vom Status-Filter (DECIDED — `sent` + `status=draft`
  liefert natürlich leere Menge, kein Spezialfall).
- UI `[type]/page.tsx`: Filter-Select „Versand“ (alle/versendet/nicht
  versendet, `invoicing.read`, Query-Key `versand`), für alle Typen
  (DECIDED — greift wo `sent_at` gesetzt wird).
- Sent-Badge in Status-Spalte: `issued` + `sent_at` → „Versendet“-Badge
  (`data-testid="document-sent-badge"`); sonst Status-Label unverändert.
- Keine Migration (`sent_at` existiert seit M3-01).

## Nicht-Umfang

- Kein Provider-Versand (STOPP-Zone), kein Re-Send/Un-Send.
- Keine neuen Routen, kein Versand-Button in Liste (bleibt Detail).
- Kein F8.7 (Mahnwesen, XRechnung, Bankabgleich, WH-Rechnungen).

## Akzeptanzmatrix

| ID | Anspruch | Beleg |
|---|---|---|
| F823A-CT-01 | Schema: `sent`-Enum, optional, strikte Keys | Contract-Tests |
| F823A-DB-01 | `sent` liefert nur `sent_at`-gesetzte, `unsent` nur NULL | DB-Tests |
| F823A-DB-02 | Kombination `sent` + `status` schränkt korrekt ein | DB-Tests |
| F823A-E2E-01 | Badge sichtbar + Filter wirkt im Browser | E2E-Test |
