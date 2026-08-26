/**
 * Modulgrenzen (Architektur §1):
 *  - Module reden nur über ihre index.ts miteinander, nie über Interna.
 *  - lib/ ist das Fundament und darf nicht von modules/ abhängen (sonst
 *    Zirkularität / Schicht-Inversion).
 *  - app/ (Routen, Server Actions) greift nie an der öffentlichen Schnittstelle
 *    eines Moduls vorbei auf dessen Interna zu.
 *
 * Hinweis zu den `to.path`-Regexen: `$1` referenziert die in `from.path`
 * erfasste Capture-Gruppe (dependency-cruiser ersetzt `$<n>`-Platzhalter aus
 * den `from`-Matches, siehe src/utl/regex-util.mjs#replaceGroupPlaceholders —
 * NICHT das Regex-Backreference-Zeichen `\1`, das innerhalb eines einzelnen
 * Patterns auf eine eigene, vorher definierte Gruppe verweist).
 */
module.exports = {
  forbidden: [
    {
      name: "module-internals-sind-privat",
      comment:
        "Module reden nur über ihre index.ts miteinander (Architektur §1). " +
        "Imports von Interna (service.ts, queries.ts, …) eines FREMDEN Moduls " +
        "sind verboten; Zugriffe innerhalb des eigenen Moduls bleiben erlaubt.",
      severity: "error",
      from: { path: "^modules/([^/]+)/" },
      to: { path: "^modules/(?!$1/)([^/]+)/(?!index\\.ts$).+" },
    },
    {
      name: "lib-kennt-keine-module",
      comment: "lib/ ist Fundament und darf nicht von Modulen abhängen.",
      severity: "error",
      from: { path: "^lib/" },
      to: { path: "^modules/" },
    },
    {
      name: "app-nur-module-public-api",
      comment: "Routen/Actions greifen nie an Modul-Interna vorbei.",
      severity: "error",
      from: { path: "^app/" },
      to: { path: "^modules/[^/]+/(?!index\\.ts$).+" },
    },
    {
      name: "db-client-nur-ueber-tenant",
      comment:
        "lib/db/client.ts (roher App-Pool/Db, OHNE app.workspace_id) darf NUR " +
        "von lib/db/tenant.ts importiert werden. Jeder andere Import wäre ein " +
        "Umgehungspfad an withTenant/withAuthorizedTenant, RLS-Kontext, " +
        "Outbox und Audit vorbei (Codex-Review, MUSS vor Merge). Auth hat aus " +
        "demselben Grund einen EIGENEN Client: lib/db/auth-client.ts.",
      severity: "error",
      from: { pathNot: "^lib/db/tenant\\.ts$" },
      to: { path: "^lib/db/client\\.ts$" },
    },
    {
      name: "auth-client-nur-fuer-auth",
      comment:
        "lib/db/auth-client.ts ist die Verbindung OHNE Mandantenkontext für " +
        "better-auth. Domänencode (modules/, app/, übriges lib/) hat dort " +
        "nichts zu suchen — der legale Weg ist withTenant/withAuthorizedTenant.",
      severity: "error",
      from: { pathNot: "^lib/auth\\.ts$" },
      to: { path: "^lib/db/auth-client\\.ts$" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
  },
};
