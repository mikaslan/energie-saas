# F16.3 Slice D — Fix-Rabatt-Modell global (Snapshot-v2, Geld, PDF, UI)

Status: **SPECIFIED (DISCOVERED abgeschlossen)**

Lane: `codex/muse-welle-03-e2e` off `origin/codex/m1-wave-02`.
Vorgänger: F16.3-C (Prozent-Apply). Katalog: F16.3 „Fix mit Cap".
Problem: Das Variantenmodell kennt global nur Prozent; Fix-Beträge und
Caps haben kein Zielfeld. `customDeal` ist Zielpreis (kein Rabatt-Ziel)
und wird NICHT zweckentfremdet.

## Kern-DECIDED (Integrität)
- Neues Snapshot-Feld `globalFixDiscountCents` (nullable, Cent-Integer).
  Es MUSS in den kanonischen Hash — sonst wäre der Fix-Betrag nicht
  siegelgebunden. Folglich Snapshot-Versionssprung
  `offer-variant-snapshot.v1` → `.v2`.
- Dual-Read (einziger Engpass `validateOfferVariantSnapshot`): v2
  primär, v1-Fallback für siegelgebundene Historie (Issuance/PDF lesen
  alte Revisionen). Schreiber schreiben IMMER v2. Kein Rewrite alter
  Zeilen (Revisionen sind WORM-Historie).
- Geldlogik (money.ts, nach globalem Prozent, vor Steuer-Neuberechnung):
  Fix vom rabattierten Basis-Total abziehen (floor 0), pro-rata auf
  Basis-Zeilen allokieren (eigener Helper, Rundung half-up wie Bestand;
  Optional-Zeilen unberührt — wie globaler Prozent-Rabatt).
- Cap-Semantik Fix: Fix-Vorlagen tragen per CHECK keinen Cap
  (`subsidy_template_cap_ck`/`discount`-Analogon) — Apply übernimmt den
  Betrag wörtlich, floor am Total 0.

## Scope
1. Contract: `globalFixDiscountCents` in Basis-Schema (nullable, default
   null für v1-Lesung — aber kanonisch enthalten, sobald gesetzt),
   `OFFER_VARIANT_SNAPSHOT_VERSION = "offer-variant-snapshot.v2"`,
   Dual-Read in `validateOfferVariantSnapshot` (v2→v1), neue Operation
   `set_global_fix_discount` (moneyCents, `discount.apply`-Gate wie
   `set_global_discount`).
2. money.ts: `OfferPricingInput.globalFixDiscountCents`,
   Allokations-Helper + Line/Totals-Konsistenz (Semantik-Check bleibt
   grün per Konstruktion).
3. Service `applyDiscountTemplateToOfferGlobal`: Fix-Zweig
   (cap-frei per CHECK garantiert) → `set_global_fix_discount`;
   Subsidy-Spiegel. Cap-Prozent weiter Validation (Cap gehört an die
   Prozent-Allokation — Folgeslice E, kein Teil von D).
4. Anzeige: „Globaler Fix-Rabatt" in pdf-template + issuance-template
   (Bedingung: nur wenn nicht null; Format wie CustomDeal-Zeile).
5. Editor: „Globaler Fix-Rabatt €"-Eingabe (Draft/Model/Validierung im
   customDeal-Muster) + Vorlagen-Dropdown listet zusätzlich Fix-
   Vorlagen (Label „… € · Rabatt/Förderung").
6. Tests: (a) DB `f1603d-fix-discount`: Fix-Apply → Totals − Betrag,
   Zeilen-Allokation summiert, v1-Altrevision weiter lesbar (v1-Body im
   Test kanonisch siegeln — Implementierungsdetail im Slice);
   (b) Unit money-Matrix (Fix 0/Teil/Voll/Rundung/Optional-Ausschluss);
   (c) E2E-04 (Fix-Vorlage → Übernehmen → Save → Total − Betrag).

## Nicht-Ziele
- Kein Cap-Apply bei Prozent (Slice E: Cap als Allokations-Deckel).
- Keine Sektions-/Zeilen-Fixbeträge, keine Portal-Schreibpfade.
- Kein Umschreiben von v1-Historie.

## Akzeptanz
- `npm run check` grün (inkl. aller bestehenden Offer-/Issuance-/PDF-
  Tests — Dual-Read beweist sich an v1-Bestand), `db:generate` ohne
  Drift (kein Tabellen-Eingriff), E2E-Spec grün (CI),
  Reviews Exit-3 (Selbstreview + Gates).
- Risikoflag: größter Slice der Welle (Snapshot-Versionssprung) —
  Review-Schwerpunkt Dual-Read + Allokations-Rundung.
