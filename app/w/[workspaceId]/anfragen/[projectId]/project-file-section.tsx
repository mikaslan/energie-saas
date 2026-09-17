"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ProjectFileDto } from "@/modules/project-files";

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

// F7-16 Projekt-Dateien: interne Ablage (nur canWrite sieht das Formular;
// Externe bekommen die Sektion gar nicht erst — Loader-Gate in page.tsx).
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
              </span>
              <a
                data-testid="project-file-download"
                href={`/api/workspaces/${workspaceId}/projects/${projectId}/dateien?fileId=${encodeURIComponent(file.id)}`}
                className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700"
              >
                Herunterladen
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
