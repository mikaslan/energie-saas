# F16.3 Slice E — Cap-Prozent global (Snapshot-v3, Geld, UI)

Status: **IMPLEMENTED (lokal verifiziert 2026-09-04: lint 0 Errors, typecheck, depcruise, generate ohne Drift, catalog-contract-check, E2E-05 --list, DB-frei 1020 passed/21 nur Umgebung; DB-/E2E-Ausführung pending CI/Maschine — Billing-Block Q6)**

Lane: `codex/muse-welle-03-e2e` off `origin/codex/m1-wave-02`.
Vorgänger: F16.3-D (Fix-Modell, Snapshot-v2). Katalog: F16.3 „Fix mit
Cap“ (letzter offener Unterpunkt: gedeckelte Prozent-Vorlagen sind
global noch abgewiesen — `modules/discounts/service.ts` und
`modules/subsidies/service.ts` werfen ValidationError).
Problem: Der Cap (`capCents`, Cent-Integer, nullable) steckt nur in der
Vorlage. Der Snapshot kennt ihn nicht — serverautoritatives Repricing
(`repriceSnapshot` rechnet allein aus Snapshot-Feldern) könnte
gedeckelte Totale nicht reproduzieren. Folglich muss der Cap ins Siegel.

## Kern-DECIDED (Integrität)
- Neues Snapshot-Feld `globalDiscountCapCents` (nullable, Cent-Integer,
  null = ungedeckelt). Es MUSS in den kanonischen Hash — sonst wäre das
  Total nicht aus dem Snapshot reproduzierbar. Folglich
  `offer-variant-snapshot.v2` → `.v3`.
- Triple-Read (`validateOfferVariantSnapshot`): v3 primär, v2-Fallback
  (Fix-Key vorhanden, Cap auf null normalisiert), v1-Fallback (beide
  Keys fehlen, beide null). Schreiber schreiben IMMER v3. Kein Rewrite
  alter Zeilen (WORM-Historie). Muster aus Slice D wiederverwenden
  (eine Kette je Version, ein Minimaltyp für die Semantikprüfung).
- Geldlogik (money.ts, in `applyDiscount`): Rabattbetrag =
  min(Prozentbetrag, Cap); Cap null = ungedeckelt. Allokation weiter
  über Largest-Remainder auf Basis-Zeilen; Floor 0 bleibt. Fix und Cap
  sind kombinierbar (Reihenfolge: Prozent (gedeckelt) → Fix → Steuer).
- Operation `set_global_discount` bekommt optionales `capCents`
  (moneyCents, nullable, default null). Cap-Gate: derselbe
  `discount.apply`-Check wie bisher. `set_global_fix_discount` bleibt
  cap-frei (per CHECK garantiert, Slice D).
- Apply (`applyDiscountTemplateToOfferGlobal` + Subsidy-Spiegel):
  Prozent-Vorlage mit Cap → `set_global_discount` mit wörtlichem
  Prozent UND wörtlichem Cap (nie still verlieren, nie umrechnen).
  Prozent ohne Cap → wie bisher (Cap null).

## Scope
1. Contract: `globalDiscountCapCents` ins Basis-Schema (nullable),
   `OFFER_VARIANT_SNAPSHOT_VERSION = "offer-variant-snapshot.v3"`,
   Triple-Read, `set_global_discount` + `capCents`, neuer
   `OFFER_SCHEMA_SHA256`-Pin (Generator + Contract-Test).
2. money.ts: `OfferPricingInput.globalDiscountCapCents`, Cap in
   `applyDiscount` (min-Deckel), Service-Threading (Resolution-Build,
   Reprice).
3. DB: Migration 0066 (CHECK v1/v2/v3), Schema-Check spiegeln.
4. PDF/Issuance: keine neue Zeile (Totale sind korrekt); Builder
   übernehmen den Cap-Key (strikte Schemas!).
5. Editor: Cap-Anzeige neben Prozent (nur wenn gesetzt, „gedeckelt auf
   X €“), Detail-View dito; Vorlagen-Dropdown listet Cap-Vorlagen mit
   Cap-Hinweis im Label.
6. Tests: (a) DB `f1603e-cap-prozent`: Cap-Apply → Total = Basis −
   min(Prozent, Cap), ungedeckelt unverändert, v2-Historie lesbar
   (Cap null normalisiert); (b) Unit money-Matrix (Cap 0/Teil/bindend/
   nicht-bindend); (c) E2E-05 (Cap-Vorlage → Übernehmen → Save →
   Total gedeckelt).
7. Fixture-Migration + Golden-Pins (m202/m203a/m203b1) wie Slice D,
   kanonisches Delta per Strip-Beweis belegen.

## Nicht-Ziele
- Kein Cap bei Fix (per CHECK cap-frei), keine Sektions-/Zeilen-Caps,
  keine Portal-Schreibpfade, kein Umschreiben von v1/v2-Historie.

## Akzeptanz
- Lokale Gates grün (lint 0 Errors, typecheck, depcruise, generate ohne
  Drift, catalog-check, E2E-05 --list), DB-frei ohne neue Fails,
  Reviews Exit-3, Push auf Lane, CI lesen.
- Risikoflag: zweiter Versionssprung in Folge — Review-Schwerpunkt
  Triple-Read + Cap-an-der-Kante (Cap 0, Cap = Prozentbetrag exakt,
  Cap > Prozentbetrag).
