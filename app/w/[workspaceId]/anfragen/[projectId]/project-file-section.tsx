"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProjectFileDto } from "@/modules/project-files";
import {
  setProjectFileVisibilityAction,
  withdrawProjectFileAction,
  type ProjectFileActionState,
} from "./project-file-actions";

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Europe/Berlin",
});

const sizeFormatter = new Intl.NumberFormat("de-DE");

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${sizeFormatter.format(bytes)} B`;
  return `${(bytes / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} KB`;
}

type UploadError = { status: number } | { status: "network" | "shape" };

// F7-16: Datei-Upload per Route (25 MiB, 1 Datei pro Request). Wirft
// UploadError mit Status (Aufrufer mappt auf deutschen Text).
async function postProjectFile({
  workspaceId,
  projectId,
  file,
}: {
  workspaceId: string;
  projectId: string;
  file: File;
}): Promise<string> {
  const form = new FormData();
  form.set("datei", file, file.name);
  let response: Response;
  try {
    response = await fetch(
      `/api/workspaces/${workspaceId}/projects/${projectId}/dateien`,
      { method: "POST", body: form },
    );
  } catch {
    throw { status: "network" } satisfies UploadError;
  }
  if (!response.ok) throw { status: response.status } satisfies UploadError;
  const data = (await response.json().catch(() => null)) as { fileId?: unknown } | null;
  if (!data || typeof data.fileId !== "string" || data.fileId === "") {
    throw { status: "shape" } satisfies UploadError;
  }
  return data.fileId;
}

function uploadErrorText(error: UploadError): string {
  if (error.status === 400) return "Nur PDF-, JPEG- oder PNG-Dateien bis 25 MB sind erlaubt.";
  if (error.status === 404) return "Projekt nicht gefunden (Seite neu laden).";
  if (error.status === 401 || error.status === 403) {
    return "Keine Berechtigung für diesen Upload.";
  }
  return "Der Upload ist fehlgeschlagen.";
}

function visibilityErrorText(state: ProjectFileActionState): string | null {
  if (state.status === "invalid") return "Ungültige Auswahl (Seite neu laden).";
  if (state.status === "not_found") return "Datei nicht gefunden (Seite neu laden).";
  if (state.status === "denied") return "Keine Berechtigung für diese Änderung.";
  if (state.status === "unauthenticated") return "Sitzung abgelaufen (neu anmelden).";
  return null;
}

function withdrawErrorText(state: ProjectFileActionState): string | null {
  if (state.status === "invalid") return "Ungültige Auswahl (Seite neu laden).";
  if (state.status === "not_found") return "Datei nicht gefunden (Seite neu laden).";
  if (state.status === "denied") return "Keine Berechtigung für diese Änderung.";
  if (state.status === "unauthenticated") return "Sitzung abgelaufen (neu anmelden).";
  return null;
}

// F10-17: Sichtbarkeits-Toggle je Zeile (nur canWrite). Checkbox sendet
// beim Umschalten sofort (Zielwert im Hidden-Feld, kein Extra-Klick);
// Erfolg aktualisiert die Liste per Refresh (Hidden-Zielwert +
// Checkbox-Grundzustand folgen den neuen Server-Props).
function ProjectFileVisibilityToggle({
  workspaceId,
  projectId,
  file,
}: {
  workspaceId: string;
  projectId: string;
  file: ProjectFileDto;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(setProjectFileVisibilityAction, {
    status: "idle",
  });
  useEffect(() => {
    if (state.status === "success") router.refresh();
  }, [state, router]);
  const error = visibilityErrorText(state);
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <form action={formAction}>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="fileId" value={file.id} />
        <input
          type="hidden"
          name="visible"
          value={file.visibleToCustomer ? "false" : "true"}
        />
        <label className="flex cursor-pointer items-center gap-1 text-xs font-medium text-slate-600">
          <input
            type="checkbox"
            data-testid="project-file-visibility-toggle"
            defaultChecked={file.visibleToCustomer}
            disabled={pending}
            onChange={(event) => event.currentTarget.form?.requestSubmit()}
            className="h-4 w-4 accent-slate-900"
          />
          Für Kunden sichtbar
        </label>
      </form>
      {state.status === "success" ? (
        <span
          role="status"
          data-testid="project-file-visibility-feedback"
          className="text-xs font-semibold text-emerald-700"
        >
          {state.message}
        </span>
      ) : null}
      {error ? (
        <span
          role="alert"
          data-testid="project-file-visibility-feedback"
          className="text-xs font-semibold text-red-700"
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}

// F7-16b: Zurückziehen-Button je aktiver Zeile (nur canWrite).
// Zwei-Klick-Bestaetigung (one-way, kein Undo in diesem Slice).
// Direkter Action-Call statt Form-Submit (E2E-Befund: JEDER
// formularbasierte Submit — confirm-Dialog, requestSubmit, nativer
// type=submit, Checkbox-Relais — landete nativ mit Reload statt im
// Action-State; useActionState sah nie pending/success, obwohl der
// Server die Action ausführte). Der direkte Call umgeht die
// Submit-Interception vollständig (Upload-Muster: fetch → State).
// Feedback auf Zeilenebene (onDone → Parent-Notes): Der Button
// demountet nach dem Refresh (nur aktive Zeilen).
function ProjectFileWithdrawButton({
  workspaceId,
  projectId,
  file,
  onDone,
}: {
  workspaceId: string;
  projectId: string;
  file: ProjectFileDto;
  onDone: (note: { ok: boolean; text: string }) => void;
}) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [pending, startTransition] = useTransition();
  return armed ? (
    <button
      type="button"
      data-testid="project-file-withdraw"
      disabled={pending}
      aria-label={`Wirklich zurückziehen: ${file.originalFilename}`}
      onClick={() => {
        const formData = new FormData();
        formData.set("workspaceId", workspaceId);
        formData.set("projectId", projectId);
        formData.set("fileId", file.id);
        startTransition(async () => {
          const result = await withdrawProjectFileAction({ status: "idle" }, formData);
          if (result.status === "success") {
            onDone({ ok: true, text: result.message });
            router.refresh();
          } else {
            onDone({
              ok: false,
              text: withdrawErrorText(result) ?? "Das Zurückziehen ist fehlgeschlagen.",
            });
          }
        });
      }}
      className="shrink-0 rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 disabled:opacity-50"
    >
      Wirklich zurückziehen
    </button>
  ) : (
    <button
      type="button"
      data-testid="project-file-withdraw"
      disabled={pending}
      aria-label={`Zurückziehen: ${file.originalFilename}`}
      onClick={() => setArmed(true)}
      className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 disabled:opacity-50"
    >
      Zurückziehen
    </button>
  );
}

// F7-16 Projekt-Dateien: interne Ablage (nur canWrite sieht das Formular;
// Externe bekommen die Sektion gar nicht erst — Loader-Gate in page.tsx).
// F10-17: Toggle „Für Kunden sichtbar" je Zeile (canWrite); Leser sehen
// den Zustand als Text.
// F7-16b: „Zurückgezogen"-Badge je Zeile für ALLE internen Leser;
// canWrite sieht den Zurückziehen-Button nur bei aktiven Zeilen.
export function ProjectFileSection({
  workspaceId,
  projectId,
  files,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  files: ProjectFileDto[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // F7-16b: Withdraw-Feedback je Datei (Zeilenebene — überlebt den
  // Refresh, der den Button demountet; Loop-geschützt via Gleichheit).
  const [withdrawNotes, setWithdrawNotes] = useState<Record<string, { ok: boolean; text: string }>>({});

  async function handleUpload(): Promise<void> {
    if (pending.length === 0 || uploading) return;
    setUploading(true);
    setError(null);
    setSuccess(null);
    // Client-Loop bei Mehrfachwahl (1 Datei pro Request, foto-Muster).
    const queue = [...pending];
    let done = 0;
    let failed: UploadError | null = null;
    for (const file of queue) {
      try {
        await postProjectFile({ workspaceId, projectId, file });
        done += 1;
      } catch (cause) {
        failed = cause as UploadError;
        break;
      }
    }
    setPending([]);
    setUploading(false);
    router.refresh();
    if (failed) {
      setError(uploadErrorText(failed));
    } else {
      setSuccess(
        done === 1 ? "Datei hochgeladen." : `${sizeFormatter.format(done)} Dateien hochgeladen.`,
      );
    }
  }

  return (
    <section
      aria-label="Projektdateien"
      data-testid="project-files-section"
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-slate-900">Projektdateien</h2>
      {canWrite ? (
        <div className="mt-3">
          <label
            htmlFor="project-file-input"
            className="block text-sm font-medium text-slate-700"
          >
            Datei hochladen
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="project-file-input"
              data-testid="project-file-input"
              type="file"
              multiple
              accept=".pdf,.jpg,.jpeg,.png"
              disabled={uploading}
              onChange={(event) => {
                setPending([...(event.target.files ?? [])]);
                setError(null);
                setSuccess(null);
              }}
              className="text-sm text-slate-600"
            />
            <button
              type="button"
              disabled={pending.length === 0 || uploading}
              onClick={() => void handleUpload()}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {uploading ? "Wird hochgeladen …" : "Hochladen"}
            </button>
          </div>
          {error ? (
            <p role="alert" data-testid="project-file-error" className="mt-2 text-sm font-semibold text-red-700">
              {error}
            </p>
          ) : null}
          {success ? (
            <p role="status" data-testid="project-file-success" className="mt-2 text-sm font-semibold text-emerald-700">
              {success}
            </p>
          ) : null}
        </div>
      ) : null}
      {files.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Noch keine Dateien.</p>
      ) : (
        <ul data-testid="project-file-list" className="mt-3 divide-y divide-slate-100">
          {files.map((file) => (
            <li
              key={file.id}
              data-testid="project-file-row"
              className="flex items-center justify-between gap-3 py-2 text-sm"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-slate-800">{file.originalFilename}</span>
                <span className="block text-xs text-slate-500">
                  {formatBytes(file.byteSize)} · {dateFormatter.format(new Date(file.createdAt))}
                </span>
                {file.withdrawn ? (
                  <span
                    data-testid="project-file-withdrawn-badge"
                    className="mt-0.5 inline-block rounded bg-slate-200 px-1.5 py-0.5 text-xs font-semibold text-slate-700"
                  >
                    Zurückgezogen
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {canWrite ? (
                  <ProjectFileVisibilityToggle
                    workspaceId={workspaceId}
                    projectId={projectId}
                    file={file}
                  />
                ) : (
                  <span
                    data-testid="project-file-visibility-state"
                    className="text-xs text-slate-500"
                  >
                    {`Für Kunden sichtbar: ${file.visibleToCustomer ? "Ja" : "Nein"}`}
                  </span>
                )}
                {canWrite && !file.withdrawn ? (
                  <ProjectFileWithdrawButton
                    workspaceId={workspaceId}
                    projectId={projectId}
                    file={file}
                    onDone={(note) => {
                      const fileId = file.id;
                      setWithdrawNotes((prev) => {
                        const current = prev[fileId];
                        if (current?.ok === note.ok && current?.text === note.text) return prev;
                        return { ...prev, [fileId]: note };
                      });
                    }}
                  />
                ) : null}
                {withdrawNotes[file.id] ? (
                  <span
                    role={withdrawNotes[file.id]!.ok ? "status" : "alert"}
                    data-testid="project-file-withdraw-feedback"
                    className={`text-xs font-semibold ${withdrawNotes[file.id]!.ok ? "text-emerald-700" : "text-red-700"}`}
                  >
                    {withdrawNotes[file.id]!.text}
                  </span>
                ) : null}
                <a
                  data-testid="project-file-download"
                  href={`/api/workspaces/${workspaceId}/projects/${projectId}/dateien?fileId=${encodeURIComponent(file.id)}`}
                  className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700"
                >
                  Herunterladen
                </a>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
