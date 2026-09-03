"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import {
  SIGNATURE_ACTION_INITIAL_STATE,
  type SignatureActionState,
} from "./signature-action-state";
import {
  createSignatureRequestAction,
  uploadAnalogSignatureAction,
  withdrawSignatureRequestAction,
} from "./signature-actions";

function actionMessage(state: SignatureActionState): string | null {
  switch (state.status) {
    case "created":
      return state.replayed
        ? "Signaturlink bereits vorhanden."
        : "Signaturlink vorbereitet — wartet auf Signatur.";
    case "withdrawn":
      return "Signaturlink widerrufen.";
    case "signed":
      return "Analoge Signatur hochgeladen.";
    case "denied":
      return "Keine Berechtigung für diese Aktion.";
    case "conflict":
      return "Zustand hat sich geändert — bitte neu laden.";
    case "not_found":
      return "Signaturanforderung nicht gefunden.";
    case "unavailable":
      return "Vorübergehend nicht verfügbar.";
    default:
      return null;
  }
}

function SubmitButton(props: { children: string; tone: "primary" | "secondary" }) {
  const { pending } = useFormStatus();
  const className = props.tone === "primary"
    ? "inline-flex min-h-11 items-center justify-center rounded-md bg-slate-900 px-5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
    : "inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50";
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? "…" : props.children}
    </button>
  );
}

function Feedback(props: { state: SignatureActionState }) {
  const message = actionMessage(props.state);
  if (!message) return null;
  return (
    <p className="mt-2 text-sm font-medium text-blue-800" aria-live="polite" role="status">
      {message}
    </p>
  );
}

export function CreateSignatureForm(props: {
  workspaceId: string;
  offerId: string;
  variantId: string;
}) {
  const [state, formAction] = useActionState(createSignatureRequestAction, SIGNATURE_ACTION_INITIAL_STATE);
  return (
    <form action={formAction} className="mt-6 grid gap-3 border-t border-slate-100 pt-5 sm:grid-cols-[1fr_auto]">
      <div className="grid gap-1">
        <label htmlFor="ttlDays" className="text-xs font-medium text-slate-600">
          Gültigkeit in Tagen (1–60)
        </label>
        <input
          id="ttlDays"
          name="ttlDays"
          type="number"
          min={1}
          max={60}
          defaultValue={14}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </div>
      <input type="hidden" name="workspaceId" value={props.workspaceId} />
      <input type="hidden" name="offerId" value={props.offerId} />
      <input type="hidden" name="variantId" value={props.variantId} />
      <div className="flex items-end">
        <SubmitButton tone="primary">Signaturlink vorbereiten</SubmitButton>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function WithdrawSignatureForm(props: { workspaceId: string; requestId: string }) {
  const [state, formAction] = useActionState(withdrawSignatureRequestAction, SIGNATURE_ACTION_INITIAL_STATE);
  return (
    <form action={formAction}>
      <input type="hidden" name="workspaceId" value={props.workspaceId} />
      <input type="hidden" name="requestId" value={props.requestId} />
      <input type="hidden" name="reasonCode" value="other" />
      <SubmitButton tone="secondary">Link widerrufen</SubmitButton>
      <Feedback state={state} />
    </form>
  );
}

export function AnalogSignatureForm(props: { workspaceId: string; requestId: string }) {
  const [state, formAction] = useActionState(uploadAnalogSignatureAction, SIGNATURE_ACTION_INITIAL_STATE);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="workspaceId" value={props.workspaceId} />
      <input type="hidden" name="requestId" value={props.requestId} />
      <input type="date" name="signingDate" className="rounded-md border border-slate-300 px-2 py-2 text-sm" />
      <input type="file" name="artifact" accept="application/pdf,image/jpeg" className="text-sm" />
      <SubmitButton tone="primary">Analog hochladen</SubmitButton>
      <Feedback state={state} />
    </form>
  );
}
