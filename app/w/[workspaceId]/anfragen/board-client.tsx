"use client";

import {
  createContext,
  startTransition,
  useActionState,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import {
  moveProjectAction,
  type MoveProjectState,
} from "./actions";

const initialMoveProjectState: MoveProjectState = { status: "idle" };

type BoardColumnOption = { id: string; name: string };
type BoardCardLabel = { id: string; label: string };

type CardDragData = {
  type: "project-card";
  boardId: string;
  projectId: string;
  expectedColumnId: string;
};

type ColumnDropData = {
  type: "project-column";
  boardId: string;
  columnId: string;
};

type BoardContextValue = {
  boardId: string;
  columns: BoardColumnOption[];
  canMove: boolean;
  dndEnabled: boolean;
  pending: boolean;
  selectedMobileColumn: string;
  formAction: (formData: FormData) => void;
};

const BoardContext = createContext<BoardContextValue | null>(null);

function useBoardContext(): BoardContextValue {
  const context = useContext(BoardContext);
  if (!context) throw new Error("RequestBoard-Komponente fehlt");
  return context;
}

function isCardDragData(value: Record<string | symbol, unknown>): value is CardDragData {
  return value.type === "project-card"
    && typeof value.boardId === "string"
    && typeof value.projectId === "string"
    && typeof value.expectedColumnId === "string";
}

function isColumnDropData(value: Record<string | symbol, unknown>): value is ColumnDropData {
  return value.type === "project-column"
    && typeof value.boardId === "string"
    && typeof value.columnId === "string";
}

function announcementFor(
  state: MoveProjectState,
  columns: Map<string, string>,
  cards: Map<string, string>,
): string {
  if (state.status === "success") {
    const card = cards.get(state.projectId) ?? "Die Anfrage";
    const source = columns.get(state.sourceColumnId) ?? "der bisherigen Spalte";
    const target = columns.get(state.targetColumnId) ?? "der Zielspalte";
    return state.changed
      ? `„${card}“ wurde von „${source}“ nach „${target}“ verschoben.`
      : `„${card}“ befindet sich bereits in „${target}“.`;
  }
  if (state.status === "conflict") {
    return "Die Anfrage wurde zwischenzeitlich geändert. Das Board wurde aktualisiert.";
  }
  if (state.status === "invalid") return "Die Zielspalte ist ungültig.";
  if (state.status === "unauthenticated") {
    return "Die Sitzung ist abgelaufen. Bitte lade die Seite neu und melde dich erneut an.";
  }
  if (state.status === "denied") return "Für diese Änderung fehlt die Berechtigung.";
  return "";
}

export function RequestBoardClient({
  workspaceId,
  boardId,
  columns,
  cards,
  canMove,
  children,
}: {
  workspaceId: string;
  boardId: string;
  columns: BoardColumnOption[];
  cards: BoardCardLabel[];
  canMove: boolean;
  children: ReactNode;
}) {
  const boundAction = useMemo(
    () => moveProjectAction.bind(null, workspaceId),
    [workspaceId],
  );
  const [state, formAction, pending] = useActionState(
    boundAction,
    initialMoveProjectState,
  );
  const [dndEnabled, setDndEnabled] = useState(false);
  const [selectedMobileColumn, setSelectedMobileColumn] = useState("all");
  const columnNames = useMemo(
    () => new Map(columns.map((column) => [column.id, column.name])),
    [columns],
  );
  const cardNames = useMemo(
    () => new Map(cards.map((card) => [card.id, card.label])),
    [cards],
  );
  const announcement = announcementFor(state, columnNames, cardNames);

  useEffect(() => {
    if (!canMove) return;
    const media = window.matchMedia("(min-width: 768px) and (pointer: fine)");
    const sync = () => setDndEnabled(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [canMove]);

  useEffect(() => {
    if (!dndEnabled || !canMove) return;
    return monitorForElements({
      canMonitor: ({ source }) =>
        isCardDragData(source.data) && source.data.boardId === boardId,
      onDrop: ({ source, location }) => {
        if (!isCardDragData(source.data)) return;
        const target = location.current.dropTargets.find(({ data }) =>
          isColumnDropData(data) && data.boardId === boardId,
        );
        if (!target || !isColumnDropData(target.data)) return;
        if (target.data.columnId === source.data.expectedColumnId) return;

        const formData = new FormData();
        formData.set("projectId", source.data.projectId);
        formData.set("expectedColumnId", source.data.expectedColumnId);
        formData.set("targetColumnId", target.data.columnId);
        startTransition(() => formAction(formData));
      },
    });
  }, [boardId, canMove, dndEnabled, formAction]);

  useEffect(() => {
    if (state.status !== "success" && state.status !== "conflict") return;
    let attempts = 0;
    let frame = 0;
    const projectId = state.projectId;
    const focusMovedControl = () => {
      const control = document.querySelector<HTMLElement>(
        `[data-move-control="${projectId}"]`,
      );
      if (control) {
        control.focus();
        return;
      }
      attempts += 1;
      if (attempts < 6) frame = requestAnimationFrame(focusMovedControl);
    };
    frame = requestAnimationFrame(focusMovedControl);
    return () => cancelAnimationFrame(frame);
  }, [state]);

  const context = useMemo<BoardContextValue>(() => ({
    boardId,
    columns,
    canMove,
    dndEnabled,
    pending,
    selectedMobileColumn,
    formAction,
  }), [boardId, canMove, columns, dndEnabled, formAction, pending, selectedMobileColumn]);

  return (
    <BoardContext.Provider value={context}>
      <div className="mb-4 md:hidden">
        <label className="grid gap-1.5 text-sm font-medium text-slate-800">
          Status anzeigen
          <select
            value={selectedMobileColumn}
            onChange={(event) => setSelectedMobileColumn(event.target.value)}
            className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200"
          >
            <option value="all">Alle Status</option>
            {columns.map((column) => (
              <option key={column.id} value={column.id}>{column.name}</option>
            ))}
          </select>
        </label>
      </div>
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={announcement ? "mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-950" : "sr-only"}
      >
        {announcement}
      </p>
      {children}
    </BoardContext.Provider>
  );
}

export function RequestBoardColumn({
  columnId,
  children,
}: {
  columnId: string;
  children: ReactNode;
}) {
  const { boardId, canMove, dndEnabled, pending, selectedMobileColumn } = useBoardContext();
  const ref = useRef<HTMLElement | null>(null);
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || !canMove || !dndEnabled) return;
    return dropTargetForElements({
      element,
      getData: (): ColumnDropData => ({
        type: "project-column",
        boardId,
        columnId,
      }),
      canDrop: ({ source }) =>
        !pending
        && isCardDragData(source.data)
        && source.data.boardId === boardId
        && source.data.expectedColumnId !== columnId,
      onDragEnter: () => setIsOver(true),
      onDragLeave: () => setIsOver(false),
      onDrop: () => setIsOver(false),
    });
  }, [boardId, canMove, columnId, dndEnabled, pending]);

  const mobileHidden = selectedMobileColumn !== "all" && selectedMobileColumn !== columnId;
  return (
    <section
      ref={ref}
      data-column-id={columnId}
      data-mobile-hidden={mobileHidden ? "true" : "false"}
      className={`min-w-0 rounded-lg border bg-slate-50/80 ${
        isOver ? "border-blue-500 ring-2 ring-blue-200" : "border-slate-200"
      } ${mobileHidden ? "max-md:hidden" : ""}`}
    >
      {isOver ? (
        <p className="mx-3 mt-3 rounded bg-blue-100 px-3 py-2 text-center text-xs font-semibold text-blue-900">
          Hier ablegen
        </p>
      ) : null}
      {children}
    </section>
  );
}

export function RequestBoardCard({
  projectId,
  currentColumnId,
  projectLabel,
  children,
}: {
  projectId: string;
  currentColumnId: string;
  projectLabel: string;
  children: ReactNode;
}) {
  const { boardId, columns, canMove, dndEnabled, pending, formAction } = useBoardContext();
  const cardRef = useRef<HTMLElement | null>(null);
  const handleRef = useRef<HTMLSpanElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const targets = columns.filter((column) => column.id !== currentColumnId);

  useEffect(() => {
    const element = cardRef.current;
    const dragHandle = handleRef.current;
    if (!element || !dragHandle || !canMove || !dndEnabled) return;
    return draggable({
      element,
      dragHandle,
      canDrag: () => !pending,
      getInitialData: (): CardDragData => ({
        type: "project-card",
        boardId,
        projectId,
        expectedColumnId: currentColumnId,
      }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });
  }, [boardId, canMove, currentColumnId, dndEnabled, pending, projectId]);

  return (
    <article
      ref={cardRef}
      data-project-id={projectId}
      className={`relative rounded-md border bg-white p-4 shadow-sm ${
        dragging ? "border-blue-500 opacity-70 shadow-lg" : "border-slate-200"
      }`}
    >
      {canMove && dndEnabled ? (
        <span
          ref={handleRef}
          aria-hidden="true"
          title="Mit der Maus verschieben"
          data-testid={`drag-${projectId}`}
          className="absolute right-3 top-3 hidden cursor-grab select-none rounded px-2 py-1 text-base leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-700 md:block"
        >
          ⠿
        </span>
      ) : null}
      {children}
      {canMove ? (
        <form action={formAction} className="mt-4 grid gap-2 border-t border-slate-100 pt-3">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="expectedColumnId" value={currentColumnId} />
          <label htmlFor={`target-${projectId}`} className="text-xs font-medium text-slate-700">
            Zielspalte für „{projectLabel}“
          </label>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <select
              id={`target-${projectId}`}
              name="targetColumnId"
              defaultValue=""
              required
              disabled={pending}
              className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-2 text-xs outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200 disabled:cursor-wait disabled:bg-slate-100"
            >
              <option value="">Ziel wählen</option>
              {targets.map((column) => (
                <option key={column.id} value={column.id}>{column.name}</option>
              ))}
            </select>
            <button
              type="submit"
              disabled={pending || targets.length === 0}
              data-move-control={projectId}
              aria-label={`„${projectLabel}“ verschieben`}
              className="min-h-11 rounded-md bg-slate-900 px-3 text-xs font-semibold text-white outline-none hover:bg-slate-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {pending ? "Wird verschoben …" : "Verschieben"}
            </button>
          </div>
        </form>
      ) : (
        <p className="mt-4 border-t border-slate-100 pt-3 text-xs font-medium text-slate-500">
          Nur Lesezugriff
        </p>
      )}
    </article>
  );
}
