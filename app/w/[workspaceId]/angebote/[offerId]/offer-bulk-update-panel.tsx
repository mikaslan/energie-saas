"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  bulkUpdateVariantsEditorAction,
  type BulkUpdateEditorActionState,
} from "../actions";
import type { OfferDetailSurfaceView } from "./offer-detail-view";

type BulkUpdateSurface = NonNullable<OfferDetailSurfaceView["bulkUpdate"]>;
type BulkRowSurface = BulkUpdateSurface["rows"][number];
type BulkSkipReason = NonNullable<BulkRowSurface["skipReason"]> | "variant_current";

type RowDraft = {
  tax: "" | "standard_19" | "zero_operator_confirmed";
  name: string;
  zeroConfirmed: boolean;
};

type Outcome =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "validation"; message: string }
  | { status: "success"; createdNames: readonly string[] }
  | { status: "error"; message: string };

const SKIP_LABELS: Record<BulkSkipReason, string> = {
  variant_signature_pending: "wartet auf Signatur",
  variant_signed: "signiert",
  variant_revoked_by_customer: "vom Kunden widerrufen",
  variant_current: "bereits aktuell",
};

function defaultSuccessorName(sourceName: string, resolutionRevision: number): string {
  const suffix = ` · Kat.-Rev. ${resolutionRevision}`;
  // Code-Point-Schnitt wie im Service (Review-P2): nie Surrogate teilen.
  const base = Array.from(sourceName.normalize("NFC").trim())
    .slice(0, Math.max(0, 120 - suffix.length))
    .join("");
  return `${base}${suffix}`.normalize("NFC").trim();
}

function skipLabel(reason: string): string {
  return (SKIP_LABELS as Record<string, string>)[reason] ?? "übersprungen";
}

function errorMessageFor(result: BulkUpdateEditorActionState): string {
  if (result.status === "conflict") return "Basis hat sich geändert, neu laden";
  if (result.status === "blocked") {
    if (result.code === "variant_limit") return "Variantenlimit 12 erreicht";
    if (result.code === "project_not_eligible") {
      return "Das Projekt ist für neue Varianten nicht mehr geeignet.";
    }
    if (result.code === "installation_site_changed") {
      return "Die Installationsadresse hat sich geändert, neu laden";
    }
    return "Die Voraussetzungen haben sich geändert, neu laden";
  }
  if (result.status === "invalid") return "Bitte prüfe die markierten Zeilen.";
  if (result.status === "denied") return "Keine Berechtigung für das Bulk-Update.";
  if (result.status === "unauthenticated") return "Sitzung abgelaufen — bitte neu anmelden.";
  if (result.status === "unavailable") return "Speichern ist vorübergehend nicht verfügbar.";
  return "Das Bulk-Update ist fehlgeschlagen.";
}

export function OfferBulkUpdatePanel({
  workspaceId,
  offerId,
  bulk,
  disabled,
}: {
  workspaceId: string;
  offerId: string;
  bulk: BulkUpdateSurface;
  disabled: boolean;
}) {
  const router = useRouter();
  const executable = bulk.rows.filter((row) => row.skipReason === null);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>(() =>
    Object.fromEntries(executable.map((row) => [row.variantId, {
      tax: "",
      name: defaultSuccessorName(row.name, bulk.expectedResolutionRevision),
      zeroConfirmed: false,
    } satisfies RowDraft])),
  );
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<Outcome>({ status: "idle" });
  const [serverSkips, setServerSkips] = useState<ReadonlyArray<{
    sourceVariantId: string;
    reason: string;
  }>>([]);

  const nameById = new Map(bulk.rows.map((row) => [row.variantId, row.name]));
  const previewSkips = bulk.rows.filter((row) => row.skipReason !== null);
  const serverSkipIds = new Set(serverSkips.map((skip) => skip.sourceVariantId));
  const mergedSkips: ReadonlyArray<{ key: string; name: string; reason: string }> = [
    ...previewSkips
      .filter((row) => !serverSkipIds.has(row.variantId))
      .map((row) => ({ key: row.variantId, name: row.name, reason: row.skipReason as string })),
    ...serverSkips.map((skip) => ({
      key: skip.sourceVariantId,
      name: nameById.get(skip.sourceVariantId) ?? "Variante",
      reason: skip.reason,
    })),
  ];

  function setDraft(variantId: string, patch: Partial<RowDraft>) {
    setDrafts((current) => ({
      ...current,
      [variantId]: { ...current[variantId]!, ...patch },
    }));
  }

  async function confirm() {
    const invalid = new Set<string>();
    for (const row of executable) {
      const draft = drafts[row.variantId] ?? {
        tax: "",
        name: defaultSuccessorName(row.name, bulk.expectedResolutionRevision),
        zeroConfirmed: false,
      };
      const name = draft.name.normalize("NFC").trim();
      if (name.length === 0 || name.length > 120) invalid.add(`f1614-name-${row.variantId}`);
      if (draft.tax === "") invalid.add(`f1614-tax-${row.variantId}`);
      if (draft.tax === "zero_operator_confirmed" && !draft.zeroConfirmed) {
        invalid.add(`f1614-zero-${row.variantId}`);
      }
    }
    setInvalidFields(invalid);
    if (invalid.size > 0) {
      setOutcome({ status: "validation", message: "Bitte prüfe die markierten Zeilen." });
      return;
    }
    const formData = new FormData();
    formData.set("workspaceId", workspaceId);
    formData.set("offerId", offerId);
    formData.set("expectedRequirementRevision", String(bulk.expectedRequirementRevision));
    formData.set("expectedCalculationRevision", String(bulk.expectedCalculationRevision));
    formData.set("expectedResolutionRevision", String(bulk.expectedResolutionRevision));
    formData.set("rows", JSON.stringify(executable.map((row) => {
      const draft = drafts[row.variantId]!;
      return {
        sourceVariantId: row.variantId,
        expectedSourceRevision: row.revision,
        name: draft.name.normalize("NFC").trim(),
        taxTreatment: draft.tax,
        ...(draft.tax === "zero_operator_confirmed"
          ? { zeroConfirmation: { code: "zero_tax_draft_operator_confirmed", confirmed: true } }
          : {}),
      };
    })));
    setOutcome({ status: "pending" });
    let result: BulkUpdateEditorActionState;
    try {
      result = await bulkUpdateVariantsEditorAction(formData);
    } catch {
      setOutcome({ status: "error", message: "Das Bulk-Update ist fehlgeschlagen." });
      return;
    }
    if (result.status !== "success") {
      setOutcome({ status: "error", message: errorMessageFor(result) });
      return;
    }
    setServerSkips([...result.skipped]);
    setOutcome({
      status: "success",
      createdNames: result.created.map((entry) => entry.name),
    });
    router.refresh();
  }

  const pending = outcome.status === "pending" || disabled;
  const confirmLabel = `${executable.length} Nachfolger auf Kat.-Rev. ${bulk.expectedResolutionRevision} anlegen`;

  return (
    <section
      data-f1614-bulk-section
      aria-labelledby="f1614-bulk-heading"
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h2 id="f1614-bulk-heading" className="font-semibold">Bulk-Update</h2>
      <p className="mt-1 text-base leading-6 text-slate-600">
        Legt für jede veraltete Variante genau einen Nachfolger auf Kat.-Rev.{" "}
        {bulk.expectedResolutionRevision} an — ein Revisionsstand, ein Confirm, ein Commit.
        Die Steuer wird pro Zeile ausdrücklich gewählt und nie vererbt.
      </p>
      {outcome.status === "validation" || outcome.status === "error" ? (
        <p role="alert" className="mt-3 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-base leading-6 text-rose-950">
          {outcome.message}
        </p>
      ) : null}
      {outcome.status === "success" ? (
        <p aria-live="polite" className="mt-3 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-base leading-6 text-emerald-950">
          {outcome.createdNames.length} Nachfolger angelegt: {outcome.createdNames.join(", ")}
        </p>
      ) : null}
      {executable.length > 0 ? (
        <ul className="mt-3 grid list-none gap-3 p-0">
          {executable.map((row) => {
            const draft = drafts[row.variantId] ?? {
              tax: "",
              name: defaultSuccessorName(row.name, bulk.expectedResolutionRevision),
              zeroConfirmed: false,
            };
            const taxId = `f1614-tax-${row.variantId}`;
            const nameId = `f1614-name-${row.variantId}`;
            const zeroId = `f1614-zero-${row.variantId}`;
            return (
              <li key={row.variantId} className="min-w-0 rounded-md border border-slate-200 p-3">
                <p className="min-w-0 break-words text-sm font-semibold text-slate-950">
                  {row.name} <span className="font-normal text-slate-600">· Rev. {row.revision} · veraltet</span>
                </p>
                <div className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <label htmlFor={nameId} className="text-xs font-semibold">
                      Nachfolgername für {row.name}
                    </label>
                    <input
                      id={nameId}
                      value={draft.name}
                      aria-invalid={invalidFields.has(nameId) || undefined}
                      aria-describedby={invalidFields.has(nameId) ? `${nameId}-error` : undefined}
                      onChange={(event) => setDraft(row.variantId, { name: event.target.value })}
                      className="mt-1 min-h-11 w-full min-w-0 rounded-md border border-slate-300 px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
                    />
                    {invalidFields.has(nameId) ? (
                      <p id={`${nameId}-error`} role="alert" className="mt-1 text-sm leading-5 text-rose-700">
                        Der Nachfolgername muss 1 bis 120 Zeichen enthalten.
                      </p>
                    ) : null}
                  </div>
                  <div className="min-w-0">
                    <label htmlFor={taxId} className="text-xs font-semibold">
                      Steuer für {row.name}
                    </label>
                    <select
                      id={taxId}
                      value={draft.tax}
                      aria-invalid={invalidFields.has(taxId) || undefined}
                      aria-describedby={invalidFields.has(taxId) ? `${taxId}-error` : undefined}
                      onChange={(event) => setDraft(row.variantId, {
                        tax: event.target.value as RowDraft["tax"],
                        zeroConfirmed: false,
                      })}
                      className="mt-1 min-h-11 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
                    >
                      <option value="">Bitte ausdrücklich auswählen</option>
                      <option value="standard_19">19 % USt.</option>
                      <option value="zero_operator_confirmed">0 % USt. bewusst bestätigen</option>
                    </select>
                    {invalidFields.has(taxId) ? (
                      <p id={`${taxId}-error`} role="alert" className="mt-1 text-sm leading-5 text-rose-700">
                        Wähle die Steuerbehandlung für diese Zeile ausdrücklich aus.
                      </p>
                    ) : null}
                  </div>
                </div>
                {draft.tax === "zero_operator_confirmed" ? (
                  <div className="mt-2">
                    <label className="flex min-h-11 items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 text-base leading-6">
                      <input
                        id={zeroId}
                        type="checkbox"
                        checked={draft.zeroConfirmed}
                        aria-invalid={invalidFields.has(zeroId) || undefined}
                        aria-describedby={invalidFields.has(zeroId) ? `${zeroId}-error` : undefined}
                        onChange={(event) => setDraft(row.variantId, { zeroConfirmed: event.target.checked })}
                        className="size-5 shrink-0 accent-emerald-700"
                      />
                      <span className="min-w-0 break-words">0-%-Steuerentwurf für {row.name} bestätigen</span>
                    </label>
                    {invalidFields.has(zeroId) ? (
                      <p id={`${zeroId}-error`} role="alert" className="mt-1 text-sm leading-5 text-rose-700">
                        0 % USt. muss für diese Zeile bewusst bestätigt werden.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {mergedSkips.length > 0 ? (
        <div className="mt-3">
          <p className="text-sm font-semibold text-slate-950">Übersprungen:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-base leading-6 text-slate-700">
            {mergedSkips.map((skip) => (
              <li key={skip.key} className="break-words">
                {skip.name} — {skipLabel(skip.reason)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {executable.length > 0 ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => void confirm()}
          className="mt-3 min-h-11 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {confirmLabel}
        </button>
      ) : null}
    </section>
  );
}
