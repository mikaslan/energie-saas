## Verdikt: NACHBESSERUNG

Kernmechanik (Exactly-One via partiellem Index, Lock-Reihenfolge Projekt→Offer→Variante, atomarer Demote+Promote in einer Tx, Migrationsreihenfolge additiv→Backfill→Index, additive Readmodell-Erweiterung) ist sauber umgesetzt. Keine P0/P1-Befunde. Die Mängel liegen in der Audit-Vollständigkeit und der No-op-Disziplin.

---

## Befunde

### P2 – Audit-Event-Vollständigkeit lückenhaft

**Stelle:** `modules/offers/service.ts` – `setOptionalBundles` (Payload), `setTotalPriceOverride` (Clear-Pfad), `setPrimaryVariant` (Payload).

- `offer.variant_bundles_set`: Payload enthält nur `{offerId, variantId, actor, at}` – **nicht die gesetzten Bundles**. Da Bundles revisionslos sind, ist der neue Zustand historisch nirgends rekonstruierbar; das Audit sagt „geändert", aber nicht „wozu". Das ist der gravierendste Audit-Mangel.
- `offer.total_override_cleared`: Payload enthält den **vorherigen Override-Wert nicht**. Bei einem geldrelevanten Eingriff gehört der Altwert ins Audit (Vorher/Nachher).
- `offer.primary_switched`: Die **vormals primäre Variante** (`previousPrimaryVariantId`) fehlt. Zwar aus der Event-Historie ableitbar, aber forensisch schwach.

**Fix:**
- Bundles: `bundles: command.bundles` ins Event-Payload und in `writeAudit.details` aufnehmen (Canonicalisierung wie beim Vergleich).
- Override: Vor dem Update den aktuellen `total_price_override_net_cents` aus `offerRecord` lesen und als `previousValueNetCents` in Set- **und** Clear-Payload aufnehmen.
- Primary: Vor dem Demote-Update die bisherige Primary-ID selektieren (oder aus dem Demote-`RETURNING id`) und als `previousPrimaryVariantId` ins Payload.

### P2 – Fehlende No-op-Disziplin beim Deal-Override

**Stelle:** `modules/offers/service.ts` – `setTotalPriceOverride`.

`setPrimaryVariant` (`alreadyPrimary`) und `setOptionalBundles` (`changed`, kanonischer Vergleich) unterdrücken No-ops ohne Event/Audit. `setTotalPriceOverride` schreibt bei identischem Wert (oder erneutem `null` bei bereits leerem Override) **jedes Mal Event + Audit + `updated_at`-Touch**. Inkonsistent innerhalb des Slices und Audit-Rauschen bei geldrelevanter Aktion.

**Fix:** Vor dem Update `offerRecord.total_price_override_net_cents` mit `command.totalPriceOverrideNetCents` vergleichen; bei Gleichheit früh returnen (analog `changed: false` bzw. eigenes Flag im Result) ohne Event/Audit/Touch. Test ergänzen: zweimal identisches Setzen bzw. doppeltes Clearen erzeugt kein zweites Event.

### P3 – DB-Check für `optional_bundles` nur Array-Ebene

**Stelle:** `lib/db/schema/offers.ts` (`offer_variant_bundles_ck`) / `drizzle/0055_…sql`.

Der Check prüft nur `jsonb_typeof = 'array'`. Element-Shape (`name` nicht-leer, `position` 0–999, Positions-Eindeutigkeit) existiert nur auf Zod-Ebene. Direkte DB-Zugriffe (Backfills, künftige Migrationen, manuelle Eingriffe) können kaputte Elemente einschleusen; `setOptionalBundles` fällt dann auf `Array.isArray`-Fallback mit stillschweigendem `[]` statt Integrity-Fehler.

**Fix:** Check um Element-Validierung erweitern (z. B. via `jsonb_array_elements`-Subquery: Objekt, `name` getrimmt 1–120, `position` int 0–999, Positionen distinct), oder zumindest im Service bei nicht-konformem Bestand `OfferIntegrityError` werfen statt `[]` anzunehmen. Niedrig priorisiert, da App-Pfad validiert.

### P3 – Testlücken bei Berechtigungsmatrix

**Stelle:** `tests/db/f202-variant-deepening.test.ts`.

Getestet: Operator (darf alles), Viewer (darf nichts). **Nicht getestet:** `plainEditor` (Rolle `editor`, keine Capabilities) – der interessante Fall, da `setTotalPriceOverride` zusätzlich `price.edit` verlangt, `setPrimaryVariant`/`setOptionalBundles` aber nur `project.write`. Erwartung (plainEditor darf Primary/Bundles, aber **nicht** Override) ist ungesichert; ein späteres Wegfallen der `price.edit`-Prüfung würde nicht auffallen.

**Fix:** Testfall für plainEditor über alle drei Mutationen: Primary/Bundles erfolgreich, Override → `PermissionDeniedError`.

---

## Positiv festgehalten (keine Befunde)

- **Exactly-One:** Partieller Unique-Index `(workspace_id, offer_id) WHERE is_primary` als letzte Schranke; Backfill deterministisch (ordinal, created_at, id) **vor** Index-Erzeugung; Demote+Promote in einer Tx unter Offer-Row-Lock → konkurrierende Switches serialisiert; Duplikate/From-Resolution immer `is_primary=false`; DB-Ebenen-Test auf Doppel-Primary vorhanden.
- **Scoping:** Variante stets mit `workspace_id + offer_id + id` aufgelöst; fremde/unbekannte IDs → `NotFound` (Test vorhanden), Unique-Verletzung → `IntegrityError`, klare Trennung.
- **Migration 0055:** Reihenfolge korrekt (Spalten → Backfill → Index → Checks), Journal-Eintrag konsistent (idx 55, Tag = Dateiname).
- **Geld-Ranges:** JSON-Schema-Maximum 9 000 000 000 000 000 deckt sich mit `moneyCheck`/Constraint; negativer Wert → ValidationError (Test).
- **Netto/Brutto-Trennung:** Override ist netto-only, `displayTotalGrossCents` bei aktivem Override explizit `null`; kein Vermischen im Readmodell; Readmodell-Felder rein additiv (bestehende Tests unberührt).
- **Readmodel-Integrität:** Safe-Integer-/Vorzeichenprüfung des Overrides im Readpfad.
- **Revisionslosigkeit:** Override/Bundles erzeugen keine `offer_variant_revision` (Test zählt Revisionen).
- **Vertrag:** Schema-Regenerierung inkl. aktualisiertem `OFFER_SCHEMA_SHA256`, strikte Zod-Objekte, `additionalProperties: false`.
- **Kein Scope-Creep** (kein Demote-Command, kein Brutto-Override, keine Bundle-Revisionierung), **keine Secrets** (synthetische Fixtures).

---

## Offene Fragen

1. Ist das Fehlen der No-op-Unterdrückung beim Override bewusst (z. B. weil jede Preisberührung auditpflichtig sein soll, auch wertgleich)? Falls ja, bitte in der Spec festhalten, sonst wie oben angleichen.
2. Soll `displayTotalGrossCents` bei aktivem Override bewusst `null` sein, oder soll – bei bekanntem `taxTreatment` des Offers – ein Brutto-Schätzwert abgeleitet werden? Aktuell implizit entschieden, nicht spezifiziert.
3. Soll das Primary-Switch-Event/Audit die Vorgänger-Primary zwingend enthalten, oder genügt die Ableitbarkeit aus der Event-Kette?