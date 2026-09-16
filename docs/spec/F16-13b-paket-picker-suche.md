# F16-13b Paket-Picker-Suche (Server-Suche über die 200er-Grenze)

## Befund

Die Paket-Seite lädt alle aktiven Katalogkomponenten (Limit 200) in jedes
Zeilen-Select. Produkte hinter Position 200 sind im Picker **still
unsichtbar** — keine Suche, kein Hinweis. M108B-09 löste dasselbe Problem an
der Resolution per Server-Suche; der Picker bekommt denselben Pfad.

## ESTIMATE (reversibel)

- Preload (erste 200) bleibt — bestehende E2E laufen unverändert weiter.
- Pro Zeile ein Suchfeld („Katalog suchen N", min. 2 Zeichen, max. 120,
  NFKC); Treffer werden serverseitig geholt und in die Optionsmenge der
  Zeile gemischt (Dedupe Id+Revision). Select, Labels, Bindelogik, Speichern:
  unverändert.
- Keine neue Permission: Lese-Gate wie die Seite (`discount_template.read`),
  Service erzwingt zusätzlich `catalog.read`; EK-Redaktion wie bisher.

## Vertrag

`searchCatalogBindingOptionsAction(workspaceId, query)`:

- Query-Normierung (`normalizeBindingSearchQuery`): kein String/leer/kürzer
  als 2 Zeichen/nach NFKC-Trim leer/über 120 Zeichen → `null` = keine Suche
  (leere Treffer, kein Fehler-Orakel).
- Sonst `listCatalogComponents({ status: "active", query })`, max. 50
  Treffer, gleiche Projektion + EK-Redaktion wie der Preload.
- `denied`/`unauthenticated`/`invalid` als Status (Client zeigt ehrlichen
  Hinweis, keine Trefferliste); `ok` mit Optionen.

## UI

Suchfeld je Zeile mit Debounce (300 ms), Zustände „Suche läuft…" /
„Suche fehlgeschlagen — versuch es erneut" / Trefferzähler. Erfolgreiche
Treffer erscheinen im bestehenden Select (Labelform unverändert:
`SKU — Name (Rev. N)`); gewählte Bindung und „Gebunden:"-Hinweis wie bisher.

## Tests

- Unit `normalizeBindingSearchQuery` (leer/kurz/lang/Kontrollzeichen/Trim).
- E2E `f16-13b-paket-picker-suche`: 201 Füller-Produkte + 1 Zielprodukt mit
  eindeutiger SKU seeden, Ziel per Suche finden (unter 202 unsichtbar ohne
  Suche), binden, Paket speichern, „Gebunden:"-Nachweis; Regression
  F16-13-E2E unverändert grün.
- Isolation (Vorderbau-41-Regel): eigener Workspace statt w3 — die Füller
  verdrängten sonst `F7-3-WR` aus dem 200er-Checklist-Select (Orakel-Rot
  35000268644, F7-03 ×2). Beweis: F7-03 + F16-13B gemeinsam 5/5.

## Bewusst offen

- Keine Volltext-Rangfolge über SKU/Name hinaus; kein unbegrenztes
  Nachladen (50er-Cap wie die Projekt-Suche).
