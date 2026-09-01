"use client";

import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  useActionState,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent,
  type FormEvent,
  type MutableRefObject,
  type RefObject,
} from "react";
import {
  EMPTY_TASK_RICH_TEXT_V1,
  PROJECT_TASK_COMMAND_VERSION,
  PROJECT_TASK_MAX_ASSIGNEES,
  PROJECT_TASK_MAX_CHECKLIST_ITEMS,
  PROJECT_TASK_MAX_LABELS,
  PROJECT_TASK_MEMBER_SEARCH_LIMIT,
  taskLabelColors,
  type ProjectTaskItemV1,
  type ProjectTaskMemberOptionV1,
  type TaskLabelColor,
  type TaskRichTextV1,
} from "@/lib/integrations/tasks/contract";
import {
  changeProjectTask,
  searchProjectTaskMembers,
  type ProjectTaskActionState,
  type ProjectTaskMemberSearchState,
} from "./task-actions";
import {
  taskBodyFromEditor,
  taskBodyToEditorDocument,
} from "./task-editor-model";

type LocalChecklistItem = {
  clientKey: string;
  id: string | null;
  text: string;
  done: boolean;
};

type LocalLabel = {
  clientKey: string;
  id: string | null;
  name: string;
  color: TaskLabelColor;
};

const INITIAL_EDITOR_STATE: ProjectTaskActionState = { status: "idle" };
const INITIAL_MEMBER_SEARCH_STATE: ProjectTaskMemberSearchState = { status: "idle" };

const editorExtensions = [
  StarterKit.configure({
    blockquote: false,
    code: false,
    codeBlock: false,
    dropcursor: false,
    gapcursor: false,
    heading: { levels: [2, 3] },
    horizontalRule: false,
    link: false,
    strike: false,
    underline: false,
    trailingNode: false,
  }),
];

const colorLabels: Record<TaskLabelColor, string> = {
  slate: "Grau",
  blue: "Blau",
  emerald: "Grün",
  amber: "Gelb",
  rose: "Rot",
  violet: "Violett",
};

const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([type='hidden']):not([disabled])",
  "select:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function dueDateValue(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => (
    parts.find((item) => item.type === type)?.value ?? ""
  );
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function editorMessage(state: ProjectTaskActionState): string {
  switch (state.status) {
    case "idle": return "";
    case "success": return state.operation === "create"
      ? "Die vollständige Aufgabe wurde erstellt."
      : "Die Aufgabendetails wurden gespeichert.";
    case "invalid": return "Prüfe Titel, Beschreibung, Datum und Listenfelder.";
    case "conflict": return state.currentRevision === undefined
      ? "Die Aufgabe wurde zwischenzeitlich geändert. Deine Eingaben bleiben erhalten; lade die Seite neu und versuche es erneut."
      : `Die Aufgabe wurde zwischenzeitlich geändert. Deine Eingaben bleiben erhalten. Speichere erneut mit Stand ${state.currentRevision}.`;
    case "illegal_transition": return "Diese Aufgabe kann in ihrem aktuellen Zustand nicht bearbeitet werden.";
    case "archived": return "Archivierte Aufgaben können nicht mehr bearbeitet werden.";
    case "limit_reached": return "Eine zulässige Aufgabenobergrenze wurde erreicht.";
    case "not_found": return "Die Aufgabe oder das Projekt ist nicht mehr verfügbar.";
    case "denied": return "Für diese Änderung fehlt dir die Berechtigung.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu.";
  }
}

function memberSearchMessage(state: ProjectTaskMemberSearchState): string {
  switch (state.status) {
    case "idle": return "";
    case "results": return state.hasMore
      ? `Die ersten ${PROJECT_TASK_MEMBER_SEARCH_LIMIT} Treffer werden angezeigt. Grenze die Suche weiter ein.`
      : `${state.members.length} passende ${state.members.length === 1 ? "Person" : "Personen"} gefunden.`;
    case "empty": return `Keine interne Person für „${state.query}“ gefunden.`;
    case "invalid": return "Gib mindestens zwei Zeichen für die Personensuche ein.";
    case "not_found": return "Das Projekt ist nicht mehr verfügbar.";
    case "denied": return "Die interne Personensuche ist für dich nicht freigegeben.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu.";
  }
}

function ToolbarButton({
  label,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  pressed?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`min-h-11 rounded-md border px-3 py-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-slate-400 ${pressed
        ? "border-blue-700 bg-blue-50 text-blue-900"
        : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"}`}
    >
      {label}
    </button>
  );
}

function TaskRichTextEditor({
  initialBody,
  onBodyChange,
  editorDocumentRef,
  describedById,
  invalid,
  disabled,
  onEditorTab,
}: {
  initialBody: TaskRichTextV1;
  onBodyChange: (value: string, valid: boolean) => void;
  editorDocumentRef: MutableRefObject<(() => unknown) | null>;
  describedById: string;
  invalid: boolean;
  disabled: boolean;
  onEditorTab: (backward: boolean) => void;
}) {
  // A conflict revalidation may refresh the server task while this dialog is
  // still open. Keep the editor's first document stable so the user's local
  // body is not replaced before they retry with the refreshed revision.
  const [initialEditorDocument] = useState(() => (
    taskBodyToEditorDocument(initialBody)
  ));
  const publish = useCallback((document: unknown) => {
    const result = taskBodyFromEditor(document);
    onBodyChange(JSON.stringify(result.body), result.valid);
  }, [onBodyChange]);
  const editor = useEditor({
    extensions: editorExtensions,
    content: initialEditorDocument,
    immediatelyRender: false,
    enableContentCheck: true,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "Aufgabenbeschreibung",
        "aria-multiline": "true",
        "aria-describedby": describedById,
        "aria-invalid": invalid ? "true" : "false",
        class: "min-h-32 break-words px-3 py-3 text-sm leading-6 text-slate-900 outline-none",
      },
    },
    onCreate: ({ editor: currentEditor }) => publish(currentEditor.getJSON()),
    onUpdate: ({ editor: currentEditor }) => publish(currentEditor.getJSON()),
  }, [publish]);
  const active = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      bold: currentEditor?.isActive("bold") ?? false,
      italic: currentEditor?.isActive("italic") ?? false,
      paragraph: currentEditor?.isActive("paragraph") ?? false,
      heading2: currentEditor?.isActive("heading", { level: 2 }) ?? false,
      heading3: currentEditor?.isActive("heading", { level: 3 }) ?? false,
      bulletList: currentEditor?.isActive("bulletList") ?? false,
      orderedList: currentEditor?.isActive("orderedList") ?? false,
    }),
  });

  useEffect(() => {
    editorDocumentRef.current = editor ? () => editor.getJSON() : null;
    return () => {
      editorDocumentRef.current = null;
    };
  }, [editor, editorDocumentRef]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
    const editable = editor.view.dom;
    editable.setAttribute("aria-describedby", describedById);
    editable.setAttribute("aria-invalid", invalid ? "true" : "false");
    editable.setAttribute("aria-disabled", disabled ? "true" : "false");
    if (invalid) {
      editable.setAttribute("aria-errormessage", describedById);
    } else {
      editable.removeAttribute("aria-errormessage");
    }
  }, [describedById, disabled, editor, invalid]);

  return (
    <div className="rounded-md border border-slate-300 bg-white focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-600 focus-within:ring-offset-2">
      <div className="flex flex-wrap gap-1 border-b border-slate-200 bg-slate-50 p-2">
        <ToolbarButton label="Fett" pressed={active?.bold} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleBold().run()} />
        <ToolbarButton label="Kursiv" pressed={active?.italic} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleItalic().run()} />
        <ToolbarButton label="Absatz" pressed={active?.paragraph} disabled={!editor || disabled} onClick={() => editor?.chain().focus().setParagraph().run()} />
        <ToolbarButton label="Überschrift 2" pressed={active?.heading2} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} />
        <ToolbarButton label="Überschrift 3" pressed={active?.heading3} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} />
        <ToolbarButton label="Aufzählung" pressed={active?.bulletList} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleBulletList().run()} />
        <ToolbarButton label="Nummerierte Liste" pressed={active?.orderedList} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleOrderedList().run()} />
        <ToolbarButton label="Zeilenumbruch" disabled={!editor || disabled} onClick={() => editor?.chain().focus().setHardBreak().run()} />
      </div>
      <EditorContent
        editor={editor}
        onKeyDownCapture={(event) => {
          if (disabled) return;
          if (event.key !== "Tab") return;
          event.preventDefault();
          event.stopPropagation();
          onEditorTab(event.shiftKey);
        }}
      />
    </div>
  );
}

export function ProjectTaskEditorDialog({
  workspaceId,
  projectId,
  task,
  returnFocusRef,
  onSuccess,
  onClose,
}: {
  workspaceId: string;
  projectId: string;
  task: ProjectTaskItemV1 | null;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onSuccess: (message: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const bodyFeedbackId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const memberSearchInputRef = useRef<HTMLInputElement | null>(null);
  const editorDocumentRef = useRef<(() => unknown) | null>(null);
  const localKey = useRef(0);
  const boundAction = useMemo(
    () => changeProjectTask.bind(null, workspaceId, projectId),
    [projectId, workspaceId],
  );
  const boundMemberSearch = useMemo(
    () => searchProjectTaskMembers.bind(null, workspaceId, projectId),
    [projectId, workspaceId],
  );
  const [state, formAction, pending] = useActionState(boundAction, INITIAL_EDITOR_STATE);
  const [memberSearchState, memberSearchAction, memberSearchPending] = useActionState(
    boundMemberSearch,
    INITIAL_MEMBER_SEARCH_STATE,
  );
  const [, startFormTransition] = useTransition();
  const [, startMemberSearchTransition] = useTransition();
  // Keep persisted scalars controlled as part of the local draft. Submission
  // below uses an explicit transition instead of a form action so React cannot
  // auto-reset any field after a resolved domain conflict.
  const [title, setTitle] = useState(() => task?.title ?? "");
  const [dueDate, setDueDate] = useState(() => dueDateValue(task?.dueAt ?? null));
  const [bodyJson, setBodyJson] = useState(() => JSON.stringify(task?.body ?? EMPTY_TASK_RICH_TEXT_V1));
  const [bodyValid, setBodyValid] = useState(true);
  const [selectedAssignees, setSelectedAssignees] = useState<ProjectTaskMemberOptionV1[]>(
    () => task?.assignees.map(({ membershipId, label }) => ({ membershipId, label })) ?? [],
  );
  const [checklist, setChecklist] = useState<LocalChecklistItem[]>(() => (
    task?.checklist.map((item) => ({
      clientKey: item.id,
      id: item.id,
      text: item.text,
      done: item.done,
    })) ?? []
  ));
  const [labels, setLabels] = useState<LocalLabel[]>(() => (
    task?.labels.map((label) => ({
      clientKey: label.id,
      id: label.id,
      name: label.name,
      color: label.color,
    })) ?? []
  ));
  const message = editorMessage(state);
  const isError = state.status !== "idle" && state.status !== "success";
  const expectedRevision = task === null
    ? null
    : state.status === "conflict" && state.currentRevision !== undefined
      ? Math.max(task.revision, state.currentRevision)
      : task.revision;
  const memberMessage = memberSearchMessage(memberSearchState);
  const memberSearchError = memberSearchState.status === "invalid"
    || memberSearchState.status === "not_found"
    || memberSearchState.status === "denied"
    || memberSearchState.status === "unauthenticated";

  const onBodyChange = useCallback((value: string, valid: boolean) => {
    setBodyJson(value);
    setBodyValid(valid);
  }, []);

  useEffect(() => {
    const returnTarget = returnFocusRef.current;
    titleRef.current?.focus();
    return () => {
      returnTarget?.focus();
    };
  }, [returnFocusRef]);

  useEffect(() => {
    if (state.status !== "idle" && state.status !== "success") {
      feedbackRef.current?.focus();
    }
  }, [state]);

  useEffect(() => {
    if (
      state.status === "success"
      && (state.operation === "create" || state.operation === "update")
    ) {
      onSuccess(editorMessage(state));
      onClose();
    }
  }, [onClose, onSuccess, state]);

  function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!pending) onClose();
      return;
    }
    if (event.key === "Tab") {
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        DIALOG_FOCUSABLE_SELECTOR,
      ) ?? []);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (focusable.length === 0) {
        event.preventDefault();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }

  const onEditorTab = useCallback((backward: boolean) => {
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      DIALOG_FOCUSABLE_SELECTOR,
    ) ?? []);
    const activeIndex = focusable.findIndex((element) => element === document.activeElement);
    if (activeIndex < 0) return;
    const target = focusable[activeIndex + (backward ? -1 : 1)];
    target?.focus();
  }, []);

  function toggleAssignee(member: ProjectTaskMemberOptionV1) {
    setSelectedAssignees((current) => current.some(
      ({ membershipId }) => membershipId === member.membershipId,
    )
      ? current.filter(({ membershipId }) => membershipId !== member.membershipId)
      : current.length < PROJECT_TASK_MAX_ASSIGNEES
        ? [...current, member]
        : current);
  }

  function runMemberSearch() {
    const formData = new FormData();
    formData.set("query", memberSearchInputRef.current?.value ?? "");
    startMemberSearchTransition(() => memberSearchAction(formData));
  }

  function nextKey(prefix: string): string {
    localKey.current += 1;
    return `${prefix}-${localKey.current}`;
  }

  function submitEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const currentDocument = editorDocumentRef.current?.();
    const hiddenBody = form.elements.namedItem("bodyJson");
    if (currentDocument === undefined || !(hiddenBody instanceof HTMLInputElement)) {
      setBodyValid(false);
      return;
    }
    const result = taskBodyFromEditor(currentDocument);
    const serialized = JSON.stringify(result.body);
    hiddenBody.value = serialized;
    setBodyJson(serialized);
    setBodyValid(result.valid);
    if (!result.valid) return;
    const formData = new FormData(form);
    startFormTransition(() => formAction(formData));
  }

  const checklistJson = JSON.stringify(checklist.map((item) => task === null
    ? { text: item.text, done: item.done }
    : { id: item.id, text: item.text, done: item.done }));
  const labelsJson = JSON.stringify(labels.map((label) => task === null
    ? { name: label.name, color: label.color }
    : { id: label.id, name: label.name, color: label.color }));

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/60 p-2 sm:p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={onDialogKeyDown}
        className="max-h-[calc(100dvh-1rem)] w-full max-w-3xl overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Aufgabe</p>
            <h1 id={titleId} className="mt-1 break-words text-xl font-semibold text-slate-950">
              {task ? "Aufgabe bearbeiten" : "Vollständige Aufgabe anlegen"}
            </h1>
            <p id={descriptionId} className="mt-2 text-sm leading-6 text-slate-600">
              Titel, Beschreibung, Fälligkeit, Personen, Checkliste und Labels werden gemeinsam gespeichert.
            </p>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={onClose}
            aria-label="Aufgabeneditor schließen"
            className="min-h-11 rounded-md px-3 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-slate-400"
          >
            Schließen
          </button>
        </div>

        <form onSubmit={submitEditor} className="mt-6 grid min-w-0 gap-6">
          <input type="hidden" name="schemaVersion" value={PROJECT_TASK_COMMAND_VERSION} />
          <input type="hidden" name="kind" value={task ? "update" : "create"} />
          <input type="hidden" name="projectId" value={projectId} />
          {task ? <input type="hidden" name="taskId" value={task.id} /> : null}
          {expectedRevision !== null ? (
            <input type="hidden" name="expectedRevision" value={expectedRevision} />
          ) : null}
          <input type="hidden" name="bodyJson" value={bodyJson} readOnly />
          <input type="hidden" name="assigneeIdsJson" value={JSON.stringify(selectedAssignees.map(({ membershipId }) => membershipId))} />
          <input type="hidden" name="checklistJson" value={checklistJson} />
          <input type="hidden" name="labelsJson" value={labelsJson} />

          <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-slate-900">
            Titel
            <input
              ref={titleRef}
              type="text"
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              minLength={1}
              maxLength={200}
              required
              disabled={pending}
              className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-base font-normal text-slate-950 outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 disabled:cursor-wait disabled:bg-slate-100"
            />
          </label>

          <div className="grid min-w-0 gap-1.5">
            <span className="text-sm font-semibold text-slate-900">Beschreibung</span>
            <TaskRichTextEditor
              initialBody={task?.body ?? EMPTY_TASK_RICH_TEXT_V1}
              onBodyChange={onBodyChange}
              editorDocumentRef={editorDocumentRef}
              describedById={bodyFeedbackId}
              invalid={!bodyValid}
              disabled={pending}
              onEditorTab={onEditorTab}
            />
            <p
              id={bodyFeedbackId}
              role={bodyValid ? undefined : "alert"}
              className={bodyValid ? "sr-only" : "text-sm font-semibold text-red-800"}
            >
              {bodyValid
                ? "Die Beschreibung unterstützt Absätze, Überschriften, Listen, Fett- und Kursivschrift."
                : "Die Beschreibung überschreitet das sichere Format oder eine zulässige Grenze."}
            </p>
          </div>

          <label className="grid max-w-xs gap-1.5 text-sm font-semibold text-slate-900">
            Fällig am
            <input
              type="date"
              name="dueDate"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
              disabled={pending}
              className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-base font-normal text-slate-950 outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 disabled:cursor-wait disabled:bg-slate-100"
            />
          </label>

          <fieldset className="min-w-0 rounded-md border border-slate-200 p-4">
            <legend className="px-1 text-sm font-semibold text-slate-900">Zuständige Personen</legend>
            <p className="text-xs leading-5 text-slate-600">
              Bis zu {PROJECT_TASK_MAX_ASSIGNEES} interne Personen. Die Suche zeigt höchstens {PROJECT_TASK_MEMBER_SEARCH_LIMIT} Treffer.
            </p>

            <div role="search" aria-label="Zuständige Personen durchsuchen" className="mt-3 grid min-w-0 gap-2 rounded-md bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <label className="grid min-w-0 gap-1 text-xs font-semibold text-slate-700">
                Interne Person suchen
                <input
                  ref={memberSearchInputRef}
                  type="search"
                  minLength={2}
                  maxLength={80}
                  disabled={memberSearchPending}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    runMemberSearch();
                  }}
                  className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-base font-normal text-slate-950 outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 disabled:cursor-wait disabled:bg-slate-100"
                />
              </label>
              <button
                type="button"
                disabled={memberSearchPending}
                onClick={runMemberSearch}
                className="min-h-11 rounded-md border border-blue-700 bg-white px-3 text-sm font-semibold text-blue-800 outline-none hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:border-slate-300 disabled:text-slate-400"
              >
                {memberSearchPending ? "Suche läuft …" : "Person suchen"}
              </button>
            </div>

            <p
              role={memberSearchError ? "alert" : "status"}
              aria-live={memberSearchError ? "assertive" : "polite"}
              className={memberMessage ? `mt-2 text-xs leading-5 ${memberSearchError ? "font-semibold text-red-800" : "text-slate-600"}` : "sr-only"}
            >
              {memberMessage}
            </p>

            {memberSearchState.status === "results" ? (
              <ul aria-label="Gefundene Personen" className="mt-3 grid list-none gap-2 sm:grid-cols-2">
                {memberSearchState.members.map((member) => {
                  const selected = selectedAssignees.some(
                    ({ membershipId }) => membershipId === member.membershipId,
                  );
                  return (
                    <li key={member.membershipId}>
                      <button
                        type="button"
                        disabled={pending || memberSearchPending || (!selected && selectedAssignees.length >= PROJECT_TASK_MAX_ASSIGNEES)}
                        onClick={() => toggleAssignee(member)}
                        aria-label={`${member.label} ${selected ? "aus Auswahl entfernen" : "auswählen"}`}
                        className="flex min-h-11 w-full min-w-0 items-center justify-between gap-3 rounded-md border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-slate-400"
                      >
                        <span className="min-w-0 break-all">{member.label}</span>
                        <span aria-hidden="true" className="shrink-0 font-semibold">{selected ? "−" : "+"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}

            <div className="mt-4 border-t border-slate-200 pt-3">
              <p className="text-xs font-semibold text-slate-700">
                Ausgewählt: {selectedAssignees.length}/{PROJECT_TASK_MAX_ASSIGNEES}
              </p>
              {selectedAssignees.length > 0 ? (
                <ul aria-label="Ausgewählte Personen" className="mt-2 grid list-none gap-2 sm:grid-cols-2">
                  {selectedAssignees.map((member) => (
                    <li key={member.membershipId} className="flex min-h-11 min-w-0 items-center justify-between gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-950">
                      <span className="min-w-0 break-all">{member.label}</span>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => toggleAssignee(member)}
                        aria-label={`${member.label} aus Auswahl entfernen`}
                        className="min-h-9 shrink-0 rounded-md px-2 text-xs font-semibold text-red-800 outline-none hover:bg-white focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:text-slate-400"
                      >
                        Entfernen
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-slate-600">Noch keine Person ausgewählt.</p>
              )}
            </div>
          </fieldset>

          <fieldset className="min-w-0 rounded-md border border-slate-200 p-4">
            <legend className="px-1 text-sm font-semibold text-slate-900">Checkliste</legend>
            <div className="grid gap-3">
              {checklist.map((item, index) => (
                <div key={item.clientKey} className="grid min-w-0 gap-2 rounded-md bg-slate-50 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                  <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={item.done} disabled={pending} onChange={(event) => setChecklist((current) => current.map((entry) => entry.clientKey === item.clientKey ? { ...entry, done: event.target.checked } : entry))} className="size-4 accent-blue-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2" />
                    Erledigt
                  </label>
                  <label className="grid min-w-0 gap-1 text-xs font-semibold text-slate-700">
                    Punkt {index + 1}
                    <input type="text" value={item.text} minLength={1} maxLength={500} required disabled={pending} onChange={(event) => setChecklist((current) => current.map((entry) => entry.clientKey === item.clientKey ? { ...entry, text: event.target.value } : entry))} className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-base font-normal text-slate-950 outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1" />
                  </label>
                  <button type="button" disabled={pending} onClick={() => setChecklist((current) => current.filter((entry) => entry.clientKey !== item.clientKey))} className="min-h-11 rounded-md px-3 text-sm font-semibold text-red-700 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:text-slate-400">
                    Entfernen
                  </button>
                </div>
              ))}
            </div>
            {checklist.length < PROJECT_TASK_MAX_CHECKLIST_ITEMS ? (
              <button type="button" disabled={pending} onClick={() => setChecklist((current) => [...current, { clientKey: nextKey("check"), id: null, text: "", done: false }])} className="mt-3 min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
                Checklistenpunkt hinzufügen
              </button>
            ) : null}
          </fieldset>

          <fieldset className="min-w-0 rounded-md border border-slate-200 p-4">
            <legend className="px-1 text-sm font-semibold text-slate-900">Labels</legend>
            <div className="grid gap-3">
              {labels.map((label, index) => (
                <div key={label.clientKey} className="grid min-w-0 gap-2 rounded-md bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
                  <label className="grid min-w-0 gap-1 text-xs font-semibold text-slate-700">
                    Label {index + 1}
                    <input type="text" value={label.name} minLength={1} maxLength={40} required disabled={pending} onChange={(event) => setLabels((current) => current.map((entry) => entry.clientKey === label.clientKey ? { ...entry, name: event.target.value } : entry))} className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-base font-normal text-slate-950 outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1" />
                  </label>
                  <label className="grid gap-1 text-xs font-semibold text-slate-700">
                    Farbe
                    <select value={label.color} disabled={pending} onChange={(event) => setLabels((current) => current.map((entry) => entry.clientKey === label.clientKey ? { ...entry, color: event.target.value as TaskLabelColor } : entry))} className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-base font-normal text-slate-950 outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1">
                      {taskLabelColors.map((color) => <option key={color} value={color}>{colorLabels[color]}</option>)}
                    </select>
                  </label>
                  <button type="button" disabled={pending} onClick={() => setLabels((current) => current.filter((entry) => entry.clientKey !== label.clientKey))} className="min-h-11 rounded-md px-3 text-sm font-semibold text-red-700 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:text-slate-400">
                    Entfernen
                  </button>
                </div>
              ))}
            </div>
            {labels.length < PROJECT_TASK_MAX_LABELS ? (
              <button type="button" disabled={pending} onClick={() => setLabels((current) => [...current, { clientKey: nextKey("label"), id: null, name: "", color: "slate" }])} className="mt-3 min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
                Label hinzufügen
              </button>
            ) : null}
          </fieldset>

          <p ref={feedbackRef} tabIndex={-1} role={isError ? "alert" : "status"} aria-live={isError ? "assertive" : "polite"} className={message ? `rounded-md border px-3 py-2 text-sm outline-none ${isError ? "border-amber-200 bg-amber-50 text-amber-950" : "border-emerald-200 bg-emerald-50 text-emerald-950"}` : "sr-only"}>
            {message}
          </p>

          <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
            <button type="button" disabled={pending} onClick={onClose} className="min-h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-slate-400">
              Abbrechen
            </button>
            <button type="submit" disabled={pending || !bodyValid} aria-busy={pending || undefined} className="min-h-11 rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400">
              {pending ? "Wird gespeichert …" : task ? "Änderungen speichern" : "Aufgabe anlegen"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
