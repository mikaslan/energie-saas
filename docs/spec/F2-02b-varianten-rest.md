# F2-02b — Varianten-Rest (Duplikat-Kopie, Content-Lock-Guards)

Status: **SPEC-DRAFT (Lane 7, Welle 2)**

Vorgänger: F2-02 (`docs/spec/F2-02-varianten-vertiefung.md`) — Präzedenz gilt:
No-op-Disziplin (kein Event/Audit/Touch ohne Zustandsänderung), Promote-only,
Events via bestehendes `emitEvent`-Muster. Lock-Präzedenz: `reviseOfferVariant`
(`service.ts` Z.2880–2892: `readVariantContentLock` → `OfferBlockedError`).

## Scope

1. **D1-01 `duplicateOfferVariant` kopiert `optional_bundles` + `payment_option_id`
   der Quelle.** Katalog F2.2 „Duplizieren kopiert alles"; `is_primary=false`
   bleibt (stiehlt nie Primary, F2-02 Scope 4).
2. **D1-03 Content-Lock-Guards** in den vier revisionslosen Settern:
   `setPrimaryVariant`, `setOptionalBundles`, `setVariantPaymentOption`
   (variant-scoped) + `setTotalPriceOverride` (Scope: s. Service-Semantik).

## Nicht-Ziele

- Keine Migration (alle Spalten existieren).
- Kein VERIFIED-Umbau, keine UI-Änderung.
- Keine 5b/5d-Slices, kein Provider/Lock/Versand/Auto-Installation.
- Keine Änderung der Geld-/Rabatt-Mathematik, keine neue Permission.

## Datenmodell

- Kein Schema-Delta. `offer_variant.optional_bundles` (jsonb, ESTIMATE-Form
  `[{name, position}]`), `offer_variant.payment_option_id` (nullable FK) und
  `offer.total_price_override_net_cents` bestehen. `lockVariant` liefert beide
  Quellspalten bereits (`service.ts` Z.1946–1948).

## Service-Semantik

### D1-01 Duplikat-Kopie

- **DECIDED: `insertVariant`-Signatur erweitern** (optionale Felder
  `optionalBundles`, `paymentOptionId`), kein Nach-Update. Begründung: ein
  INSERT, atomar, keine zweite `updated_at`-Semantik, keine neue Roundtrip-
  Fehlerklasse. Nach-Update verworfen (extra Write + Touch-Frage ohne Nutzen).
- Kopie = Deep-Copy der Quelle zum Duplikat-Zeitpunkt (JSON-Wert, keine
  Referenz); `payment_option_id` wird **ungeprüft** übernommen — auch wenn die
  Option inzwischen archiviert ist (Copy, kein Neu-Assign; Historie-Präzedenz
  `setVariantPaymentOption`, Z.3232–3234: archivierte Bindung bleibt lesbar).
- Event/Audit unverändert (`offer.variant_duplicated`, `variant_duplicate`).

### D1-03 Lock-Guards

- **Fehlercodes (DECIDED):** `OfferBlockedError` mit denselben Codes wie
  `reviseOfferVariant`: `variant_signature_pending` / `variant_signed` /
  `variant_revoked_by_customer` (Mapping aus `readVariantContentLock`-Status).
- **Lock-Prüfung VOR No-op (DECIDED).** Begründung: revise-Präzedenz (Lock-Check
  Z.2886 steht vor No-op-Return Z.2901); ein stiller Erfolg auf gesperrter
  Variante würde den Signaturstatus verschleiern — der Client soll den Block
  explizit sehen. Reihenfolge je Setter: Rechte → Parse → Locks (kanonisch) →
  Lock-Guard → No-op-Check → Write → Event/Audit.
- **Events bei Block: keine (DECIDED).** Throw vor Event/Audit, kein
  `allowed:false`-Audit — Präzedenz revise, kein Rauschen ohne Zustandsänderung.
- `setOptionalBundles` / `setVariantPaymentOption`: Guard auf der Zielvariante
  via `readVariantContentLock` (bestehender Helper, kein neuer Code).
- `setPrimaryVariant`: Guard auf **Ziel- UND bisheriger Primary-Variante**
  (DECIDED). Begründung: Promote ändert die kundenwirksame Anzeige beider —
  ein Demote einer signierten Primary per Promote einer anderen würde den Lock
  umgehen. `previousPrimaryVariantId`-Lookup (Z.2973–2980) läuft vor dem Guard.
- `setTotalPriceOverride`: **Scope DECIDED — irgendeine Variante gelockt → Block.**
  Begründung: Offer-Level-Wert (F2.4-Deal-Wert, revisionslos wie Forecast),
  überlagert `displayTotalNetCents` der Primary und ist damit kundenwirksam.
  Nur-Primary-Prüfung verworfen (Primary kann fehlen/wechseln; Offer-Wert wirkt
  offer-weit). Umsetzung: `readVariantContentLocks` (Bulk-Helper Z.658–686)
  über alle Varianten-IDs des Offers nach `lockOffer`; Code-Priorität bei
  mehreren Locks wie Helper-Sortierung: revoked > signed > pending.

## Tests (RED zuerst)

- **F202B-DB-01** Duplikat übernimmt Bundles + Payment-Option (Deep-Copy:
  Quellenänderung danach berührt Kopie nicht), `is_primary=false`.
- **F202B-DB-02** Duplikat mit archivierter Payment-Option: Kopie behält
  `payment_option_id` (kein Validierungsfehler).
- **F202B-DB-03** Je Setter × Lock-Status (pending/signed/revoked):
  `OfferBlockedError` mit erwartetem Code, kein Write, kein Event/Audit.
- **F202B-DB-04** Lock vor No-op: wertgleicher Call auf gelockter Variante
  wirft (kein stiller `{changed:false}`/`alreadyPrimary`-Erfolg).
- **F202B-DB-05** `setPrimaryVariant`: gelockte bisherige Primary blockt
  Promote einer anderen Variante; beide ungelockt → Switch ok.
- **F202B-DB-06** `setTotalPriceOverride`: Lock auf Nicht-Primary-Variante
  blockt; ohne Locks → Set/Clear ok; Code-Priorität revoked > signed > pending.
- **F202B-DB-07** Ungelockt-Regression: alle vier Setter wie F2-02 (No-op ohne
  Event, Events mit Payload, Cross-Tenant → `OfferNotFoundError`).
- **F202B-UNIT-01** Code-Mapping Lock-Status → Block-Code (inkl. Bulk-Priorität).
- **F202B-E2E-01** Duplikat-Then-Read-back (Bundles + Zahlart sichtbar);
  Override-Block bei pending-Signatur (UI-Fehlermeldung, kein Redirect).

## Offene Punkte → FRAGEN-AN-MIKAIL.md

- O1: Soll ein geblockter Versuch später doch auditiert werden
  (`allowed:false`)? Spec sagt nein (revise-Präzedenz); Compliance-Bedarf offen.
- O2: `createVariantFromCurrentResolution` kopiert Bundles/Zahlart bewusst
  nicht (Resolution-Snapshot, kein Duplikat) — Bestätigung ausstehend.
