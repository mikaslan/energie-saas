"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import type {
  InstallationDto,
  InstallationHandoverHistoryEntry,
  InstallationMemberOption,
} from "@/modules/installations";
import {
  completeInstallationAction,
  createInstallationAction,
  recordHandoverAction,
  setLeadInstallerAction,
  type InstallationActionState,
} from "./installation-actions";

const initialState: InstallationActionState = { status: "idle" };

const dateTimeFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

function formatDateTime(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

const STATUS_LABELS: Record<InstallationDto["status"], string> = {
  active: "Aktiv",
  completed: "Abgeschlossen",
};

function Feedback({ state }: { state: InstallationActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <p role="status" className="mt-3 text-sm text-slate-700">
        {state.message}
      </p>
    );
  }
  const text =
    state.status === "invalid"
      ? "Die Anforderung war ungültig. Lade die Seite neu und versuche es erneut."
      : state.status === "conflict"
        ? "Für dieses Projekt existiert bereits eine Installation."
        : state.status === "not_found"
          ? "Die Installation ist nicht mehr verfügbar."
          : state.status === "denied"
            ? "Du darfst die Installation nicht ändern."
            : "Deine Anmeldung ist abgelaufen. Melde dich erneut an.";
  return (
    <p role="alert" className="mt-3 text-sm font-semibold text-rose-800">
      {text}
    </p>
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas leer"));
    }, "image/png");
  });
}

// F7-07B: Vorschau der Gegenzeichnung (Server-Bytes als Daten-URL).
function CountersignPreview({ workspaceId, projectId }: {
  workspaceId: string;
  projectId: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // no-store: Nach Korrektur darf kein 60-s-Cache die alte Vorschau liefern.
    fetch(`/api/workspaces/${workspaceId}/projects/${projectId}/installation/gegenzeichnung`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`gegenzeichnung GET ${response.status}`);
        const dataUrl = await blobToDataUrl(await response.blob());
        if (!cancelled) setSrc(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => { cancelled = true; };
  }, [workspaceId, projectId]);
  if (src === null) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- Daten-URL-Vorschau, Optimierer n/a.
    <img
      src={src}
      alt="Gegenzeichnung-Vorschau"
      className="mt-1 max-h-32 rounded-md border border-slate-300 bg-white"
    />
  );
}

// F7-07B: Gegenzeichnung erfassen (Name + Canvas, on-screen, intern).
// Canvas-Logik bewusst wie F7-02I (klein, kein app-cross-Import).
function CountersignForm({ workspaceId, projectId, defaultName }: {
  workspaceId: string;
  projectId: string;
  defaultName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(defaultName);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);

  const canvasPoint = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setHasDrawn(false);
    setNotice(null);
  };

  const save = async () => {
    if (name.trim() === "") {
      setNotice("Bitte zuerst einen Namen eingeben.");
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas || !hasDrawn) {
      setNotice("Bitte zuerst unterschreiben.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    setSaved(false);
    try {
      const blob = await canvasToPng(canvas);
      const form = new FormData();
      form.set("byName", name.trim());
      form.set("datei", blob, "gegenzeichnung.png");
      const response = await fetch(
        `/api/workspaces/${workspaceId}/projects/${projectId}/installation/gegenzeichnung`,
        { method: "POST", body: form },
      );
      if (!response.ok) {
        setError(
          response.status === 400
            ? "Gegenzeichnung abgelehnt (Name und PNG-Unterschrift bis 10 MB erforderlich)."
            : response.status === 404
              ? "Installation nicht gefunden (Seite neu laden)."
              : response.status === 401 || response.status === 403
                ? "Keine Berechtigung für diese Gegenzeichnung."
                : "Gegenzeichnung ist fehlgeschlagen.",
        );
        return;
      }
      clearCanvas();
      setSaved(true);
      router.refresh();
    } catch {
      setError("Gegenzeichnung ist fehlgeschlagen.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-950">
        {defaultName === "" ? "Gegenzeichnung festhalten" : "Gegenzeichnung korrigieren"}
      </h3>
      <label className="mt-2 block">
        <span className="block text-sm font-semibold text-slate-800">Gegengezeichnet von</span>
        <input
          type="text"
          aria-label="Gegengezeichnet von"
          value={name}
          maxLength={160}
          onChange={(event) => setName(event.target.value)}
          disabled={saving}
          className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
        />
      </label>
      <div className="mt-2">
        <canvas
          ref={canvasRef}
          width={300}
          height={100}
          aria-label="Gegenzeichnung zeichnen"
          onPointerDown={(event) => {
            const context = canvasRef.current?.getContext("2d");
            if (!context) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drawingRef.current = true;
            const point = canvasPoint(event);
            context.beginPath();
            context.moveTo(point.x, point.y);
            context.fillStyle = "#000000";
            context.fillRect(point.x - 1, point.y - 1, 2, 2);
            context.strokeStyle = "#000000";
            context.lineWidth = 2;
            context.lineCap = "round";
            setHasDrawn(true);
          }}
          onPointerMove={(event) => {
            if (!drawingRef.current) return;
            const context = canvasRef.current?.getContext("2d");
            if (!context) return;
            const point = canvasPoint(event);
            context.lineTo(point.x, point.y);
            context.stroke();
            setHasDrawn(true);
          }}
          onPointerUp={() => { drawingRef.current = false; }}
          onPointerCancel={() => { drawingRef.current = false; }}
          className="touch-none rounded-md border border-slate-300 bg-white"
        />
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={clearCanvas}
            disabled={saving}
            className="min-h-11 rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            Löschen
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="min-h-11 rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            {saving ? "Speichert …" : "Gegenzeichnung speichern"}
          </button>
        </div>
      </div>
      {notice !== null ? (
        <p className="mt-1 text-xs font-semibold text-amber-700">{notice}</p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="mt-1 text-xs font-semibold text-red-700">{error}</p>
      ) : null}
      {saved ? (
        <p role="status" className="mt-3 text-sm text-slate-700">Gegenzeichnung festgehalten.</p>
      ) : null}
    </div>
  );
}

export function InstallationSection({
  workspaceId,
  projectId,
  installation,
  installerOptions,
  handoverHistory,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  installation: InstallationDto | null;
  installerOptions: InstallationMemberOption[];
  handoverHistory: InstallationHandoverHistoryEntry[];
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(createInstallationAction, initialState);
  const [completeState, completeDispatch] = useActionState(completeInstallationAction, initialState);
  const [handoverState, handoverDispatch] = useActionState(recordHandoverAction, initialState);
  const [leadState, leadDispatch] = useActionState(setLeadInstallerAction, initialState);
  const feedbackState = leadState.status === "idle"
    ? (handoverState.status === "idle"
      ? (completeState.status === "idle" ? createState : completeState)
      : handoverState)
    : leadState;

  return (
    <section aria-labelledby="project-installation-title" className="min-w-0">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-800">Akte</p>
      <h2 id="project-installation-title" className="mt-1 text-xl font-semibold text-slate-950">
        Installation
      </h2>

      {installation === null ? (
        <div className="mt-2">
          <p className="text-sm leading-6 text-slate-600">
            Noch keine Installation. Die Direktanlage stellt das Projekt
            auf die Phase Installation — ohne Signatur-Umweg.
          </p>
          {canWrite ? (
            <form action={createDispatch} className="mt-3">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="projectId" value={projectId} />
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
              >
                Installation direkt anlegen
              </button>
            </form>
          ) : (
            <p className="mt-3 text-sm text-slate-600">Nur Lesezugriff: Keine Anlage möglich.</p>
          )}
        </div>
      ) : (
        <dl className="mt-2 grid gap-2 text-sm leading-6 text-slate-700">
          <div className="flex gap-2">
            <dt className="font-semibold text-slate-800">Status:</dt>
            <dd>{STATUS_LABELS[installation.status]}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold text-slate-800">Quelle:</dt>
            <dd>{installation.source === "direct" ? "Direktanlage" : "Signatur"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold text-slate-800">Angelegt:</dt>
            <dd>{formatDateTime(installation.createdAt)}</dd>
          </div>
          {installation.status === "completed" ? (
            <div className="flex gap-2">
              <dt className="font-semibold text-slate-800">Abgeschlossen:</dt>
              <dd>{formatDateTime(installation.completedAt)}</dd>
            </div>
          ) : null}
          <div className="flex gap-2">
            <dt className="font-semibold text-slate-800">Lead Installer:</dt>
            <dd>{installation.leadInstallerLabel ?? "nicht zugewiesen"}</dd>
          </div>
          {installation.handoverAt !== null ? (
            <>
              <div className="flex gap-2">
                <dt className="font-semibold text-slate-800">Abgenommen:</dt>
                <dd>{formatDateTime(installation.handoverAt)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-semibold text-slate-800">Abgenommen durch:</dt>
                <dd>{installation.handoverByName}</dd>
              </div>
              {installation.handoverNote ? (
                <div className="flex gap-2">
                  <dt className="font-semibold text-slate-800">Notiz:</dt>
                  <dd>{installation.handoverNote}</dd>
                </div>
              ) : null}
              {installation.handoverCustomerName !== null ? (
                <>
                  <div className="flex gap-2">
                    <dt className="font-semibold text-slate-800">Gegengezeichnet von:</dt>
                    <dd>{installation.handoverCustomerName}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-semibold text-slate-800">Gegengezeichnet am:</dt>
                    <dd>{formatDateTime(installation.handoverCustomerSignedAt)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-semibold text-slate-800">Unterschrift:</dt>
                    <dd>
                      <CountersignPreview
                        key={installation.handoverCustomerSignedAt ?? "none"}
                        workspaceId={workspaceId}
                        projectId={projectId}
                      />
                    </dd>
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </dl>
      )}

      {installation !== null && canWrite ? (
        <form action={leadDispatch} className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-950">Lead Installer zuweisen</h3>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">Mitglied</span>
            <select
              name="membershipId"
              defaultValue={installation.leadInstallerMembershipId ?? ""}
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            >
              <option value="">— nicht zugewiesen —</option>
              {installerOptions.map((option) => (
                <option key={option.membershipId} value={option.membershipId}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Zuweisung speichern
          </button>
        </form>
      ) : null}

      {installation !== null && installation.status === "active" ? (
        <div className="mt-3">
          {canWrite ? (
            <form action={completeDispatch}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="projectId" value={projectId} />
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
              >
                Installation abschließen
              </button>
            </form>
          ) : (
            <p className="mt-3 text-sm text-slate-600">Nur Lesezugriff: Kein Abschluss möglich.</p>
          )}
        </div>
      ) : null}

      {installation !== null && installation.status === "completed" && canWrite ? (
        <form action={handoverDispatch} className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-950">
            {installation.handoverAt !== null ? "Abnahme korrigieren" : "Abnahme festhalten"}
          </h3>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">Abgenommen durch</span>
            <input
              type="text"
              name="byName"
              required
              maxLength={160}
              defaultValue={installation.handoverByName ?? ""}
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            />
          </label>
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">Notiz (optional)</span>
            <input
              type="text"
              name="note"
              maxLength={500}
              defaultValue={installation.handoverNote ?? ""}
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            />
          </label>
          <button
            type="submit"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Abnahme speichern
          </button>
        </form>
      ) : null}

      {installation !== null
      && installation.status === "completed"
      && installation.handoverAt !== null
      && canWrite ? (
        <CountersignForm
          workspaceId={workspaceId}
          projectId={projectId}
          defaultName={installation.handoverCustomerName ?? ""}
        />
      ) : null}

      {installation !== null && handoverHistory.length > 0 ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4" data-testid="handover-history">
          <h3 className="text-sm font-semibold text-slate-950">Abnahme-Verlauf</h3>
          <ul className="mt-2 grid gap-2" aria-label="Abnahme-Verlauf">
            {handoverHistory.map((entry, index) => (
              <li key={entry.id} className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-700">
                <span className="font-semibold text-slate-800">Abnahme {index + 1}:</span>{" "}
                {entry.byName} · {formatDateTime(entry.recordedAt)}
                {entry.note ? (
                  <>
                    {" — "}
                    {entry.note}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Feedback state={feedbackState} />
    </section>
  );
}
