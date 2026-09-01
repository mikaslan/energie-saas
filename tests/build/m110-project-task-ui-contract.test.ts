import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const DETAIL = "app/w/[workspaceId]/anfragen/[projectId]";

describe("M1-10 Task-UI-Core-Vertrag", () => {
  it("rendert Richtext ausschließlich strukturell ohne HTML-Sink", async () => {
    const renderer = await readFile(`${DETAIL}/task-rich-text-renderer.tsx`, "utf8");
    expect(renderer).toContain("taskRichTextV1Schema.parse");
    expect(renderer).toContain("<strong>");
    expect(renderer).toContain("<em>");
    expect(renderer).not.toContain("dangerouslySetInnerHTML");
    expect(renderer).not.toContain("innerHTML");
    expect(renderer).not.toContain("parseHTML");
  });

  it("hält Quick Create, Status, Fokus und Viewer-Grenze zugänglich", async () => {
    const section = await readFile(`${DETAIL}/project-tasks-section.tsx`, "utf8");
    expect(section).toContain("useActionState");
    expect(section).toContain("changeProjectTask.bind(null, workspaceId, projectId)");
    expect(section).toContain('name="title"');
    expect(section).toContain('aria-label="Neue Aufgabe"');
    expect(section).toContain("if (isError || taskCardMovedOrRemoved) feedbackRef.current?.focus()");
    expect(section).toContain('state.operation === "complete"');
    expect(section).toContain('state.operation === "reopen"');
    expect(section).toContain('state.operation === "archive"');
    expect(section).toContain("useFormStatus");
    expect(section).toContain("setEditorFeedback(\"\")");
    expect(section).toContain("Checklistfortschritt");
    expect(section).not.toContain('canWrite && !isArchived && task.status === "open"');
    expect(section).toContain('role={isError ? "alert" : "status"}');
    expect(section).toContain("workspace.permissions.canWrite");
    expect(section).toContain("min-h-11");
    expect(section).toContain("break-words");
    expect(section).not.toContain("dangerouslySetInnerHTML");
  });

  it("projiziert Activity nur über geschlossene Ereignisbezeichnungen", async () => {
    const panel = await readFile(`${DETAIL}/project-activity-panel.tsx`, "utf8");
    expect(panel).toContain("ACTIVITY_LABELS");
    expect(panel).toContain("item.taskTitle");
    expect(panel).toContain("Aufgabe:");
    expect(panel).toContain('<ol role="list"');
    expect(panel).toContain("<time");
    expect(panel).not.toContain("eventType");
    expect(panel).not.toContain("payload");
  });

  it("lädt interne Aufgaben und Aktivität erst nach der External-Verzweigung", async () => {
    const page = await readFile(`${DETAIL}/page.tsx`, "utf8");
    const externalBoundary = page.indexOf(
      'if (pageDetail.audience === "assigned_external")',
    );
    const taskRead = page.indexOf(
      "const taskPageResult = await loadProjectTaskPage(",
      externalBoundary,
    );

    expect(externalBoundary).toBeGreaterThan(-1);
    expect(taskRead).toBeGreaterThan(externalBoundary);
    expect(page).toContain('"task.read"');
    expect(page).toContain('"project_task_page"');
    expect(page).toContain("<ProjectTasksSection");
    expect(page).toContain("<ProjectActivityPanel");
    expect(page).toContain("activityAt");
    expect(page).toContain("activityId");
  });

  it("stellt Full Create und Edit als fokussierten echten Tiptap-Dialog bereit", async () => {
    const editor = await readFile(`${DETAIL}/project-task-editor-dialog.tsx`, "utf8");
    const section = await readFile(`${DETAIL}/project-tasks-section.tsx`, "utf8");

    expect(editor).toContain("useEditor");
    expect(editor).toContain("StarterKit.configure");
    expect(editor).toContain("immediatelyRender: false");
    expect(editor).toContain('role="dialog"');
    expect(editor).toContain('aria-modal="true"');
    expect(editor).toContain('aria-describedby');
    expect(editor).toContain('aria-errormessage');
    expect(editor).toContain('event.key === "Tab"');
    expect(editor).toContain("onEditorTab");
    expect(editor).toContain("input:not([type='hidden']):not([disabled])");
    expect(editor).toContain("returnTarget?.focus()");
    expect(editor).toContain("onSuccess(editorMessage(state))");
    expect(editor).toContain("toggleBold()");
    expect(editor).toContain("toggleItalic()");
    expect(editor).toContain('name="bodyJson"');
    expect(editor).toContain('name="assigneeIdsJson"');
    expect(editor).toContain('name="checklistJson"');
    expect(editor).toContain('name="labelsJson"');
    expect(editor).toContain("onSubmit={submitEditor}");
    expect(editor).toContain("event.preventDefault()");
    expect(editor).toContain("startFormTransition(() => formAction(formData))");
    expect(editor).not.toContain("<form action={formAction}");
    expect(editor).toContain("state.currentRevision");
    expect(editor).toContain("const [initialEditorDocument] = useState(() => (");
    expect(editor).toContain("taskBodyToEditorDocument(initialBody)");
    expect(editor).toContain("content: initialEditorDocument,");
    expect(editor).toContain('const [title, setTitle] = useState(() => task?.title ?? "")');
    expect(editor).toContain("const [dueDate, setDueDate] = useState(() => dueDateValue(task?.dueAt ?? null))");
    expect(editor).toContain("value={title}");
    expect(editor).toContain("onChange={(event) => setTitle(event.target.value)}");
    expect(editor).toContain("value={dueDate}");
    expect(editor).toContain("onChange={(event) => setDueDate(event.target.value)}");
    expect(editor).not.toContain('defaultValue={task?.title ?? ""}');
    expect(editor).not.toContain("defaultValue={dueDateValue(task?.dueAt ?? null)}");
    expect(editor).not.toContain("initialEditorDocument.current");
    expect(editor).toContain("}, [publish]);");
    expect(editor).not.toContain("}, [initialBody, publish]);");
    expect(editor).toContain("editor.setEditable(!disabled)");
    expect(editor).toContain('editable.setAttribute("aria-disabled", disabled ? "true" : "false")');
    expect(editor).toContain("disabled={!editor || disabled}");
    expect(editor).toContain("disabled={pending}");
    expect(editor).toContain("searchProjectTaskMembers");
    expect(editor).toContain("task?.assignees");
    expect(editor).toContain("PROJECT_TASK_MEMBER_SEARCH_LIMIT");
    expect(editor).not.toContain('role="toolbar"');
    expect(editor).not.toContain("ring-blue-600/30");
    expect(editor).not.toContain("dangerouslySetInnerHTML");
    expect(section).toContain("<ProjectTaskEditorDialog");
    expect(section).toContain("editorFeedback");
    expect(section).toContain("onSuccess={handleEditorSuccess}");
    expect(section).toContain('kind={task.status === "done" ? "reopen" : "complete"}');
    expect(section).toContain("TASK_LABEL_CLASSES[label.color]");
  });

  it("trennt Client-Verträge von der öffentlichen serverseitigen Task-API", async () => {
    const editor = await readFile(`${DETAIL}/project-task-editor-dialog.tsx`, "utf8");
    const section = await readFile(`${DETAIL}/project-tasks-section.tsx`, "utf8");
    const model = await readFile(`${DETAIL}/task-editor-model.ts`, "utf8");
    const renderer = await readFile(`${DETAIL}/task-rich-text-renderer.tsx`, "utf8");
    const page = await readFile(`${DETAIL}/page.tsx`, "utf8");
    const actions = await readFile(`${DETAIL}/task-actions.ts`, "utf8");
    const service = await readFile("modules/tasks/service.ts", "utf8");
    for (const clientFile of [editor, section, model, renderer]) {
      expect(clientFile).not.toContain('from "@/modules/tasks');
      expect(clientFile).toContain('from "@/lib/integrations/tasks/contract"');
    }
    for (const serverFile of [page, actions]) {
      expect(serverFile).toContain('from "@/modules/tasks"');
      expect(serverFile).not.toContain('from "@/modules/tasks/');
    }
    expect(service.startsWith('import "server-only";')).toBe(true);
  });

  it("fällt bei fehlerhaften oder wiederholten Task-Queries auf sichere Defaults zurück", async () => {
    const page = await readFile(`${DETAIL}/page.tsx`, "utf8");
    expect(page).toContain("safeActivityQuery");
    expect(page).toContain('typeof value === "string"');
    expect(page).not.toContain("if (!parsedActivityQuery.success) notFound()");
  });

  it("macht echte Task-Folgeseiten erreichbar und lädt Task plus Activity gemeinsam", async () => {
    const page = await readFile(`${DETAIL}/page.tsx`, "utf8");
    const section = await readFile(`${DETAIL}/project-tasks-section.tsx`, "utf8");
    expect(page).toContain("getProjectTaskPage");
    expect(page).toContain("taskCursor");
    expect(page).toContain("nextTaskCursor");
    expect(page).toContain("nextTaskHref");
    expect(section).toContain("Weitere Aufgaben");
    expect(section).not.toContain("workspace.members");
  });

  it("macht weitere Activity-Seiten explizit erreichbar", async () => {
    const panel = await readFile(`${DETAIL}/project-activity-panel.tsx`, "utf8");
    expect(panel).toContain("activity.nextCursor");
    expect(panel).toContain("nextHref");
    expect(panel).toContain("<Link");
    expect(panel).toContain("Ältere Aktivität");
  });

  it("hält das einwegige Archiv lesbar und getrennt von der Standardliste", async () => {
    const page = await readFile(`${DETAIL}/page.tsx`, "utf8");
    const section = await readFile(`${DETAIL}/project-tasks-section.tsx`, "utf8");
    expect(page).toContain('tasks: z.literal("archived").optional()');
    expect(page).toContain("archived: showingArchived,");
    expect(section).toContain("showingArchived");
    expect(section).toContain("Archiv anzeigen");
    expect(section).toContain("Aktive Aufgaben");
  });
});
