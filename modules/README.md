# Modul-Konvention

Jedes Fachmodul (crm, offers, invoicing, …) ist ein Ordner mit genau einer öffentlichen
Schnittstelle: `index.ts`. Interna (service.ts, queries.ts, …) sind privat — der Import
aus fremden Modul-Interna ist per dependency-cruiser CI-rot. Service-Funktionen nehmen
`TenantTx` + `ServiceCtx`, prüfen `can()`, emittieren `domain_events`. Referenz: `modules/sites/`.

## Tenant-Entitäten: zusammengesetzte Schlüssel sind Pflicht

Foreign-Key-Prüfungen in PostgreSQL verwenden RLS **nicht** als Sichtbarkeitsfilter. Ein
einfacher `site_id`-FK aus Workspace A kann deshalb problemlos auf eine Site aus Workspace B
zeigen — die Mandantengrenze wäre über die Referenz umgangen (Codex-Review #7).

Daraus folgen zwei bindende Regeln für jede Tenant-Entität:

1. **Jede Tenant-Tabelle trägt zusätzlich zum Primary Key ein `UNIQUE (workspace_id, id)`.**
   Referenz: `site_ws_id_uq` in `lib/db/schema/site.ts`.
2. **Jeder FK auf eine Tenant-Entität ist ZUSAMMENGESETZT**, nie einspaltig:

   ```sql
   -- richtig: die Zieltabelle muss im SELBEN Workspace liegen
   alter table project add constraint project_site_fk
     foreign key (workspace_id, site_id) references site (workspace_id, id);

   -- falsch: erlaubt eine Site aus einem fremden Workspace
   alter table project add constraint project_site_fk
     foreign key (site_id) references site (id);
   ```

Zusätzlich hat jede Tenant-Tabelle einen FK `workspace_id → workspace.id`, damit keine Zeile
in einem gar nicht existierenden Workspace landen kann.

## RLS-Policies: genau EINE permissive Policy pro Tenant-Tabelle

PostgreSQL verknüpft mehrere **permissive** Policies mit **OR**. Eine zweite permissive Policy
neben `tenant_isolation` würde die Mandantengrenze also *öffnen*, nicht verengen — der
geplante `external_only`-Filter wäre wirkungslos oder gäbe sogar fremde Zeilen frei
(Codex-Review #6).

Vertrag, den `tests/db/tenant-invariants.test.ts` erzwingt:

- Pro Tenant-Tabelle existiert **genau eine** permissive Policy: `tenant_isolation`.
- **Jeder** zusätzliche Filter (z. B. `external_only`, Assignment-Sichtbarkeit) MUSS
  `create policy … as restrictive …` sein. Restrictive Policies werden mit AND verknüpft
  und können die Grenze deshalb nur verengen.
- `with check` darf nie fehlen und nie `true` sein — sonst bleiben Cross-Tenant-Inserts und
  Workspace-Transfers möglich, obwohl `using` korrekt aussieht.

## Durchsetzung

`npm run depcruise` (Teil von `npm run check`) erzwingt drei Regeln
(`.dependency-cruiser.cjs`):

- **module-internals-sind-privat** — ein Modul darf nur `index.ts` eines *anderen*
  Moduls importieren, nie dessen Interna. Zugriffe innerhalb des eigenen Moduls
  bleiben erlaubt.
- **lib-kennt-keine-module** — `lib/` (Fundament) darf nicht von `modules/` abhängen,
  auch nicht über `index.ts`.
- **app-nur-module-public-api** — `app/` (Routen, Server Actions) darf ausschließlich
  über `index.ts` auf ein Modul zugreifen, nie an dessen Internas vorbei.

Verstöße sind ein Build-Fehler (`severity: "error"`), kein Warning.
