"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { ContactSuggestion } from "@/modules/contacts";
import {
  createManualLeadAction,
  type ManualLeadActionState,
} from "./manual-lead-actions";
import { suggestManualLeadContacts } from "./manual-lead-contact-actions";

const initialState: ManualLeadActionState = { status: "idle" };

const inputClass =
  "min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-brand-600";
const labelClass = "grid gap-1 text-sm font-medium text-slate-700";

const SUGGEST_DEBOUNCE_MS = 250;

const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([type='hidden']):not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

type SuggestStatus = "idle" | "searching" | "results" | "empty" | "denied";

function Feedback({ state, workspaceId }: { state: ManualLeadActionState; workspaceId: string }) {
  if (state.status === "idle") return null;
  if (state.status === "success") return null;
  if (state.status === "note-failed") {
    return (
      <p role="status" data-testid="manual-lead-note-failed" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Anfrage angelegt, Notiz nicht gespeichert —{" "}
        <Link
          href={`/w/${workspaceId}/anfragen/${state.projectId}`}
          className="font-semibold underline underline-offset-2"
        >
          Projektakte öffnen
        </Link>
      </p>
    );
  }
  const tone = "border-amber-300 bg-amber-50 text-amber-900";
  const message =
    state.status === "invalid"
      ? "Bitte prüfen: Name sowie E-Mail oder Telefon sind Pflicht (PLZ fünfstellig)."
      : state.status === "lane-missing"
        ? "Für diesen Bereich ist keine Eingangs-Spalte verfügbar."
        : state.status === "denied"
          ? "Keine Berechtigung zum Anlegen."
          : "Bitte erneut anmelden.";
  return (
    <p role="alert" className={`rounded-md border px-3 py-2 text-sm ${tone}`}>
      {message}
    </p>
  );
}

function suggestionDetailLine(suggestion: ContactSuggestion): string | null {
  const parts = [suggestion.email, suggestion.phone].filter(
    (value): value is string => value !== null && value.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * F1-16 · Dialog-Körper: Kontakt-Suche mit Vorbefüllung + unverändertes
 * F1-11-Formular. Eigene Komponente, damit jede Öffnung mit frischem
 * Zustand startet (wie bisher beim Inline-Formular).
 */
function ManualLeadDialog({
  workspaceId,
  scope,
  scopeLabel,
  sources,
  campaigns,
  state,
  dispatch,
  onClose,
}: {
  workspaceId: string;
  scope: "residential" | "commercial";
  scopeLabel: string;
  sources: Array<{ id: string; name: string }>;
  campaigns: Array<{
    id: string;
    name: string;
    leadSourceName: string;
    assigneeLabel: string | null;
  }>;
  state: ManualLeadActionState;
  dispatch: (formData: FormData) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const resultsId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const requestIdRef = useRef(0);

  // Vorbefüllungs-Ziele sind kontrolliert, Quelle/Kampagne/Notiz bleiben unkontrolliert.
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [street, setStreet] = useState("");
  const [houseNumber, setHouseNumber] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [city, setCity] = useState("");

  const [searchQuery, setSearchQuery] = useState("");
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [suggestStatus, setSuggestStatus] = useState<SuggestStatus>("idle");
  const [selected, setSelected] = useState<ContactSuggestion | null>(null);

  // Der Öffner-Button ist während des Dialogs nicht gemountet — die
  // Fokus-Rückgabe übernimmt die Elternkomponente nach dem Schließen.
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (selected || trimmed.length < 2) return;
    const requestId = (requestIdRef.current += 1);
    const timer = setTimeout(() => {
      setSuggestStatus("searching");
      void (async () => {
        const result = await suggestManualLeadContacts(workspaceId, trimmed);
        if (requestIdRef.current !== requestId) return;
        if (result.status === "results") {
          setSuggestions(result.suggestions);
          setSuggestStatus("results");
        } else if (result.status === "empty") {
          setSuggestions([]);
          setSuggestStatus("empty");
        } else if (result.status === "denied") {
          setSuggestions([]);
          setSuggestStatus("denied");
        } else {
          setSuggestions([]);
          setSuggestStatus("idle");
        }
      })();
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery, selected, workspaceId]);

  function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        DIALOG_FOCUSABLE_SELECTOR,
      ) ?? []);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (focusable.length === 0) {
        event.preventDefault();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }

  function selectSuggestion(suggestion: ContactSuggestion) {
    setSelected(suggestion);
    setDisplayName(suggestion.displayName);
    setEmail(suggestion.email ?? "");
    setPhone(suggestion.phone ?? "");
    setStreet(suggestion.street ?? "");
    setHouseNumber(suggestion.houseNumber ?? "");
    setPostalCode(suggestion.postalCode ?? "");
    setCity(suggestion.city ?? "");
    setSearchQuery("");
    setSuggestions([]);
    setSuggestStatus("idle");
  }

  function clearSelection() {
    // Nur die Auswahl (contactId) leeren — vorbefüllte Felder bleiben
    // bearbeitbar, die Anlage läuft dann über den normalen Dedupe.
    setSelected(null);
    setSearchQuery("");
    setSuggestions([]);
    setSuggestStatus("idle");
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/60 p-2 sm:p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={onDialogKeyDown}
        className="max-h-[calc(100dvh-1rem)] w-full max-w-2xl overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="break-words text-xl font-semibold text-slate-950">
              Anfrage manuell erfassen
            </h2>
            <p id={descriptionId} className="mt-1 text-sm leading-6 text-slate-600">
              {`Neue Anfrage im Bereich ${scopeLabel} — Name sowie E-Mail oder Telefon sind Pflicht.`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Dialog schließen"
            data-testid="manual-lead-close"
            className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Schließen
          </button>
        </div>

        <form
          action={dispatch}
          data-testid="manual-lead-form"
          className="mt-4 grid min-w-0 gap-3"
        >
          <input type="hidden" name="scope" value={scope} />
          {selected ? <input type="hidden" name="contactId" value={selected.id} /> : null}
          <div className="grid gap-1">
            <label htmlFor={resultsId} className={labelClass}>
              Kontakt suchen (optional, füllt das Formular vor)
              <input
                id={resultsId}
                ref={searchInputRef}
                type="search"
                value={searchQuery}
                onChange={(event) => {
                  const value = event.target.value;
                  setSearchQuery(value);
                  if (value.trim().length < 2) {
                    requestIdRef.current += 1;
                    setSuggestions([]);
                    setSuggestStatus("idle");
                  }
                }}
                placeholder="Mindestens 2 Zeichen"
                autoComplete="off"
                data-testid="manual-lead-contact-search"
                className={inputClass}
              />
            </label>
            {selected ? (
              <p className="flex flex-wrap items-center gap-2 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900" data-testid="manual-lead-contact-selected">
                <span className="font-semibold">{selected.displayName}</span>
                <button
                  type="button"
                  onClick={clearSelection}
                  data-testid="manual-lead-contact-clear"
                  className="inline-flex min-h-11 items-center rounded-md border border-brand-300 bg-white px-3 text-sm font-semibold text-brand-900 outline-none hover:bg-brand-100 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                >
                  Auswahl entfernen
                </button>
              </p>
            ) : null}
            <div aria-live="polite">
              {suggestStatus === "searching" ? (
                <p className="text-sm text-slate-500" data-testid="manual-lead-contact-searching">
                  Suche läuft …
                </p>
              ) : null}
              {suggestStatus === "empty" ? (
                <p className="text-sm text-slate-500" data-testid="manual-lead-contact-empty">
                  Keine Kontakte gefunden — das Formular legt einen neuen Kontakt an.
                </p>
              ) : null}
              {suggestStatus === "denied" ? (
                <p className="text-sm text-slate-500" data-testid="manual-lead-contact-denied">
                  Keine Leseberechtigung für Kontakte — Erfassung ohne Suche möglich.
                </p>
              ) : null}
            </div>
            {suggestStatus === "results" ? (
              <ul className="grid list-none gap-1" data-testid="manual-lead-contact-results" aria-label="Kontakt-Vorschläge">
                {suggestions.map((suggestion) => (
                  <li key={suggestion.id}>
                    <button
                      type="button"
                      onClick={() => selectSuggestion(suggestion)}
                      data-testid="manual-lead-contact-option"
                      className="flex min-h-11 w-full flex-col items-start justify-center gap-0.5 rounded-md border border-slate-200 bg-white px-3 py-2 text-left outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                    >
                      <span className="text-sm font-semibold text-slate-900">{suggestion.displayName}</span>
                      {suggestionDetailLine(suggestion) ? (
                        <span className="text-xs text-slate-500">{suggestionDetailLine(suggestion)}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <label className={labelClass}>
            Name *
            <input name="displayName" required maxLength={200} autoComplete="off" value={displayName} onChange={(event) => setDisplayName(event.target.value)} className={inputClass} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              E-Mail
              <input name="email" type="email" maxLength={200} autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} className={inputClass} />
            </label>
            <label className={labelClass}>
              Telefon
              <input name="phone" type="tel" maxLength={40} autoComplete="off" value={phone} onChange={(event) => setPhone(event.target.value)} className={inputClass} />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              Straße
              <input name="street" maxLength={200} autoComplete="off" value={street} onChange={(event) => setStreet(event.target.value)} className={inputClass} />
            </label>
            <label className={labelClass}>
              Hausnummer
              <input name="houseNumber" maxLength={30} autoComplete="off" value={houseNumber} onChange={(event) => setHouseNumber(event.target.value)} className={inputClass} />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={labelClass}>
              PLZ
              <input name="postalCode" inputMode="numeric" maxLength={10} autoComplete="off" value={postalCode} onChange={(event) => setPostalCode(event.target.value)} className={inputClass} />
            </label>
            <label className={labelClass}>
              Ort
              <input name="city" maxLength={200} autoComplete="off" value={city} onChange={(event) => setCity(event.target.value)} className={inputClass} />
            </label>
          </div>
          <label className={labelClass}>
            Lead-Quelle (optional)
            <select name="leadSourceId" defaultValue="" className={inputClass}>
              <option value="">Keine Quelle</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Funnel-Kampagne (optional, bestimmt Quelle und Zuweisung)
            <select name="funnelCampaignId" defaultValue="" className={inputClass}>
              <option value="">Keine Kampagne</option>
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {`${campaign.name} · ${campaign.leadSourceName}${
                    campaign.assigneeLabel ? ` · Zuweisung: ${campaign.assigneeLabel}` : ""
                  }`}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Notiz (optional)
            <textarea name="note" rows={2} maxLength={2000} className={inputClass} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
            >
              Anfrage anlegen
            </button>
            <button
              type="button"
              onClick={onClose}
              data-testid="manual-lead-cancel"
              className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50"
            >
              Abbrechen
            </button>
          </div>
          <Feedback state={state} workspaceId={workspaceId} />
        </form>
      </div>
    </div>
  );
}

/**
 * F1-11 · Manuelle Anfrage-Erfassung (Editoren). Legt Kontakt + Standort +
 * Projekt auf der Intake-Spalte des aktuellen Bereichs an.
 * F1-16 · Das Formular öffnet als Modal mit Kontakt-Suche und Vorbefüllung.
 */
export function ManualLeadForm({
  workspaceId,
  scope,
  scopeLabel,
  sources,
  campaigns,
}: {
  workspaceId: string;
  scope: "residential" | "commercial";
  scopeLabel: string;
  sources: Array<{ id: string; name: string }>;
  campaigns: Array<{
    id: string;
    name: string;
    leadSourceName: string;
    assigneeLabel: string | null;
  }>;
}) {
  const [open, setOpen] = useState(false);
  const [state, dispatch] = useActionState(
    createManualLeadAction.bind(null, workspaceId),
    initialState,
  );
  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusOnCloseRef = useRef(false);

  useEffect(() => {
    if (!open && returnFocusOnCloseRef.current) {
      returnFocusOnCloseRef.current = false;
      openButtonRef.current?.focus();
    }
  }, [open ]);

  function closeDialog() {
    returnFocusOnCloseRef.current = true;
    setOpen(false);
  }

  if (state.status === "success") {
    return (
      <p role="status" data-testid="manual-lead-success" className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        Anfrage angelegt
        {state.contactReused ? " (bestehender Kontakt, Prüfung ausstehend)" : ""}
        {" — "}
        <Link
          href={`/w/${workspaceId}/anfragen/${state.projectId}`}
          className="font-semibold underline underline-offset-2"
        >
          Projektakte öffnen
        </Link>
      </p>
    );
  }

  if (!open) {
    return (
      <button
        ref={openButtonRef}
        type="button"
        onClick={() => setOpen(true)}
        data-testid="manual-lead-open"
        className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
      >
        Anfrage manuell erfassen
      </button>
    );
  }

  return (
    <ManualLeadDialog
      workspaceId={workspaceId}
      scope={scope}
      scopeLabel={scopeLabel}
      sources={sources}
      campaigns={campaigns}
      state={state}
      dispatch={dispatch}
      onClose={closeDialog}
    />
  );
}
