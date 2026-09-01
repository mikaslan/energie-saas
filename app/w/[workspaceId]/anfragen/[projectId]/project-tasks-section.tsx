"use client";

import Link from "next/link";
import {
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useFormStatus } from "react-dom";
import {
  PROJECT_TASK_COMMAND_VERSION,
  type ProjectTaskItemV1,
  type ProjectTaskWorkspaceV1,
  type TaskLabelColor,
} from "@/lib/integrations/tasks/contract";
import {
  changeProjectTask,
  type ProjectTaskActionState,
} from "./task-actions";
import { TaskRichTextRenderer } from "./task-rich-text-renderer";
import { ProjectTaskEditorDialog } from "./project-task-editor-dialog";

const INITIAL_TASK_ACTION_STATE: ProjectTaskActionState = { status: "idle" };

const TASK_LABEL_CLASSES: Record<TaskLabelColor, string> = {
  slate: "border-slate-300 bg-slate-50 text-slate-800",
  blue: "border-blue-200 bg-blue-50 text-blue-900",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
  amber: "border-amber-200 bg-amber-50 text-amber-950",
  rose: "border-rose-200 bg-rose-50 text-rose-900",
  violet: "border-violet-200 bg-violet-50 text-violet-900",
};

const dueDateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeZone: "Europe/Berlin",
});

function actionMessage(state: ProjectTaskActionState): string {
  switch (state.status) {
    case "idle": return "";
    case "success":
      if (!state.changed) return "Die Aufgabe war bereits auf diesem Stand.";
      if (state.operation === "quick_create" || state.operation === "create") {
        return "Die Aufgabe wurde erstellt.";
      }
      if (state.operation === "complete") return "Die Aufgabe wurde abgeschlossen.";
      if (state.operation === "reopen") return "Die Aufgabe wurde wieder geöffnet.";
      if (state.operation === "archive") return "Die Aufgabe wurde archiviert.";
      if (state.operation === "toggle_checklist_item") return "Die Checkliste wurde aktualisiert.";
      return "Die Aufgabe wurde aktualisiert.";
    case "invalid": return "Die Aufgabenänderung ist unvollständig oder ungültig.";
    case "conflict": return "Die Aufgabe wurde zwischenzeitlich geändert. Die Ansicht wurde aktualisiert.";
    case "illegal_transition": return "Dieser Statuswechsel ist nicht möglich.";
    case "archived": return "Archivierte Aufgaben können nicht mehr geändert werden.";
    case "limit_reached": return "Für diese Aufgabe wurde eine zulässige Obergrenze erreicht.";
    case "not_found": return "Die Aufgabe oder das Projekt ist nicht mehr verfügbar.";
    case "denied": return "Für diese Aufgabenänderung fehlt dir die Berechtigung.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu.";
  }
}

function formatDueAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Termin nicht verfügbar" : dueDateFormatter.format(date);
}

function LocalSubmitButton({
  children,
  pendingLabel,
  ariaLabel,
  className,
}: {
  children: ReactNode;
  pendingLabel: string;
  ariaLabel?: string;
  className: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending || undefined}
      aria-label={ariaLabel}
      className={className}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

function TaskCommandFields({
  projectId,
  task,
  kind,
}: {
  projectId: string;
  task: ProjectTaskItemV1;
  kind: "complete" | "reopen" | "archive";
}) {
  return (
    <>
      <input type="hidden" name="schemaVersion" value={PROJECT_TASK_COMMAND_VERSION} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={task.id} />
      <input type="hidden" name="expectedRevision" value={task.revision} />
      {kind === "archive" ? (
        <input type="hidden" name="archiveConfirmation" value="archive" />
      ) : null}
    </>
  );
}

function TaskCard({
  projectId,
  task,
  action,
  canWrite,
  onEdit,
}: {
  projectId: string;
  task: ProjectTaskItemV1;
  action: (formData: FormData) => void;
  canWrite: boolean;
  onEdit: (event: MouseEvent<HTMLButtonElement>, task: ProjectTaskItemV1) => void;
}) {
  const isArchived = task.archivedAt !== null;
  const completedChecklistItems = task.checklist.filter((item) => item.done).length;
  return (
    <article id={`project-task-${task.id}`} className="min-w-0 scroll-mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h4 className="break-words text-base font-semibold text-slate-950">{task.title}</h4>
          <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-600">
            <span className="rounded-full bg-slate-100 px-2 py-1">Stand {task.revision}</span>
            {task.dueAt ? (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-slate-700">
                Fällig {formatDueAt(task.dueAt)}
              </span>
            ) : null}
          </div>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${isArchived
          ? "bg-slate-200 text-slate-700"
          : task.status === "done"
            ? "bg-emerald-100 text-emerald-900"
            : "bg-blue-100 text-blue-900"}`}>
          {isArchived ? "Archiviert" : task.status === "done" ? "Erledigt" : "Offen"}
        </span>
      </div>

      {task.labels.length > 0 ? (
        <ul aria-label="Aufgabenlabels" className="mt-3 flex list-none flex-wrap gap-2">
          {task.labels.map((label) => (
            <li key={label.id} className={`max-w-full break-words rounded-full border px-2.5 py-1 text-xs ${TASK_LABEL_CLASSES[label.color]}`}>
              {label.name}
            </li>
          ))}
        </ul>
      ) : null}

      <TaskRichTextRenderer body={task.body} headingOffset={3} />

      {task.assignees.length > 0 ? (
        <p className="mt-3 break-words text-xs leading-5 text-slate-600">
          Zuständig: {task.assignees.map(({ label }) => label).join(", ")}
        </p>
      ) : null}

      {task.checklist.length > 0 ? (
        <div className="mt-4">
          <p
            aria-label={`Checklistfortschritt: ${completedChecklistItems} von ${task.checklist.length} erledigt`}
            className="text-xs font-semibold text-slate-600"
          >
            Checkliste: {completedChecklistItems}/{task.checklist.length} erledigt
          </p>
          <ul aria-label="Checkliste" className="mt-2 grid list-none gap-2">
            {task.checklist.map((item) => (
              <li key={item.id} className="min-w-0">
                {canWrite && !isArchived ? (
                  <form action={action}>
                    <input type="hidden" name="schemaVersion" value={PROJECT_TASK_COMMAND_VERSION} />
                    <input type="hidden" name="kind" value="toggle_checklist_item" />
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="taskId" value={task.id} />
                    <input type="hidden" name="expectedRevision" value={task.revision} />
                    <input type="hidden" name="checklistItemId" value={item.id} />
                    <input type="hidden" name="done" value={item.done ? "false" : "true"} />
                    <LocalSubmitButton
                      pendingLabel="Checkliste wird aktualisiert …"
                      ariaLabel={`${item.text} als ${item.done ? "offen" : "erledigt"} markieren`}
                      className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-md px-2 text-left text-sm text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-slate-400"
                    >
                      <span aria-hidden="true" className="shrink-0 text-base">{item.done ? "☑" : "☐"}</span>
                      <span className={`min-w-0 break-words ${item.done ? "text-slate-500 line-through" : ""}`}>{item.text}</span>
                    </LocalSubmitButton>
                  </form>
                ) : (
                  <div className="flex min-h-11 min-w-0 items-center gap-3 px-2 text-sm text-slate-700">
                    <span aria-hidden="true" className="shrink-0 text-base">{item.done ? "☑" : "☐"}</span>
                    <span className="sr-only">{item.done ? "Erledigt: " : "Offen: "}</span>
                    <span className={`min-w-0 break-words ${item.done ? "text-slate-500 line-through" : ""}`}>{item.text}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canWrite && !isArchived ? (
        <div className="mt-4 flex flex-wrap items-start gap-2 border-t border-slate-200 pt-4">
          <button
            type="button"
            onClick={(event) => onEdit(event, task)}
            className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Bearbeiten
          </button>
          <form action={action}>
            <TaskCommandFields
              projectId={projectId}
              task={task}
              kind={task.status === "done" ? "reopen" : "complete"}
            />
            <LocalSubmitButton
              pendingLabel="Status wird gespeichert …"
              className="min-h-11 rounded-md bg-blue-700 px-3 py-2 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400"
            >
              {task.status === "done" ? "Wieder öffnen" : "Abschließen"}
            </LocalSubmitButton>
          </form>
          <details className="group rounded-md border border-slate-300 bg-white">
            <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 py-2 text-sm font-semibold text-red-700 outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2">
              Archivieren
            </summary>
            <div className="max-w-sm border-t border-slate-200 p-3">
              <p className="text-xs leading-5 text-slate-600">
                Die Archivierung ist endgültig. Die Aufgabe bleibt ausschließlich im internen Verlauf lesbar.
              </p>
              <form action={action} className="mt-3">
                <TaskCommandFields projectId={projectId} task={task} kind="archive" />
                <LocalSubmitButton
                  pendingLabel="Aufgabe wird archiviert …"
                  className="min-h-11 rounded-md bg-red-700 px-3 py-2 text-sm font-semibold text-white outline-none hover:bg-red-800 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400"
                >
                  Endgültig archivieren
                </LocalSubmitButton>
              </form>
            </div>
          </details>
        </div>
      ) : null}
    </article>
  );
}

export function ProjectTasksSection({
  workspaceId,
  projectId,
  workspace,
  showingArchived,
  nextTaskHref,
  latestTaskHref,
}: {
  workspaceId: string;
  projectId: string;
  workspace: ProjectTaskWorkspaceV1;
  showingArchived: boolean;
  nextTaskHref: string | null;
  latestTaskHref: string | null;
}) {
  const boundAction = useMemo(
    () => changeProjectTask.bind(null, workspaceId, projectId),
    [projectId, workspaceId],
  );
  const [state, action] = useActionState(boundAction, INITIAL_TASK_ACTION_STATE);
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const editorReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTask, setEditorTask] = useState<ProjectTaskItemV1 | null>(null);
  const [editorFeedback, setEditorFeedback] = useState("");
  const message = editorFeedback || actionMessage(state);
  const isError = editorFeedback === ""
    && state.status !== "idle"
    && state.status !== "success";
  const taskCardMovedOrRemoved = state.status === "success"
    && state.changed
    && (
      state.operation === "complete"
      || state.operation === "reopen"
      || state.operation === "archive"
    );
  const detailPath = `/w/${workspaceId}/anfragen/${projectId}`;
  const currentEditorTask = editorTask === null
    ? null
    : [...workspace.open, ...workspace.done, ...workspace.archived]
        .find((task) => task.id === editorTask.id) ?? editorTask;

  const closeEditor = useCallback(() => setEditorOpen(false), []);
  const handleEditorSuccess = useCallback((feedback: string) => {
    setEditorFeedback(feedback);
  }, []);
  const runAction = useCallback((formData: FormData) => {
    setEditorFeedback("");
    action(formData);
  }, [action]);

  function openCreateEditor(event: MouseEvent<HTMLButtonElement>) {
    setEditorFeedback("");
    editorReturnFocusRef.current = event.currentTarget;
    setEditorTask(null);
    setEditorOpen(true);
  }

  function openEditEditor(event: MouseEvent<HTMLButtonElement>, task: ProjectTaskItemV1) {
    setEditorFeedback("");
    editorReturnFocusRef.current = event.currentTarget;
    setEditorTask(task);
    setEditorOpen(true);
  }

  useEffect(() => {
    if (isError || taskCardMovedOrRemoved) feedbackRef.current?.focus();
  }, [isError, state, taskCardMovedOrRemoved]);

  return (
    <section id="project-tasks" aria-labelledby="project-tasks-title" className="min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Arbeit</p>
          <h2 id="project-tasks-title" className="mt-1 text-xl font-semibold text-slate-950">Aufgaben</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Interne Aufgaben, Zuständigkeiten und Checklisten für dieses Projekt.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showingArchived ? (
            <Link
              href={`${detailPath}#project-tasks`}
              className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Aktive Aufgaben
            </Link>
          ) : workspace.archivedCount > 0 ? (
            <Link
              href={`${detailPath}?tasks=archived#project-tasks`}
              className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Archiv anzeigen ({workspace.archivedCount})
            </Link>
          ) : null}
          {workspace.permissions.canWrite && !showingArchived ? (
            <button type="button" onClick={openCreateEditor} className="min-h-11 rounded-md border border-blue-700 bg-white px-4 py-2 text-sm font-semibold text-blue-800 outline-none hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
              Vollständige Aufgabe
            </button>
          ) : null}
        </div>
      </div>

      {workspace.permissions.canWrite && !showingArchived ? (
        <form action={runAction} className="mt-5 grid min-w-0 gap-2 rounded-lg border border-blue-200 bg-blue-50 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <input type="hidden" name="schemaVersion" value={PROJECT_TASK_COMMAND_VERSION} />
          <input type="hidden" name="kind" value="quick_create" />
          <input type="hidden" name="projectId" value={projectId} />
          <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-blue-950">
            Neue Aufgabe
            <input
              type="text"
              name="title"
              aria-label="Neue Aufgabe"
              minLength={1}
              maxLength={200}
              required
              className="min-h-11 min-w-0 rounded-md border border-blue-300 bg-white px-3 text-base font-normal text-slate-950 outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1"
            />
          </label>
          <LocalSubmitButton
            pendingLabel="Wird gespeichert …"
            className="min-h-11 rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400"
          >
            Aufgabe anlegen
          </LocalSubmitButton>
        </form>
      ) : !showingArchived ? (
        <p className="mt-5 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
          Du kannst Aufgaben und Checklisten sehen, aber nicht verändern.
        </p>
      ) : null}

      <p
        ref={feedbackRef}
        tabIndex={-1}
        role={isError ? "alert" : "status"}
        aria-live={isError ? "assertive" : "polite"}
        aria-atomic="true"
        className={message
          ? `mt-4 rounded-md border px-3 py-2 text-sm outline-none ${isError
            ? "border-amber-200 bg-amber-50 text-amber-950"
            : "border-emerald-200 bg-emerald-50 text-emerald-950"}`
          : "sr-only"}
      >
        {message}
      </p>

      {workspace.open.length === 0 && workspace.done.length === 0 && workspace.archived.length === 0 ? (
        <p className="mt-5 rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-600">
          {showingArchived ? "Noch keine archivierten Aufgaben vorhanden." : "Noch keine Aufgaben vorhanden."}
        </p>
      ) : null}

      {workspace.open.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Offen</h3>
          <div className="mt-3 grid min-w-0 gap-3">
            {workspace.open.map((task) => (
              <TaskCard key={task.id} projectId={projectId} task={task} action={runAction} canWrite={workspace.permissions.canWrite} onEdit={openEditEditor} />
            ))}
          </div>
        </div>
      ) : null}

      {workspace.done.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Erledigt</h3>
          <div className="mt-3 grid min-w-0 gap-3">
            {workspace.done.map((task) => (
              <TaskCard key={task.id} projectId={projectId} task={task} action={runAction} canWrite={workspace.permissions.canWrite} onEdit={openEditEditor} />
            ))}
          </div>
        </div>
      ) : null}

      {workspace.archived.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Archiv</h3>
          <div className="mt-3 grid min-w-0 gap-3">
            {workspace.archived.map((task) => (
              <TaskCard key={task.id} projectId={projectId} task={task} action={runAction} canWrite={false} onEdit={openEditEditor} />
            ))}
          </div>
        </div>
      ) : null}

      {latestTaskHref !== null || nextTaskHref !== null ? (
        <nav aria-label="Aufgabenseiten" className="mt-6 flex flex-wrap gap-2 border-t border-slate-200 pt-4">
          {latestTaskHref !== null ? (
            <Link
              href={latestTaskHref}
              className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Erste Aufgabenseite
            </Link>
          ) : null}
          {nextTaskHref !== null ? (
            <Link
              href={nextTaskHref}
              className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-3 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Weitere Aufgaben
            </Link>
          ) : null}
        </nav>
      ) : null}

      {editorOpen && !showingArchived ? (
        <ProjectTaskEditorDialog
          key={currentEditorTask?.id ?? "create"}
          workspaceId={workspaceId}
          projectId={projectId}
          task={currentEditorTask}
          returnFocusRef={editorReturnFocusRef}
          onSuccess={handleEditorSuccess}
          onClose={closeEditor}
        />
      ) : null}
    </section>
  );
}
