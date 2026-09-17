# F16-14 Angebots-Bulk-Update auf aktuelle Katalogbasis

## Befund

Blaupause F16.1 (`docs/blaupause/01-modulkatalog.md`: Komponentenkatalog mit
gesteuerter Änderungs-Propagation: „Outdated components"-Banner +
Bulk-Update → Snapshot-Architektur) ist erst halb gebaut: Der Editor zeigt
den Outdated-Zustand (`PersistentOutdatedWarning`,
`app/w/[workspaceId]/angebote/[offerId]/offer-editor.tsx`) und bietet genau
einen Ausweg — „Neue Basis" (eine Variante, manuell benannt, Steuer
ausdrücklich gewählt, keine Vererbung). Bei N veralteten Varianten braucht
es N manuelle Einzelläufe; dabei driftet die Katalogbasis zwischen den
Läufen weiter. F16-14 bündelt das in einen Batch-Befehl: ein Revisionsstand,
ein Confirm, ein Commit — mit denselben Garantien wie der Einzellauf.

## ESTIMATE (reversibel)

- Neuer Batch-Befehl `bulkUpdateVariantsFromCurrentResolution` in
  `modules/offers/service.ts` (+ `OFFER_VARIANT_BULK_UPDATE_COMMAND_VERSION`
  `offer-variant-bulk-update-command.v1` in
  `lib/integrations/offers/contract.ts`, zod-Schema im Stil der
  Geschwister-Commands). Nachfolger entstehen über denselben
  `loadCurrentBasis`→`buildResolutionSnapshot`-Pfad wie „Neue Basis"
  (kein zweiter Preis-Pfad).
- Pro Variante eine Nachfolger-Zeile: `{ sourceVariantId,
  expectedSourceRevision, name, taxTreatment, zeroConfirmation? }`.
- Keine Migration (nur INSERTs in `offer_variant` /
  `offer_variant_revision` / `offer_variant_section` / `offer_bom_line`
  via `insertVariant`+`persistRevision`, plus je Nachfolger ein
  Domain-Event + Audit-Eintrag via `recordOfferMutation` und
  Angebot/Projekt-Timestamp-Touch wie der Einzellauf), keine neue
  Permission (`project.write` + `price.edit`
  existieren in `lib/permissions.ts`).
- UI: Bulk-Sektion auf der Angebotsseite (Outdated-Variantenliste +
  Steuer je Zeile + ein Confirm + Skip-Gründe), bestehender Editor,
  „Neue Basis" und Banner unverändert.

## Vertrag

`bulkUpdateVariantsFromCurrentResolution(tx, ctx, value)`:

- Permissions upfront: `requireOfferAccess(ctx, "project.write", …)` und
  `requireOfferAccess(ctx, "price.edit", …)` — wie
  `createVariantFromCurrentResolution` (`service.ts`, dort
  Angebots-/Preis-Gate). Fehlt eines → `PermissionDeniedError`, kein Write.
- Reihenfolge (fix): validieren → Projekt/Angebot sperren (`lockProjectBasis`,
  `lockOffer` — serialisiert konkurrierende Batches je Angebot) →
  Skip-Menge bestimmen → 12-Cap prüfen → Batch-CAS prüfen →
  Namens-Dup-Prüfung → alle Nachfolger einfügen. Jeder Fail-closed-Schritt
  vor dem ersten INSERT wirft ohne einen einzigen Write.
- Skip fail-closed (vor CAS und Cap): Quellen mit Content-Lock
  (`readVariantContentLock`: `pending`/`signed`/`revoked_by_customer`) und
  bereits aktuelle Varianten werden nicht angefasst und mit Grund
  zurückgegeben (`skipped: [{ sourceVariantId, reason }]` mit
  `variant_signature_pending` / `variant_signed` /
  `variant_revoked_by_customer` / `variant_current`). Signierte Zeilen
  bleiben byte-identisch (kein UPDATE auf bestehenden
  `offer_variant`-/`offer_variant_revision`-Zeilen, auch nicht signed).
- 12-Cap upfront: `bestehende Varianten + ausführbare Nachfolger ≤ 12`,
  sonst `OfferBlockedError("variant_limit")` vor jedem Write (gleiche
  Grenze wie `nextVariantOrdinal`).
- Batch-CAS all-or-nothing: genau ein Satz `expectedRequirementRevision` /
  `expectedCalculationRevision` / `expectedResolutionRevision` für den
  ganzen Batch, einmalig über `loadCurrentBasis` geprüft; zusätzlich je
  Zeile `expectedSourceRevision` gegen `current_revision` (Duplikat-Muster).
  Jede Abweichung → `OfferConflictError`, null Nachfolger.
- Steuer ausdrücklich je Zeile, keine Vererbung: jede Zeile braucht ein
  eigenes `taxTreatment` (`standard_19` → 1_900 bps,
  `zero_operator_confirmed` → 0 bps nur mit `zeroConfirmation`
  `{ code: "zero_tax_draft_operator_confirmed", confirmed: true }` —
  `taxDecision`-Semantik). Die `taxDecision` der Quelle wird nie kopiert.
- Deterministische Nachfolger-Namen + Dup fail-closed: Default
  `<Quellname> · Kat.-Rev. <expectedResolutionRevision>`, NFC-Trim,
  1–120 Zeichen (`normalizedRequiredText(120)`-Semantik; Quelle wird
  zugunsten des Suffixes gekürzt). Vor dem Einfügen prüft der Service
  alle Nachfolgernamen gegen die bestehenden Variantennamen des Angebots
  (kein Namens-Unique-Constraint in der DB — nur Ordinal-/Primary-UQs):
  Kollision → `OfferConflictError`. Retry mit gleichen Namen erzeugt daher
  keine Duplikate (Idempotenz fail-closed statt still doppelt).
- Geld in Minor Units: alle Preise in Cents aus der Live-Resolution
  (`buildResolutionSnapshot`-Pfad), keine Floats, kein Client-Preis zählt.
- Ergebnis: `{ offerId, created: [{ sourceVariantId, variantId, revision:
  1, name }], skipped: […] }`, je Nachfolger ein Audit-/Event-Eintrag im
  Stil des Einzellaufs (`offer.variant_created`, `price.edit`).

## UI

- Bulk-Sektion auf der Angebotsdetailseite (nur bei `canCreateBasis` und
  mindestens einer outdated Variante; Outdated je Variante über
  `readOfferCatalogFreshness` mit Varianten-`requestKey` + Einzel-Binding —
  `requestKey` ist eine freie UUID, ein Binding pro Request ist zulässig).
- Liste aller outdated Varianten: Quellname + Revisionsstand, pro Zeile ein
  Steuer-Select (Default leer = „Bitte ausdrücklich auswählen", 19 % /
  0 % mit zusätzlicher 0-%-Checkbox wie `basis-tax`), vorbelegter
  deterministischer Nachfolgername (editierbar, 1–120).
- Genau ein Confirm („N Nachfolger auf Kat.-Rev. R anlegen", deterministische
  Vorlage `${n} Nachfolger auf Kat.-Rev. ${r} anlegen`); darunter
  Skip-Gründe („Übersprungen:" + `{Name} — {Grund}` mit
  `wartet auf Signatur` / `signiert` / `vom Kunden widerrufen` /
  `bereits aktuell`). Fehler ehrlich
  (Konflikt → „Basis hat sich geändert, neu laden"; Cap → „Variantenlimit
  12 erreicht"), keine Treffer-/Namens-Orakel über fremde Angebote.
- Breakpoints 375 / 768 / 1440 ohne horizontales Scrollen der Tabelle
  (Zeilen umbrechen wie der Editor), Axe-Prüfung (`AxeBuilder`-Muster der
  Repo-E2E) auf der Bulk-Sektion.

## Tests

- DB `tests/db/f1614-bulk-update.test.ts` (Muster `f1613`: eigener
  Workspace per `randomUUID`, `seedM201ReadyProject`, dann Katalog-Revision
  erhöhen + Resolution neu auflösen, damit Quellen outdated sind):
  Happy Path (2 outdated → 2 Nachfolger, `revision: 1`, Preise aus neuer
  Resolution, Cents); Batch-CAS-Miss (falsche `expectedResolutionRevision`
  → `OfferConflictError` + null Writes); Quell-Revisions-Race (Quelle
  zwischenzeitlich revidiert → Konflikt, nichts geschrieben); konkurrierende
  Batches (zweiter Batch → Konflikt/Dup, kein Doppel-Nachfolger);
  signed-untouched (`signature_request` Status `signed` → skipped mit
  `variant_signed`, Snapshot vorher/nachher byte-identisch);
  pending/revoked/current-Skips mit Gründen; 12-Cap (11 + 2 → `variant_limit`,
  null Writes); Steuer (fehlendes `taxTreatment` → Validation, 0 % ohne
  `zeroConfirmation` → Validation, 19 %-Nachfolger einer 0-%-Quelle →
  keine Vererbung); Retry-Idempotenz (gleicher Batch zweimal → zweiter
  `OfferConflictError`, Variantenzahl unverändert); Audit (kein UPDATE auf
  bestehenden Varianten-/Revisionszeilen).
- E2E `tests/e2e/f16-14-bulk-update.spec.ts`: eigener isolierter Workspace
  (randomUUID + Membership-Insert, F16-13b-Muster), NIEMALS w3; Seed:
  Angebot mit 2 outdated + 1 wartenden (pending) Variante auf offenem
  Projekt (signiert/widerrufen/geschlossen nur DB-05/07/13, da
  `loadCurrentBasis` ausfuehrbare Zeilen auf won mit
  `project_not_eligible` verweigert); Bulk-Sektion öffnen, pro
  Zeile Steuer wählen, Confirm → 2 Nachfolger mit deterministischen Namen,
  Skip-Grund für die wartende; Viewports 375/768/1440 + Axe. RED-first:
  Spec und DB-Cases werden vor der Implementierung rot gefahren.
- Regression: F16-13b-E2E und Angebots-Nachbarn grün (kein Behavior-Change
  am Einzellauf).

## Bewusst offen

- Kein Teilerfolg-Modus: Entweder entstehen alle ausführbaren Nachfolger
  oder keiner (Skips sind kein Teilerfolg, sie sind deklariert).
- Nachfolger sind frische Resolution-Seeds wie „Neue Basis": manuelle
  Zeilen, Rabatte und Bündel der Quelle werden nicht mitkopiert; kein
  automatischer Primary-Wechsel.
- Keine angebotsübergreifende Bulk-Ansicht; Sortierung der Outdated-Liste
  (Ordinal) ohne Rangfolge.
- Doppelte Quellzeilen im selben Batch (gleiche `sourceVariantId` mit
  verschiedenen Namen) erzeugen je einen Nachfolger — kein Guard, kein Test
  (Review-Notiz, harmlos: jeder Nachfolger ist eine legitime neue Variante).
- Gleiche Variantennamen erzeugen gleiche sichtbare Zeilen-Labels
  (`Steuer für {Name}`); die `htmlFor`-Zuordnung bleibt pro Variante
  eindeutig, textbasierte Strikt-Selektoren wären mehrdeutig — kein Test.
