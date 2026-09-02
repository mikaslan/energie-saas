"use client";

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
  PROJECT_NOTE_COMMAND_VERSION,
  type ProjectNoteItemV1,
  type ProjectNotePageV1,
} from "@/lib/integrations/notes/note-contract";
import {
  changeProjectNote,
  type ProjectNoteActionState,
} from "./note-actions";
import { NoteMarkdownRenderer } from "./note-markdown-renderer";
import { NoteEditorDialog } from "./note-editor-dialog";

const INITIAL_STATE: ProjectNoteActionState = { status: "idle" };

const dateTimeFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

function actionMessage(state: ProjectNoteActionState): string {
  switch (state.status) {
    case "idle": return "";
    case "success":
      if (!state.changed) return "Die Notiz war bereits auf diesem Stand.";
      if (state.operation === "create_note") return "Die Notiz wurde erstellt.";
      if (state.operation === "update_note_text") return "Die Notiz wurde aktualisiert.";
      if (state.operation === "set_note_pinned") return "Die Notiz wurde angepinnt bzw. gelöst.";
      if (state.operation === "delete_note") return "Die Notiz wurde gelöscht.";
      return "Die Notiz wurde geändert.";
    case "invalid": return "Die Notizänderung ist unvollständig oder ungültig.";
    case "conflict": return "Die Notiz wurde zwischenzeitlich geändert. Die Ansicht wurde aktualisiert.";
    case "not_found": return "Die Notiz oder das Projekt ist nicht mehr verfügbar.";
    case "denied": return "Für diese Notizänderung fehlt dir die Berechtigung.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu.";
  }
}

function formatDateTime(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dateTimeFormatter.format(date);
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

function NoteCard({
  projectId,
  note,
  action,
  canWrite,
  onEdit,
}: {
  projectId: string;
  note: ProjectNoteItemV1;
  action: (formData: FormData) => void;
  canWrite: boolean;
  onEdit: (event: MouseEvent<HTMLButtonElement>, note: ProjectNoteItemV1) => void;
}) {
  const editedAt = formatDateTime(note.editedAt);
  const createdAt = formatDateTime(note.createdAt);
  return (
    <article id={`project-note-${note.id}`} className={`min-w-0 scroll-mt-6 rounded-lg border bg-white p-4 shadow-sm ${note.pinned ? "border-blue-300 ring-1 ring-blue-100" : "border-slate-200"}`}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {note.pinned ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-900">
              <span aria-hidden="true">📌</span> Angepinnt
            </span>
          ) : null}
          <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">Stand {note.revision}</span>
        </div>
        <span className="text-xs text-slate-500">
          {note.createdByLabel} · {createdAt}
        </span>
      </div>

      <NoteMarkdownRenderer textMarkdown={note.textMarkdown} />

      {(editedAt !== "" || note.pinnedByLabel !== null) ? (
        <p className="mt-2 text-xs leading-5 text-slate-500">
          {note.pinnedByLabel !== null ? `Angepinnt von ${note.pinnedByLabel}` : null}
          {note.pinnedByLabel !== null && editedAt !== "" ? " · " : null}
          {editedAt !== "" ? `Zuletzt bearbeitet von ${note.editedByLabel} am ${editedAt}` : null}
        </p>
      ) : null}

      {canWrite ? (
        <div className="mt-4 flex flex-wrap items-start gap-2 border-t border-slate-200 pt-4">
          <form action={action}>
            <input type="hidden" name="schemaVersion" value={PROJECT_NOTE_COMMAND_VERSION} />
            <input type="hidden" name="kind" value="set_note_pinned" />
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="noteId" value={note.id} />
            <input type="hidden" name="expectedRevision" value={note.revision} />
            <input type="hidden" name="pinned" value={note.pinned ? "false" : "true"} />
            <LocalSubmitButton
              pendingLabel="Wird gespeichert …"
              ariaLabel={note.pinned ? "Notiz lösen" : "Notiz anpinnen"}
              className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-slate-400"
            >
              {note.pinned ? "Lösen" : "Anpinnen"}
            </LocalSubmitButton>
          </form>
          <button
            type="button"
            onClick={(event) => onEdit(event, note)}
            className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Bearbeiten
          </button>
          <details className="group rounded-md border border-slate-300 bg-white">
            <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 py-2 text-sm font-semibold text-red-700 outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2">
              Löschen
            </summary>
            <div className="max-w-sm border-t border-slate-200 p-3">
              <p className="text-xs leading-5 text-slate-600">
                Die Notiz wird dauerhaft entfernt und ist danach nicht mehr sichtbar.
              </p>
              <form action={action} className="mt-3">
                <input type="hidden" name="schemaVersion" value={PROJECT_NOTE_COMMAND_VERSION} />
                <input type="hidden" name="kind" value="delete_note" />
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="noteId" value={note.id} />
                <input type="hidden" name="expectedRevision" value={note.revision} />
                <LocalSubmitButton
                  pendingLabel="Notiz wird gelöscht …"
                  className="min-h-11 rounded-md bg-red-700 px-3 py-2 text-sm font-semibold text-white outline-none hover:bg-red-800 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400"
                >
                  Endgültig löschen
                </LocalSubmitButton>
              </form>
            </div>
          </details>
        </div>
      ) : null}
    </article>
  );
}

export function ProjectNotesSection({
  workspaceId,
  projectId,
  page,
}: {
  workspaceId: string;
  projectId: string;
  page: ProjectNotePageV1;
}) {
  const boundAction = useMemo(
    () => changeProjectNote.bind(null, workspaceId, projectId),
    [projectId, workspaceId],
  );
  const [state, action] = useActionState(boundAction, INITIAL_STATE);
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const editorReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorNote, setEditorNote] = useState<ProjectNoteItemV1 | null>(null);
  const [editorFeedback, setEditorFeedback] = useState("");
  const message = editorFeedback || actionMessage(state);
  const isError = editorFeedback === "" && state.status !== "idle" && state.status !== "success";
  const currentEditorNote = editorNote === null
    ? null
    : page.notes.find((note) => note.id === editorNote.id) ?? editorNote;

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
    setEditorNote(null);
    setEditorOpen(true);
  }

  function openEditEditor(event: MouseEvent<HTMLButtonElement>, note: ProjectNoteItemV1) {
    setEditorFeedback("");
    editorReturnFocusRef.current = event.currentTarget;
    setEditorNote(note);
    setEditorOpen(true);
  }

  useEffect(() => {
    if (isError) feedbackRef.current?.focus();
  }, [isError, state]);

  return (
    <section id="project-notes" aria-labelledby="project-notes-title" className="min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Akte</p>
          <h2 id="project-notes-title" className="mt-1 text-xl font-semibold text-slate-950">Notizen</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Freie Notizen zu diesem Projekt. Angepinnte Notizen stehen oben.
          </p>
        </div>
        {page.permissions.canWrite ? (
          <button type="button" onClick={openCreateEditor} className="min-h-11 rounded-md border border-blue-700 bg-white px-4 py-2 text-sm font-semibold text-blue-800 outline-none hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
            Notiz anlegen
          </button>
        ) : null}
      </div>

      {!page.permissions.canWrite ? (
        <p className="mt-5 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
          Du kannst Notizen sehen, aber nicht verändern.
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

      {page.notes.length === 0 ? (
        <p className="mt-5 rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-600">
          Noch keine Notizen vorhanden.
        </p>
      ) : (
        <div className="mt-6 grid min-w-0 gap-3">
          {page.notes.map((note) => (
            <NoteCard
              key={note.id}
              projectId={projectId}
              note={note}
              action={runAction}
              canWrite={page.permissions.canWrite}
              onEdit={openEditEditor}
            />
          ))}
        </div>
      )}

      {editorOpen ? (
        <NoteEditorDialog
          key={currentEditorNote?.id ?? "create"}
          workspaceId={workspaceId}
          projectId={projectId}
          note={currentEditorNote}
          returnFocusRef={editorReturnFocusRef}
          onSuccess={handleEditorSuccess}
          onClose={closeEditor}
        />
      ) : null}
    </section>
  );
}
