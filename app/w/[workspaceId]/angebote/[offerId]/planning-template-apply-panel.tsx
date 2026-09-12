"use client";

import { useActionState } from "react";
import { applyPlanningTemplateEditorAction } from "../variant-actions";
import {
  APPLY_PLANNING_TEMPLATE_INITIAL_STATE,
  type ApplyPlanningTemplateEditorState,
} from "../variant-action-state";

export interface PlanningTemplateEntry {
  id: string;
  name: string;
  mode: "quick" | "2d" | "3d";
}

const MODE_LABELS: Record<PlanningTemplateEntry["mode"], string> = {
  quick: "Quick-Planung",
  "2d": "2D-Planung",
  "3d": "3D-Planung",
};

function feedback(state: ApplyPlanningTemplateEditorState): string | null {
  switch (state.status) {
    case "idle":
      return null;
    case "success": {
      const label: string = (MODE_LABELS as Record<string, string>)[state.mode] ?? state.mode;
      return `Planungsmodus gesetzt (${label}).`;
    }
    case "not_found":
      return "Vorlage wurde nicht gefunden oder ist archiviert.";
    case "conflict":
      return "Variante wurde zwischenzeitlich geändert; Seite neu laden.";
    case "denied":
      return "Dafür fehlt dir die Angebots-Freigabe.";
    case "unauthenticated":
      return "Bitte erneut anmelden.";
    case "unavailable":
      return "Vorlagen sind aktuell nicht verfügbar.";
    default:
      return "Eingaben prüfen (Vorlage wählen).";
  }
}

// F16-08: Planungs-Vorlage an einer Variante anwenden (Modus-Preset).
// Reine Client-Komponente: Server-Truth kommt aus dem Angebots-Detail.
export function PlanningTemplateApplyPanel({
  workspaceId,
  offerId,
  variantId,
  expectedRevision,
  templates,
}: {
  workspaceId: string;
  offerId: string;
  variantId: string;
  expectedRevision: number;
  templates: readonly PlanningTemplateEntry[];
}) {
  const [state, dispatch] = useActionState(
    applyPlanningTemplateEditorAction,
    APPLY_PLANNING_TEMPLATE_INITIAL_STATE,
  );
  const message = feedback(state);
  return (
    <form action={dispatch} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="variantId" value={variantId} />
      <input type="hidden" name="expectedRevision" value={String(expectedRevision)} />
      <label className="grid gap-1 text-sm font-medium text-slate-800">
        Planungs-Vorlage
        <select
          name="templateId"
          required
          defaultValue=""
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600"
        >
          <option value="" disabled>
            Vorlage wählen …
          </option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name} ({MODE_LABELS[template.mode]})
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600"
      >
        Vorlage anwenden
      </button>
      {message ? (
        <p role={state.status === "success" ? "status" : "alert"} className="w-full text-sm text-slate-700">
          {message}
        </p>
      ) : null}
    </form>
  );
}
