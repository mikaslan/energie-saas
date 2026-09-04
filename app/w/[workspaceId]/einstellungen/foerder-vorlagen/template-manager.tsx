"use client";

import { useActionState, useState } from "react";
import type { SubsidyTemplateDto } from "@/lib/integrations/subsidies/contract";
import {
  archiveSubsidyTemplateAction,
  createSubsidyTemplateAction,
  type SubsidyTemplateActionState,
  restoreSubsidyTemplateAction,
  updateSubsidyTemplateAction,
} from "./actions";

const initialState: SubsidyTemplateActionState = { status: "idle" };

function Feedback({ state }: { state: SubsidyTemplateActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return <p role="status" className="mt-2 text-sm font-medium text-green-700">{state.message}</p>;
  }
  const message =
    state.status === "conflict"
      ? "Eine aktive Vorlage mit diesem Namen existiert bereits."
      : state.status === "denied"
        ? "Dafür fehlt dir die discounts-Freigabe."
        : state.status === "not_found"
          ? "Vorlage nicht gefunden."
          : state.status === "unauthenticated"
            ? "Bitte erneut anmelden."
            : "Eingaben prüfen (Art, Beträge, Cap nur bei Prozent).";
  return <p role="alert" className="mt-2 text-sm font-medium text-red-700">{message}</p>;
}

function formatValue(template: SubsidyTemplateDto): string {
  if (template.kind === "fix_cents") {
    return `${((template.amountCents ?? 0) / 100).toFixed(2)} €`;
  }
  const percent = ((template.percentBps ?? 0) / 100).toFixed(2).replace(".", ",");
  const cap = template.capCents === null
    ? "ohne Deckel"
    : `, Deckel ${((template.capCents ?? 0) / 100).toFixed(2)} €`;
  return `${percent} %${cap}`;
}

// F16.3 Slice B: Create-/Edit-Formular (kind-Umschalter: Fix braucht
// Betrag, Prozent braucht bps + optional Cap). Cent-Eingaben als Euro.
function TemplateForm({
  workspaceId,
  template,
  action,
  submitLabel,
}: {
  workspaceId: string;
  template?: SubsidyTemplateDto;
  action: (
    previous: SubsidyTemplateActionState,
    formData: FormData,
  ) => Promise<SubsidyTemplateActionState>;
  submitLabel: string;
}) {
  const [kind, setKind] = useState<"fix_cents" | "percent_bps">(template?.kind ?? "fix_cents");
  const [state, dispatch] = useActionState(action, initialState);
  return (
    <form action={dispatch} className="grid gap-3">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      {template ? <input type="hidden" name="id" value={template.id} /> : null}
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Name
        <input
          type="text"
          name="name"
          defaultValue={template?.name ?? ""}
          required
          maxLength={200}
          aria-label="Name"
          className="rounded-md border border-slate-300 px-3 py-2 font-normal"
        />
      </label>
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Art
        <select
          name="kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as "fix_cents" | "percent_bps")}
          aria-label="Art"
          className="rounded-md border border-slate-300 px-3 py-2 font-normal"
        >
          <option value="fix_cents">Fester Betrag</option>
          <option value="percent_bps">Prozentsatz</option>
        </select>
      </label>
      {kind === "fix_cents" ? (
        <label className="grid gap-1 text-sm font-semibold text-slate-800">
          Betrag (€)
          <input
            type="number"
            name="amountEuro"
            defaultValue={template?.amountCents !== null && template?.amountCents !== undefined
              ? (template.amountCents / 100).toFixed(2)
              : ""}
            required
            min={0}
            step="0.01"
            aria-label="Betrag in Euro"
            className="rounded-md border border-slate-300 px-3 py-2 font-normal"
          />
        </label>
      ) : (
        <>
          <label className="grid gap-1 text-sm font-semibold text-slate-800">
            Prozentsatz (z. B. 5 für 5 %)
            <input
              type="number"
              name="percentValue"
              defaultValue={template?.percentBps !== null && template?.percentBps !== undefined
                ? (template.percentBps / 100).toString()
                : ""}
              required
              min={0.01}
              max={100}
              step="0.01"
              aria-label="Prozentsatz"
              className="rounded-md border border-slate-300 px-3 py-2 font-normal"
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-slate-800">
            Deckel (€, optional)
            <input
              type="number"
              name="capEuro"
              defaultValue={template?.capCents !== null && template?.capCents !== undefined
                ? (template.capCents / 100).toFixed(2)
                : ""}
              min={0}
              step="0.01"
              aria-label="Deckel in Euro"
              className="rounded-md border border-slate-300 px-3 py-2 font-normal"
            />
          </label>
        </>
      )}
      <input type="hidden" name="position" value={template?.position ?? 0} />
      <div>
        <button
          type="submit"
          className="min-h-11 rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600"
        >
          {submitLabel}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function SubsidyTemplateManager({
  workspaceId,
  templates,
  canWrite,
}: {
  workspaceId: string;
  templates: SubsidyTemplateDto[];
  canWrite: boolean;
}) {
  const [createState] = useActionState(createSubsidyTemplateAction, initialState);
  const [archiveState, archiveDispatch] = useActionState(archiveSubsidyTemplateAction, initialState);
  const [restoreState, restoreDispatch] = useActionState(restoreSubsidyTemplateAction, initialState);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="grid gap-6">
      {canWrite ? (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-950">Neue Vorlage</h2>
          <div className="mt-3">
            <TemplateForm
              workspaceId={workspaceId}
              action={createSubsidyTemplateAction}
              submitLabel="Anlegen"
            />
          </div>
        </section>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-950">Vorlagen</h2>
        {templates.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-slate-500">Noch keine Vorlagen angelegt.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 rounded-md border border-slate-200">
            {templates.map((template) => (
              <li key={template.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    {template.name}
                    {!template.active ? (
                      <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                        archiviert
                      </span>
                    ) : null}
                  </span>
                  {canWrite ? (
                    <span className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingId(editingId === template.id ? null : template.id)}
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Bearbeiten
                      </button>
                      {template.active ? (
                        <form action={archiveDispatch} className="inline">
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="id" value={template.id} />
                          <button
                            type="submit"
                            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            Archivieren
                          </button>
                        </form>
                      ) : (
                        <form action={restoreDispatch} className="inline">
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="id" value={template.id} />
                          <button
                            type="submit"
                            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            Reaktivieren
                          </button>
                        </form>
                      )}
                    </span>
                  ) : null}
                </div>
                <span className="mt-1 block text-sm text-slate-600">{formatValue(template)}</span>
                {editingId === template.id && canWrite ? (
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <TemplateForm
                      workspaceId={workspaceId}
                      template={template}
                      action={updateSubsidyTemplateAction}
                      submitLabel="Speichern"
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Feedback state={createState} />
        <Feedback state={archiveState} />
        <Feedback state={restoreState} />
      </section>
    </div>
  );
}
