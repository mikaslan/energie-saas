"use client";

import { useActionState } from "react";
import type {
  InstallableVariantOption,
  InstallationDto,
  InstallationWorkbook,
} from "@/modules/installations";
import {
  setInstallationVariantAction,
  type InstallationActionState,
} from "./installation-actions";

const initialState: InstallationActionState = { status: "idle" };

const CATEGORY_LABELS: Record<string, string> = {
  module: "Module",
  inverter: "Wechselrichter",
  battery: "Speicher",
  wallbox: "Wallbox",
  heat_pump: "Wärmepumpe",
  mounting: "Montage",
  other: "Sonstige",
};

const euroFormatter = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});

function formatEuro(cents: number): string {
  return euroFormatter.format(cents / 100);
}

function optionLabel(option: InstallableVariantOption): string {
  const offer = option.offerNumber ?? "Angebot";
  const signed = option.signed ? " (signiert)" : "";
  return `${offer} · ${option.variantName} (Rev. ${option.revision})${signed}`;
}

/**
 * F7-08 · Workbook: zu installierende Variante binden (signierte
 * Variante vorausgewählt, Mensch bestätigt) + Stückliste je Kategorie
 * aus dem versiegelten Snapshot (VK-Summen, keine Einkaufspreise).
 */
export function InstallationWorkbookPanel({
  workspaceId,
  projectId,
  installation,
  variants,
  workbook,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  installation: InstallationDto | null;
  variants: InstallableVariantOption[];
  workbook: InstallationWorkbook | null;
  canWrite: boolean;
}) {
  const [state, dispatch] = useActionState(setInstallationVariantAction, initialState);
  if (installation === null) return null;
  const suggested = variants.find((option) => option.signed) ?? variants[0] ?? null;
  const frozen = installation.status === "completed";

  return (
    <section
      aria-labelledby="project-workbook-title"
      data-testid="installation-workbook-panel"
      className="mt-6 min-w-0"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-800">Akte</p>
      <h2 id="project-workbook-title" className="mt-1 text-xl font-semibold text-slate-950">
        Workbook
      </h2>

      {canWrite && !frozen && suggested !== null ? (
        <form action={dispatch} className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-950">Zu installierende Variante</h3>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">Variante</span>
            <select
              name="variantId"
              defaultValue={suggested.variantId}
              data-testid="workbook-variant"
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            >
              {variants.map((option) => (
                <option key={option.variantId} value={option.variantId}>
                  {optionLabel(option)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            data-testid="workbook-variant-submit"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Variante festlegen
          </button>
          {state.status === "success" ? (
            <p role="status" data-testid="workbook-variant-success" className="mt-2 text-sm text-slate-700">
              {state.message}
            </p>
          ) : null}
          {state.status !== "idle" && state.status !== "success" ? (
            <p role="alert" className="mt-2 text-sm font-semibold text-rose-800">
              Die Variante konnte nicht festgelegt werden.
            </p>
          ) : null}
        </form>
      ) : null}

      {workbook === null ? (
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Noch keine Variante gebunden — Stückliste folgt nach der Festlegung.
        </p>
      ) : (
        <div className="mt-3" data-testid="workbook-bom">
          <p className="text-sm text-slate-700">
            {workbook.offerNumber ?? "Angebot"} · {workbook.variantName} (Rev. {workbook.revision})
          </p>
          {workbook.sections.map((section) => (
            <div key={`${section.position}-${section.category}`} className="mt-3">
              <h3 className="text-sm font-semibold text-slate-950">
                {CATEGORY_LABELS[section.category] ?? section.category} · {section.title}
              </h3>
              <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                {section.lines.map((line) => (
                  <li
                    key={line.position}
                    className="flex items-baseline justify-between gap-4 px-3 py-2 text-sm"
                  >
                    <span className="text-slate-700">
                      <span className="mr-2 font-semibold tabular-nums text-slate-500">
                        {line.position}.
                      </span>
                      {line.name} · {line.quantity}
                    </span>
                    <span className="font-semibold tabular-nums text-slate-900">
                      {formatEuro(line.grossCents)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="mt-3 text-sm text-slate-700" data-testid="workbook-total">
            Stücklistensumme (VK, sichtbare Zeilen):{" "}
            <span className="font-semibold tabular-nums text-slate-900">
              {formatEuro(workbook.visibleGrossCents)}
            </span>
          </p>
        </div>
      )}
    </section>
  );
}
