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
  type FormEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type RefObject,
} from "react";
import {
  PROJECT_NOTE_COMMAND_VERSION,
  type ProjectNoteItemV1,
} from "@/lib/integrations/notes/note-contract";
import {
  changeProjectNote,
  type ProjectNoteActionState,
} from "./note-actions";
import {
  noteEditorDocumentFromMarkdown,
  noteMarkdownFromEditor,
} from "./note-editor-model";

const INITIAL_STATE: ProjectNoteActionState = { status: "idle" };

const noteEditorExtensions = [
  StarterKit.configure({
    blockquote: false,
    codeBlock: false,
    dropcursor: false,
    gapcursor: false,
    hardBreak: false,
    heading: { levels: [1, 2, 3] },
    horizontalRule: false,
    underline: false,
    trailingNode: false,
  }),
];

const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([type='hidden']):not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function editorMessage(state: ProjectNoteActionState): string {
  switch (state.status) {
    case "idle": return "";
    case "success": return "Die Notiz wurde gespeichert.";
    case "invalid": return "Der Notiztext ist leer oder enthält nicht unterstützte Formatierung.";
    case "conflict": return state.currentRevision === undefined
      ? "Die Notiz wurde zwischenzeitlich geändert. Lade die Seite neu und versuche es erneut."
      : `Die Notiz wurde zwischenzeitlich geändert. Speichere erneut mit Stand ${state.currentRevision}.`;
    case "not_found": return "Die Notiz oder das Projekt ist nicht mehr verfügbar.";
    case "denied": return "Für diese Änderung fehlt dir die Berechtigung.";
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

function NoteRichTextEditor({
  initialMarkdown,
  onMarkdownChange,
  editorDocumentRef,
  describedById,
  invalid,
  disabled,
  onEditorTab,
}: {
  initialMarkdown: string;
  onMarkdownChange: (value: string, valid: boolean) => void;
  editorDocumentRef: MutableRefObject<(() => unknown) | null>;
  describedById: string;
  invalid: boolean;
  disabled: boolean;
  onEditorTab: (backward: boolean) => void;
}) {
  const [initialDocument] = useState(() => noteEditorDocumentFromMarkdown(initialMarkdown));
  const publish = useCallback((document: unknown) => {
    const result = noteMarkdownFromEditor(document);
    onMarkdownChange(result.markdown, result.valid);
  }, [onMarkdownChange]);
  const editor = useEditor({
    extensions: noteEditorExtensions,
    content: initialDocument,
    immediatelyRender: false,
    enableContentCheck: true,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "Notiztext",
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
      strike: currentEditor?.isActive("strike") ?? false,
      code: currentEditor?.isActive("code") ?? false,
      link: currentEditor?.isActive("link") ?? false,
      paragraph: currentEditor?.isActive("paragraph") ?? false,
      heading1: currentEditor?.isActive("heading", { level: 1 }) ?? false,
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
  }, [describedById, disabled, editor, invalid]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const previous = editor.getAttributes("link").href as string | undefined;
    const href = window.prompt("Link-Adresse (https:// oder mailto:)", previous ?? "");
    if (href === null) return;
    if (href === "") {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().setLink({ href }).run();
  }, [editor]);

  return (
    <div className="rounded-md border border-slate-300 bg-white focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-600 focus-within:ring-offset-2">
      <div className="flex flex-wrap gap-1 border-b border-slate-200 bg-slate-50 p-2">
        <ToolbarButton label="Fett" pressed={active?.bold} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleBold().run()} />
        <ToolbarButton label="Kursiv" pressed={active?.italic} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleItalic().run()} />
        <ToolbarButton label="Durchgestrichen" pressed={active?.strike} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleStrike().run()} />
        <ToolbarButton label="Code" pressed={active?.code} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleCode().run()} />
        <ToolbarButton label="Link" pressed={active?.link} disabled={!editor || disabled} onClick={setLink} />
        <ToolbarButton label="Absatz" pressed={active?.paragraph} disabled={!editor || disabled} onClick={() => editor?.chain().focus().setParagraph().run()} />
        <ToolbarButton label="Überschrift 1" pressed={active?.heading1} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} />
        <ToolbarButton label="Überschrift 2" pressed={active?.heading2} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} />
        <ToolbarButton label="Überschrift 3" pressed={active?.heading3} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} />
        <ToolbarButton label="Aufzählung" pressed={active?.bulletList} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleBulletList().run()} />
        <ToolbarButton label="Nummerierte Liste" pressed={active?.orderedList} disabled={!editor || disabled} onClick={() => editor?.chain().focus().toggleOrderedList().run()} />
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

export function NoteEditorDialog({
  workspaceId,
  projectId,
  note,
  returnFocusRef,
  onSuccess,
  onClose,
}: {
  workspaceId: string;
  projectId: string;
  note: ProjectNoteItemV1 | null;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onSuccess: (message: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const bodyFeedbackId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const editorDocumentRef = useRef<(() => unknown) | null>(null);
  const boundAction = useMemo(
    () => changeProjectNote.bind(null, workspaceId, projectId),
    [projectId, workspaceId],
  );
  const [state, formAction, pending] = useActionState(boundAction, INITIAL_STATE);
  const [, startFormTransition] = useTransition();
  const [markdown, setMarkdown] = useState(() => note?.textMarkdown ?? "");
  const [markdownValid, setMarkdownValid] = useState(true);
  const [pinned, setPinned] = useState(() => note?.pinned ?? false);
  const message = editorMessage(state);
  const isError = state.status !== "idle" && state.status !== "success";
  const expectedRevision = note === null
    ? null
    : state.status === "conflict" && state.currentRevision !== undefined
      ? Math.max(note.revision, state.currentRevision)
      : note.revision;

  const onMarkdownChange = useCallback((value: string, valid: boolean) => {
    setMarkdown(value);
    setMarkdownValid(valid);
  }, []);

  useEffect(() => {
    const returnTarget = returnFocusRef.current;
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
    if (state.status === "success") {
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

  function submitEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const currentDocument = editorDocumentRef.current?.();
    const hiddenBody = form.elements.namedItem("textMarkdown");
    if (currentDocument === undefined || !(hiddenBody instanceof HTMLInputElement)) {
      setMarkdownValid(false);
      return;
    }
    const result = noteMarkdownFromEditor(currentDocument);
    hiddenBody.value = result.markdown;
    setMarkdown(result.markdown);
    setMarkdownValid(result.valid);
    if (!result.valid) return;
    const formData = new FormData(form);
    startFormTransition(() => formAction(formData));
  }

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
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Notiz</p>
            <h1 id={titleId} className="mt-1 break-words text-xl font-semibold text-slate-950">
              {note ? "Notiz bearbeiten" : "Notiz anlegen"}
            </h1>
            <p id={descriptionId} className="mt-2 text-sm leading-6 text-slate-600">
              Absätze, Überschriften, Listen und Hervorhebungen. Links sind nur mit https:// oder mailto: erlaubt.
            </p>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={onClose}
            aria-label="Notizeditor schließen"
            className="min-h-11 rounded-md px-3 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-slate-400"
          >
            Schließen
          </button>
        </div>

        <form onSubmit={submitEditor} className="mt-6 grid min-w-0 gap-6">
          <input type="hidden" name="schemaVersion" value={PROJECT_NOTE_COMMAND_VERSION} />
          <input type="hidden" name="kind" value={note ? "update_note_text" : "create_note"} />
          <input type="hidden" name="projectId" value={projectId} />
          {note ? <input type="hidden" name="noteId" value={note.id} /> : null}
          {expectedRevision !== null ? (
            <input type="hidden" name="expectedRevision" value={expectedRevision} />
          ) : null}
          <input type="hidden" name="textMarkdown" value={markdown} readOnly />
          {note === null ? (
            <input type="hidden" name="pinned" value={pinned ? "true" : "false"} />
          ) : null}

          <div className="grid min-w-0 gap-1.5">
            <span className="text-sm font-semibold text-slate-900">Notiztext</span>
            <NoteRichTextEditor
              initialMarkdown={note?.textMarkdown ?? ""}
              onMarkdownChange={onMarkdownChange}
              editorDocumentRef={editorDocumentRef}
              describedById={bodyFeedbackId}
              invalid={!markdownValid}
              disabled={pending}
              onEditorTab={onEditorTab}
            />
            <p
              id={bodyFeedbackId}
              role={markdownValid ? undefined : "alert"}
              className={markdownValid ? "sr-only" : "text-sm font-semibold text-red-800"}
            >
              {markdownValid
                ? "Der Notiztext unterstützt Absätze, Überschriften, Listen und Hervorhebungen."
                : "Der Notiztext ist leer, zu lang oder enthält nicht unterstützte Formatierung."}
            </p>
          </div>

          {note === null ? (
            <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-900">
              <input
                type="checkbox"
                checked={pinned}
                disabled={pending}
                onChange={(event) => setPinned(event.target.checked)}
                className="size-4 accent-blue-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              />
              Notiz anpinnen
            </label>
          ) : null}

          <p ref={feedbackRef} tabIndex={-1} role={isError ? "alert" : "status"} aria-live={isError ? "assertive" : "polite"} className={message ? `rounded-md border px-3 py-2 text-sm outline-none ${isError ? "border-amber-200 bg-amber-50 text-amber-950" : "border-emerald-200 bg-emerald-50 text-emerald-950"}` : "sr-only"}>
            {message}
          </p>

          <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
            <button type="button" disabled={pending} onClick={onClose} className="min-h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-slate-400">
              Abbrechen
            </button>
            <button type="submit" disabled={pending || !markdownValid} aria-busy={pending || undefined} className="min-h-11 rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400">
              {pending ? "Wird gespeichert …" : note ? "Änderungen speichern" : "Notiz anlegen"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
