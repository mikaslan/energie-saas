# F2-01b — Angebots-Ansichten (Converted-Badge, Forecast-Pin)

Status: **SPEC-DRAFT Lane 7 Welle 2**

Vorgänger: M2-01 (`docs/spec/M2-01-angebotsvarianten-snapshot-bom.md`),
F2-02 (`docs/spec/F2-02-varianten-vertiefung.md`).
Anlass: (a) D2-1b Converted-Badge Katalog F2.1 (0 Treffer im Code, fehlt
komplett); (b) D2-4 Forecast-Pin-Test (Money-Härtung VERIFIED-Pfad).

## Scope

1. Converted-Badge (D2-1b): sichtbare Kennzeichnung, dass eine Anfrage in
   einen Angebotsentwurf überführt wurde — F2.1-Kataloglücke, rein additiv.
2. Forecast-Pin (D2-4): Contract-Tests pinnen die bestehende
   Forecast-Semantik cent-exakt — kein Verhaltenswechsel (VERIFIED-Pfad).

## Nicht-Ziele

- Keine Migration (Badge liest Bestand, Forecast-Spalte existiert).
- Keine Nummernformat-Themen (5d-TABU), keine 5b-Slices.
- Kein Provider/Lock/Versand/Auto-Installation.
- Keine Änderung der Geld-/Rabatt-Mathematik (M2-01-Vertrag unverändert).
- Keine zweite Preiswahrheit: Forecast bleibt CRM-Wert, nie Kundensumme.

## Datenmodell

- Keine Schemaänderung. Quellen sind Bestand:
  - `offer (workspace_id, project_id)` — genau ein Offer pro Project (M2-01).
  - `offer.forecast_value_net_cents bigint NULL` + CHECK `0..9e15`.
  - `project.phase = 'offer'` — Transaktionsfolge, keine Badge-Wahrheit.

## Service-/UI-Semantik

### Badge-Datenquelle (DECIDED): Offer-Existenz, nicht Phase, nicht Event

- Quelle: `EXISTS (offer WHERE workspace_id + project_id)` im
  tenantgescopten Readmodell. Begründung: `project.phase = 'offer'` ist nur
  Transaktionsfolge und überlebt die DSGVO-Erasure als Tombstone *ohne*
  Offer (M2-01: Tombstone behält `phase=offer`, erscheint aber nicht im
  Offer-Readmodell) — Phase allein würde ein falsches Badge zeigen.
  Events sind Audit, keine Zustandswahrheit.
- Der Read-Pfad erweitert den bestehenden Projektakt-Read um ein boolesches
  `hasOffer`; kein N+1 (ein JOIN/EXISTS pro Akte/Liste).

### Anzeigeorte (DECIDED)

1. Projektakte `anfragen/[projectId]` — Kopfbereich neben Phasanzeige.
2. Bestehende Converted-Section (`data-offer-create-state="converted"` in
   `offer-create-entry.tsx`) — Badge ergänzt die Section, ersetzt sie nicht.
- GESTRICHEN (Review Lane 7): Angebotsübersicht `angebote` — ohne D2-2
  (F2-01c-STUDIE, kein Bau) stammen alle Offers aus Requests; das Badge
  wäre immer an und damit sinnlos. Folgt ggf. mit Direktpfad.
- Kein Badge auf Board-Karten und in PDFs in v1 (eigener Slice).

### Wortlaut (DECIDED)

- DE: `Angebot angelegt` — Begründung: identisch zur bestehenden
  Converted-Überschrift („Angebot ist bereits angelegt"), kein neues Vokabular.
- EN: `Offer created`.
- Styling: bestehendes Emerald-Badge-Muster der Akte
  (`border-emerald-300 bg-emerald-50`, vgl. „Serverstand aktuell").

### Forecast-Pin-Umfang (DECIDED, kein Verhaltenswechsel)

Gepinnte Funktionen (alle Bestand):

1. `euroForecastToCents` (`offer-create-view.ts`) — Parser: Dezimaltext →
   Cent-Integer oder `null`; ungültig (negativ, >2 Nachkommastellen) → `null`
   (UI blockiert Submit, kein Silent-Round).
2. `createOfferFromRequest` (Service) — persistiert den Forecast unverändert
   (`forecast_value_net_cents`); `""` → `NULL`; nie aus BOM abgeleitet.
3. `getOfferDetail` (`modules/offers/service.ts:706`) — Forecast-Mapping
   `string|null → number|null`, safe-integer-geprüft; `null` bleibt `null`.
- Cent-Exaktheit: Roundtrip Parse→Persist→Read ist identisch (kein Float,
  kein Drift); Grenzwerte `0` und `9_000_000_000_000_000` inklusive.
- Forecast≠displayTotal: `displayTotalNetCents = override ?? basisNet`
  (F2-02-Regel) — Forecast fließt nie in Anzeige- oder Kundensummen ein;
  Forecast≠Override (zwei unabhängige Offer-CRM-Werte).

## Tests (RED zuerst)

- F201B-1: Badge erscheint mit Offer, fehlt ohne Offer (Akte-Kopf + Section).
- F201B-2: Tombstone (`phase=offer`, Offer gelöscht) zeigt kein Badge.
- F201B-3: Cross-Tenant: fremdes Offer erzeugt kein Badge (`hasOffer=false`).
- F201B-4: Parser-Pin: gültige Fälle (`"25.000,00"`→2500000, `""`→null-Input),
  ungültige (`"-1"`, `"1,234"`, `"abc"`) → `null`.
- F201B-5: Roundtrip-Pin: Create mit Forecast → `getOfferDetail` liefert
  exakt denselben Cent-Wert; `NULL`-Fall bleibt `null`.
- F201B-6: Trennungs-Pin: Forecast ≠ `displayTotalNetCents` bei aktivem,
  inaktivem und fehlendem Override (drei Fälle, kein Verhaltenswechsel).
- F201B-7: Grenz-Pin: `0` und `9e15` passieren, `9e15+1`/negativ blockiert.

## Offene Punkte

- O1: Badge auf Board-Karten — eigener UI-Slice nach Lane-7-Entscheid?
- O2: EN-Strings ohne i18n-Framework nur als Spec-Vorgabe (Code bleibt DE)?
- O3 (ENTSCHIEDEN Review Lane 7): Akte-only in v1 (`hasOffer` nur im
  Projektakt-Read, kein Listen-Readmodell — kein Listen-Badge ohne D2-2).
