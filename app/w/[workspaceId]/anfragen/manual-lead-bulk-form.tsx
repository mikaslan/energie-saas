"use client";

import { useActionState, useRef, useState } from "react";
import {
  importManualLeadBulkAction,
  type ManualLeadBulkActionState,
} from "./manual-lead-bulk-actions";
import type { ManualLeadBulkReport, ManualLeadBulkRowError } from "@/modules/projects";

const initialState: ManualLeadBulkActionState = { status: "idle" };

const inputClass =
  "min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-brand-600";
const labelClass = "grid gap-1 text-sm font-medium text-slate-700";

const ROW_ERROR_LABELS: Record<ManualLeadBulkRowError, string> = {
  "missing-name": "Name fehlt",
  "missing-contact": "E-Mail oder Telefon fehlt",
  "invalid-scope": "Unbekannter Bereich (erwartet z. B. Wohnbau oder Gewerbe)",
  "unknown-source": "Unbekannte Lead-Quelle",
  "invalid-row": "Ungültige Zeile (E-Mail, Telefon oder PLZ prüfen)",
  "lane-missing": "Keine Eingangs-Spalte für diesen Bereich",
  "note-denied": "Keine Berechtigung für Notizen",
  "note-failed": "Anfrage angelegt, Notiz nicht gespeichert",
};

function FileErrorMessage({ code, detail }: { code: string; detail?: string }) {
  const message =
    code === "empty-file"
      ? "Die Datei enthält keine Datenzeilen."
      : code === "no-delimiter"
        ? "Kein Trennzeichen gefunden (Semikolon oder Komma erwartet)."
        : code === "missing-name-column"
          ? "Pflichtspalte „Name“ fehlt in der Kopfzeile."
          : code === "unknown-column"
            ? `Unbekannte Spalte: ${detail ?? "?"}.`
            : code === "duplicate-column"
              ? `Spalte ist doppelt vorhanden: ${detail ?? "?"}.`
              : code === "too-many-rows"
                ? `Zu viele Zeilen (${detail ?? "?"}; max. 500).`
                : "Die Datei konnte nicht gelesen werden.";
  return (
    <p role="alert" data-testid="manual-lead-bulk-file-error" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {message}
    </p>
  );
}

function Report({ report }: { report: ManualLeadBulkReport }) {
  const invalidRows = report.rows.filter((row) => row.status === "invalid" || row.status === "note-failed");
  return (
    <div data-testid="manual-lead-bulk-report" className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4">
      <p role="status" className="text-sm font-semibold text-slate-900">
        {report.dryRun
          ? `Prüfung: ${report.totalRows} ${report.totalRows === 1 ? "Zeile" : "Zeilen"} gelesen — ${report.rows.filter((row) => row.status === "valid").length} gültig, ${invalidRows.length} fehlerhaft. Es wurde nichts angelegt.`
          : `Import: ${report.createdCount} von ${report.totalRows} ${report.totalRows === 1 ? "Anfrage" : "Anfragen"} angelegt${report.reusedCount > 0 ? ` (${report.reusedCount} bestehende Kontakte)` : ""}${report.noteFailedProjectIds.length > 0 ? `, ${report.noteFailedProjectIds.length} Notizen offen` : ""}.`}
      </p>
      {invalidRows.length > 0 ? (
        <table data-testid="manual-lead-bulk-errors" className="w-full border-collapse text-left text-sm">
          <caption className="pb-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            Fehlerhafte Zeilen
          </caption>
          <thead>
            <tr className="border-b border-slate-200 text-xs text-slate-500">
              <th scope="col" className="py-1 pr-3 font-semibold">Zeile</th>
              <th scope="col" className="py-1 pr-3 font-semibold">Name</th>
              <th scope="col" className="py-1 font-semibold">Fehler</th>
            </tr>
          </thead>
          <tbody>
            {invalidRows.map((row) => (
              <tr key={row.line} className="border-b border-slate-100 last:border-0">
                <td className="py-1 pr-3 tabular-nums">{row.line}</td>
                <td className="py-1 pr-3">{row.displayName ?? "—"}</td>
                <td className="py-1">{row.errors.map((code) => ROW_ERROR_LABELS[code]).join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function Feedback({ state }: { state: ManualLeadBulkActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "report") return <Report report={state.report} />;
  if (state.status === "file-error") return <FileErrorMessage code={state.code} detail={state.detail} />;
  const message =
    state.status === "too-large"
      ? "Die Datei ist zu groß (max. 1 MB Text)."
      : state.status === "invalid"
        ? "Bitte prüfen: CSV-Text und Modus sind Pflicht."
        : state.status === "denied"
          ? "Keine Berechtigung zum Anlegen."
          : "Bitte erneut anmelden.";
  return (
    <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {message}
    </p>
  );
}

/**
 * F1-02 · CSV-Bulk-Import manueller Anfragen (Editoren). Prüfen (Dry-Run)
 * validiert ohne Writes; Importieren legt gültige Zeilen über
 * createManualLead an und meldet ungültige Zeilen einzeln zurück.
 */
export function ManualLeadBulkForm({
  workspaceId,
  scope,
  scopeLabel,
}: {
  workspaceId: string;
  scope: "residential" | "commercial";
  scopeLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [csvText, setCsvText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [state, dispatch] = useActionState(
    importManualLeadBulkAction.bind(null, workspaceId),
    initialState,
  );

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setCsvText(await file.text());
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="manual-lead-bulk-open"
        className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
      >
        CSV-Import
      </button>
    );
  }

  return (
    <form
      action={dispatch}
      data-testid="manual-lead-bulk-form"
      className="grid max-w-2xl gap-3 rounded-lg border border-slate-200 bg-white p-4"
    >
      <input type="hidden" name="defaultScope" value={scope} />
      <p className="text-sm text-slate-600">
        {`Mehrere Anfragen als CSV (Semikolon oder Komma) — leere Bereichs-Spalte übernimmt „${scopeLabel}“. Spalten: Name*; E-Mail; Telefon; Straße; Hausnummer; PLZ; Ort; Bereich; Quelle; Notiz.`}
      </p>
      <label className={labelClass}>
        CSV-Datei (optional, füllt das Textfeld)
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={onFileChange}
          className="text-sm text-slate-700"
        />
      </label>
      <label className={labelClass}>
        CSV-Text
        <textarea
          name="csvText"
          rows={6}
          required
          value={csvText}
          onChange={(event) => setCsvText(event.target.value)}
          placeholder="Name;E-Mail;Telefon;PLZ;Ort&#10;Max Sonne;max@beispiel.de;0151 23456789;10115;Berlin"
          className={`${inputClass} font-mono`}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          name="mode"
          value="dry-run"
          className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
        >
          Prüfen
        </button>
        <button
          type="submit"
          name="mode"
          value="import"
          className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
        >
          Importieren
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50"
        >
          Abbrechen
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}
