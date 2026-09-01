import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const INBOX = "app/w/[workspaceId]/aufgaben";
const PROJECT = "app/w/[workspaceId]/anfragen/[projectId]";

describe("M1-12a globale Aufgaben-Inbox UI-Vertrag", () => {
  it("lädt ausschließlich serverseitig über die interne task.read-Grenze", async () => {
    const page = await readFile(`${INBOX}/page.tsx`, "utf8");
    const view = await readFile(`${INBOX}/task-inbox-view.tsx`, "utf8");
    expect(page).toContain('"task.read"');
    expect(page).toContain('"global_task_inbox"');
    expect(page).toContain("getGlobalTaskInboxPage(tx, ctx, query)");
    expect(page).toContain("GlobalTaskInboxContractError");
    expect(page).toContain("DeniedState");
    expect(view).not.toContain('"use client"');
    expect(view).not.toContain("changeProjectTask");
    expect(view).not.toContain("useActionState");
    expect(view).not.toContain("form action=");
  });

  it("bietet geschlossene GET-Filter und ausschließlich den Projekt-Deep-Link", async () => {
    const view = await readFile(`${INBOX}/task-inbox-view.tsx`, "utf8");
    expect(view).toContain('method="get"');
    expect(view).toContain('role="search"');
    for (const field of ["filter", "state", "dueBucket", "query"]) {
      expect(view).toContain(`name="${field}"`);
    }
    expect(view).toContain("assigned_by_me");
    expect(view).toContain("Von mir erstellt");
    expect(view).toContain("Sucht im Titel und im sicheren Beschreibungstext.");
    expect(view).toContain("#project-tasks");
    expect(view).not.toContain("#project-task-");
    expect(view).not.toContain("assigneeMembershipIds");
    expect(view).not.toContain("createdByActorId");
  });

  it("hält External aus der Navigation und die Projektmutation als einzige Wahrheit", async () => {
    const requests = await readFile("app/w/[workspaceId]/anfragen/page.tsx", "utf8");
    const project = await readFile(`${PROJECT}/page.tsx`, "utf8");
    const actions = await readFile(`${PROJECT}/task-actions.ts`, "utf8");
    expect(requests).toContain('board.audience === "internal"');
    expect(requests).toContain("/aufgaben");
    expect(project.indexOf('pageDetail.audience === "assigned_external"'))
      .toBeLessThan(project.indexOf("Alle Aufgaben"));
    expect(actions).toContain('revalidatePath(`/w/${workspaceId}/aufgaben`)');
  });

  it("stellt Tastatur-, Reflow- und Textsignale ohne reine Farbbedeutung bereit", async () => {
    const view = await readFile(`${INBOX}/task-inbox-view.tsx`, "utf8");
    expect(view).toContain("Zur Aufgabenliste springen");
    expect(view).toContain('aria-current="page"');
    expect(view).toContain('aria-describedby="task-query-help"');
    expect(view).toContain("Überfällig ·");
    expect(view).toContain("Heute fällig ·");
    expect(view).toContain("min-h-11");
    expect(view).toContain("break-words");
  });

  it("macht das Sprungziel des Skip-Links programmatisch fokussierbar", async () => {
    const view = await readFile(`${INBOX}/task-inbox-view.tsx`, "utf8");
    const target = view.indexOf('id="global-task-inbox-main"');
    expect(target).toBeGreaterThan(-1);
    expect(view.indexOf('href="#global-task-inbox-main"')).toBeLessThan(target);
    // tabIndex muss am Sprungziel selbst stehen, nicht irgendwo in der Datei.
    expect(view.slice(target, target + 200)).toContain("tabIndex={-1}");
  });

  it("setzt das Filterformular nach einer reinen Parameternavigation zurück", async () => {
    const view = await readFile(`${INBOX}/task-inbox-view.tsx`, "utf8");
    const form = view.indexOf('method="get"');
    expect(form).toBeGreaterThan(-1);
    // Der key muss jeden Wert tragen, den ein defaultValue abbildet.
    const head = view.slice(Math.max(0, form - 400), form);
    expect(head).toContain("key={");
    for (const field of ["page.filter", "page.state", "page.dueBucket", "page.query"]) {
      expect(head, `key muss ${field} enthalten`).toContain(field);
    }
  });

  it("hält den Ladezustand unter Reduced Motion still und maschinenlesbar", async () => {
    // Der Ladezustand ist im Browser nur in einem Rennfenster sichtbar. Statt
    // ihn per Routenabfangen in einem flackernden E2E zu erzwingen, wird der
    // Vertrag hier gepinnt.
    const loading = await readFile(`${INBOX}/loading.tsx`, "utf8");
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("motion-reduce:animate-none");
    expect(loading).toContain("Aufgaben-Inbox wird geladen");
  });

  it("bietet der Error Boundary den Vertragsnamen dieser Next-Version", async () => {
    // node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md
    // benennt die Prop dieser Version ausdrücklich `retry`, nicht `reset`.
    const boundary = await readFile(`${INBOX}/error.tsx`, "utf8");
    expect(boundary).toContain('"use client"');
    expect(boundary).toContain("retry");
    expect(boundary).toContain('role="alert"');
    expect(boundary).not.toContain("reset()");
  });

  it("dopppelt die Marke nicht im Seitentitel", async () => {
    const page = await readFile(`${INBOX}/page.tsx`, "utf8");
    const layout = await readFile("app/layout.tsx", "utf8");
    expect(layout).toContain("template:");
    expect(page).toContain('title: "Aufgaben"');
    expect(page).not.toContain("Aufgaben | WMEE");
  });

  it("führt die Anmeldung verlässlich in die Inbox zurück", async () => {
    const page = await readFile(`${INBOX}/page.tsx`, "utf8");
    // Der freie Suchtext darf nicht ins Rücksprungziel: ein wörtliches
    // Prozentzeichen lässt safeInternalNextPath fail-closed auf "/" fallen.
    expect(page).toContain("globalTaskInboxHref(workspaceId, { ...query, query: null })");
  });

  it("meldet Projektionsfehler als Serverfehler statt als 404", async () => {
    const page = await readFile(`${INBOX}/page.tsx`, "utf8");
    const branch = page.slice(page.indexOf("GlobalTaskInboxContractError"));
    expect(branch).toContain('error.code === "invalid_global_task_inbox_projection"');
    expect(branch).toContain("throw error");
    // Query- und Cursorfehler bleiben ein ehrliches 404.
    expect(page).toContain('if (result.kind === "invalid") notFound()');
  });
});
