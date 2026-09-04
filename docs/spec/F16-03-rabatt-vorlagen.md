# F16.3 Slice A — Rabatt-Vorlagen (Fix/Prozent mit Cap)

Status: **SPECIFIED (DISCOVERED abgeschlossen)**

Lane: `codex/muse-welle-03-e2e` off `origin/codex/m1-wave-02`.
Vorgänger: F7.3 Checklisten-Vorlagen (Muster: Tabelle + Contract +
Service + Einstellungs-UI). Katalog: F16.3 „Rabatt (Fix/Prozent mit
Cap/Steuerabzug)" (Modulkatalog M16).

## Angewendete Skill-Regeln
- reonic-parity: TDD RED→IMPLEMENTED, keine erfundenen Felder.
- contract-first: Template-DTO + Commands im eigenen Vertrag.
- database-migrations: Tabelle per Migration (Nummer GLOBAL prüfen:
  0060 ist frei); RLS + Grants + Rollenvertrag-Pins (§2.2/§2.3);
  Zähler (§2.4); DB-CHECKs symmetrisch zu Zod.

## Scope
1. Migration `0060_f16_03_discount_templates`: `discount_template`
   mit (id, workspace_id, name, name_normalized, kind
   [`fix_cents`|`percent_bps`], amount_cents NULL, percent_bps NULL,
   cap_cents NULL, active, position, created_by, updated_by,
   created_at, updated_at) — CHECKs: Name-Form wie Checklisten (200,
   kein Lead-Space, kein Control); kind-abhängige Belegung (fix →
   amount_cents gesetzt + percent NULL, percent → umgekehrt;
   percent_bps 1..10000; amount_cents ≥ 0; cap nur bei percent,
   cap_cents ≥ 0); Timestamps. Indexe/Uniques wie Checklisten
   (ws/active/position, ws+id, ws+name partial-active). RLS FORCE +
   `tenant_isolation` im 0053-Muster (keine Actor-Policies —
   Rollenprüfung im Service, 0050/0057-Präzedenz).
2. Rollenvertrag: `DISCOUNT_TEMPLATE_RELATIONS = ["discount_template"]`
   (Inventar + RLS/FORCE + Grants-Verify fließen automatisch);
   APPLY: revoke + grant select/insert/update an app_runtime (kein
   DELETE — Archiv statt Löschen, Checklisten-Muster); Policy-Pin
   `discount_template:tenant_isolation:<sha256>` mit bewiesenem Q
   (0053-SQL ist template-identisch).
3. Berechtigung: NEU `discount_template.read` (viewer, internalOnly) +
   `discount_template.write` (editor + Capability `discounts`,
   internalOnly) — additiv, economics.write-Muster. Kein Bestand
   ändert sich.
4. Contract `lib/integrations/discounts/contract.ts`:
   `DISCOUNT_TEMPLATE_SCHEMA_VERSION = 1`, DTO (id, name, kind,
   amountCents, percentBps, capCents, position, active, createdAt,
   updatedAt, permissions.canWrite), Create-/Update-Commands
   (Name-Clean wie Checklisten; kind-Diskriminante beide-oder-keiner
   je Zweig; percent_bps 1..10000; cap nur percent).
5. Service `modules/discounts/` (service.ts, errors.ts, index.ts):
   `listDiscountTemplates` (includeArchived, active-first-Sort wie
   Checklisten), `create/update/archive/restoreDiscountTemplate`
   (requireRead/Write, 23505 → Conflict, 23514 → Validation, Events
   + Audit wie Checklisten), PLUS reine Funktion
   `applyDiscountTemplate(netCents, template)` → discountedCents
   (fix: max(0, net − amount); percent: Skonto = floor(net·bps/10000),
   gedeckelt auf cap; clamped ≥ 0; integer-Arithmetik, kein Float).
6. UI `app/w/[workspaceId]/einstellungen/rabatt-vorlagen/`
   (page + actions + manager, Checklisten-Spiegel): Liste (Name, Art,
   Wert, Cap, Status), Create-/Edit-Form (kind-Umschalter Fix/Prozent,
   Cap nur bei Prozent eingeblendet), Archivieren/Wiederherstellen.
   Kein Einstellungs-Index zu pflegen (keiner verlinkt Subseiten).
7. Tests: (a) Vitest-DB: CRUD, Name-Doppelt → Conflict (aktiv),
   Archiv/Reaktivieren, kind-Verletzung → Validation, Tenant-Trennung
   (zweiter Workspace sieht nichts), Viewer lesen/Extern denied
   (Capability-Gate: Editor OHNE discounts-Cap denied);
   Unit: Apply-Matrix (fix, fix>net→0, percent, percent+cap,
   100 %, Cent-Rundung floor); (b) E2E (W3-Workspace, kein Projekt
   nötig — Einstellungsseite): Fix-Vorlage + Prozent-Vorlage per UI
   anlegen, beide gelistet.

## Nicht-Ziele
- Kein Steuerabzug (Steuer rechnet das Angebot downstream; Template
  kennt nur Netto-Sicht — Katalog-„Steuerabzug" ist Angebotslogik,
  eigener Slice mit F4-Anbindung).
- Kein Anwenden im Angebots-Editor (eigener Slice F16.3-B; braucht
  Angebots-Schreibpfad + `discount.apply`-Verdrahtung).
- Kein Löschen (Archiv statt Delete, Checklisten-Muster).
- Keine weiteren Vorlagentypen (Förderung, Task, Termin, E-Mail,
  File-Request, Angebot, Planung) — eigene Slices.

## Akzeptanz
- `npm run check` grün, `db:generate` ohne Drift, E2E-Spec grün (CI),
  Reviews Exit-3 (Selbstreview + Gates).
- Editor ohne `discounts`-Capability kann NICHT schreiben
  (Test-Aussage — das Gate ist der Sinn der Capability).
- Zähler + Rollenvertrag grün (Pin per bewiesenem Q).
