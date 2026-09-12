"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  CHECKLIST_BLOCKS_TRANSPORT_MAX_BYTES,
  checklistProgress,
  isChecklistWorkItem,
  isItemEffectivelyVisible,
  segmentItemProgress,
  segmentRequiredRemaining,
  toEditableChecklistBlocks,
  type ChecklistBlockV1,
  type ChecklistBlocksV1,
  type ChecklistItemV1,
  type ChecklistSegmentV1,
  type ProjectChecklistDto,
} from "@/lib/integrations/checklists/contract";
import type { ChecklistTemplateDto } from "@/lib/integrations/checklists/template-contract";
import type { TeamOption } from "@/lib/integrations/teams/contract";
import {
  applyTemplateAction,
  assignChecklistBlockTeamAction,
  mutateChecklistSegmentAction,
  saveProjectChecklistAction,
  setChecklistItemIrrelevantAction,
  unassignChecklistBlockTeamAction,
  type ChecklistActionState,
} from "./actions";
import { enqueueSegmentComplete } from "./segment-outbox";
import { SegmentOutboxSync } from "./segment-outbox-sync";

const initialState: ChecklistActionState = { status: "idle" };

function message(state: ChecklistActionState): { text: string; isError: boolean } | null {
  switch (state.status) {
    case "success": {
      const label = {
        save: "Gespeichert",
        apply: "Vorlage angewendet",
        complete: "Segment abgeschlossen",
        unlock: "Segment entsperrt",
        mark: "Punkt als irrelevant markiert",
        unmark: "Irrelevant-Markierung aufgehoben",
        assign: "Team zugewiesen",
        unassign: "Team-Zuweisung entfernt",
      }[state.operation];
      return { text: `${label} (Version ${state.version}).`, isError: false };
    }
    case "state": return {
      text: state.state === "completed"
        ? "Das Segment ist abgeschlossen und unveränderlich."
        : "Der Punkt ist derzeit verborgen und kann nicht markiert werden.",
      isError: true,
    };
    case "incomplete": return {
      text: `${state.remainingRequired} Pflichtpunkt${state.remainingRequired === 1 ? " ist" : "e sind"} noch offen.`,
      isError: true,
    };
    case "invalid": return { text: "Die Eingabe ist ungültig.", isError: true };
    case "conflict": return {
      text: "Die Checkliste wurde zwischenzeitlich geändert. Bitte neu laden und erneut versuchen.",
      isError: true,
    };
    case "not_found": return { text: "Die Checkliste oder Projektakte wurde nicht gefunden.", isError: true };
    case "denied": return { text: "Dir fehlt die Berechtigung für diese Aktion.", isError: true };
    case "unauthenticated": return { text: "Deine Sitzung ist abgelaufen.", isError: true };
    case "error": return { text: "Die Aktion ist unerwartet fehlgeschlagen. Bitte erneut versuchen.", isError: true };
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
  teamOptions,
}: {
  workspaceId: string;
  projectId: string;
  checklist: ProjectChecklistDto;
  teamOptions: TeamOption[];
}) {
  const { canWrite, canConfigure, canComplete, canUnlock } = checklist.permissions;
  const canEditStructure = canConfigure || (checklist.version === 0 && canWrite);
  const [blocksState, setBlocksState] = useState<{
    version: number;
    blocks: ChecklistBlocksV1;
  }>({ version: checklist.version, blocks: checklist.blocks });
  const [state, dispatch, savePending] = useActionState(saveProjectChecklistAction, initialState);

  const savedActionVersion = state.status === "success" && state.operation === "save"
    ? state.version
    : 0;
  const baseVersion = Math.max(savedActionVersion, checklist.version);
  const blocks = blocksState.version === checklist.version
    ? blocksState.blocks
    : checklist.blocks;
  // F7-05b: assignedTeams ist reines Server-Overlay aus versionslosen Ops
  // (Zuweisen/Entfernen bumpt die Baumversion bewusst nicht). Nach
  // Revalidierung deshalb immer frisch vom Serverprop je Block-ID
  // einmischen — sonst ueberstimmt der lokal zwischengespeicherte Baum
  // (gleiche Version) das entfernte Team und der Chip bleibt stehen.
  const serverTeamsByBlock = new Map(
    checklist.blocks.map((block) => [block.id, block.assignedTeams] as const),
  );
  const blocksWithServerTeams = blocks.map((block) => ({
    ...block,
    assignedTeams: serverTeamsByBlock.get(block.id) ?? [],
  }));
  const editableBlocks = toEditableChecklistBlocks(blocks);
  const serializedBlocks = JSON.stringify(editableBlocks);
  const blocksExceedTransport = new TextEncoder().encode(serializedBlocks).byteLength
    > CHECKLIST_BLOCKS_TRANSPORT_MAX_BYTES;
  const visibleBlocks = blocksWithServerTeams.filter((block) => block.visible);
  const hasUnsavedChanges = JSON.stringify(editableBlocks)
    !== JSON.stringify(toEditableChecklistBlocks(checklist.blocks));
  const progress = checklistProgress(blocks);
  const hasEmptyTitle = blocks.some((block) =>
    block.name.trim() === ""
    || block.segments.some((segment) =>
      segment.name.trim() === ""
      || segment.items.some((item) => item.title.trim() === "")));
  const blocksCapped = blocks.length >= 50;

  function patchBlocks(
    allowed: boolean,
    updater: (value: ChecklistBlocksV1) => ChecklistBlocksV1,
  ): void {
    if (!allowed || savePending) return;
    setBlocksState({ version: checklist.version, blocks: updater(blocks) });
  }

  const addBlock = () => patchBlocks(canEditStructure, (value) => [
    ...value,
    {
      id: crypto.randomUUID(),
      name: "Neuer Block",
      position: value.length,
      visible: true,
      segments: [],
      // F7-05b: neuer Block hat serverseitig noch keine Teams.
      assignedTeams: [],
    },
  ]);

  const addSegment = (blockIndex: number) => patchBlocks(canEditStructure, (value) => {
    const block = value[blockIndex]!;
    return value.map((candidate, index) => index === blockIndex
      ? {
          ...candidate,
          segments: [
            ...candidate.segments,
            {
              id: crypto.randomUUID(),
              name: "Neues Segment",
              position: block.segments.length,
              visible: true,
              items: [],
              completedAt: null,
              completedById: null,
            },
          ],
        }
      : candidate);
  });

  const addItem = (blockIndex: number, segmentIndex: number) =>
    patchBlocks(canEditStructure, (value) => value.map((block, index) => {
      if (index !== blockIndex) return block;
      return {
        ...block,
        segments: block.segments.map((segment, currentSegmentIndex) => {
          if (currentSegmentIndex !== segmentIndex || segment.completedAt !== null) return segment;
          return {
            ...segment,
            items: [
              ...segment.items,
              {
                id: crypto.randomUUID(),
                title: "Neuer Punkt",
                done: false,
                required: false,
                visible: true,
              },
            ],
          };
        }),
      };
    }));

  const setItem = (
    blockIndex: number,
    segmentIndex: number,
    itemIndex: number,
    patch: Partial<ChecklistItemV1>,
    allowed: boolean,
  ) => patchBlocks(allowed, (value) => value.map((block, index) => {
    if (index !== blockIndex) return block;
    return {
      ...block,
      segments: block.segments.map((segment, currentSegmentIndex) => {
        if (currentSegmentIndex !== segmentIndex || segment.completedAt !== null) return segment;
        return {
          ...segment,
          items: segment.items.map((item, currentItemIndex) =>
            currentItemIndex === itemIndex ? { ...item, ...patch } : item),
        };
      }),
    };
  }));

  const renameBlock = (blockIndex: number, name: string) =>
    patchBlocks(canEditStructure, (value) => value.map((block, index) =>
      index === blockIndex ? { ...block, name } : block));
  const renameSegment = (blockIndex: number, segmentIndex: number, name: string) =>
    patchBlocks(canEditStructure, (value) => value.map((block, index) => {
      if (index !== blockIndex) return block;
      return {
        ...block,
        segments: block.segments.map((segment, currentSegmentIndex) =>
          currentSegmentIndex === segmentIndex && segment.completedAt === null
            ? { ...segment, name }
            : segment),
      };
    }));

  return (
    <div className="space-y-6">
      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-950">{checklist.title}</h2>
            <p className="mt-1 text-xs text-slate-500">Phase: Baustellendokumentation</p>
          </div>
          <p className="text-sm font-semibold text-slate-800">
            Segmentfortschritt: {progress.done}/{progress.total}
            {progress.total > 0 ? ` (${Math.round((progress.done / progress.total) * 100)} %)` : ""}
          </p>
        </div>

        {checklist.checklistId !== null ? (
          <SegmentOutboxSync
            workspaceId={workspaceId}
            projectId={projectId}
            checklistId={checklist.checklistId}
            version={baseVersion}
            segments={blocks.flatMap((block) =>
              block.segments.map((segment) => ({
                segmentId: segment.id,
                name: segment.name,
                completedAt: segment.completedAt,
              })),
            )}
            canWrite={canComplete}
          />
        ) : null}

        {visibleBlocks.length === 0 ? (
          <p className="mt-3 text-sm leading-6 text-slate-500">Noch keine sichtbaren Blöcke angelegt.</p>
        ) : (
          <div className="mt-3 space-y-4">
            {visibleBlocks.map((block) => {
              const blockIndex = blocks.findIndex((candidate) => candidate.id === block.id);
              return (
                <BlockCard
                  key={block.id}
                  block={block}
                  blockIndex={blockIndex}
                  workspaceId={workspaceId}
                  projectId={projectId}
                  checklistId={checklist.checklistId}
                  baseVersion={baseVersion}
                  canWrite={canWrite}
                  canEditStructure={canEditStructure}
                  canConfigure={canConfigure}
                  canComplete={canComplete}
                  canUnlock={canUnlock}
                  hasUnsavedChanges={hasUnsavedChanges}
                  onRename={(name) => renameBlock(blockIndex, name)}
                  onAddSegment={() => addSegment(blockIndex)}
                  onAddItem={(segmentIndex) => addItem(blockIndex, segmentIndex)}
                  onRenameSegment={(segmentIndex, name) => renameSegment(blockIndex, segmentIndex, name)}
                  onSetItem={(segmentIndex, itemIndex, patch, allowed) =>
                    setItem(blockIndex, segmentIndex, itemIndex, patch, allowed)}
                  teamOptions={teamOptions}
                />
              );
            })}
          </div>
        )}

        {canEditStructure ? (
          <button
            type="button"
            onClick={addBlock}
            disabled={blocksCapped || savePending}
            className="mt-4 min-h-11 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            Block hinzufügen
          </button>
        ) : null}

        {canWrite ? (
          <form action={dispatch} className="mt-5">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="checklistId" value={checklist.checklistId ?? ""} />
            <input type="hidden" name="phase" value={checklist.phase} />
            <input type="hidden" name="title" value={checklist.title} />
            <input type="hidden" name="baseVersion" value={baseVersion} />
            <input type="hidden" name="blocks" value={serializedBlocks} />
            <Feedback state={state} />
            {hasEmptyTitle ? (
              <p className="mt-3 text-sm font-semibold text-amber-700">
                Bitte alle Block-, Segment- und Punktnamen ausfüllen, bevor du speicherst.
              </p>
            ) : null}
            {blocksExceedTransport ? (
              <p className="mt-3 text-sm font-semibold text-amber-700">
                Die Checkliste ist zu groß. Bitte Struktur oder Texte kürzen.
              </p>
            ) : null}
            <button
              type="submit"
              disabled={hasEmptyTitle || blocksExceedTransport || savePending}
              className="mt-3 inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {savePending ? "Speichert …" : "Speichern"}
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}

type SetItem = (
  segmentIndex: number,
  itemIndex: number,
  patch: Partial<ChecklistItemV1>,
  allowed: boolean,
) => void;

function BlockCard({
  block, blockIndex, workspaceId, projectId, checklistId, baseVersion,
  canWrite, canEditStructure, canConfigure, canComplete, canUnlock,
  hasUnsavedChanges, teamOptions,
  onRename, onAddSegment, onAddItem, onRenameSegment, onSetItem,
}: {
  block: ChecklistBlockV1;
  blockIndex: number;
  workspaceId: string;
  projectId: string;
  checklistId: string | null;
  baseVersion: number;
  canWrite: boolean;
  canEditStructure: boolean;
  canConfigure: boolean;
  canComplete: boolean;
  canUnlock: boolean;
  hasUnsavedChanges: boolean;
  teamOptions: TeamOption[];
  onRename: (name: string) => void;
  onAddSegment: () => void;
  onAddItem: (segmentIndex: number) => void;
  onRenameSegment: (segmentIndex: number, name: string) => void;
  onSetItem: SetItem;
}) {
  const visibleSegments = block.segments.filter((segment) => segment.visible);
  return (
    <div className="rounded-md border border-slate-200 p-4">
      {canEditStructure ? (
        <input
          type="text"
          aria-label={`Block-Name ${blockIndex + 1}`}
          value={block.name}
          onChange={(event) => onRename(event.target.value)}
          className="min-h-11 w-full max-w-md rounded-md border border-slate-300 px-2 text-base font-semibold outline-none focus:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600 sm:text-sm"
        />
      ) : (
        <h3 className="text-sm font-semibold text-slate-900">{block.name}</h3>
      )}
      {checklistId !== null ? (
        <BlockTeamControl
          workspaceId={workspaceId}
          projectId={projectId}
          checklistId={checklistId}
          block={block}
          teamOptions={teamOptions}
          canWrite={canWrite}
        />
      ) : null}

      <div className="mt-3 space-y-3">
        {visibleSegments.map((segment) => {
          const segmentIndex = block.segments.findIndex((candidate) => candidate.id === segment.id);
          return (
            <SegmentGroup
              key={segment.id}
              segment={segment}
              segmentIndex={segmentIndex}
              workspaceId={workspaceId}
              projectId={projectId}
              checklistId={checklistId}
              baseVersion={baseVersion}
              canWrite={canWrite}
              canEditStructure={canEditStructure}
              canConfigure={canConfigure}
              canComplete={canComplete}
              canUnlock={canUnlock}
              hasUnsavedChanges={hasUnsavedChanges}
              onRename={(name) => onRenameSegment(segmentIndex, name)}
              onAddItem={() => onAddItem(segmentIndex)}
              onSetItem={(itemIndex, patch, allowed) => onSetItem(segmentIndex, itemIndex, patch, allowed)}
            />
          );
        })}
        {visibleSegments.length === 0 ? (
          <p className="text-xs text-slate-500">Noch keine sichtbaren Segmente.</p>
        ) : null}
      </div>

      {canEditStructure ? (
        <button
          type="button"
          aria-label={`${block.name}: Segment hinzufügen`}
          onClick={onAddSegment}
          className="mt-3 min-h-11 rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          Segment hinzufügen
        </button>
      ) : null}
    </div>
  );
}

function SegmentGroup({
  segment, segmentIndex, workspaceId, projectId, checklistId, baseVersion,
  canWrite, canEditStructure, canConfigure, canComplete, canUnlock, onRename, onAddItem, onSetItem,
  hasUnsavedChanges,
}: {
  segment: ChecklistSegmentV1;
  segmentIndex: number;
  workspaceId: string;
  projectId: string;
  checklistId: string | null;
  baseVersion: number;
  canWrite: boolean;
  canEditStructure: boolean;
  canConfigure: boolean;
  canComplete: boolean;
  canUnlock: boolean;
  hasUnsavedChanges: boolean;
  onRename: (name: string) => void;
  onAddItem: () => void;
  onSetItem: (itemIndex: number, patch: Partial<ChecklistItemV1>, allowed: boolean) => void;
}) {
  const [mutationState, mutationDispatch, mutationPending] = useActionState(
    mutateChecklistSegmentAction,
    initialState,
  );
  // F7-04c: Offline-Abschluss in die Segment-Outbox statt Submit.
  const [offlineNotice, setOfflineNotice] = useState<string | null>(null);
  const completed = segment.completedAt !== null;
  const remainingRequired = segmentRequiredRemaining(segment);
  const itemProgress = segmentItemProgress(segment);
  const pending = mutationPending;
  // F7-02B: effektive Sichtbarkeit (if/then, Single-Hop). Die Map wird pro
  // Render neu aufgebaut (kleine Arrays); Indizes bleiben stabil, weil
  // versteckte Punkte als null weitergerendert werden.
  const segmentItemsById = new Map(segment.items.map((candidate) => [candidate.id, candidate]));

  return (
    <div className={`rounded-md p-3 ${completed ? "border border-green-200 bg-green-50" : "bg-slate-50"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        {canEditStructure && !completed ? (
          <input
            type="text"
            aria-label={`Segment-Name ${segmentIndex + 1}`}
            value={segment.name}
            onChange={(event) => onRename(event.target.value)}
            className="min-h-11 w-full max-w-md rounded-md border border-slate-300 bg-white px-2 text-base font-semibold outline-none focus:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600 sm:text-sm"
          />
        ) : (
          <h4 className="text-sm font-semibold text-slate-800">{segment.name}</h4>
        )}
        <p className="text-xs font-semibold text-slate-600">Punkte: {itemProgress.done}/{itemProgress.total}</p>
      </div>

      {completed ? (
        <p className="mt-2 text-xs font-semibold text-green-800">
          Abgeschlossen: <time dateTime={segment.completedAt!}>{formatTimestamp(segment.completedAt!)}</time>
          {" · Inhalte schreibgeschützt"}
        </p>
      ) : remainingRequired > 0 ? (
        <p className="mt-2 text-xs font-semibold text-amber-700">
          Noch {remainingRequired} Pflichtpunkt{remainingRequired === 1 ? "" : "e"} offen.
        </p>
      ) : null}

      <ul className="mt-2 space-y-2">
        {segment.items.map((item, itemIndex) => isItemEffectivelyVisible(item, segmentItemsById) ? (
          <li key={item.id} className="flex items-start gap-1">
            {isChecklistWorkItem(item) ? (
              <label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center">
                <input
                  type="checkbox"
                  aria-label={item.title || `Punkt ${itemIndex + 1}`}
                  checked={item.done}
                  disabled={!canWrite || completed || pending}
                  onChange={(event) => onSetItem(itemIndex, { done: event.target.checked }, canWrite)}
                  className="h-5 w-5 rounded border-slate-300 text-brand-800 focus:ring-2 focus:ring-brand-600"
                />
              </label>
            ) : null}
            <div className="min-w-0 flex-1">
              {canEditStructure && !completed ? (
                <input
                  type="text"
                  value={item.title}
                  aria-label={`Punkt-Name ${segmentIndex + 1}.${itemIndex + 1}`}
                  onChange={(event) => onSetItem(itemIndex, { title: event.target.value }, canEditStructure)}
                  placeholder="Punkt"
                  className="min-h-11 w-full rounded-md border border-slate-300 bg-white px-2 text-base outline-none focus:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600 sm:text-sm"
                />
              ) : (
                <span className={`text-sm ${item.done ? "text-slate-500 line-through" : "text-slate-800"}${item.kind === "title" ? " font-semibold" : ""}`}>
                  {item.title}
                </span>
              )}
              {canEditStructure && !completed ? (
                <ItemKindControl
                  item={item}
                  itemIndex={itemIndex}
                  canEditStructure={canEditStructure}
                  onSetItem={onSetItem}
                />
              ) : null}
              {item.kind === "description" && item.description && !(canEditStructure && !completed) ? (
                <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">{item.description}</p>
              ) : null}
              {canConfigure && !completed && isChecklistWorkItem(item) ? (
                <label className="mt-1 flex min-h-11 w-fit cursor-pointer items-center gap-2 px-1 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    aria-label={`${item.title || `Punkt ${itemIndex + 1}`}: Pflichtpunkt`}
                    checked={item.required}
                    onChange={(event) => onSetItem(itemIndex, { required: event.target.checked }, canConfigure)}
                    className="h-5 w-5 rounded border-slate-300 text-brand-800 focus:ring-2 focus:ring-brand-600"
                  />
                  Pflichtpunkt
                </label>
              ) : item.required ? (
                <span className="mt-0.5 block text-xs text-slate-500">Pflichtpunkt</span>
              ) : null}
              {canConfigure && !completed ? (
                <ItemVisibilityRuleControl
                  item={item}
                  itemIndex={itemIndex}
                  segment={segment}
                  canConfigure={canConfigure}
                  onSetItem={onSetItem}
                />
              ) : null}
              {checklistId !== null ? (
                <ItemIrrelevantControl
                  workspaceId={workspaceId}
                  projectId={projectId}
                  checklistId={checklistId}
                  segmentId={segment.id}
                  item={item}
                  baseVersion={baseVersion}
                  canWrite={canWrite}
                  completed={completed}
                />
              ) : null}
            </div>
          </li>
        ) : null)}
      </ul>

      {canEditStructure && !completed ? (
        <button
          type="button"
          aria-label={`${segment.name}: Punkt hinzufügen`}
          onClick={onAddItem}
          disabled={pending}
          className="mt-2 min-h-11 rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:bg-slate-100"
        >
          Punkt hinzufügen
        </button>
      ) : null}

      {!completed && canComplete && checklistId !== null ? (
        <form
          action={mutationDispatch}
          className="mt-3"
          onSubmit={(event) => {
            if (typeof navigator !== "undefined" && navigator.onLine === false) {
              event.preventDefault();
              const targetChecklistId = checklistId;
              if (targetChecklistId === null) return;
              void enqueueSegmentComplete({
                workspaceId,
                projectId,
                checklistId: targetChecklistId,
                segmentId: segment.id,
                queuedAt: new Date().toISOString(),
              }).then(
                () => setOfflineNotice(
                  "Offline gespeichert — wird synchronisiert, sobald du wieder online bist.",
                ),
                () => setOfflineNotice(
                  "Offline-Speichern ist fehlgeschlagen (erneut versuchen, sobald online).",
                ),
              );
            } else {
              setOfflineNotice(null);
            }
          }}
        >
          <SegmentMutationFields workspaceId={workspaceId} projectId={projectId} checklistId={checklistId}
            segmentId={segment.id} baseVersion={baseVersion} operation="complete" />
          <button
            type="submit"
            aria-label={`${segment.name}: Segment abschließen`}
            disabled={remainingRequired > 0 || hasUnsavedChanges || pending}
            className="min-h-11 rounded-md bg-brand-700 px-3 text-xs font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {mutationPending ? "Schließt ab …" : "Segment abschließen"}
          </button>
          {hasUnsavedChanges ? (
            <p className="mt-2 text-xs font-semibold text-amber-700">
              Änderungen zuerst speichern, dann das Segment abschließen.
            </p>
          ) : null}
          {offlineNotice !== null ? (
            <p role="status" className="mt-2 text-xs font-semibold text-slate-700">
              {offlineNotice}
            </p>
          ) : null}
        </form>
      ) : null}

      {completed && canUnlock && checklistId !== null ? (
        <form action={mutationDispatch} className="mt-3">
          <SegmentMutationFields workspaceId={workspaceId} projectId={projectId} checklistId={checklistId}
            segmentId={segment.id} baseVersion={baseVersion} operation="unlock" />
          <button
            type="submit"
            aria-label={`${segment.name}: Segment entsperren`}
            disabled={pending}
            className="min-h-11 rounded-md border border-slate-400 bg-white px-3 text-xs font-semibold text-slate-800 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            {mutationPending ? "Entsperrt …" : "Segment entsperren"}
          </button>
        </form>
      ) : null}
      <Feedback state={mutationState} />
    </div>
  );
}

// F7-05b: Block-Team-Zuweisung (mehrere Teams parallel, Katalog F7.5).
// Eigene Server-Actions (sofort wirksam, keine Revision): aktive Teams
// zuweisen, zugewiesene (auch archivierte) entfernen.
function BlockTeamControl({ workspaceId, projectId, checklistId, block, teamOptions, canWrite }: {
  workspaceId: string;
  projectId: string;
  checklistId: string;
  block: ChecklistBlockV1;
  teamOptions: TeamOption[];
  canWrite: boolean;
}) {
  const [assignState, assignDispatch, assignPending] = useActionState(
    assignChecklistBlockTeamAction,
    initialState,
  );
  const [unassignState, unassignDispatch, unassignPending] = useActionState(
    unassignChecklistBlockTeamAction,
    initialState,
  );
  const assignedIds = new Set(block.assignedTeams.map((entry) => entry.teamId));
  const assignable = teamOptions.filter((option) => !assignedIds.has(option.id));
  const blockLabel = block.name || "Block";
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-500">Teams:</span>
        {block.assignedTeams.length === 0 ? (
          <span className="text-xs text-slate-500">keine zugewiesen</span>
        ) : null}
        {block.assignedTeams.map((entry) => (
          <span key={entry.teamId} className="inline-flex items-center gap-1">
            <span
              data-testid={`checklist-block-team-${block.id}-${entry.teamId}`}
              className="inline-block rounded-full bg-brand-100 px-2 py-px text-xs font-medium text-brand-900"
            >
              {entry.teamName}{entry.active ? "" : " (archiviert)"}
            </span>
            {canWrite ? (
              <form action={unassignDispatch} className="inline">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="checklistId" value={checklistId} />
                <input type="hidden" name="blockId" value={block.id} />
                <input type="hidden" name="teamId" value={entry.teamId} />
                <button
                  type="submit"
                  aria-label={`${blockLabel}: ${entry.teamName} entfernen`}
                  disabled={unassignPending}
                  className="min-h-11 rounded-md border border-slate-300 px-2 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:bg-slate-100"
                >
                  {unassignPending ? "Entfernt …" : "Entfernen"}
                </button>
              </form>
            ) : null}
          </span>
        ))}
      </div>
      {canWrite && assignable.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {assignable.map((option) => (
            <form key={option.id} action={assignDispatch} className="inline">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="checklistId" value={checklistId} />
              <input type="hidden" name="blockId" value={block.id} />
              <input type="hidden" name="teamId" value={option.id} />
              <button
                type="submit"
                aria-label={`${blockLabel}: ${option.name} zuweisen`}
                disabled={assignPending}
                className="min-h-11 rounded-md border border-dashed border-slate-300 px-2 text-xs font-semibold text-slate-600 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:bg-slate-100"
              >
                {assignPending ? "Weist zu …" : `${option.name} zuweisen`}
              </button>
            </form>
          ))}
        </div>
      ) : null}
      <Feedback state={assignState} />
      <Feedback state={unassignState} />
    </div>
  );
}

// F7-04b: Irrelevant-Markierung je Pflichtpunkt. Eigene Server-Action
// (sofort wirksam, eigene Version) statt Whole-Tree-Save — Begründungspflicht
// und Gate-Skip kommen aus der Kapsel, nicht aus lokalem State.
function ItemIrrelevantControl({ workspaceId, projectId, checklistId, segmentId, item, baseVersion, canWrite, completed }: {
  workspaceId: string;
  projectId: string;
  checklistId: string;
  segmentId: string;
  item: ChecklistItemV1;
  baseVersion: number;
  canWrite: boolean;
  completed: boolean;
}) {
  const [markState, markDispatch, markPending] = useActionState(
    setChecklistItemIrrelevantAction,
    initialState,
  );
  const [formOpen, setFormOpen] = useState(false);
  const title = item.title || "Punkt";
  if (!canWrite || completed) return null;

  if (item.irrelevant != null) {
    return (
      <div className="mt-1">
        <p
          data-testid={`checklist-item-irrelevant-${item.id}`}
          className="inline-block rounded-full bg-slate-200 px-2 py-px text-xs font-medium text-slate-700"
        >
          Irrelevant: {item.irrelevant.reason}
        </p>
        <form action={markDispatch} className="mt-1">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="checklistId" value={checklistId} />
          <input type="hidden" name="segmentId" value={segmentId} />
          <input type="hidden" name="itemId" value={item.id} />
          <input type="hidden" name="baseVersion" value={baseVersion} />
          <input type="hidden" name="reason" value="" />
          <button
            type="submit"
            aria-label={`${title}: Markierung aufheben`}
            disabled={markPending}
            className="min-h-11 rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            {markPending ? "Hebt auf …" : "Markierung aufheben"}
          </button>
        </form>
        <Feedback state={markState} />
      </div>
    );
  }

  if (!item.required) return null;
  return (
    <div className="mt-1">
      {formOpen ? (
        <form action={markDispatch} className="mt-1 space-y-2">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="checklistId" value={checklistId} />
          <input type="hidden" name="segmentId" value={segmentId} />
          <input type="hidden" name="itemId" value={item.id} />
          <input type="hidden" name="baseVersion" value={baseVersion} />
          <label className="block text-xs font-semibold text-slate-700" htmlFor={`irrelevant-reason-${item.id}`}>
            Begründung (Pflicht)
          </label>
          <textarea
            id={`irrelevant-reason-${item.id}`}
            name="reason"
            rows={2}
            maxLength={2000}
            disabled={markPending}
            className="min-h-11 w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm outline-none focus:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600 disabled:bg-slate-100"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              aria-label={`${title}: Als irrelevant markieren`}
              disabled={markPending}
              className="min-h-11 rounded-md bg-brand-700 px-3 text-xs font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {markPending ? "Markiert …" : "Als irrelevant markieren"}
            </button>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              disabled={markPending}
              className="min-h-11 rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:bg-slate-100"
            >
              Abbrechen
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          aria-label={`${title}: Irrelevant-Dialog öffnen`}
          onClick={() => setFormOpen(true)}
          className="min-h-11 rounded-md border border-dashed border-slate-300 px-3 text-xs font-semibold text-slate-600 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          Als irrelevant markieren
        </button>
      )}
      <Feedback state={markState} />
    </div>
  );
}

// F7-02C: Typ-Editor für Anzeige-Punkte (title/description). Der Typwechsel
// schreibt ehrlich um (kein Dialog): weg von Aufgabe → done/required false,
// weg von Beschreibung → description null. Mischbestände lehnen Zod-Guard
// und DB-Validator (0130) fail-closed ab.
function ItemKindControl({ item, itemIndex, canEditStructure, onSetItem }: {
  item: ChecklistItemV1;
  itemIndex: number;
  canEditStructure: boolean;
  onSetItem: (itemIndex: number, patch: Partial<ChecklistItemV1>, allowed: boolean) => void;
}) {
  const title = item.title || "Punkt";
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-slate-600">
      <label htmlFor={`item-kind-${item.id}`}>Typ</label>
      <select
        id={`item-kind-${item.id}`}
        value={item.kind ?? "task"}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "description") {
            onSetItem(itemIndex, { kind: "description", done: false, required: false }, canEditStructure);
          } else if (next === "title") {
            onSetItem(itemIndex, { kind: "title", done: false, required: false, description: null }, canEditStructure);
          } else {
            onSetItem(itemIndex, { kind: "task", description: null }, canEditStructure);
          }
        }}
        className="min-h-11 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-800 outline-none focus:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600"
      >
        <option value="task">Aufgabe</option>
        <option value="title">Titel</option>
        <option value="description">Beschreibung</option>
      </select>
      {item.kind === "description" ? (
        <textarea
          aria-label={`${title}: Beschreibungstext`}
          value={item.description ?? ""}
          onChange={(event) => {
            const value = event.target.value;
            onSetItem(itemIndex, { description: value === "" ? null : value }, canEditStructure);
          }}
          rows={2}
          placeholder="Beschreibungstext"
          className="min-h-11 w-full max-w-md rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-800 outline-none focus:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600"
        />
      ) : null}
    </div>
  );
}

// F7-02B: Regel-Editor für bedingte Sichtbarkeit (if/then). Schreibt die
// Regel in den lokalen Baum (Whole-Tree-Save persistiert); der Save-Guard
// (Zod) und der DB-Validator (0129) verweigern baumelnde Regeln
// fail-closed — eine verwaiste Referenz bleibt als deaktivierte Option
// sichtbar, statt still auf „Immer" zu fallen.
function ItemVisibilityRuleControl({ item, itemIndex, segment, canConfigure, onSetItem }: {
  item: ChecklistItemV1;
  itemIndex: number;
  segment: ChecklistSegmentV1;
  canConfigure: boolean;
  onSetItem: (itemIndex: number, patch: Partial<ChecklistItemV1>, allowed: boolean) => void;
}) {
  const title = item.title || "Punkt";
  const rule = item.visibleIf ?? null;
  const siblings = segment.items.filter((candidate) => candidate.id !== item.id);
  const dangling = rule !== null && !siblings.some((candidate) => candidate.id === rule.itemId);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-slate-600">
      <label htmlFor={`visible-if-${item.id}`}>Sichtbar, wenn</label>
      <select
        id={`visible-if-${item.id}`}
        value={rule?.itemId ?? ""}
        onChange={(event) => {
          const next = event.target.value;
          onSetItem(itemIndex, {
            visibleIf: next === "" ? null : { itemId: next, equals: rule?.equals ?? true },
          }, canConfigure);
        }}
        className="min-h-11 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-800 outline-none focus:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600"
      >
        <option value="">Immer sichtbar</option>
        {dangling && rule !== null ? (
          <option value={rule.itemId} disabled>Entfernter Punkt (ungültig)</option>
        ) : null}
        {siblings.map((sibling) => (
          <option key={sibling.id} value={sibling.id}>{sibling.title || "Punkt"}</option>
        ))}
      </select>
      {rule !== null ? (
        <select
          aria-label={`${title}: Bedingung`}
          value={rule.equals ? "done" : "open"}
          onChange={(event) => {
            onSetItem(itemIndex, {
              visibleIf: { itemId: rule.itemId, equals: event.target.value === "done" },
            }, canConfigure);
          }}
          className="min-h-11 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-800 outline-none focus:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          <option value="done">erledigt ist</option>
          <option value="open">nicht erledigt ist</option>
        </select>
      ) : null}
    </div>
  );
}

function SegmentMutationFields({ workspaceId, projectId, checklistId, segmentId, baseVersion, operation }: {
  workspaceId: string;
  projectId: string;
  checklistId: string;
  segmentId: string;
  baseVersion: number;
  operation: "complete" | "unlock";
}) {
  return (
    <>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="checklistId" value={checklistId} />
      <input type="hidden" name="segmentId" value={segmentId} />
      <input type="hidden" name="baseVersion" value={baseVersion} />
      <input type="hidden" name="operation" value={operation} />
    </>
  );
}

function formatTimestamp(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/u, " UTC");
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
  const [applyState, applyDispatch, applyPending] = useActionState(applyTemplateAction, initialState);
  if (!canWrite || templates.length === 0) {
    return null;
  }
  // Nach erfolgreicher Anlage bleibt nur die Bestätigung sichtbar. Die
  // Controls verschwinden sofort; ein deterministisch konfliktender zweiter
  // Apply ist damit weder möglich noch kann sein Feedback verdeckt werden.
  const appliedInThisRender = applyState.status === "success"
    && applyState.operation === "apply";
  if (checklistVersion !== 0 || appliedInThisRender) {
    return applyState.status === "success" ? (
      <section aria-label="Vorlagenanwendung" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-5 py-2">
        <Feedback state={applyState} />
      </section>
    ) : null;
  }
  return (
    <section className={`${applyPending ? "hidden " : ""}min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6`}>
      <h2 className="text-base font-semibold text-slate-950">Aus Vorlage anlegen</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        Erzeugt die Material-Checkliste aus einer Vorlage (ESTIMATE-Mapping).
      </p>
      <form action={applyDispatch} className="mt-3 flex flex-wrap items-center gap-2">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="projectId" value={projectId} />
        <select name="templateId" aria-label="Vorlage" disabled={applyPending}
          className="min-h-11 rounded-md border border-slate-300 px-2 text-base outline-none focus:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600 disabled:bg-slate-100 sm:text-sm">
          {templates.map((template) => (
            <option key={template.id} value={template.id}>{template.name}</option>
          ))}
        </select>
        <button type="submit" disabled={applyPending}
          className="min-h-11 rounded-md bg-brand-700 px-3 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:bg-slate-300">
          {applyPending ? "Erstellt …" : "Checkliste erstellen"}
        </button>
      </form>
      <Feedback state={applyState} />
    </section>
  );
}
