"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
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
    case "invalid":
      return "Eingaben sind unvollständig oder ungültig.";
    case "unauthenticated":
      return "Sitzung abgelaufen — bitte neu anmelden.";
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
  const token = props.state.status === "created" ? props.state.token : null;
  const isError = props.state.status !== "idle" && props.state.status !== "created"
    && props.state.status !== "withdrawn" && props.state.status !== "signed";
  if (!message && !token) return null;
  return (
    <p
      className={`mt-2 text-sm font-medium ${isError ? "text-amber-700" : "text-brand-800"}`}
      aria-live={isError ? "assertive" : "polite"}
      role={isError ? "alert" : "status"}
    >
      {message}
      {message && token ? " " : null}
      {token ? (
        <a
          href={`/s/${token}`}
          className="font-mono text-xs break-all text-brand-800 underline underline-offset-2"
        >
          /s/{token}
        </a>
      ) : null}
    </p>
  );
}

function useRefreshAfterMutation(state: SignatureActionState): void {
  const router = useRouter();
  const refreshedMutationRef = useRef<string | null>(null);
  const mutationKey = state.status === "created"
    || state.status === "withdrawn"
    || state.status === "signed"
    ? `${state.status}:${state.requestId}`
    : null;

  useEffect(() => {
    if (mutationKey === null || refreshedMutationRef.current === mutationKey) return;
    refreshedMutationRef.current = mutationKey;
    router.refresh();
  }, [mutationKey, router]);
}

export function CreateSignatureForm(props: {
  workspaceId: string;
  offerId: string;
  variantId: string;
  disabled: boolean;
  pendingRequestId: string | null;
}) {
  const [state, formAction] = useActionState(createSignatureRequestAction, SIGNATURE_ACTION_INITIAL_STATE);
  useRefreshAfterMutation(state);
  const visibleState = state.status === "created" && state.requestId !== props.pendingRequestId
    ? SIGNATURE_ACTION_INITIAL_STATE
    : state;
  return (
    <form action={formAction} className="mt-6 grid gap-3 border-t border-slate-100 pt-5 sm:grid-cols-[1fr_auto]">
      {props.disabled ? (
        <p className="text-xs text-slate-500 sm:col-span-2">
          Für diese Variante besteht bereits eine aktive oder bindende Signaturanforderung.
        </p>
      ) : (
        <>
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
              className="min-h-11 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <input type="hidden" name="workspaceId" value={props.workspaceId} />
          <input type="hidden" name="offerId" value={props.offerId} />
          <input type="hidden" name="variantId" value={props.variantId} />
          <div className="flex items-end">
            <SubmitButton tone="primary">Signaturlink vorbereiten</SubmitButton>
          </div>
        </>
      )}
      <Feedback state={visibleState} />
    </form>
  );
}

const WITHDRAW_REASONS: Array<{ value: string; label: string }> = [
  { value: "content_error", label: "Inhaltlicher Fehler" },
  { value: "recipient_error", label: "Empfängerfehler" },
  { value: "commercial_error", label: "Kommerzieller Fehler" },
  { value: "other", label: "Sonstiges" },
];

export function WithdrawSignatureForm(props: { workspaceId: string; requestId: string }) {
  const [state, formAction] = useActionState(withdrawSignatureRequestAction, SIGNATURE_ACTION_INITIAL_STATE);
  useRefreshAfterMutation(state);
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="workspaceId" value={props.workspaceId} />
      <input type="hidden" name="requestId" value={props.requestId} />
      <div className="grid gap-1">
        <label htmlFor={`withdraw-reason-${props.requestId}`} className="text-xs font-medium text-slate-600">
          Widerrufsgrund
        </label>
        <select
          id={`withdraw-reason-${props.requestId}`}
          name="reasonCode"
          required
          defaultValue="other"
          className="min-h-11 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
        >
          {WITHDRAW_REASONS.map((reason) => (
            <option key={reason.value} value={reason.value}>{reason.label}</option>
          ))}
        </select>
      </div>
      <SubmitButton tone="secondary">Link widerrufen</SubmitButton>
      <Feedback state={state} />
    </form>
  );
}

export function AnalogSignatureForm(props: { workspaceId: string; requestId: string }) {
  const [state, formAction] = useActionState(uploadAnalogSignatureAction, SIGNATURE_ACTION_INITIAL_STATE);
  useRefreshAfterMutation(state);
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="workspaceId" value={props.workspaceId} />
      <input type="hidden" name="requestId" value={props.requestId} />
      <div className="grid gap-1">
        <label htmlFor={`analog-signing-date-${props.requestId}`} className="text-xs font-medium text-slate-600">
          Unterschriftsdatum
        </label>
        <input
          id={`analog-signing-date-${props.requestId}`}
          type="date"
          name="signingDate"
          className="min-h-11 rounded-md border border-slate-300 px-2 py-2 text-sm"
        />
      </div>
      <div className="grid gap-1">
        <label htmlFor={`analog-artifact-${props.requestId}`} className="text-xs font-medium text-slate-600">
          Unterschriebenes Dokument
        </label>
        <input
          id={`analog-artifact-${props.requestId}`}
          type="file"
          name="artifact"
          accept="application/pdf,image/jpeg"
          className="min-h-11 text-sm"
        />
      </div>
      <SubmitButton tone="primary">Analog hochladen</SubmitButton>
      <Feedback state={state} />
    </form>
  );
}
