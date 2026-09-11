"use client";

import { useActionState, useState } from "react";
import {
  archiveBoardColumnAction,
  createBoardColumnAction,
  moveBoardColumnAction,
  renameBoardColumnAction,
  restoreBoardColumnAction,
  setColumnConversionRatioAction,
  type BoardColumnActionState,
} from "./board-column-actions";

const initialState: BoardColumnActionState = { status: "idle" };

const inputClass =
  "min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-600";
const buttonClass =
  "inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2";
const primaryButtonClass =
  "inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2";

export type BoardColumnAdminItem = {
  id: string;
  name: string;
  type: "lead" | "offer" | "won" | "lost";
  position: number;
  color: "neutral" | "blue" | "amber" | "green";
  isIntake: boolean;
  conversionRatioBps: number | null;
  archived: boolean;
  cardCount: number;
};

const TYPE_LABELS: Record<BoardColumnAdminItem["type"], string> = {
  lead: "Lead",
  offer: "Angebot",
  won: "Gewonnen",
  lost: "Verloren",
};

const COLOR_LABELS: Record<BoardColumnAdminItem["color"], string> = {
  neutral: "Neutral",
  blue: "Blau",
  amber: "Bernstein",
  green: "Grün",
};

function Feedback({ state }: { state: BoardColumnActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    const message =
      state.action === "created"
        ? "Spalte angelegt."
        : state.action === "renamed"
          ? `Spalte umbenannt in „${state.detail ?? ""}".`
          : state.action === "moved"
            ? "Spalte verschoben."
            : state.action === "archived"
              ? "Spalte archiviert."
              : state.action === "ratio"
                ? "Conversion-Ratio gespeichert."
                : "Spalte wiederhergestellt.";
    return (
      <p role="status" data-testid="board-column-success" className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        {message}
      </p>
    );
  }
  const tone = "border-amber-300 bg-amber-50 text-amber-900";
  const message =
    state.status === "invalid"
      ? state.detail === "intake"
        ? "Die Eingangs-Spalte ist geschützt."
        : "Bitte prüfen: Name (1–120 Zeichen), Typ und Farbe."
      : state.status === "conflict"
        ? state.detail === "intake"
          ? "Die Eingangs-Spalte kann nicht archiviert werden."
          : state.detail === "non_empty"
            ? "Spalte enthält noch Anfragen — erst verschieben, dann archivieren."
            : state.detail === "not_found"
              ? "Spalte oder Board nicht gefunden."
              : state.detail === "archived"
                ? "Spalte ist bereits archiviert."
                : "Konflikt — Seite neu laden und erneut versuchen."
        : state.status === "denied"
          ? "Keine Berechtigung zum Verwalten."
          : "Bitte erneut anmelden.";
  return (
    <p role="alert" data-testid="board-column-error" className={`rounded-md border px-3 py-2 text-sm ${tone}`}>
      {message}
    </p>
  );
}

function ColumnRow({
  workspaceId,
  column,
}: {
  workspaceId: string;
  column: BoardColumnAdminItem;
}) {
  const [renameState, renameDispatch] = useActionState(
    renameBoardColumnAction.bind(null, workspaceId), initialState,
  );
  const [moveState, moveDispatch] = useActionState(
    moveBoardColumnAction.bind(null, workspaceId), initialState,
  );
  const [archiveState, archiveDispatch] = useActionState(
    archiveBoardColumnAction.bind(null, workspaceId), initialState,
  );
  const [restoreState, restoreDispatch] = useActionState(
    restoreBoardColumnAction.bind(null, workspaceId), initialState,
  );
  const [ratioState, ratioDispatch] = useActionState(
    setColumnConversionRatioAction.bind(null, workspaceId), initialState,
  );
  const lastState = [renameState, moveState, archiveState, restoreState, ratioState].find(
    (candidate) => candidate.status !== "idle",
  ) ?? renameState;
  const ratioPercent = column.conversionRatioBps === null
    ? null
    : (column.conversionRatioBps / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 });
  return (
    <li
      data-testid="board-column-row"
      data-column-id={column.id}
      className="grid gap-2 rounded-md border border-slate-200 bg-white p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm text-slate-950">{column.name}</strong>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
          {TYPE_LABELS[column.type]}
        </span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
          {COLOR_LABELS[column.color]}
        </span>
        {column.isIntake ? (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-800">
            Eingang
          </span>
        ) : null}
        {column.archived ? (
          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
            Archiviert
          </span>
        ) : null}
        <span className="text-[11px] tabular-nums text-slate-500">
          {column.cardCount} {column.cardCount === 1 ? "Karte" : "Karten"}
        </span>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600">
          {ratioPercent === null ? "Ratio: —" : `Ratio: ${ratioPercent} %`}
        </span>
      </div>
      {!column.archived ? (
        <div className="flex flex-wrap items-center gap-2">
          <form action={renameDispatch} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="columnId" value={column.id} />
            <label className="sr-only" htmlFor={`rename-${column.id}`}>
              {`Neuer Name für ${column.name}`}
            </label>
            <input
              id={`rename-${column.id}`}
              name="name"
              defaultValue={column.name}
              maxLength={120}
              autoComplete="off"
              className={`${inputClass} w-44`}
            />
            <button type="submit" className={buttonClass}>
              Speichern
            </button>
          </form>
          <form action={moveDispatch} className="flex items-center gap-1">
            <input type="hidden" name="columnId" value={column.id} />
            <button type="submit" name="direction" value="left" aria-label={`${column.name} nach links`} className={buttonClass}>
              ←
            </button>
            <button type="submit" name="direction" value="right" aria-label={`${column.name} nach rechts`} className={buttonClass}>
              →
            </button>
          </form>
          {!column.isIntake ? (
            <form action={archiveDispatch}>
              <input type="hidden" name="columnId" value={column.id} />
              <button type="submit" aria-label={`${column.name} archivieren`} className={buttonClass}>
                Archivieren
              </button>
            </form>
          ) : null}
          <form action={ratioDispatch} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="columnId" value={column.id} />
            <label className="sr-only" htmlFor={`ratio-${column.id}`}>
              {`Conversion-Ratio in % für ${column.name} (leer = keine)`}
            </label>
            <input
              id={`ratio-${column.id}`}
              name="ratioPercent"
              defaultValue={ratioPercent ?? ""}
              placeholder="z. B. 25"
              inputMode="decimal"
              autoComplete="off"
              className={`${inputClass} w-28`}
            />
            <button type="submit" className={buttonClass}>
              Ratio speichern
            </button>
          </form>
        </div>
      ) : (
        <form action={restoreDispatch}>
          <input type="hidden" name="columnId" value={column.id} />
          <button type="submit" aria-label={`${column.name} wiederherstellen`} className={buttonClass}>
            Wiederherstellen
          </button>
        </form>
      )}
      <Feedback state={lastState} />
    </li>
  );
}

/**
 * F1-05a · Spaltenverwaltung des Anfrage-Boards (Editoren):
 * anlegen, umbenennen, verschieben, archivieren/wiederherstellen.
 */
export function BoardColumnAdmin({
  workspaceId,
  boardId,
  scopeLabel,
  columns,
}: {
  workspaceId: string;
  boardId: string;
  scopeLabel: string;
  columns: BoardColumnAdminItem[];
}) {
  const [open, setOpen] = useState(false);
  const [createState, createDispatch] = useActionState(
    createBoardColumnAction.bind(null, workspaceId, boardId), initialState,
  );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="board-column-admin-open"
        className={buttonClass}
      >
        Spalten verwalten
      </button>
    );
  }

  return (
    <section
      aria-label="Spalten verwalten"
      data-testid="board-column-admin"
      className="grid w-full max-w-2xl gap-3 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-950">
          {`Spalten verwalten (${scopeLabel})`}
        </h2>
        <button type="button" onClick={() => setOpen(false)} className={buttonClass}>
          Schließen
        </button>
      </div>
      <ul className="grid list-none gap-2">
        {columns.map((column) => (
          <ColumnRow key={column.id} workspaceId={workspaceId} column={column} />
        ))}
      </ul>
      <form action={createDispatch} data-testid="board-column-create" className="grid gap-2 rounded-md border border-dashed border-slate-300 p-3">
        <p className="text-sm font-semibold text-slate-800">Neue Spalte</p>
        <label className="grid gap-1 text-sm font-medium text-slate-700">
          Name *
          <input name="name" required maxLength={120} autoComplete="off" className={inputClass} />
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Typ
            <select name="columnType" defaultValue="lead" className={inputClass}>
              <option value="lead">Lead</option>
              <option value="offer">Angebot</option>
              <option value="won">Gewonnen</option>
              <option value="lost">Verloren</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Farbe
            <select name="color" defaultValue="neutral" className={inputClass}>
              <option value="neutral">Neutral</option>
              <option value="blue">Blau</option>
              <option value="amber">Bernstein</option>
              <option value="green">Grün</option>
            </select>
          </label>
        </div>
        <div>
          <button type="submit" className={primaryButtonClass}>
            Spalte anlegen
          </button>
        </div>
      </form>
      <Feedback state={createState} />
    </section>
  );
}
