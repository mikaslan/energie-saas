"use client";

import { useActionState } from "react";
import {
  FILE_REQUEST_STATUS_LABEL,
  nextFileRequestStatuses,
  type FileRequestDto,
  type FileRequestUploadDto,
} from "@/lib/file-request";
import type { FileRequestTemplateDto } from "@/lib/file-request-template";
import {
  applyFileRequestTemplateAction,
  createFileRequestAction,
  downloadFileRequestAction,
  downloadFileRequestUploadAction,
  transitionFileRequestAction,
  type FileRequestActionState,
  type FileRequestDownloadState,
} from "./file-request-actions";

const initialAction: FileRequestActionState = { status: "idle" };
const initialDownload: FileRequestDownloadState = { status: "idle" };

function Feedback({ state, testId }: { state: FileRequestActionState; testId: string }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <p role="status" data-testid={testId} className="mt-3 text-sm font-semibold text-emerald-700">
        {state.message}
      </p>
    );
  }
  const message =
    state.status === "invalid"
      ? "Die Eingabe ist ungültig."
      : state.status === "conflict"
        ? "Die Anfrage ist bereits beantwortet."
        : state.status === "not_found"
          ? "Die Anfrage ist nicht mehr verfügbar."
          : state.status === "denied"
            ? "Dir fehlt die Berechtigung für diese Aktion."
            : "Deine Sitzung ist abgelaufen.";
  return (
    <p role="alert" data-testid={testId} className="mt-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function ReceiptRow({
  workspaceId,
  projectId,
  request,
}: {
  workspaceId: string;
  projectId: string;
  request: FileRequestDto;
}) {
  const [downloadState, downloadDispatch] = useActionState(
    downloadFileRequestAction,
    initialDownload,
  );
  const dataUrl =
    downloadState.status === "ready"
      ? `data:${downloadState.contentType};base64,${downloadState.base64}`
      : null;
  return (
    <div className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
      <span className="block font-medium text-slate-800" data-testid="file-request-receipt">
        Beleg: {request.originalFilename} ({request.byteSize !== null ? formatBytes(request.byteSize) : "?"})
      </span>
      {request.fileSha256 ? (
        <code className="mt-1 block break-all text-xs text-slate-500" title="SHA-256-Prüfsumme">
          {request.fileSha256}
        </code>
      ) : null}
      {dataUrl ? (
        <a
          href={dataUrl}
          download={downloadState.status === "ready" ? downloadState.filename : undefined}
          data-testid="file-request-download-link"
          className="mt-1 inline-block font-semibold text-brand-700 hover:underline"
        >
          Beleg herunterladen
        </a>
      ) : (
        <form action={downloadDispatch} className="mt-1">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="requestId" value={request.id} />
          <button
            type="submit"
            data-testid="file-request-download"
            className="font-semibold text-brand-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            Beleg laden
          </button>
        </form>
      )}
      {downloadState.status === "not_found" || downloadState.status === "invalid" ? (
        <p role="alert" className="mt-1 text-sm font-semibold text-red-700">
          Der Beleg ist nicht mehr verfügbar.
        </p>
      ) : null}
    </div>
  );
}

// F10-11: Folge-Beleg je Upload-Zeile (eigener Download-Status je Zeile,
// Muster ReceiptRow).
function UploadRow({
  workspaceId,
  projectId,
  requestId,
  upload,
}: {
  workspaceId: string;
  projectId: string;
  requestId: string;
  upload: FileRequestUploadDto;
}) {
  const [downloadState, downloadDispatch] = useActionState(
    downloadFileRequestUploadAction,
    initialDownload,
  );
  const dataUrl =
    downloadState.status === "ready"
      ? `data:${downloadState.contentType};base64,${downloadState.base64}`
      : null;
  return (
    <li className="text-sm text-slate-600">
      <span className="block">
        Weitere Datei: {upload.originalFilename}
        {upload.byteSize !== null ? ` (${formatBytes(upload.byteSize)})` : ""}
      </span>
      {dataUrl ? (
        <a
          href={dataUrl}
          download={downloadState.status === "ready" ? downloadState.filename : undefined}
          data-testid="file-request-upload-download-link"
          className="mt-0.5 inline-block font-semibold text-brand-700 hover:underline"
        >
          Folge-Beleg herunterladen
        </a>
      ) : (
        <form action={downloadDispatch} className="mt-0.5">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="uploadId" value={upload.id} />
          <button
            type="submit"
            data-testid="file-request-upload-download"
            className="font-semibold text-brand-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            Folge-Beleg laden
          </button>
        </form>
      )}
      {downloadState.status === "not_found" || downloadState.status === "invalid" ? (
        <p role="alert" className="mt-0.5 text-sm font-semibold text-red-700">
          Der Folge-Beleg ist nicht mehr verfügbar.
        </p>
      ) : null}
    </li>
  );
}

// F10-04 Datei-Anfragen: Anlage (Titel/Beschreibung), Eingangs-QR mit
// Prüfsumme + Download, Folge-Buttons. Reine Darstellung gespeicherter Werte.
export function FileRequestSection({
  workspaceId,
  projectId,
  requests,
  canWrite,
  templates,
}: {
  workspaceId: string;
  projectId: string;
  requests: FileRequestDto[];
  canWrite: boolean;
  templates: FileRequestTemplateDto[];
}) {
  const [createState, createDispatch] = useActionState(createFileRequestAction, initialAction);
  const [transitionState, transitionDispatch] = useActionState(
    transitionFileRequestAction,
    initialAction,
  );
  const [applyState, applyDispatch] = useActionState(applyFileRequestTemplateAction, initialAction);
  return (
    <section aria-label="Datei-Anfragen" className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Datei-Anfragen</h2>
      {requests.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600" data-testid="file-request-empty">
          Noch keine Datei-Anfrage für dieses Projekt.
        </p>
      ) : (
        <ul className="mt-2 space-y-3" data-testid="file-request-list">
          {requests.map((request) => {
            const next = nextFileRequestStatuses(request.status);
            return (
              <li key={request.id} className="rounded-md border border-slate-200 px-3 py-2">
                <span className="block text-sm font-medium text-slate-800">{request.title}</span>
                {request.description ? (
                  <span className="block text-sm text-slate-500">{request.description}</span>
                ) : null}
                <span
                  className="mt-1 block text-sm font-semibold text-slate-700"
                  data-testid="file-request-status"
                >
                  {FILE_REQUEST_STATUS_LABEL[request.status]}
                  {request.allowMany ? " · Mehrere Dateien" : ""}
                </span>
                {request.storageKey !== null ? (
                  <ReceiptRow workspaceId={workspaceId} projectId={projectId} request={request} />
                ) : null}
                {request.uploads.length > 0 ? (
                  <ul className="mt-2 space-y-1" data-testid="file-request-uploads">
                    {request.uploads.map((upload) => (
                      <UploadRow
                        key={upload.id}
                        workspaceId={workspaceId}
                        projectId={projectId}
                        requestId={request.id}
                        upload={upload}
                      />
                    ))}
                  </ul>
                ) : null}
                {canWrite && next.length > 0 ? (
                  <form action={transitionDispatch} className="mt-2 flex flex-wrap gap-2">
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="requestId" value={request.id} />
                    {next.map((status) => (
                      <button
                        key={status}
                        type="submit"
                        name="status"
                        value={status}
                        data-testid={`file-request-transition-${status}`}
                        className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                      >
                        {status === "erledigt" ? "Als erledigt markieren" : "Stornieren"}
                      </button>
                    ))}
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {canWrite ? (
        <form action={createDispatch} className="mt-3 space-y-2">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <label className="block text-sm text-slate-600">
            Titel
            <input
              type="text"
              name="title"
              required
              maxLength={160}
              data-testid="file-request-title"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
            />
          </label>
          <label className="block text-sm text-slate-600">
            Beschreibung (optional)
            <input
              type="text"
              name="description"
              maxLength={2000}
              data-testid="file-request-description"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              name="allowMany"
              data-testid="file-request-allow-many"
              className="min-h-6 min-w-6 accent-slate-900"
            />
            Mehrere Dateien erlauben
          </label>
          <button
            type="submit"
            data-testid="file-request-create"
            className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Datei-Anfrage anlegen
          </button>
        </form>
      ) : null}
      {canWrite && templates.length > 0 ? (
        <form action={applyDispatch} className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <label className="grid gap-1 text-sm text-slate-600">
            Dateivorlage
            <select
              name="templateId"
              required
              defaultValue=""
              className="min-h-11 min-w-44 rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900 outline-none focus:border-brand-600"
            >
              <option value="" disabled>
                Vorlage wählen …
              </option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name} – {template.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Vorlage anwenden
          </button>
        </form>
      ) : null}
      <Feedback state={createState} testId="file-request-create-feedback" />
      <Feedback state={transitionState} testId="file-request-transition-feedback" />
      <Feedback state={applyState} testId="file-request-apply-feedback" />
    </section>
  );
}
