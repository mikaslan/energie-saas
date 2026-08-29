"use client";

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  AddressSearchResultSchema,
  type AddressCandidate,
} from "@/lib/integrations/geocoding/client";
import {
  correctProjectAddressAction,
  type CorrectProjectAddressState,
} from "../project-actions";
import { AddressPinMap } from "./address-pin-map";

const initialCorrectionState: CorrectProjectAddressState = { status: "idle" };

type SearchState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "results" }
  | { status: "empty" }
  | { status: "error"; message: string };

type Pin = {
  latitude: number;
  longitude: number;
};

function actionMessage(state: CorrectProjectAddressState): string {
  switch (state.status) {
    case "success":
      return "Die Hausadresse wurde gespeichert. Prüfe den neuen Stand und bestätige den Planungs-Pin anschließend getrennt.";
    case "invalid":
      return "Die Adressauswahl ist ungültig. Bitte wähle die Hausadresse erneut aus.";
    case "unauthenticated":
      return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu und melde dich erneut an.";
    case "denied":
      return "Für die Adresskorrektur fehlt dir die Berechtigung.";
    case "stale":
      return "Die Adresse wurde inzwischen in einem anderen Tab geändert. Bitte lade die Projektakte neu.";
    case "not_editable":
      return "Dieser Standort kann im aktuellen Zustand nicht mehr korrigiert werden. Bitte lade die Projektakte neu.";
    case "collision":
      return "Für diesen Kontakt ist die ausgewählte Hausadresse bereits als anderer Standort hinterlegt.";
    case "shared_site":
      return "Der Standort wird von mehreren Projekten verwendet und kann deshalb hier nicht geändert werden.";
    case "pin_out_of_range":
      return "Der Planungs-Pin liegt mehr als 150 Meter von der ausgewählten Hausadresse entfernt.";
    case "provider_rate_limited":
      return "Der Adressdienst ist gerade ausgelastet. Bitte versuche es später erneut.";
    case "provider_timeout":
      return "Der Adressdienst hat nicht rechtzeitig geantwortet. Bitte versuche es erneut.";
    case "provider_unavailable":
      return "Der Adressdienst ist momentan nicht verfügbar. Bitte versuche es später erneut.";
    case "provider_invalid_response":
      return "Die ausgewählte Adresse konnte nicht sicher bestätigt werden. Bitte suche sie erneut.";
    default:
      return "";
  }
}

function searchErrorMessage(code: string | null, status: number): string {
  if (code === "invalid_request" || status === 400) {
    return "Bitte gib eine vollständige Hausadresse mit Straße, Hausnummer und Ort ein.";
  }
  if (code === "unauthenticated" || status === 401) {
    return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu und melde dich erneut an.";
  }
  if (code === "forbidden" || code === "origin_mismatch" || status === 403) {
    return "Für die Adresssuche fehlt dir die Berechtigung.";
  }
  if (code === "not_found" || status === 404) {
    return "Die Projektakte ist nicht mehr verfügbar. Bitte lade die Seite neu.";
  }
  if (code === "not_editable" || status === 409) {
    return "Die Adresse kann im aktuellen Zustand nicht mehr korrigiert werden.";
  }
  if (
    code === "rate_limited"
    || code === "geocoding_rate_limited"
    || status === 429
  ) {
    return "Zu viele Suchanfragen. Bitte warte kurz und versuche es erneut.";
  }
  if (code === "geocoding_invalid_response" || status === 502) {
    return "Der Adressdienst hat keine verlässlichen Ergebnisse geliefert. Bitte versuche es erneut.";
  }
  if (code === "geocoding_unavailable" || status === 503) {
    return "Der Adressdienst ist momentan nicht verfügbar. Bitte versuche es später erneut.";
  }
  return "Die Adresssuche ist fehlgeschlagen. Bitte versuche es erneut.";
}

function responseErrorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("error" in value)) return null;
  const error = value.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function formatCoordinate(value: number): string {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  }).format(value);
}

export function AddressEditor({
  workspaceId,
  projectId,
  addressRevision,
}: {
  workspaceId: string;
  projectId: string;
  addressRevision: number;
}) {
  const listboxId = useId();
  const searchHelpId = useId();
  const searchStatusId = useId();
  const selectionStatusRef = useRef<HTMLDivElement | null>(null);
  const actionStatusRef = useRef<HTMLParagraphElement | null>(null);
  const activeRequestRef = useRef<AbortController | null>(null);
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({ status: "idle" });
  const [candidates, setCandidates] = useState<AddressCandidate[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [listOpen, setListOpen] = useState(false);
  const [selected, setSelected] = useState<AddressCandidate | null>(null);
  const [pin, setPin] = useState<Pin | null>(null);
  const [correctionState, correctionAction, correctionPending] = useActionState(
    correctProjectAddressAction,
    initialCorrectionState,
  );

  useEffect(() => () => activeRequestRef.current?.abort(), []);

  useEffect(() => {
    if (correctionState.status === "idle") return;
    actionStatusRef.current?.focus();
  }, [correctionState]);

  const selectCandidate = (candidate: AddressCandidate) => {
    setSelected(candidate);
    setPin({ latitude: candidate.latitude, longitude: candidate.longitude });
    setQuery(candidate.formattedAddress);
    setListOpen(false);
    setActiveIndex(-1);
    requestAnimationFrame(() => selectionStatusRef.current?.focus());
  };

  const handleSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (searchState.status === "pending") return;

    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    setSearchState({ status: "pending" });
    setCandidates([]);
    setSelected(null);
    setPin(null);
    setListOpen(false);
    setActiveIndex(-1);

    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/address-candidates`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        },
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setSearchState({
          status: "error",
          message: searchErrorMessage(responseErrorCode(body), response.status),
        });
        return;
      }

      const parsed = AddressSearchResultSchema.safeParse(body);
      if (!parsed.success) {
        setSearchState({
          status: "error",
          message: "Die Suchergebnisse waren nicht verlässlich. Bitte versuche es erneut.",
        });
        return;
      }
      if (parsed.data.candidates.length === 0) {
        setSearchState({ status: "empty" });
        return;
      }

      setCandidates(parsed.data.candidates);
      setSearchState({ status: "results" });
      setActiveIndex(0);
      setListOpen(true);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setSearchState({
        status: "error",
        message: "Die Adresssuche ist fehlgeschlagen. Bitte prüfe deine Verbindung und versuche es erneut.",
      });
    } finally {
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
    }
  };

  const handleComboboxKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setListOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (event.key === "Tab") {
      setListOpen(false);
      return;
    }
    if (event.key === "ArrowDown" && candidates.length > 0) {
      event.preventDefault();
      setListOpen(true);
      setActiveIndex((current) => current < 0 ? 0 : (current + 1) % candidates.length);
      return;
    }
    if (event.key === "ArrowUp" && candidates.length > 0) {
      event.preventDefault();
      setListOpen(true);
      setActiveIndex((current) => current <= 0 ? candidates.length - 1 : current - 1);
      return;
    }
    if (event.key === "Enter" && listOpen && activeIndex >= 0) {
      const candidate = candidates[activeIndex];
      if (candidate) {
        event.preventDefault();
        selectCandidate(candidate);
      }
    }
  };

  const searchMessage = searchState.status === "pending"
    ? "Hausadressen werden gesucht …"
    : searchState.status === "empty"
      ? "Keine hausgenaue Adresse gefunden. Ergänze Straße, Hausnummer, PLZ und Ort."
      : searchState.status === "error"
        ? searchState.message
        : searchState.status === "results"
          ? `${candidates.length} hausgenaue ${candidates.length === 1 ? "Adresse" : "Adressen"} gefunden.`
          : "";
  const correctionMessage = actionMessage(correctionState);
  const correctionFailed = correctionState.status !== "idle"
    && correctionState.status !== "success";

  return (
    <section
      aria-labelledby="address-editor-title"
      className="min-w-0 rounded-lg border border-blue-200 bg-blue-50/50 p-4 sm:p-5"
    >
      <div className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Adresskorrektur</p>
        <h3 id="address-editor-title" className="mt-1 text-base font-semibold text-slate-950">
          Hausadresse nachtragen
        </h3>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Wähle eine hausgenaue Adresse. Das Speichern bestätigt den Planungs-Pin noch nicht.
        </p>
      </div>

      <form
        onSubmit={handleSearch}
        className="relative grid gap-2"
        role="search"
        aria-busy={searchState.status === "pending"}
      >
        <label htmlFor="project-address-search" className="text-sm font-semibold text-slate-900">
          Hausadresse suchen
        </label>
        <p id={searchHelpId} className="text-xs leading-5 text-slate-600">
          Mindestens fünf Zeichen; am besten Straße, Hausnummer, PLZ und Ort eingeben.
        </p>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <input
              id="project-address-search"
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCandidates([]);
                setActiveIndex(-1);
                setSearchState({ status: "idle" });
                setSelected(null);
                setPin(null);
                setListOpen(false);
              }}
              onKeyDown={handleComboboxKeyDown}
              onFocus={() => candidates.length > 0 && setListOpen(true)}
              onBlur={() => setListOpen(false)}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={listOpen}
              aria-controls={listboxId}
              aria-activedescendant={
                listOpen && activeIndex >= 0
                  ? `${listboxId}-option-${activeIndex}`
                  : undefined
              }
              aria-describedby={`${searchHelpId} ${searchStatusId}`}
              autoComplete="street-address"
              required
              minLength={5}
              maxLength={160}
              disabled={searchState.status === "pending" || correctionPending}
              className="min-h-11 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 text-base text-slate-950 shadow-sm outline-none placeholder:text-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-200 disabled:cursor-wait disabled:bg-slate-100 sm:text-sm"
              placeholder="Musterstraße 12, 10115 Berlin"
            />
            {listOpen ? (
              <ul
                id={listboxId}
                role="listbox"
                aria-label="Gefundene Hausadressen"
                className="absolute z-20 mt-1 max-h-72 w-full min-w-0 overflow-y-auto rounded-md border border-slate-300 bg-white p-1 shadow-xl"
              >
                {candidates.map((candidate, index) => (
                  <li
                    key={candidate.placeId}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={activeIndex === index}
                    tabIndex={-1}
                    onPointerDown={(event) => event.preventDefault()}
                    onPointerMove={() => setActiveIndex(index)}
                    onClick={() => selectCandidate(candidate)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        selectCandidate(candidate);
                      }
                    }}
                    className={`cursor-pointer rounded px-3 py-3 text-sm leading-5 outline-none ${
                      activeIndex === index
                        ? "bg-blue-700 text-white"
                        : "text-slate-800 hover:bg-blue-50"
                    }`}
                  >
                    <span className="block break-words font-semibold">{candidate.formattedAddress}</span>
                    <span className={`mt-0.5 block text-xs ${activeIndex === index ? "text-blue-100" : "text-slate-500"}`}>
                      Hausgenau · Deutschland
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <button
            type="submit"
            disabled={searchState.status === "pending" || correctionPending}
            className="min-h-11 shrink-0 rounded-md border border-blue-700 bg-white px-4 text-sm font-semibold text-blue-800 outline-none hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:border-slate-300 disabled:text-slate-400"
          >
            {searchState.status === "pending" ? "Suche läuft …" : "Adresse suchen"}
          </button>
        </div>
        <p
          id={searchStatusId}
          role={searchState.status === "error" ? "alert" : "status"}
          aria-live={searchState.status === "error" ? "assertive" : "polite"}
          aria-atomic="true"
          className={searchMessage
            ? searchState.status === "error"
              ? "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-900"
              : "text-sm leading-5 text-slate-600"
            : "sr-only"}
        >
          {searchMessage}
        </p>
      </form>

      {selected && pin ? (
        <div className="mt-5 grid min-w-0 gap-4">
          <div
            ref={selectionStatusRef}
            tabIndex={-1}
            role="status"
            aria-live="polite"
            className="min-w-0 rounded-lg border border-emerald-200 bg-emerald-50 p-4 outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
          >
            <p className="text-sm font-semibold text-emerald-950">Hausadresse ausgewählt</p>
            <dl className="mt-3 grid min-w-0 gap-2 text-sm sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-xs text-emerald-800">Straße und Hausnummer</dt>
                <dd className="break-words font-semibold text-slate-950">
                  {selected.street} {selected.houseNumber}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-emerald-800">PLZ und Ort</dt>
                <dd className="break-words font-semibold text-slate-950">
                  {selected.postalCode} {selected.city}
                </dd>
              </div>
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-xs text-emerald-800">Vollständige Adresse</dt>
                <dd className="break-words font-semibold text-slate-950">
                  {selected.formattedAddress}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-emerald-800">Adresspunkt</dt>
                <dd className="break-all font-mono text-xs text-slate-800">
                  {formatCoordinate(selected.latitude)}, {formatCoordinate(selected.longitude)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-emerald-800">Aktueller Planungs-Pin</dt>
                <dd className="break-all font-mono text-xs text-slate-800">
                  {formatCoordinate(pin.latitude)}, {formatCoordinate(pin.longitude)}
                </dd>
              </div>
            </dl>
          </div>

          <AddressPinMap
            key={selected.placeId}
            pin={pin}
            onPinChange={setPin}
          />

          <form action={correctionAction} className="grid min-w-0 gap-3">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="projectId" value={projectId} />
            <input
              type="hidden"
              name="expectedAddressRevision"
              value={addressRevision}
            />
            <input type="hidden" name="placeId" value={selected.placeId} />
            <input type="hidden" name="pinLatitude" value={pin.latitude.toString()} />
            <input type="hidden" name="pinLongitude" value={pin.longitude.toString()} />
            <p className="text-xs leading-5 text-slate-600">
              Der Server löst die Adresse beim Speichern erneut auf und akzeptiert den Pin nur bis einschließlich 150 Meter vom Hauspunkt.
            </p>
            {correctionState.status === "pin_out_of_range" ? (
              <button
                type="button"
                onClick={() => setPin({ latitude: selected.latitude, longitude: selected.longitude })}
                className="min-h-11 justify-self-start rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Pin auf Hauspunkt zurücksetzen
              </button>
            ) : null}
            <button
              type="submit"
              disabled={correctionPending || correctionState.status === "success"}
              className="min-h-11 w-full rounded-md bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {correctionPending
                ? "Adresse wird geprüft …"
                : correctionState.status === "success"
                  ? "Adresse übernommen"
                  : "Adresse übernehmen"}
            </button>
            <p
              ref={actionStatusRef}
              tabIndex={-1}
              role={correctionFailed ? "alert" : "status"}
              aria-live={correctionFailed ? "assertive" : "polite"}
              aria-atomic="true"
              className={correctionMessage
                ? correctionState.status === "success"
                  ? "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm leading-5 text-emerald-900 outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
                  : "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-900 outline-none focus-visible:ring-2 focus-visible:ring-red-600"
                : "sr-only"}
            >
              {correctionMessage}
            </p>
          </form>
        </div>
      ) : null}
    </section>
  );
}
