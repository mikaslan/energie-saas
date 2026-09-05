# F2.2 — Varianten-Vertiefung (primäre Variante, Deal-Override, optionale Bundles)

Status: **IMPLEMENTED (UI-Slice inklusive; VERIFIED pending CI/Maschine — Billing-Block Q6)**

## UI-Slice (FRAGEN-AN-MIKAIL.md Nr. 4, geschlossen)
- `OfferVariantControlsPanel` (`app/w/[workspaceId]/angebote/[offerId]/offer-variant-controls-panel.tsx`):
  Primär-Badge + Promote-Formulare je nicht-primärer Variante, Deal-Override-Feld
  (Euro mit Komma/Punkt, "" = Clear) + Zurücksetzen, Bundle-Liste der aktiven
  Variante (Name/Position, add/remove, max 50). Read-only-Zweig zeigt Werte ohne
  Formulare. Rechte: Promote/Bundles `project.write`, Override `price.edit`
  (Service setzt durch, UI blendet nur aus).
- Server-Actions (`angebote/variant-actions.ts`, exakte Formfelder + zod +
  `authorizedOfferMutationAction`, Revalidate ohne Redirect) auf den bestehenden
  Service-Funktionen (`setPrimaryVariant`, `setTotalPriceOverride`,
  `setOptionalBundles`) — kein Backend-Umbau, nur additiver Read (`bundles` je
  Variante in `getOfferDetail`).
- Reine Helfer (`lib/integrations/offers/variant-controls.ts`) + Unit-Tests
  (`tests/unit/f202-variant-controls.test.ts`); E2E-02 (Promote/Override/Bundles
  + DB-Read-back) in `tests/e2e/f2-02-varianten-vertiefung.spec.ts`.
- Reviews: Kimi + DeepSeek Exit-3 (kein OPENROUTER_API_KEY) — Gates entscheiden.

Lane: `codex/f2-02-varianten-vertiefung` off `origin/codex/m1-wave-02` (0055).
Vorgänger: M2-01 (Varianten, Snapshot-BOM, Custom Deal pro Revision).

## Angewendete Skill-Regeln
- reonic-parity: Vertrag zuerst, TDD RED→IMPLEMENTED, keine erfundenen Preise, additive Migration, RLS strikt, kein Reonic-Code (nur live beobachtetes Verhalten).
- contract-first: ein kanonischer Artefakt pro Grenze (`lib/integrations/offers/contract.ts` + JSON-Schema-Mirror), Consumer-/Provider-Verifikation vor Merge.
- database-migrations: forward-only, keine Steuerzeichen in CHECKs, partieller Unique-Index nach 0054-Vorbild.
- product-lens: Warum — Editor braucht genau EINE als „aktuell" markierte Variante (Angebotserstellung, PDF, Freigabe) statt Ordinal-Heuristik; Deal-Override gehört auf Offer-Ebene.
- software-quality-gates/playwright-verify/browser-qa: volle Gate-Kette je Slice.

## Live-Evidenz (api.reonic.de/rest/v3/openapi, 2026-09-04, read-only)
- `ResidentialVariant` (required): `id, name, isPrimary, totalPrice, totalPriceOverride, systems, optionalBundles`.
- `isPrimary`: „Whether this is the project's primary offer variant."
- create: `isPrimary=true` „Overrides the previous primary variant" (Exactly-One, serverseitiger Switch).
- update: `isPrimary` akzeptiert nur `true` („A variant cannot stop being primary on its own, so `false` is rejected — promote another variant instead").
- `systems`: `{solar, batteryStorage, heating, evCharger, additional}`, je `VariantSystem{price, lineItems}` oder `null`.
- `VariantOptionalBundle`: `{id, name, description, selected, price, lineItems}`.
- **Deprecation-Befund (LIVE, 2026-07-23, Sunset 2026-10-31):** `Price`-Schema deprecated („variant's total depends on the selected payment option"); `totalPriceOverride` deprecated („The manually agreed total belongs to the project itself"). → Override gehört auf **Offer-Ebene** (F2.4-Deal-Wert), nicht an die Variante. Unsere Snapshot-BOM bleibt Preiswahrheit pro Revision.

## Scope
1. `offer_variant.is_primary boolean NOT NULL DEFAULT false` + partieller Unique-Index `(workspace_id, offer_id) WHERE is_primary` (höchstens eine primäre Variante je Offer).
2. `offer.total_price_override_net_cents bigint NULL` + CHECK `0..9_000_000_000_000_000` (F2.4-Deal-Wert, kundenwirksamer Total-Override; keine Ableitung aus BOM).
3. `offer_variant.optional_bundles jsonb NOT NULL DEFAULT '[]'` — ESTIMATE-Form `[{name, position}]`: Der Ultra-Prompt meldet leere Live-Bundles; das Live-Schema kennt zusätzlich `id/description/selected/price/lineItems` (Mapping siehe unten); erweiterbar, nie raten.
4. Service `setPrimaryVariant` (atomarer Switch, Promote-only: kein Demote-Endpunkt), Erstvariante automatisch primär, Duplikat/Resolution-Basisvariante nie automatisch primär.
5. `setOptionalBundles(offerId, variantId, bundles)` — DECIDED revisionslos auf der stabilen `offer_variant`-Zeile (kein Revise-Op, keine neue Revision), mit eigenem Varianten-Audit-Event + `offer_variant.updatedAt`-Touch (Spalte existiert, Schema Z.220). Recht: `project.write` via `requireOfferAccess(ctx, "project.write", "offer_variant")` (M2-01-Muster, keine neue Matrix-Action). Lookup gescopet `(workspaceId, offerId, variantId)` → Miss → `OfferNotFoundError`. Form: max 50 Bundles (DECIDED eigene Produktentscheidung, kein Live-Limit), je `{name 1..120, position int ≥0 eindeutig}`. Begründung Dormanz: siehe oben (Signaturstrecke folgt).
6. Migration **0055** (ein File, Reihenfolge: Spalten additiv → Backfill → partieller Index zuletzt; je Offer Variante mit minimalem Ordinal → `is_primary=true`; Offers ohne Variante bleiben ohne Primary).
7. Löschpfad: existiert in v1 nicht (kein DELETE im Offer-Service) — Exactly-One kann nicht durch Löschen brechen. Eine künftige Löschung der Primary ist bis zur Promote-Regel verboten.

## Nicht-Ziele
- Keine Payment-Options/Subventionen/Finanzierung (live separate Ressourcen).
- Keine Kundenauswahl-Logik optionaler Komponenten (Signaturstrecke).
- Keine Änderung der Geld-/Rabatt-Mathematik (M2-01-Vertrag unverändert).
- Keine UI-Redesigns; Editor zeigt Primärkennzeichen + Override-Feld.

## Datenmodell (0055)
- Revisionsstabilität (M2-01, belegt): `offer_variant` ist eine stabile Entität je Variante; alle fachlichen Revisionen liegen in `offer_variant_revision` (eigene Tabelle, `current_revision`-Zeiger). Kein Revise-Op legt je neue `offer_variant`-Zeilen an — `is_primary` und `optional_bundles` hängen an derselben Zeile, der partielle Index ist damit korrekt gescopet.
- `offer_variant.is_primary`, `offer.total_price_override_net_cents`, `offer_variant.optional_bundles` wie oben.
- RLS unverändert (Tabellen-Policies bestehen); Append-only/Erasuregraph unberührt (keine neuen Tabellen).
- CHECKs ohne Steuerzeichen (nur `between`, `jsonb_typeof`, Längen).

## Service-Semantik
- Create erste Variante: `is_primary=true`. Jede weitere: `false`.
- `duplicateOfferVariant`: Kopie `is_primary=false` (stiehlt nie Primary).
- `setPrimaryVariant(offerId, variantId)`: Transaktion, Locks in kanonischer Reihenfolge, Unset+Set atomar; Lookup gescopet auf `(workspaceId, offerId, variantId)` — Treffer fehlt (unbekannt, fremdes Offer, fremder Workspace) → `OfferNotFoundError` (M2-01-Nomenklatur, keine Cross-Tenant-Leaks); Recht: `project.write`. Bereits primäre Variante → idempotentes No-op ohne Audit-Event (kein Audit-Rauschen).
- Konkurrenz Erstvarianten-Create: Zwei parallele Creates ohne Bestandsvariante setzen beide `is_primary=true`; der partielle Index lässt genau einen durch, der Verlierer erhält `OfferIntegrityError` (kein stiller Retry, kein impliziter Promote) — Aufrufer wiederholt den Create-Pfad.
- Live-Abweichung (bewusst, funktional äquivalent): Live-Create-mit-Promote ist bei uns aufgeteilt in Create (weitere Varianten immer `false`) + `setPrimaryVariant`; Ergebnis identisch, Demote existiert nirgends.
- Bundle-Validierung: Service-Layer (Form via zod, Eindeutigkeit von `position`); DB-CHECK strikt nur `jsonb_typeof(optional_bundles) = 'array'` (keine Element-Checks in SQL; Rest zod im Service).
- Audit-Events (bestehendes `emitEvent`-Muster): `offer.primary_switched` (+ `previousPrimaryVariantId`), `offer.total_override_set` (+ `valueNetCents` + `previousValueNetCents`), `offer.total_override_cleared` (+ `previousValueNetCents`), `offer.variant_bundles_set` (+ `bundles`). Basis-Payload `{offerId, variantId?, actor, at}`.
- No-op-Disziplin überall: Primary bereits primär / Override wertgleich (inkl. doppelt-`null`) / Bundles identisch → Return ohne Event/Audit/Touch (`alreadyPrimary` / `changed: false`).
- `displayTotalGrossCents = null` bei aktivem Override ist bewusst (kein Brutto-Schätzwert aus bekanntem Steuersatz — keine erfundene Steuerumrechnung; Brutto folgt in der Signatur-/Steuerstrecke).
- `displayTotal*` sind neue additive Readmodell-Felder ohne Bestandskonsumenten (PDF rendert weiter Snapshot-Totals); Editor zeigt bei `overrideActive` Netto + Hinweis. Scope 2: Override `0` explizit zulässig (Explizit-Override ≠ Clear via `null`).
- Konkurrenz-Verlierer: Fehler propagiert an Client („Variante inzwischen angelegt, erneut laden"), kein automatisches Retry (Retry würde Duplikat-Variante erzeugen).
- Backfill deterministisch: `ORDER BY ordinal ASC, created_at ASC, id ASC LIMIT 1` je Offer.
- Spätere Bundle-`id`: Backfill auf `position`-Basis oder lazy beim nächsten Write.
- Anzeige-Fallback ist reine Readmodell-Interna (`getOfferDetail`: `displayTotal = override ?? Basis-Brutto der aktuellen Revision der Primary`), getestet über Readmodell-Tests — kein neuer Eintrag in `contract.ts`.
- `duplicateOffer` existiert nicht (nur `duplicateOfferVariant`); Kopie-Regel gilt pro Variante.
- `setTotalPriceOverride(offerId, cents|null)`: `price.edit` (existiert, `lib/permissions.ts`, minRole editor — keine neue Permission, kein Matrix-Delta jenseits neuer Action-Zeilen); `null` löscht; keine Snapshot-Umschreibung.
- Anzeige-Regel (Netto/Brutto sauber getrennt, keine erfundene Steuerumrechnung): `getOfferDetail` liefert `displayTotalNetCents = override ?? basisNetCents(aktuelle Revision der Primary)` und `displayTotalGrossCents = override==null ? basisGrossCents : null` plus `overrideActive: boolean`. Mit aktivem Override ist nur Netto definiert (Brutto folgt erst in der Signatur-/Steuerstrecke); ohne Override gelten beide Snapshot-Werte.
- Offer ohne Primary (Altbestand, bewusst ohne Backfill): `primaryVariantId = null`, `overrideActive` aus Offer-Spalte. Formel gilt durchgängig (kein Sonderfall): `displayTotalNetCents = override ?? null` (kein Basis-Brutto ohne Primary), `displayTotalGrossCents = null`. Override ohne Primary ist damit wirksam für Netto — konsistent zur Offer-Level-Platzierung. Kein Ordinal-Fallback (keine stille Primary-Heuristik).
- Folge-Vertrag (verbindlich für künftigen Delete-Slice): Varianten-Löschung muss Promote-vor-Delete erzwingen oder das Primary-Löschverbot per Service-Guard implementieren — sonst Exactly-One-Bruch.
- Revisionsbindung (DECIDED, Präzedenz `forecast_value_net_cents` aus M2-01): Der Override ist ein Offer-CRM-Wert wie Forecast — bewusst revisionslos, keine neue Variantenrevision. Jede Setzung/Clearing schreibt einen eigenen Offer-Audit-Event (Actor + DB-Zeitpunkt) und aktualisiert `offer.updatedAt`. Begründung: Der Override ersetzt keine BOM-Wahrheit, sondern überlagert nur die Anzeige; Revisionen bleiben der stücklistenbezogenen Fachlichkeit vorbehalten.
- Begriffsklärung „Basis": Die beim Offer-Create angelegte erste Variante (Ordinal 1) heißt `Basis` (M2-01) und ist automatisch primär. Später per `createVariantFromCurrentResolution` angelegte „neue Basisvarianten" sind Resolution-Snapshots und nie automatisch primär.
- Bundle-Mapping (Live → übernommen): `name` → ja (Pflicht, 1..120); Ordnung → `position` (eigen, int ≥0, eindeutig je Variante); `description` → nein (kein Anzeigekonzept in v1); `selected` → nein (Kundenauswahl = Nicht-Ziel Signaturstrecke); `price/lineItems` → nein (Preiswahrheit = Snapshot-BOM, keine zweite Preissumme); `id` → nein (positionelle Identität genügt, erweiterbar).
- Revise erwartet weiterhin `expectedRevision`; `set_variant_name/description` bleiben revisionspflichtig (unverändert).

## Tests (RED zuerst)
- DB/Contract: Exactly-One (zweite Primary verletzt Index), Promote-Switch, Demote-Ablehnung (kein API-Pfad), Erstvariante primär, Duplikat/Resolution-Basis nicht primär, Override-Range/Null + Audit-Event ohne Revisionsbump, Bundles-Form/Positions-Eindeutigkeit (leeres name, Array-Max), Backfill-Verifikation (jedes Offer mit ≥1 Variante hat genau eine Primary), konkurrierende `setPrimaryVariant`-Aufrufe (Index als letzte Schranke), konkurrierende Erstvarianten-Creates (Verlierer → `OfferIntegrityError`), Anzeige-Fallback (Override aktiv → nur Netto definiert; gecleart; nach Primary-Switch; ohne Primary → Totals null), Cross-Offer-/Cross-Tenant-Promote → `OfferNotFoundError`, Idempotenz (No-op ohne Event), Audit-Events je Mutation.
- `offer_variant.workspace_id` existiert und ist NOT NULL + Tenant-FK (Schema Z.212ff, Vorgänger-Migration) — kein Backfill nötig.
- Rollenproben: Viewer blockiert `setPrimaryVariant`/`setTotalPriceOverride`/`setOptionalBundles`; Cross-Tenant je Funktion → `OfferNotFoundError` (Matrix: bestehende `project.write`-/`price.edit`-Zeilen, keine neuen Actions).
- Audit: `setPrimaryVariant` schreibt eigenen Offer-Audit-Event (Actor + DB-Zeitpunkt) und toucht `offer.updatedAt` (kundenwirksam via Anzeige-Fallback); Test deckt Event + Timestamp ab. `setOptionalBundles` analog auf Variantenebene.
- Live-Feld-Mapping Rest: `systems` → abgedeckt durch Snapshot-BOM M2-01, kein neues Modell; `totalPrice` → nicht persistiert (abgeleitet, live deprecated); Varianten-`id` → unsere `offer_variant.id` (UUID, stabil).
- Migration 0055 läuft in einer DDL-Transaktion (additiv → Backfill → Index), nach 0054-Vorbild ohne CONCURRENTLY (kleine Tenant-Tabellen, Deploy-Fenster); keine laufenden Writes zwischen Backfill und Index außerhalb der Transaktion sichtbar.
- E2E-Grep F2.2 (nach DB-Verfügbarkeit).
- Live-Evidenz-Stichtag: OpenAPI-Abruf 2026-09-04; Deprecation-Marker darin datiert 2026-07-23 (kein Widerspruch, zwei Zeitstempel unterschiedlicher Aussagen).

## Offene Punkte → FRAGEN-AN-MIKAIL.md
- F4-Rechenkern-Abhängigkeit: keine (reine Offer-Domäne).
