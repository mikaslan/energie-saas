"use client";

import { useEffect, useRef, useState } from "react";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";

// F6-02c-A · Freier Editor: Canvas (client, controlled). Rendert NUR
// Overlay-Elemente im 640×300-Raum (eigenes SVG, Diagramm unberührt).
// Drag per pragmatic-dnd (Board-Muster), Tastatur-Nudge ±1/±10,
// ID-Chips aus dem Server-Mapping. Kein Auto-Save: Drop/Nudge melden
// nur ans Formular (onPositionChange), Save bleibt explizit.

const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 300;

/** Formularzeile (strukturell): nur was der Canvas braucht. */
export type OverlayCanvasRow = {
  kind: string;
  x: string;
  y: string;
};

type CanvasDragData = {
  type: "overlay-element";
  index: number;
};

type CanvasDropData = {
  type: "overlay-canvas";
};

const KIND_LABELS: Record<string, string> = {
  earthing_point: "Erdungspunkt",
  junction_box: "Abzweigdose",
  generic: "Generik",
  textbox: "Textbox",
};

function isCanvasDragData(value: Record<string | symbol, unknown>): value is CanvasDragData {
  return value.type === "overlay-element" && typeof value.index === "number";
}

function isCanvasDropData(value: Record<string | symbol, unknown>): value is CanvasDropData {
  return value.type === "overlay-canvas";
}

function parseCoordinate(value: string, max: number): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) return null;
  return parsed;
}

function clampRound(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.round(value)));
}

function OverlayHandle({
  index,
  kind,
  x,
  y,
  id,
  disabled,
  dndEnabled,
  onNudge,
}: {
  index: number;
  kind: string;
  x: number;
  y: number;
  id: string | null;
  disabled: boolean;
  dndEnabled: boolean;
  onNudge: (index: number, x: number, y: number) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const label = KIND_LABELS[kind] ?? kind;
  const positionText = `Position ${x}, ${y}`;

  useEffect(() => {
    const element = ref.current;
    if (!element || disabled || !dndEnabled) return;
    return draggable({
      element,
      canDrag: () => !disabled,
      getInitialData: (): CanvasDragData => ({ type: "overlay-element", index }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });
  }, [disabled, dndEnabled, index]);

  const canInteract = !disabled;
  return (
    <span
      className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${(x / CANVAS_WIDTH) * 100}%`, top: `${(y / CANVAS_HEIGHT) * 100}%` }}
    >
      <button
        ref={ref}
        type="button"
        data-testid="schematic-overlay-handle"
        disabled={!canInteract}
        aria-label={`${label}, Zeile ${index + 1}, ${positionText}${id ? `, ID ${id}` : ""}`}
        title={`${label} — ziehen oder Pfeiltasten (±1, mit Shift ±10)`}
        onKeyDown={(event) => {
          if (!canInteract) return;
          const step = event.shiftKey ? 10 : 1;
          let nextX = x;
          let nextY = y;
          if (event.key === "ArrowRight") nextX = x + step;
          else if (event.key === "ArrowLeft") nextX = x - step;
          else if (event.key === "ArrowDown") nextY = y + step;
          else if (event.key === "ArrowUp") nextY = y - step;
          else return;
          event.preventDefault();
          onNudge(index, clampRound(nextX, CANVAS_WIDTH), clampRound(nextY, CANVAS_HEIGHT));
        }}
        className={`flex h-7 w-7 cursor-grab items-center justify-center rounded-full border-2 border-slate-950 bg-white text-xs font-bold text-slate-950 outline-none select-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40 ${
          dragging ? "opacity-70 shadow-lg" : "shadow-sm"
        }`}
      >
        <span aria-hidden="true">⠿</span>
      </button>
      {id ? (
        <span
          data-testid="schematic-overlay-id-chip"
          className="pointer-events-none absolute top-full left-1/2 mt-1 -translate-x-1/2 rounded bg-slate-950 px-1.5 py-0.5 text-[11px] leading-4 font-semibold whitespace-nowrap text-white"
        >
          {id}
        </span>
      ) : null}
    </span>
  );
}

export function SchematicOverlayCanvas({
  rows,
  elementIds,
  onPositionChange,
  disabled,
}: {
  rows: readonly OverlayCanvasRow[];
  elementIds: readonly (string | null)[];
  onPositionChange: (index: number, x: number, y: number) => void;
  disabled: boolean;
}) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [dndEnabled, setDndEnabled] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  // Board-Muster: DnD nur mit feinem Zeiger (Desktop-Maus).
  useEffect(() => {
    if (disabled) return;
    const media = window.matchMedia("(pointer: fine)");
    const sync = () => setDndEnabled(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [disabled]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || disabled || !dndEnabled) return;
    return dropTargetForElements({
      element,
      getData: (): CanvasDropData => ({ type: "overlay-canvas" }),
      canDrop: ({ source }) => !disabled && isCanvasDragData(source.data),
    });
  }, [disabled, dndEnabled]);

  useEffect(() => {
    if (disabled || !dndEnabled) return;
    return monitorForElements({
      canMonitor: ({ source }) => isCanvasDragData(source.data),
      onDrop: ({ source, location }) => {
        if (!isCanvasDragData(source.data)) return;
        const target = location.current.dropTargets.find(({ data }) => isCanvasDropData(data));
        if (!target) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const input = location.current.input;
        const x = clampRound(((input.clientX - rect.left) / rect.width) * CANVAS_WIDTH, CANVAS_WIDTH);
        const y = clampRound(((input.clientY - rect.top) / rect.height) * CANVAS_HEIGHT, CANVAS_HEIGHT);
        const index = source.data.index;
        onPositionChange(index, x, y);
        setAnnouncement(`Zeile ${index + 1} auf Position ${x}, ${y} gelegt. Noch nicht gespeichert.`);
      },
    });
  }, [disabled, dndEnabled, onPositionChange]);

  const handleNudge = (index: number, x: number, y: number) => {
    onPositionChange(index, x, y);
    setAnnouncement(`Zeile ${index + 1} auf Position ${x}, ${y}. Noch nicht gespeichert.`);
  };

  return (
    <div
      ref={canvasRef}
      data-testid="schematic-overlay-canvas"
      data-dnd-enabled={dndEnabled && !disabled ? "true" : "false"}
      className="relative aspect-[640/300] w-full overflow-visible rounded-md border border-slate-200 bg-white"
    >
      <svg
        viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
        aria-hidden="true"
        focusable="false"
        className="absolute inset-0 h-full w-full"
      >
        <rect x={0} y={0} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill="#f8fafc" />
        {Array.from({ length: 7 }, (_, i) => (i + 1) * 80).map((gx) => (
          <line key={`v${gx}`} x1={gx} y1={0} x2={gx} y2={CANVAS_HEIGHT} stroke="#e2e8f0" strokeWidth={1} />
        ))}
        {Array.from({ length: 5 }, (_, i) => (i + 1) * 50).map((gy) => (
          <line key={`h${gy}`} x1={0} y1={gy} x2={CANVAS_WIDTH} y2={gy} stroke="#e2e8f0" strokeWidth={1} />
        ))}
      </svg>
      {rows.map((row, index) => {
        if (row.kind === "connector") return null;
        const x = parseCoordinate(row.x, CANVAS_WIDTH);
        const y = parseCoordinate(row.y, CANVAS_HEIGHT);
        if (x === null || y === null) return null;
        return (
          <OverlayHandle
            key={`overlay-handle-${index}`}
            index={index}
            kind={row.kind}
            x={x}
            y={y}
            id={elementIds[index] ?? null}
            disabled={disabled}
            dndEnabled={dndEnabled}
            onNudge={handleNudge}
          />
        );
      })}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
