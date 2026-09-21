# F8-23c — Gruppen-Status-Zählungen (Draft-/Sent-Ansicht Übersicht)

Dritter F8-23-Folgeslice: Gruppen-Übersicht zeigt heute nur
`documentCount` — keine Draft-/Sent-Aufschlüsselung. Erweitert
`listDocumentGroups` um Status-Counts und rendert Zähl-Badges.

## Umfang

- `listDocumentGroups` (`modules/invoicing/service.ts`): zusätzliche
  Counts pro Gruppe via `count FILTER (WHERE …)` in derselben Query:
  `draftCount` (`status='draft'`), `issuedCount` (`status='issued'`),
  `sentCount` (`status='issued'` AND `sent_at is not null`),
  `voidedCount` (`status='voided'`).
- `commercialDocumentGroupV1Schema`: 4 Pflicht-Int-Felder additiv
  (DECIDED kein Versionsbump — Producer = derselbe Service,
  einziger Konsument = Gruppen-UI).
- UI `groups-overview.tsx`: Zähl-Badges je Gruppe („X Entwürfe“,
  „Y versendet“, `data-testid="group-draft-count"` /
  `"group-sent-count"`); Null-Werte werden ausgeblendet (DECIDED —
  ruhige Übersicht statt 0-Badges).
- Capability unverändert (`invoicing.read`).
- Keine Migration (reine Aggregat-Reads).

## Nicht-Umfang

- Keine Badge-Links auf gefilterte Listen (Gruppen ≠ Typ-Achse,
  Verlinkung passt nicht — reine Anzeige).
- Keine Zahlungsstatus-Counts (Zahlung bleibt Typ-Listen-Spalte).
- Kein Provider-/F8.7-Scope.

## Akzeptanzmatrix

| ID | Anspruch | Beleg |
|---|---|---|
| F823C-CT-01 | Schema: 4 Count-Felder, Int ≥ 0 | Contract-Tests |
| F823C-DB-01 | Counts stimmen je Gruppe (alle 4 Achsen) | DB-Tests |
| F823C-DB-02 | Leere Gruppe → alle Counts 0 | DB-Tests |
| F823C-E2E-01 | Badges sichtbar, 0-Badges ausgeblendet | E2E-Test |
