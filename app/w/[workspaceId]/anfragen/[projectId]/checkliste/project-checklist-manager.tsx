"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type {
  ChecklistBlockV1,
  ChecklistBlocksV1,
  ChecklistItemV1,
  ChecklistSegmentV1,
  ProjectChecklistDto,
} from "@/lib/integrations/checklists/contract";
import { checklistProgress } from "@/lib/integrations/checklists/contract";
import { applyTemplateAction, saveProjectChecklistAction, type ChecklistActionState } from "./actions";
import type { ChecklistTemplateDto } from "@/lib/integrations/checklists/template-contract";

const initialState: ChecklistActionState = { status: "idle" };

function message(state: ChecklistActionState): { text: string; isError: boolean } | null {
  switch (state.status) {
    case "success": return { text: `Gespeichert (Version ${state.version}).`, isError: false };
    case "invalid": return { text: "Die Eingabe ist ungültig.", isError: true };
    case "conflict": return {
      text: "Die Checkliste wurde zwischenzeitlich geändert. Bitte neu laden und erneut speichern.",
      isError: true,
    };
    case "not_found": return { text: "Die Projektakte wurde nicht gefunden.", isError: true };
    case "denied": return { text: "Dir fehlt die Berechtigung für diese Aktion.", isError: true };
    case "unauthenticated": return { text: "Deine Sitzung ist abgelaufen.", isError: true };
    case "error": return { text: "Beim Speichern ist ein unerwarteter Fehler aufgetreten. Bitte erneut versuchen.", isError: true };
    default: return null;
  }
}

function Feedback({ state }: { state: ChecklistActionState }) {
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const feedback = message(state);
  useEffect(() => {
    if (feedback?.isError) feedbackRef.current?.focus();
  }, [feedback?.isError, state]);
  return (
    <p
      ref={feedbackRef}
      tabIndex={-1}
      role={feedback?.isError ? "alert" : "status"}
      aria-live="polite"
      className={`mt-3 text-sm font-semibold ${
        feedback === null ? "hidden" : feedback.isError ? "text-red-700" : "text-green-700"
      }`}
    >
      {feedback?.text}
    </p>
  );
}

export function ProjectChecklistManager({
  workspaceId,
  projectId,
  checklist,
  templates,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  checklist: ProjectChecklistDto;
  templates: ChecklistTemplateDto[];
  canWrite: boolean;
}) {
  const [blocks, setBlocks] = useState<ChecklistBlocksV1>(checklist.blocks);
  const [state, dispatch] = useActionState(saveProjectChecklistAction, initialState);

  // Kimi-P1-2: CAS-Version aus dem letzten Save-Ergebnis ableiten (kein
  // setState-in-Effect — React-Compiler-Regel): success trägt die neue
  // Version, sonst gilt die Server-Prop vom Initial-Render.
  const baseVersion = state.status === "success" ? state.version : checklist.version;

  const progress = checklistProgress(blocks);

  // Kimi-P2-2: clientseitige Form-Hinweise — leere Titel/Blocknamen blocken
  // den Save mit konkretem Hinweis statt generischer Servermeldung.
  const hasEmptyTitle = blocks.some((block) =>
    block.name.trim() === ""
    || block.segments.some((segment) =>
      segment.name.trim() === ""
      || segment.items.some((item) => item.title.trim() === "")));
  const blocksCapped = blocks.length >= 50;

  function patchBlocks(
    updater: (value: ChecklistBlocksV1) => ChecklistBlocksV1,
  ): void {
    if (!canWrite) return;
    setBlocks(updater);
  }

  const addBlock = () => patchBlocks((value) => [
    ...value,
    { name: "Neuer Block", position: value.length, segments: [] },
  ]);

  const addSegment = (blockIndex: number) => patchBlocks((value) => {
    const block = value[blockIndex]!;
    return value.map((b, i) => i === blockIndex
      ? { ...b, segments: [...b.segments, { name: "Neues Segment", position: b.segments.length, items: [] }] }
      : b);
  });

  const addItem = (blockIndex: number, segmentIndex: number) => patchBlocks((value) => {
    const block = value[blockIndex]!;
    const segment = block.segments[segmentIndex]!;
    return value.map((b, i) => {
      if (i !== blockIndex) return b;
      return {
        ...b,
        segments: b.segments.map((s, j) => j === segmentIndex
          ? { ...s, items: [...s.items, { title: "", done: false }] }
          : s),
      };
    });
  });

  const setItem = (
    blockIndex: number,
    segmentIndex: number,
    itemIndex: number,
    patch: Partial<ChecklistItemV1>,
  ) => patchBlocks((value) => value.map((b, i) => {
    if (i !== blockIndex) return b;
    return {
      ...b,
      segments: b.segments.map((s, j) => {
        if (j !== segmentIndex) return s;
        return {
          ...s,
          items: s.items.map((item, k) => k === itemIndex ? { ...item, ...patch } : item),
        };
      }),
    };
  }));

  const renameBlock = (blockIndex: number, name: string) =>
    patchBlocks((value) => value.map((b, i) => i === blockIndex ? { ...b, name } : b));
  const renameSegment = (blockIndex: number, segmentIndex: number, name: string) =>
    patchBlocks((value) => value.map((b, i) => {
      if (i !== blockIndex) return b;
      return { ...b, segments: b.segments.map((s, j) => j === segmentIndex ? { ...s, name } : s) };
    }));

  return (
    <div className="space-y-6">
      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-950">Checkliste</h2>
          <p className="text-sm font-semibold text-slate-800">
            Fortschritt: {progress.done}/{progress.total}
            {progress.total > 0 ? ` (${Math.round((progress.done / progress.total) * 100)} %)` : ""}
          </p>
        </div>

        {blocks.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Noch keine Blöcke angelegt. Füge den ersten Block hinzu.
          </p>
        ) : (
          <div className="mt-3 space-y-4">
            {blocks.map((block, blockIndex) => (
              <BlockCard
                key={blockIndex}
                block={block}
                blockIndex={blockIndex}
                canWrite={canWrite}
                onRename={(name) => renameBlock(blockIndex, name)}
                onAddSegment={() => addSegment(blockIndex)}
                onAddItem={(segmentIndex) => addItem(blockIndex, segmentIndex)}
                onRenameSegment={(segmentIndex, name) => renameSegment(blockIndex, segmentIndex, name)}
                onSetItem={(segmentIndex, itemIndex, patch) => setItem(blockIndex, segmentIndex, itemIndex, patch)}
              />
            ))}
          </div>
        )}

        {canWrite ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={addBlock}
              disabled={blocksCapped}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              Block hinzufügen
            </button>
          </div>
        ) : null}

        {canWrite ? (
          <form action={dispatch} className="mt-5">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="baseVersion" value={baseVersion} />
            <input type="hidden" name="blocks" value={JSON.stringify(blocks)} />
            <Feedback state={state} />
            {hasEmptyTitle ? (
              <p className="mt-3 text-sm font-semibold text-amber-700">
                Bitte alle Block-, Segment- und Punktnamen ausfüllen, bevor du speicherst.
              </p>
            ) : null}
            <button
              type="submit"
              disabled={hasEmptyTitle}
              className="mt-3 inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Speichern
            </button>
          </form>
        ) : null}

        {!canWrite ? <Feedback state={state} /> : null}
      </section>
    </div>
  );
}

function BlockCard({
  block,
  blockIndex,
  canWrite,
  onRename,
  onAddSegment,
  onAddItem,
  onRenameSegment,
  onSetItem,
}: {
  block: ChecklistBlockV1;
  blockIndex: number;
  canWrite: boolean;
  onRename: (name: string) => void;
  onAddSegment: () => void;
  onAddItem: (segmentIndex: number) => void;
  onRenameSegment: (segmentIndex: number, name: string) => void;
  onSetItem: (segmentIndex: number, itemIndex: number, patch: Partial<ChecklistItemV1>) => void;
}) {
  return (
    <div className="rounded-md border border-slate-200 p-4">
      {canWrite ? (
        <input
          type="text"
          aria-label={`Block-Name ${blockIndex + 1}`}
          value={block.name}
          onChange={(event) => onRename(event.target.value)}
          className="w-full max-w-md rounded-md border border-slate-300 px-2 py-1.5 text-sm font-semibold outline-none focus:border-blue-600"
        />
      ) : (
        <h3 className="text-sm font-semibold text-slate-900">{block.name}</h3>
      )}

      <div className="mt-3 space-y-3">
        {block.segments.map((segment, segmentIndex) => (
          <SegmentGroup
            key={segmentIndex}
            segment={segment}
            segmentIndex={segmentIndex}
            canWrite={canWrite}
            onRename={(name) => onRenameSegment(segmentIndex, name)}
            onAddItem={() => onAddItem(segmentIndex)}
            onSetItem={(itemIndex, patch) => onSetItem(segmentIndex, itemIndex, patch)}
          />
        ))}
        {block.segments.length === 0 ? (
          <p className="text-xs text-slate-500">Noch keine Segmente.</p>
        ) : null}
      </div>

      {canWrite ? (
        <button
          type="button"
          onClick={onAddSegment}
          className="mt-3 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
        >
          Segment hinzufügen
        </button>
      ) : null}
    </div>
  );
}

function SegmentGroup({
  segment,
  segmentIndex,
  canWrite,
  onRename,
  onAddItem,
  onSetItem,
}: {
  segment: ChecklistSegmentV1;
  segmentIndex: number;
  canWrite: boolean;
  onRename: (name: string) => void;
  onAddItem: () => void;
  onSetItem: (itemIndex: number, patch: Partial<ChecklistItemV1>) => void;
}) {
  return (
    <div className="rounded-md bg-slate-50 p-3">
      {canWrite ? (
        <input
          type="text"
          aria-label={`Segment-Name ${segmentIndex + 1}`}
          value={segment.name}
          onChange={(event) => onRename(event.target.value)}
          className="w-full max-w-md rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm font-semibold outline-none focus:border-blue-600"
        />
      ) : (
        <h4 className="text-sm font-semibold text-slate-800">{segment.name}</h4>
      )}

      <ul className="mt-2 space-y-2">
        {segment.items.map((item, itemIndex) => (
          <li key={itemIndex} className="flex items-start gap-2">
            <input
              type="checkbox"
              aria-label={item.title || `Punkt ${itemIndex + 1}`}
              checked={item.done}
              disabled={!canWrite}
              onChange={(event) => onSetItem(itemIndex, { done: event.target.checked })}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
            />
            {canWrite ? (
              <input
                type="text"
                value={item.title}
                aria-label={`Punkt-Name ${segmentIndex + 1}.${itemIndex + 1}`}
                onChange={(event) => onSetItem(itemIndex, { title: event.target.value })}
                placeholder="Punkt"
                className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm outline-none focus:border-blue-600"
              />
            ) : (
              <span className={`text-sm ${item.done ? "text-slate-400 line-through" : "text-slate-800"}`}>
                {item.title}
              </span>
            )}
          </li>
        ))}
      </ul>

      {canWrite ? (
        <button
          type="button"
          onClick={onAddItem}
          className="mt-2 rounded-md border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
        >
          Punkt hinzufügen
        </button>
      ) : null}
    </div>
  );
}


export function ApplyTemplateSection({
  workspaceId,
  projectId,
  templates,
  canWrite,
  checklistVersion,
}: {
  workspaceId: string;
  projectId: string;
  templates: ChecklistTemplateDto[];
  canWrite: boolean;
  checklistVersion: number;
}) {
  const [applyState, applyDispatch] = useActionState(applyTemplateAction, initialState);
  // Sektion bleibt nach Erfolg gemountet, damit das Feedback sichtbar bleibt.
  if (
    !canWrite
    || templates.length === 0
    || (checklistVersion !== 0 && applyState.status !== "success")
  ) {
    return null;
  }
  return (
    <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-950">Aus Vorlage anlegen</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        Erzeugt die Material-Checkliste aus einer Vorlage (ESTIMATE-Mapping).
      </p>
      <form action={applyDispatch} className="mt-3 flex flex-wrap items-center gap-2">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="projectId" value={projectId} />
        <select
          name="templateId"
          aria-label="Vorlage"
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
        >
          {templates.map((template) => (
            <option key={template.id} value={template.id}>{template.name}</option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600"
        >
          Checkliste erstellen
        </button>
      </form>
      <Feedback state={applyState} />
    </section>
  );
}
