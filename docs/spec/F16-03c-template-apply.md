# F16.3 Slice C — Prozent-Vorlage global aufs Angebot anwenden

Status: **IMPLEMENTED (lokal verifiziert 2026-09-04: lint 0 Errors, typecheck, depcruise, generate ohne Drift, catalog-contract-check, E2E --list; DB-/E2E-Ausführung pending CI/Maschine — Billing-Block Q6)**

Lane: `codex/muse-welle-03-e2e` off `origin/codex/m1-wave-02`.
Vorgänger: F16.3-A/B (Vorlagen-CRUD + reine Arithmetik). Katalog: F16.3
„Rabatt/Förderung (Fix/Prozent mit Cap)". Das Variantenmodell kennt
global nur Prozent (`globalDiscountBps`, `set_global_discount`,
Gates `discount.apply`) — daher deckt dieser Slice nur Prozent ab.

## Angewendete Skill-Regeln
- reonic-parity: TDD RED→IMPLEMENTED, keine erfundenen Felder.
- Bestehende Operation wiederverwenden (`reviseOfferVariant` +
  `set_global_discount`), kein neues Snapshot-Feld, kein Contract-
  Versionssprung.

## Mapping-DECIDED
- Prozent-Vorlage mit `capCents = null` → `set_global_discount` mit
  `discountBps = template.percentBps` (wörtlich, via
  `reviseOfferVariant`; erwartet Revision per Caller).
- Prozent-Vorlage MIT Cap → `DiscountTemplateValidationError`
  (Cap-Verlust nie stillschweigend; Cap braucht Modellfeld → Slice D).
- Fix-Vorlage → `DiscountTemplateValidationError` (kein Fix-Mechanismus
  im Variantenmodell; `customDeal` ist Zielpreis, kein Rabatt).
- Subsidy-Vorlagen symmetrisch (`applySubsidyTemplateToOfferGlobal`).
- Rechte: `discount_template.read` + `discount.apply`
  (`reviseOfferVariant` prüft zusätzlich `project.write`).

## Scope
1. Service `applyDiscountTemplateToOfferGlobal(tx, ctx, {templateId,
   offerId, variantId, expectedRevision})` in `modules/discounts/`
   (+ Subsidy-Spiegel): aktive Vorlage laden, Mapping-Regeln,
   Delegation an `reviseOfferVariant`.
2. UI Angebots-Editor (Global-Rabatt-Bereich): Vorlagen-Dropdown
   („Aus Vorlage übernehmen", nur cap-freie Prozent-Vorlagen gelistet)
   → bestehende Server-Action mit `set_global_discount`-Operation.
   Fix-/Cap-Vorlagen erscheinen nicht (Titelzusatz erklärt nichts —
   Einstellungsseite bleibt Anlegeort).
3. Tests: (a) DB `f1603c-template-apply`: Prozent cap-frei → Revision
   trägt Bps; Cap-Vorlage → Validation; Fix → Validation; inaktive
   Vorlage → NotFound; ohne `discounts`-Cap → PermissionDenied;
   (b) E2E: vorhandene Angebots-Editor-Spec (m2-01) prüfen, ob globaler
   Rabatt per UI setzbar ist — dann Fall `F16.3-E2E-03` (Vorlage
   übernehmen, Bps sichtbar); sonst dokumentierter Fallback
   (Positivfall per DB-Test).

## Nicht-Ziele
- Kein Fix-/Cap-Apply (Slice D: neues Snapshot-Feld + money.ts + PDF).
- Keine Sektions-/Zeilen-Vorlagen, kein Portal-Schreibpfad.
- Keine Änderung an bestehenden Rabatt-Operationen.

## Akzeptanz
- `npm run check` grün, `db:generate` ohne Drift (kein Schema-Eingriff
  erwartet), E2E-Spec grün (CI), Reviews Exit-3 (Selbstreview + Gates).
