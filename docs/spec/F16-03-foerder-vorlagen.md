# F16.3 Slice B — Förder-Vorlagen (Fix/Prozent mit Cap)

Status: **IMPLEMENTED (lokal verifiziert 2026-09-04: lint 0 Errors, typecheck, depcruise, generate ohne Drift, Unit 30/30 via Temp-Config, E2E --list; DB-/E2E-Ausführung pending CI/Maschine — Billing-Block Q6)**

Lane: `codex/muse-welle-03-e2e` off `origin/codex/m1-wave-02`.
Vorgänger: F16.3-A Rabatt-Vorlagen (Muster in allem: Tabelle, Contract,
Service, UI, Tests). Katalog: F16.3 „Förderung (Fix/Prozent mit Cap/
Steuerabzug)"; M2-Objekt `SubsidyLineItem` (eigener Typ neben
`DiscountTemplate` — kein kind-Feld, getrennte Tabelle).

## Angewendete Skill-Regeln
- reonic-parity: TDD RED→IMPLEMENTED, keine erfundenen Felder.
- contract-first, database-migrations: wie Slice A (§2.2/§2.3/§2.4,
  0061 ist frei, Pins per Orakel-Q).

## Scope
1. Migration `0061_f16_03_subsidy_templates`: `subsidy_template`
   (Spalten/CHECKs/Indexe/Uniques/FK wie `discount_template`, Namen
   getauscht) + RLS FORCE + `tenant_isolation` im 0053-Muster.
2. Rollenvertrag: `SUBSIDY_TEMPLATE_RELATIONS`, APPLY-Grants
   select/insert/update (kein DELETE), Policy-Pin per Orakel-Q.
3. Berechtigung: `subsidy_template.read` (viewer, internalOnly) +
   `subsidy_template.write` (editor + Capability `discounts`,
   internalOnly) — DECIDED: keine neue Capability (Geld-Vorlagen
   teilen sich `discounts`; Matrix 45→47).
4. Contract `lib/integrations/subsidies/contract.ts` (Version 1, DTO +
   Create/Update wie Discounts), Service `modules/subsidies/`
   (CRUD + Events/Audit + reine `applySubsidyTemplate`, identische
   Arithmetik), UI `einstellungen/foerder-vorlagen/` (Spiegel, Texte
   getauscht).
5. Tests: DB (CRUD, Conflict, Archiv-Re-Create, kind-Bruch, Cap-Gate,
   Tenant-Trennung), Unit (Apply-Matrix), E2E (Fix + Prozent per UI).
   Zähler 61.

## Nicht-Ziele
- Kein Steuerabzug im Template (wie Slice A: Angebotslogik).
- Kein Anwenden im Angebot (F16.3-C mit Rabatt-Apply zusammen).
- Kein Löschen, keine weiteren Typen.

## Akzeptanz
- `npm run check` grün, `db:generate` ohne Drift, E2E-Spec grün (CI),
  Reviews Exit-3 (Selbstreview + Gates).
