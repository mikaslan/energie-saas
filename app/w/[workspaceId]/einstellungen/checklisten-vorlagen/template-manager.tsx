"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type {
  ChecklistTemplateDto,
  ChecklistTemplateItemV1,
} from "@/lib/integrations/checklists/template-contract";
import {
  archiveTemplateAction,
  createTemplateAction,
  restoreTemplateAction,
  updateTemplateAction,
  type TemplateActionState,
} from "./actions";

const initialState: TemplateActionState = { status: "idle" };

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30";

function message(state: TemplateActionState): { text: string; isError: boolean } | null {
  switch (state.status) {
    case "success": return { text: state.message, isError: false };
    case "invalid": return { text: "Die Eingabe ist ungültig.", isError: true };
    case "conflict": return { text: "Eine aktive Vorlage mit diesem Namen existiert bereits.", isError: true };
    case "not_found": return { text: "Die Vorlage wurde nicht gefunden.", isError: true };
    case "denied": return { text: "Dir fehlt die Berechtigung für diese Aktion.", isError: true };
    case "unauthenticated": return { text: "Deine Sitzung ist abgelaufen.", isError: true };
    default: return null;
  }
}

function Feedback({ state }: { state: TemplateActionState }) {
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const feedback = message(state);
  useEffect(() => {
    if (feedback?.isError) feedbackRef.current?.focus();
  }, [feedback?.isError, state]);
  return (
    <p
      ref={feedbackRef}
      tabIndex={-1}
      role={feedback?.isError ? "alert" : "status"}
      aria-live="polite"
      className={`mt-3 text-sm font-semibold ${
        feedback === null ? "hidden" : feedback.isError ? "text-red-700" : "text-green-700"
      }`}
    >
      {feedback?.text}
    </p>
  );
}

export function ChecklistTemplateManager({
  workspaceId,
  templates,
  components,
  canWrite,
}: {
  workspaceId: string;
  templates: ChecklistTemplateDto[];
  components: Array<{ id: string; sku: string }>;
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(createTemplateAction, initialState);
  const [archiveState, archiveDispatch] = useActionState(archiveTemplateAction, initialState);
  const [restoreState, restoreDispatch] = useActionState(restoreTemplateAction, initialState);

  const active = templates.filter((template) => template.active);
  const archived = templates.filter((template) => !template.active);

  return (
    <div className="space-y-6">
      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-950">Aktive Vorlagen</h2>
        {active.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-slate-500">Noch keine Vorlagen angelegt.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {active.map((template) => (
              <li key={template.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-900">{template.name}</span>
                  <span className="block text-xs text-slate-500">
                    {template.items.length} Positionen · {template.targets.join(", ") || "ohne Zielgruppen"}
                  </span>
                </span>
                {canWrite ? (
                  <>
                    <EditForm
                      key={`${template.id}-${template.updatedAt}`}
                      workspaceId={workspaceId}
                      template={template}
                      components={components}
                    />
                    <form action={archiveDispatch}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="id" value={template.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
                      >
                        Archivieren
                      </button>
                    </form>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Feedback state={archiveState} />
      </section>

      {archived.length > 0 || restoreState.status !== "idle" ? (
        <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-950">Archivierte Vorlagen</h2>
          {archived.length === 0 ? (
            <p className="mt-2 text-sm leading-6 text-slate-500">Keine archivierten Vorlagen.</p>
          ) : null}
          <ul className="mt-3 divide-y divide-slate-100">
            {archived.map((template) => (
              <li key={template.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1 text-sm text-slate-500">{template.name}</span>
                {canWrite ? (
                  <form action={restoreDispatch}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="id" value={template.id} />
                    <button
                      type="submit"
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
                    >
                      Reaktivieren
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          <Feedback state={restoreState} />
        </section>
      ) : null}

      {canWrite ? (
        <CreateForm
          workspaceId={workspaceId}
          components={components}
          state={createState}
          dispatch={createDispatch}
        />
      ) : (
        <p className="text-sm leading-6 text-slate-500">
          Du hast Lesezugriff. Zum Anlegen brauchst du Editor-Rechte.
        </p>
      )}
    </div>
  );
}

function ItemEditor({
  components,
  items,
  onChange,
}: {
  components: Array<{ id: string; sku: string }>;
  items: ChecklistTemplateItemV1[];
  onChange: (items: ChecklistTemplateItemV1[]) => void;
}) {
  const addItem = () => onChange([
    ...items,
    { componentId: components[0]?.id ?? "", quantity: 1, position: items.length, visibleToCustomer: true, priceOverridesComponent: false },
  ]);
  const setItem = (index: number, patch: Partial<ChecklistTemplateItemV1>) =>
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const removeItem = (index: number) => onChange(
    items.filter((_, i) => i !== index).map((item, i) => ({ ...item, position: i })),
  );

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <select
            aria-label={`Komponente ${index + 1}`}
            value={item.componentId}
            onChange={(event) => setItem(index, { componentId: event.target.value })}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
          >
            {components.map((component) => (
              <option key={component.id} value={component.id}>{component.sku}</option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-sm text-slate-700">
            Menge
            <input
              type="number"
              min={1}
              max={10000}
              aria-label={`Menge ${index + 1}`}
              value={item.quantity}
              onChange={(event) => {
              const quantity = Number(event.target.value);
              if (Number.isSafeInteger(quantity)) setItem(index, { quantity });
            }}
              className="w-20 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
            />
          </label>
          <button
            type="button"
            onClick={() => removeItem(index)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50"
          >
            Entfernen
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addItem}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        Position hinzufügen
      </button>
    </div>
  );
}

function CreateForm({
  workspaceId,
  components,
  state,
  dispatch,
}: {
  workspaceId: string;
  components: Array<{ id: string; sku: string }>;
  state: TemplateActionState;
  dispatch: (formData: FormData) => void;
}) {
  const [items, setItems] = useState<ChecklistTemplateItemV1[]>([]);
  return (
    <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-950">Neue Vorlage</h2>
      <form action={dispatch} className="mt-3 space-y-4">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="items" value={JSON.stringify(items)} />
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="block text-sm font-semibold text-slate-800">Name</span>
            <input type="text" name="name" required maxLength={200} className={inputClass} />
          </label>
          <label className="block">
            <span className="block text-sm font-semibold text-slate-800">Position</span>
            <input type="number" name="position" min={0} step={1} defaultValue={0} className={inputClass} />
          </label>
          <label className="block">
            <span className="block text-sm font-semibold text-slate-800">Zielgruppen (kommagetrennt)</span>
            <input type="text" name="targets" placeholder="residential" className={inputClass} />
          </label>
        </div>
        <label className="block">
          <span className="block text-sm font-semibold text-slate-800">Beschreibung</span>
          <input type="text" name="description" maxLength={2000} className={inputClass} />
        </label>
        <div>
          <span className="block text-sm font-semibold text-slate-800">Positionen (Katalog)</span>
          <div className="mt-2">
            <ItemEditor components={components} items={items} onChange={setItems} />
          </div>
        </div>
        <Feedback state={state} />
        <button
          type="submit"
          className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          Anlegen
        </button>
      </form>
    </section>
  );
}

function EditForm({
  workspaceId,
  template,
  components,
}: {
  workspaceId: string;
  template: ChecklistTemplateDto;
  components: Array<{ id: string; sku: string }>;
}) {
  // Kimi-P2-2/P2-3: eigener Action-State je Form + Remount-Key (updatedAt)
  // verhindert stale Items nach dem Speichern.
  const [state, dispatch] = useActionState(updateTemplateAction, initialState);
  const [isOpen, setIsOpen] = useState(false);
  const [items, setItems] = useState<ChecklistTemplateItemV1[]>(template.items);
  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        Bearbeiten
      </button>
    );
  }
  return (
    <form action={dispatch} className="w-full space-y-3 rounded-md border border-slate-200 p-3">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="id" value={template.id} />
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      <div className="grid gap-3 sm:grid-cols-3">
        <input
          type="text"
          name="name"
          required
          maxLength={200}
          defaultValue={template.name}
          aria-label="Name"
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
        />
        <input
          type="number"
          name="position"
          min={0}
          step={1}
          defaultValue={template.position}
          aria-label="Position"
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
        />
        <input
          type="text"
          name="targets"
          defaultValue={template.targets.join(", ")}
          aria-label="Zielgruppen"
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
        />
      </div>
      <input
        type="text"
        name="description"
        maxLength={2000}
        defaultValue={template.description ?? ""}
        aria-label="Beschreibung"
        className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
      />
      <ItemEditor components={components} items={items} onChange={setItems} />
      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600"
        >
          Speichern
        </button>
        <button
          type="button"
          onClick={() => setIsOpen(false)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50"
        >
          Abbrechen
        </button>
      </div>
      <Feedback state={state} />
    </form>
  );
}
