# M1-08c Katalog-Revisionsverlauf (read-only)

Ziel: Die in `catalog_component_revision` gespeicherte Revisionskette je
Komponente lesbar machen. Preis- und Detailrevisionen sind heute unsichtbar —
wer einen Preis ändert, hinterlässt keine einsehbare Spur (F16-13-Stale-Fälle
verweisen auf Revisionsnummern, die niemand nachschlagen kann).

## ESTIMATE (reversibel)

- Reiner Lesepfad, keine Migration (Tabelle existiert), keine neue Permission
  (`catalog.read`), kein Provider, keine PII (kein Actor-Name, nur Zeit/SHA).
- Sichtbarkeit wie `getCatalogComponent`: unbekannte ID → `null`; Entwurf für
  Nicht-Manager → `null` (fail-closed, gleiche Semantik).

## Vertrag

`listCatalogComponentRevisions(tx, ctx, componentId)`:

- Guard `catalog.read` auf `catalog_component`, UUID-Check → `CatalogInputError`.
- Gibt `null` zurück, wenn die Komponente für den Aufrufer unsichtbar ist.
- Sonst Einträge aufsteigend je Revision: `revision`, `createdAt` (ISO),
  `snapshotSha256` (hex), `displayName`, `unit`,
  `salesPriceNetCents` (`null` ohne Commercial),
  `purchasePriceNetCents` (`null` ohne Commercial oder ohne
  `price.read_purchase` — gleiche Redaktion wie die View).
- Jede Zeile wird per `validateCatalogComponentRevision` + Identitätsabgleich
  (Workspace/Komponente/Revision) geprüft; Bruch → `CatalogIntegrityError`.

## UI

Detailseite `katalog/[componentId]`: Sektion „Revisionsverlauf" (Tabelle
Revision/Zeitpunkt/Bezeichnung/VK netto/EK netto/SHA-Kurzform; EK-Spalte nur
mit `canReadPurchasePrice`; ehrlicher Leerzustand ist per Konstruktion
unmöglich — Anlegen schreibt Revision 1).

## Tests

- DB `m108c-catalog-revisions`: Anlegen (Rev 1) → Preisrevision (Rev 2, neuer
  VK, gleicher EK) → Detailrevision (Rev 3, neuer Name, Preise kopiert) →
  Verlauf 3 Einträge aufsteigend mit korrekten Preisen/Namen/SHAs; Viewer
  sieht Verlauf ohne EK; Entwurf für Viewer → `null`; unbekannte ID → `null`;
  Outsider ohne `catalog.read` → Denied.
- E2E `m1-08c-catalog-revisions`: Preisrevision im Detail → Verlauf zeigt
  beide Revisionen mit Preisen.

## Bewusst offen

- Kein Diff zwischen Revisionen (nur Stände); keine Actor-Anzeige;
  keine Statuswechsel-Historie (Statuswechsel schreibt keine Revision).
