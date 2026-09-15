"use client";

import { useActionState, useState } from "react";
import { PACKAGE_TEMPLATE_MAX_LINES } from "@/lib/integrations/offers/package-contract";
import type { PackageTemplateDto } from "@/lib/integrations/offers/package-contract";
import {
  archivePackageTemplateAction,
  createPackageTemplateAction,
  type PackageTemplateActionState,
  restorePackageTemplateAction,
  updatePackageTemplateAction,
} from "./actions";

const initialState: PackageTemplateActionState = { status: "idle" };

const CATEGORY_LABELS: Record<string, string> = {
  module: "Module",
  inverter: "Wechselrichter",
  battery: "Speicher",
  wallbox: "Wallbox",
  heat_pump: "Wärmepumpe",
  mounting: "Montage",
  other: "Sonstiges",
};

const CATEGORY_OPTIONS = [
  "module",
  "inverter",
  "battery",
  "wallbox",
  "heat_pump",
  "mounting",
  "other",
];

const UNIT_OPTIONS = [
  { value: "piece", label: "Stück" },
  { value: "set", label: "Set" },
  { value: "meter", label: "Meter" },
];

const POSITION_TYPE_OPTIONS = [
  { value: "required", label: "Pflicht" },
  { value: "additional", label: "Zusatz" },
  { value: "optional", label: "Optional" },
];

type LineRow = {
  key: string;
  displayName: string;
  description: string;
  unit: string;
  quantity: string;
  salesEuros: string;
  purchaseEuros: string;
  positionType: string;
  isHidden: boolean;
  taxTreatment: string;
};

function centsToEuros(cents: number): string {
  return (cents / 100).toString();
}

function milliToQuantity(milli: number): string {
  return (milli / 1000).toString();
}

function emptyRow(): LineRow {
  return {
    key: `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
    displayName: "",
    description: "",
    unit: "piece",
    quantity: "1",
    salesEuros: "",
    purchaseEuros: "",
    positionType: "required",
    isHidden: false,
    taxTreatment: "standard_19",
  };
}

function rowsFromTemplate(template?: PackageTemplateDto): LineRow[] {
  if (!template || template.lines.length === 0) return [emptyRow()];
  return template.lines.map((line, index) => ({
    key: `${template.id}-${index}`,
    displayName: line.displayName,
    description: line.description ?? "",
    unit: line.unit,
    quantity: milliToQuantity(line.quantityMilli),
    salesEuros: centsToEuros(line.salesUnitNetCents),
    purchaseEuros: centsToEuros(line.purchaseUnitNetCents),
    positionType: line.positionType,
    isHidden: line.isHidden,
    taxTreatment: line.taxTreatment ?? "standard_19",
  }));
}

function Feedback({ state }: { state: PackageTemplateActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return <p role="status" className="mt-2 text-sm font-medium text-green-700">{state.message}</p>;
  }
  const message =
    state.status === "conflict"
      ? "Ein aktives Paket mit diesem Namen existiert bereits."
      : state.status === "denied"
        ? "Dafür fehlt dir die Rabatt-Freigabe."
        : state.status === "not_found"
          ? "Paket nicht gefunden."
          : state.status === "unauthenticated"
            ? "Bitte erneut anmelden."
            : "Eingaben prüfen (Name, Sektionstitel, mindestens eine gültige Position).";
  return <p role="alert" className="mt-2 text-sm font-medium text-red-700">{message}</p>;
}

// F16-11: Create-/Edit-Formular (Name, Sektionstitel, Kategorie,
// dynamische Positionszeilen). Remount bei Erfolg/Datensatzwechsel
// (stale-DOM, Muster Angebots-Vorlagen).
function PackageForm({
  workspaceId,
  template,
  action,
  submitLabel,
}: {
  workspaceId: string;
  template?: PackageTemplateDto;
  action: (
    previous: PackageTemplateActionState,
    formData: FormData,
  ) => Promise<PackageTemplateActionState>;
  submitLabel: string;
}) {
  const [state, dispatch] = useActionState(action, initialState);
  const [successCount, setSuccessCount] = useState(0);
  const [prevStatus, setPrevStatus] = useState(state.status);
  if (prevStatus !== state.status) {
    setPrevStatus(state.status);
    if (state.status === "success") setSuccessCount((count) => count + 1);
  }
  const formKey = template
    ? `${template.id}:${template.updatedAt}:${successCount}`
    : `new:${successCount}`;
  const [rows, setRows] = useState<LineRow[]>(() => rowsFromTemplate(template));
  const inputClass = "min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30";
  const updateRow = (key: string, patch: Partial<LineRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };
  return (
    <form action={dispatch} key={formKey} className="grid gap-3">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      {template ? <input type="hidden" name="id" value={template.id} /> : null}
      <input
        type="hidden"
        name="linesJson"
        value={JSON.stringify(rows.map((row) => ({
          displayName: row.displayName,
          description: row.description === "" ? null : row.description,
          unit: row.unit,
          quantity: row.quantity,
          salesEuros: row.salesEuros,
          purchaseEuros: row.purchaseEuros,
          positionType: row.positionType,
          isHidden: row.isHidden,
          taxTreatment: row.taxTreatment,
        })))}
      />
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Paketname
        <input
          type="text"
          name="name"
          defaultValue={template?.name ?? ""}
          required
          maxLength={200}
          className={inputClass}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-semibold text-slate-800">
          Sektionstitel
          <input
            type="text"
            name="sectionTitle"
            defaultValue={template?.sectionTitle ?? ""}
            required
            maxLength={120}
            className={inputClass}
          />
        </label>
        <label className="grid gap-1 text-sm font-semibold text-slate-800">
          Kategorie
          <select name="category" defaultValue={template?.category ?? "other"} className={inputClass}>
            {CATEGORY_OPTIONS.map((value) => (
              <option key={value} value={value}>{CATEGORY_LABELS[value]}</option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="grid gap-3 border-0 p-0">
        <legend className="text-sm font-semibold text-slate-800">
          Positionen ({rows.length} von höchstens {PACKAGE_TEMPLATE_MAX_LINES})
        </legend>
        {rows.map((row, index) => (
          <div key={row.key} className="grid gap-2 rounded-lg border border-slate-200 p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-sm font-semibold text-slate-800">
                {`Positionsname ${index + 1}`}
                <input
                  type="text"
                  value={row.displayName}
                  onChange={(event) => updateRow(row.key, { displayName: event.target.value })}
                  required
                  maxLength={200}
                  className={inputClass}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-800">
                {`Beschreibung ${index + 1} (optional)`}
                <input
                  type="text"
                  value={row.description}
                  onChange={(event) => updateRow(row.key, { description: event.target.value })}
                  maxLength={1000}
                  className={inputClass}
                />
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-4">
              <label className="grid gap-1 text-sm font-semibold text-slate-800">
                {`Einheit ${index + 1}`}
                <select
                  value={row.unit}
                  onChange={(event) => updateRow(row.key, { unit: event.target.value })}
                  className={inputClass}
                >
                  {UNIT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-800">
                {`Menge ${index + 1}`}
                <input
                  type="text"
                  inputMode="decimal"
                  value={row.quantity}
                  onChange={(event) => updateRow(row.key, { quantity: event.target.value })}
                  required
                  placeholder="z. B. 2 oder 2,5"
                  className={inputClass}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-800">
                {`VK je Einheit € ${index + 1}`}
                <input
                  type="text"
                  inputMode="decimal"
                  value={row.salesEuros}
                  onChange={(event) => updateRow(row.key, { salesEuros: event.target.value })}
                  required
                  placeholder="z. B. 250,00"
                  className={inputClass}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-800">
                {`EK je Einheit € ${index + 1}`}
                <input
                  type="text"
                  inputMode="decimal"
                  value={row.purchaseEuros}
                  onChange={(event) => updateRow(row.key, { purchaseEuros: event.target.value })}
                  required
                  placeholder="z. B. 150,00"
                  className={inputClass}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="grid gap-1 text-sm font-semibold text-slate-800">
                {`Steuer ${index + 1}`}
                <select
                  value={row.taxTreatment}
                  onChange={(event) => updateRow(row.key, { taxTreatment: event.target.value })}
                  className={inputClass}
                >
                  <option value="standard_19">19 % USt.</option>
                  <option value="zero_operator_confirmed">0 % USt. nach Prüfung</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-800">
                {`Positionsart ${index + 1}`}
                <select
                  value={row.positionType}
                  onChange={(event) => updateRow(row.key, { positionType: event.target.value })}
                  className={inputClass}
                >
                  {POSITION_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 pt-5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={row.isHidden}
                  onChange={(event) => updateRow(row.key, { isHidden: event.target.checked })}
                  className="h-5 w-5 rounded border-slate-300 text-brand-800 focus:ring-2 focus:ring-brand-600"
                />
                {`Versteckt ${index + 1}`}
              </label>
              {rows.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Position ${index + 1} entfernen`}
                  onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}
                  className="mt-5 min-h-11 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
                >
                  Entfernen
                </button>
              ) : null}
            </div>
          </div>
        ))}
        {rows.length < PACKAGE_TEMPLATE_MAX_LINES ? (
          <button
            type="button"
            onClick={() => setRows((current) => [...current, emptyRow()])}
            className="min-h-11 w-fit rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            Position hinzufügen
          </button>
        ) : null}
      </fieldset>
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Reihenfolge
        <input
          type="text"
          name="position"
          inputMode="numeric"
          defaultValue={template ? String(template.position) : "0"}
          required
          className={inputClass}
        />
      </label>
      <div>
        <button
          type="submit"
          className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          {submitLabel}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function PackageTemplateManager({
  workspaceId,
  templates,
  canWrite,
}: {
  workspaceId: string;
  templates: PackageTemplateDto[];
  canWrite: boolean;
}) {
  const [archiveState, archiveDispatch] = useActionState(archivePackageTemplateAction, initialState);
  const [restoreState, restoreDispatch] = useActionState(restorePackageTemplateAction, initialState);
  return (
    <div className="grid gap-8">
      {canWrite ? (
        <section aria-label="Neues Paket" className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-950">Neues Paket</h2>
          <div className="mt-3">
            <PackageForm
              workspaceId={workspaceId}
              action={createPackageTemplateAction}
              submitLabel="Anlegen"
            />
          </div>
        </section>
      ) : null}
      <section aria-label="Pakete" className="grid gap-4">
        {templates.length === 0 ? (
          <p className="text-sm text-slate-600">Noch keine Pakete vorhanden.</p>
        ) : null}
        {templates.map((template) => (
          <article key={template.id} className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-semibold text-slate-950">{template.name}</h3>
              <span className="text-xs text-slate-500">
                {template.active ? "aktiv" : "archiviert"}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-700">
              {template.sectionTitle} · {CATEGORY_LABELS[template.category] ?? template.category} ·{" "}
              {template.lines.length === 1 ? "1 Position" : `${template.lines.length} Positionen`}
            </p>
            {canWrite ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-semibold text-brand-800 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-600">
                  Bearbeiten
                </summary>
                <div className="mt-3">
                  <PackageForm
                    workspaceId={workspaceId}
                    template={template}
                    action={updatePackageTemplateAction}
                    submitLabel="Speichern"
                  />
                </div>
              </details>
            ) : null}
            {canWrite ? (
              template.active ? (
                <form action={archiveDispatch} className="mt-3">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="id" value={template.id} />
                  <button
                    type="submit"
                    aria-label={`${template.name} archivieren`}
                    className="min-h-11 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    Archivieren
                  </button>
                </form>
              ) : (
                <form action={restoreDispatch} className="mt-3">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="id" value={template.id} />
                  <button
                    type="submit"
                    aria-label={`${template.name} reaktivieren`}
                    className="min-h-11 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    Reaktivieren
                  </button>
                </form>
              )
            ) : null}
          </article>
        ))}
      </section>
      {archiveState.status !== "idle" ? <Feedback state={archiveState} /> : null}
      {restoreState.status !== "idle" ? <Feedback state={restoreState} /> : null}
    </div>
  );
}
