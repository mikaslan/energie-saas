"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  CATALOG_CSV_CANONICAL_FIELDS,
  CATALOG_CSV_MAPPING_VERSION,
  CATALOG_CSV_MAX_BYTES,
  CATALOG_CSV_PREVIEW_MEDIA_TYPE,
  CATALOG_CSV_PREVIEW_WIRE_VERSION,
  CATALOG_CSV_REQUIRED_COMMON_FIELDS,
  CATALOG_IMPORT_JOB_STATES,
  encodeCatalogCsvPreviewEnvelope,
  type CatalogImportJobState,
  type CatalogCsvCanonicalField,
  type CatalogCsvWireMapping,
} from "@/lib/integrations/catalog/import-wire";

type Inspection = Readonly<{
  filename: string;
  sizeBytes: number;
  encoding: "utf-8" | "windows-1252";
  delimiter: ";" | ",";
  rowCount: number;
  headers: readonly string[];
}>;
type WizardState =
  | "empty"
  | "inspecting"
  | "inspected"
  | "mapping_incomplete"
  | "previewing"
  | "replayed"
  | "error";
type MappingColumn = { field: CatalogCsvCanonicalField; sourceHeader: string };
type PreparedResponse = Readonly<{
  importId: string;
  state: CatalogImportJobState;
  replayed: boolean;
}>;

const preparedStateLabels: Record<CatalogImportJobState, string> = {
  ready_for_review: "bereit zur Prüfung",
  queued: "eingeplant",
  running: "in Verarbeitung",
  retry_wait: "im technischen Wiederholungsversuch",
  succeeded: "erfolgreich abgeschlossen",
  partial: "teilweise abgeschlossen",
  failed_final: "endgültig fehlgeschlagen",
  cancelled_before_start: "vor dem Start abgebrochen",
};

const fieldLabels: Record<CatalogCsvCanonicalField, string> = {
  internalSku: "Interne SKU",
  componentType: "Produkttyp",
  displayName: "Anzeigename",
  manufacturer: "Hersteller",
  model: "Modell",
  unit: "Einheit",
  keyPoints: "Kernpunkte",
  technicalSourceKind: "Technik · Quellenart",
  technicalReference: "Technik · Referenz",
  technicalObservedOn: "Technik · Stand",
  technicalRightsBasis: "Technik · Rechtsgrundlage",
  technicalDocumentSha256: "Technik · Dokumenthash",
  purchasePriceNet: "EK netto",
  purchaseSourceKind: "EK · Quellenart",
  purchaseReference: "EK · Referenz",
  purchaseObservedOn: "EK · Stand",
  purchaseRightsBasis: "EK · Rechtsgrundlage",
  purchaseDocumentSha256: "EK · Dokumenthash",
  salesPriceNet: "VK netto",
  salesSourceKind: "VK · Quellenart",
  salesReference: "VK · Referenz",
  salesObservedOn: "VK · Stand",
  salesRightsBasis: "VK · Rechtsgrundlage",
  salesDocumentSha256: "VK · Dokumenthash",
  nominalPowerWatts: "Modul-Nennleistung (W)",
  nominalAcPowerWatts: "AC-Nennleistung (W)",
  phaseCount: "Phasenanzahl",
  mpptTrackerCount: "MPPT-Tracker",
  nominalCapacityWh: "Nennkapazität (Wh)",
  usableCapacityWh: "Nutzkapazität (Wh)",
  maxContinuousPowerWatts: "Dauerleistung (W)",
  roundTripEfficiencyPercent: "Roundtrip-Wirkungsgrad (%)",
  backupCapability: "Ersatzstromfähigkeit",
  maxChargingPowerWatts: "Ladeleistung (W)",
  connector: "Stecker",
  bidirectionalCapability: "Bidirektionale Fähigkeit",
  nominalHeatingPowerWatts: "Heizleistung (W)",
  scop: "SCOP",
  systemName: "Systemname",
  roofTypes: "Dachtypen",
  attributes: "Attribute (JSON)",
};

const errorMessages: Record<string, string> = {
  invalid_request: "Die Upload-Anfrage war ungültig. Bitte wähle die Datei erneut.",
  invalid_file: "Die Datei enthält keine sicher lesbaren CSV-Daten.",
  file_too_large: "Die Datei überschreitet die Grenze von 1 MiB.",
  invalid_encoding: "Die Datei ist weder gültiges UTF-8 noch unterstütztes Windows-1252.",
  invalid_filename: "Der Dateiname ist nicht zulässig. Verwende eine Datei mit Endung .csv.",
  invalid_headers: "Die Kopfzeile konnte nicht eindeutig gelesen werden.",
  too_many_columns: "Die Datei enthält mehr als 80 Spalten.",
  too_many_rows: "Die Datei enthält mehr als 1.000 Datenzeilen.",
  missing_mapping: "Mindestens eine erforderliche Spalte ist nicht zugeordnet.",
  mapping_conflict: "Eine Quellspalte oder ein Zielfeld ist mehrfach zugeordnet.",
  snapshot_budget_exceeded: "Für diesen Workspace sind derzeit zu viele offene Importvorschauen gespeichert.",
  parser_error: "Die CSV-Struktur konnte nicht sicher gelesen werden.",
  unauthenticated: "Deine Sitzung ist abgelaufen. Melde dich erneut an.",
  forbidden: "Dir fehlen Rechte für Produkt-, EK- oder VK-Daten.",
  intent_reused: "Diese Vorschau-ID ist bereits an andere Dateidaten gebunden.",
  catalog_changed: "Der Katalog hat sich während der Vorschau geändert. Prüfe die Datei erneut.",
  unavailable: "Der Importdienst ist vorübergehend nicht verfügbar.",
  internal_error: "Der Import konnte nicht verarbeitet werden.",
};

const subscribeToHydration = () => () => undefined;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseError(value: unknown): string | null {
  if (!record(value) || !record(value.error) || typeof value.error.code !== "string") {
    return null;
  }
  return value.error.code;
}

function inspectedResponse(value: unknown): {
  inspection: Inspection;
  mapping: MappingColumn[];
} | null {
  if (!record(value) || value.status !== "inspected" || !record(value.inspection)) return null;
  const inspection = value.inspection;
  if (
    typeof inspection.filename !== "string"
    || typeof inspection.sizeBytes !== "number"
    || (inspection.encoding !== "utf-8" && inspection.encoding !== "windows-1252")
    || (inspection.delimiter !== ";" && inspection.delimiter !== ",")
    || typeof inspection.rowCount !== "number"
    || !Array.isArray(inspection.headers)
    || !inspection.headers.every((header) => typeof header === "string")
    || !record(value.mapping)
    || value.mapping.schemaVersion !== CATALOG_CSV_MAPPING_VERSION
    || !Array.isArray(value.mapping.columns)
  ) return null;
  const columns: MappingColumn[] = [];
  for (const candidate of value.mapping.columns) {
    if (
      !record(candidate)
      || typeof candidate.field !== "string"
      || !CATALOG_CSV_CANONICAL_FIELDS.includes(candidate.field as CatalogCsvCanonicalField)
      || typeof candidate.sourceHeader !== "string"
    ) return null;
    columns.push({
      field: candidate.field as CatalogCsvCanonicalField,
      sourceHeader: candidate.sourceHeader,
    });
  }
  return {
    inspection: {
      filename: inspection.filename,
      sizeBytes: inspection.sizeBytes,
      encoding: inspection.encoding,
      delimiter: inspection.delimiter,
      rowCount: inspection.rowCount,
      headers: inspection.headers as string[],
    },
    mapping: columns,
  };
}

function preparedResponse(value: unknown): PreparedResponse | null {
  const counts = record(value) && record(value.counts) ? value.counts : null;
  if (
    !record(value)
    || value.status !== "prepared"
    || typeof value.importId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.importId)
    || typeof value.replayed !== "boolean"
    || typeof value.state !== "string"
    || !CATALOG_IMPORT_JOB_STATES.includes(value.state as CatalogImportJobState)
    || counts === null
    || !Number.isSafeInteger(counts.total)
    || !Number.isSafeInteger(counts.valid)
    || !Number.isSafeInteger(counts.invalid)
    || (counts.valid as number) + (counts.invalid as number) !== counts.total
    || typeof value.previewExpiresAt !== "string"
    || !Number.isFinite(new Date(value.previewExpiresAt).getTime())
  ) return null;
  return {
    importId: value.importId,
    state: value.state as CatalogImportJobState,
    replayed: value.replayed,
  };
}

export function ImportWizard({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const [file, setFile] = useState<File | null>(null);
  const [intentId, setIntentId] = useState("");
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [mapping, setMapping] = useState<MappingColumn[]>([]);
  const [state, setState] = useState<WizardState>("empty");
  const [message, setMessage] = useState("");
  const [replayedImportId, setReplayedImportId] = useState<string | null>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const mappingRef = useRef<HTMLDivElement>(null);
  const busy = state === "inspecting" || state === "previewing";
  const mappingLocked = busy || state === "replayed";

  const missingRequired = useMemo(() => {
    const selected = new Set(mapping.map((column) => column.field));
    return CATALOG_CSV_REQUIRED_COMMON_FIELDS.filter((field) => !selected.has(field));
  }, [mapping]);

  useEffect(() => {
    if (state === "error" || state === "mapping_incomplete" || state === "replayed") {
      (state === "mapping_incomplete" ? mappingRef.current : feedbackRef.current)?.focus();
    }
  }, [state]);

  function selectFile(next: File | null): void {
    setFile(next);
    setInspection(null);
    setMapping([]);
    setMessage("");
    setReplayedImportId(null);
    setState("empty");
    setIntentId(next ? crypto.randomUUID() : "");
  }

  async function post(mode: "inspect" | "preview"): Promise<unknown> {
    if (!file || !intentId) throw new Error("missing file");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const canonicalFilename = file.name.normalize("NFKC").trim();
    const wireMapping: CatalogCsvWireMapping = {
      schemaVersion: CATALOG_CSV_MAPPING_VERSION,
      columns: mapping,
    };
    const body = encodeCatalogCsvPreviewEnvelope(
      mode === "inspect"
        ? {
            schemaVersion: CATALOG_CSV_PREVIEW_WIRE_VERSION,
            mode: "inspect",
            intentId,
            filename: canonicalFilename,
          }
        : {
            schemaVersion: CATALOG_CSV_PREVIEW_WIRE_VERSION,
            mode: "preview",
            intentId,
            filename: canonicalFilename,
            mapping: wireMapping,
          },
      bytes,
    );
    const response = await fetch(`/w/${workspaceId}/katalog/import/preview`, {
      method: "POST",
      headers: { "Content-Type": CATALOG_CSV_PREVIEW_MEDIA_TYPE },
      body: body.buffer as ArrayBuffer,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const code = responseError(payload) ?? "internal_error";
      throw new Error(code);
    }
    return payload;
  }

  async function inspectFile(): Promise<void> {
    if (!file) {
      setMessage("Wähle zuerst eine CSV-Datei aus.");
      setState("error");
      return;
    }
    if (file.size < 1 || file.size > CATALOG_CSV_MAX_BYTES) {
      setMessage(file.size < 1 ? "Die Datei ist leer." : errorMessages.file_too_large!);
      setState("error");
      return;
    }
    setState("inspecting");
    setMessage("");
    try {
      const parsed = inspectedResponse(await post("inspect"));
      if (!parsed) throw new Error("internal_error");
      setInspection(parsed.inspection);
      setMapping(parsed.mapping);
      setState("inspected");
    } catch (error) {
      const code = error instanceof Error ? error.message : "internal_error";
      setMessage(errorMessages[code] ?? errorMessages.internal_error!);
      setState("error");
    }
  }

  function changeMapping(sourceHeader: string, field: string): void {
    setMapping((current) => {
      const withoutSource = current.filter((entry) => entry.sourceHeader !== sourceHeader);
      if (field === "") return withoutSource;
      return [...withoutSource, {
        sourceHeader,
        field: field as CatalogCsvCanonicalField,
      }];
    });
    if (state === "mapping_incomplete") setState("inspected");
  }

  async function createPreview(): Promise<void> {
    if (!inspection || !file) {
      setMessage("Prüfe die Datei zuerst erneut.");
      setState("error");
      return;
    }
    if (missingRequired.length > 0) {
      setMessage("Ordne alle erforderlichen gemeinsamen Felder zu.");
      setState("mapping_incomplete");
      return;
    }
    setMessage("");
    setReplayedImportId(null);
    setState("previewing");
    try {
      const prepared = preparedResponse(await post("preview"));
      if (!prepared) throw new Error("internal_error");
      if (prepared.replayed) {
        setReplayedImportId(prepared.importId);
        setMessage(`Dieser identische Importversuch existiert bereits und ist ${preparedStateLabels[prepared.state]}.`);
        setState("replayed");
        return;
      }
      setState("inspected");
      router.push(`/w/${workspaceId}/katalog/importe/${prepared.importId}`);
    } catch (error) {
      const code = error instanceof Error ? error.message : "internal_error";
      setMessage(errorMessages[code] ?? errorMessages.internal_error!);
      setState("error");
    }
  }

  const assigned = new Map(mapping.map((column) => [column.sourceHeader, column.field]));
  const selectedFields = new Set(mapping.map((column) => column.field));

  return (
    <section
      data-catalog-import-hydrated={hydrated ? "true" : "false"}
      data-catalog-import-page-state={state}
      aria-labelledby="catalog-import-file-title"
      className="grid min-w-0 gap-6"
    >
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 id="catalog-import-file-title" className="text-lg font-semibold text-slate-950">1. Datei prüfen</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          CSV, maximal 1 MiB, 1.000 Datenzeilen, 80 Spalten und 4.096 Zeichen je Zelle.
        </p>
        <label className="mt-5 grid gap-2 text-sm font-medium text-slate-800">
          CSV-Datei
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={!hydrated || busy}
            onChange={(event) => selectFile(event.currentTarget.files?.[0] ?? null)}
            className="min-h-11 min-w-0 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:font-semibold file:text-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          />
        </label>
        <button type="button" onClick={() => void inspectFile()} aria-disabled={!hydrated || busy || undefined} disabled={!hydrated || busy} className="mt-4 min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-500">
          {state === "inspecting" ? "Datei wird geprüft …" : "Datei prüfen"}
        </button>
      </div>

      {inspection ? (
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-lg font-semibold text-slate-950">2. Serverbestätigte Dateimerkmale</h2>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-slate-500">Datei</dt><dd className="mt-1 break-all font-medium text-slate-950">{inspection.filename}</dd></div>
            <div><dt className="text-slate-500">Kodierung</dt><dd className="mt-1 font-medium text-slate-950">{inspection.encoding === "utf-8" ? "UTF-8" : "Windows-1252"}</dd></div>
            <div><dt className="text-slate-500">Trennzeichen</dt><dd className="mt-1 font-medium text-slate-950">{inspection.delimiter === ";" ? "Semikolon" : "Komma"}</dd></div>
            <div><dt className="text-slate-500">Datenzeilen</dt><dd className="mt-1 font-medium tabular-nums text-slate-950">{inspection.rowCount.toLocaleString("de-DE")}</dd></div>
          </dl>
        </div>
      ) : null}

      {inspection ? (
        <div ref={mappingRef} tabIndex={-1} className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-600 sm:p-6">
          <h2 className="text-lg font-semibold text-slate-950">3. Spalten zuordnen</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Die Vorschau nutzt ausschließlich diese serverseitig erneut geprüfte Zuordnung.
          </p>
          {missingRequired.length > 0 ? (
            <div role="note" className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
              Noch erforderlich: {missingRequired.map((field) => fieldLabels[field]).join(", ")}
            </div>
          ) : (
            <p role="status" className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950">Alle gemeinsamen Pflichtfelder sind zugeordnet.</p>
          )}
          <div
            role="region"
            aria-label="Spaltenzuordnungstabelle"
            tabIndex={0}
            className="mt-4 overflow-x-auto rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            <table className="w-full min-w-[36rem] border-separate border-spacing-0 text-left text-sm">
              <thead><tr><th className="border-b border-slate-200 px-3 py-2 font-semibold text-slate-700">CSV-Spalte</th><th className="border-b border-slate-200 px-3 py-2 font-semibold text-slate-700">Zielfeld</th></tr></thead>
              <tbody>
                {inspection.headers.map((header) => {
                  const current = assigned.get(header) ?? "";
                  return (
                    <tr key={header}>
                      <th scope="row" className="border-b border-slate-100 px-3 py-2 font-medium text-slate-900">{header}</th>
                      <td className="border-b border-slate-100 px-3 py-2">
                        <label className="sr-only" htmlFor={`mapping-${inspection.headers.indexOf(header)}`}>Zielfeld für {header}</label>
                        <select id={`mapping-${inspection.headers.indexOf(header)}`} value={current} disabled={mappingLocked} onChange={(event) => changeMapping(header, event.currentTarget.value)} className="min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200">
                          <option value="">Ignorieren</option>
                          {CATALOG_CSV_CANONICAL_FIELDS.map((field) => (
                            <option key={field} value={field} disabled={selectedFields.has(field) && field !== current}>{fieldLabels[field]}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button type="button" onClick={() => void createPreview()} aria-disabled={mappingLocked || undefined} disabled={mappingLocked} className="mt-5 min-h-11 rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-500">
            {state === "previewing" ? "Vorschau wird angelegt …" : "Vorschau erstellen"}
          </button>
        </div>
      ) : null}

      {message ? (
        <div ref={feedbackRef} tabIndex={-1} role={state === "replayed" ? "status" : "alert"} aria-live={state === "replayed" ? "polite" : "assertive"} className={state === "replayed" ? "rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-950 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700" : "rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm font-medium text-red-950 outline-none focus-visible:ring-2 focus-visible:ring-red-700"}>
          <p>{message}</p>
          {state === "replayed" && replayedImportId ? (
            <Link href={`/w/${workspaceId}/katalog/importe/${replayedImportId}`} className="mt-3 inline-flex min-h-11 items-center rounded-md border border-emerald-700 bg-white px-4 font-semibold text-emerald-900 outline-none hover:bg-emerald-100 focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2">Bestehenden Import öffnen</Link>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
