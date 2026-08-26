# Modul-Konvention

Jedes Fachmodul (crm, offers, invoicing, …) ist ein Ordner mit genau einer öffentlichen
Schnittstelle: `index.ts`. Interna (service.ts, queries.ts, …) sind privat — der Import
aus fremden Modul-Interna ist per dependency-cruiser CI-rot. Service-Funktionen nehmen
`TenantTx` + `ServiceCtx`, prüfen `can()`, emittieren `domain_events`. Referenz: `modules/sites/`.

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
