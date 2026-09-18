"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// F2.8 Portal-Draw-Signatur: gezeichnete Unterschrift je Dokument.
// Progressive Enhancement — ohne JS rendert nur das Klick-Formular
// (mounted-Gate). Stift/Maus/Touch per Pointer-Events, PNG-Export per
// nativem Multipart-POST (ohne fetch, 303-Folge wie Klick-Pfad).
const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 200;
const PNG_MAX_BYTES = 512 * 1024;

type DrawSignatureFormProps = {
  token: string;
  issuanceId: string;
  lang: string;
  disclosure: string;
  clearLabel: string;
  submitLabel: string;
  emptyHint: string;
  keyboardHint: string;
  clickLabel: string;
};

export function DrawSignatureForm(props: DrawSignatureFormProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const drawingRef = useRef(false);
  // Client-only (SSR: false) ohne setState-in-Effect — no-JS sieht nur Klick.
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  const [hasStrokes, setHasStrokes] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!mounted) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = CANVAS_WIDTH * ratio;
    canvas.height = CANVAS_HEIGHT * ratio;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.lineWidth = 2.5;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#0f172a";
  }, [mounted]);

  if (!mounted) return null;

  function canvasPoint(event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
    };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const point = canvasPoint(event);
    if (!canvas || !context || !point) return;
    canvas.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    context.beginPath();
    context.moveTo(point.x, point.y);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!drawingRef.current) return;
    const context = canvasRef.current?.getContext("2d");
    const point = canvasPoint(event);
    if (!context || !point) return;
    context.lineTo(point.x, point.y);
    context.stroke();
    setHasStrokes(true);
    setError("");
  }

  function handlePointerUp(event: React.PointerEvent<HTMLCanvasElement>): void {
    drawingRef.current = false;
    if (canvasRef.current?.hasPointerCapture(event.pointerId)) {
      canvasRef.current.releasePointerCapture(event.pointerId);
    }
  }

  function handleClear(): void {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.restore();
    setHasStrokes(false);
    setError("");
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const canvas = canvasRef.current;
    const fileInput = fileRef.current;
    const form = formRef.current;
    if (!canvas || !fileInput || !form) return;
    if (!hasStrokes) {
      setError(props.emptyHint);
      return;
    }
    canvas.toBlob((blob) => {
      // Praktisch unerreichbar (600×200-Strich-PNG bleibt weit unter
      // 512 KiB; Server prueft erneut) — daher leere-Hinweis wiederverwenden.
      if (!blob || blob.size < 1 || blob.size > PNG_MAX_BYTES) {
        setError(props.emptyHint);
        return;
      }
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], "unterschrift.png", { type: "image/png" }));
      fileInput.files = transfer.files;
      form.submit();
    }, "image/png");
  }

  return (
    <div className="w-full basis-full" data-testid="draw-signature">
      <details className="rounded-md border border-slate-200 bg-slate-50">
        <summary
          className="cursor-pointer rounded-md px-3 py-2 text-sm font-semibold text-brand-800 outline-none hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-600"
          data-testid="draw-signature-disclosure"
        >
          {props.disclosure}
        </summary>
        <form
          ref={formRef}
          action={`/p/${props.token}/signatur`}
          method="post"
          encType="multipart/form-data"
          onSubmit={handleSubmit}
          className="grid gap-2 p-3"
        >
          <input type="hidden" name="action" value="sign_draw" />
          <input type="hidden" name="issuanceId" value={props.issuanceId} />
          <input type="hidden" name="lang" value={props.lang} />
          <input ref={fileRef} type="file" name="signature" accept="image/png" className="hidden" aria-hidden="true" tabIndex={-1} />
          <p id={`draw-keyboard-hint-${props.issuanceId}`} className="sr-only">
            {props.keyboardHint} <q>{props.clickLabel}</q>
          </p>
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            role="img"
            aria-label={props.disclosure}
            aria-describedby={`draw-keyboard-hint-${props.issuanceId}`}
            data-testid="draw-signature-canvas"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            className="h-auto w-full touch-none rounded-md border border-slate-300 bg-white"
          />
          {error === "" ? null : (
            <p role="alert" className="text-sm font-semibold text-red-700" data-testid="draw-signature-error">
              {error}
            </p>
          )}
          <span className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleClear}
              data-testid="draw-signature-clear"
              className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
            >
              {props.clearLabel}
            </button>
            <button
              type="submit"
              disabled={!hasStrokes}
              data-testid="draw-signature-submit"
              className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-3 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {props.submitLabel}
            </button>
          </span>
        </form>
      </details>
    </div>
  );
}
