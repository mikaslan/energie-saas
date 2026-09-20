"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  loadSchematicOverlayAction,
  saveSchematicOverlayAction,
} from "./schematic-overlay-actions";

// F6-02a · Editor-Overlay-Bibliothek (editor-overlay.v1): feste Typen aus
// docs/spec/F6-02a-editor-overlay.md. Koordinatenraum 0<=x<=640, 0<=y<=300,
// max 32 Elemente je Overlay (Formular-Modus).
type OverlayElementKind =
  | "earthing_point"
  | "junction_box"
  | "generic"
  | "textbox"
  | "connector";

const OVERLAY_KINDS: readonly { value: OverlayElementKind; label: string }[] = [
  { value: "earthing_point", label: "Erdungspunkt" },
  { value: "junction_box", label: "Abzweigdose" },
  { value: "generic", label: "Generik (mit Label)" },
  { value: "textbox", label: "Textbox" },
  { value: "connector", label: "Konnektor" },
];

const MAX_X = 640;
const MAX_Y = 300;
const MAX_ELEMENTS = 32;

// Drahtformat an die Save-Action: bewusst nachsichtig typisiert (alle
// Zusatzfelder optional) — der Server validiert streng und meldet
// "invalid". Der Cast auf den Action-Parameter beim Aufruf schützt nur
// vor strengerer Typisierung der parallel entstehenden Action-Datei.
type OverlayElementWire = {
  kind: OverlayElementKind;
  x?: number;
  y?: number;
  label?: string;
  text?: string;
  from?: string;
  to?: string;
};

// Eine Formularzeile: Eingaben als Strings (kontrollierte Inputs), die
// erst beim Speichern in Zahlen überführt werden.
type OverlayRow = {
  clientKey: string;
  kind: OverlayElementKind;
  x: string;
  y: string;
  label: string;
  text: string;
  from: string;
  to: string;
};

// Geladenes Element (Test-/Serverform): defensiv gelesen, alles optional.
type LoadedOverlayElement = {
  kind?: unknown;
  x?: unknown;
  y?: unknown;
  label?: unknown;
  text?: unknown;
  from?: unknown;
  to?: unknown;
};

type OverlayPhase =
  | { name: "loading" }
  | { name: "ready" }
  | { name: "no-diagram" }
  | { name: "blocked"; message: string };

function isOverlayKind(value: unknown): value is OverlayElementKind {
  return (
    value === "earthing_point" ||
    value === "junction_box" ||
    value === "generic" ||
    value === "textbox" ||
    value === "connector"
  );
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function toRow(element: LoadedOverlayElement, clientKey: string): OverlayRow {
  return {
    clientKey,
    kind: isOverlayKind(element.kind) ? element.kind : "earthing_point",
    x: toText(element.x),
    y: toText(element.y),
    label: toText(element.label),
    text: toText(element.text),
    from: toText(element.from),
    to: toText(element.to),
  };
}

// Neue Zeile: Standard ist der Erdungspunkt (einfachster Bibliothekstyp).
function newRow(clientKey: string): OverlayRow {
  return {
    clientKey,
    kind: "earthing_point",
    x: "",
    y: "",
    label: "",
    text: "",
    from: "",
    to: "",
  };
}

// Clientseitiger Hinweis je Koordinate (Ganzzahl + Rastergrenzen); der
// Server bleibt der strenge Prüfer (Status "invalid").
function coordinateHint(value: string, max: number, axis: string): string | null {
  if (value.trim() === "") return `${axis} fehlt — Ganzzahl zwischen 0 und ${max} erwartet.`;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return `${axis} muss eine Ganzzahl sein.`;
  if (parsed < 0 || parsed > max) return `${axis} muss zwischen 0 und ${max} liegen.`;
  return null;
}

// Zeile → Drahtformat: nur die kind-relevanten Felder werden mitgesandt
// (Koordinaten außer connector, label nur generic+connector, text nur
// textbox, from/to nur connector).
function toWire(row: OverlayRow): OverlayElementWire {
  const element: OverlayElementWire = { kind: row.kind };
  if (row.kind !== "connector") {
    const x = Number(row.x);
    const y = Number(row.y);
    // Ungültiges wird weggelassen — der Server meldet dann "invalid".
    if (Number.isInteger(x)) element.x = x;
    if (Number.isInteger(y)) element.y = y;
  }
  if (row.kind === "generic" || row.kind === "connector") element.label = row.label;
  if (row.kind === "textbox") element.text = row.text;
  if (row.kind === "connector") {
    element.from = row.from;
    element.to = row.to;
  }
  return element;
}

function saveStatusMessage(status: string, revision: number | undefined): string {
  if (status === "saved") {
    return revision === undefined ? "gespeichert" : `gespeichert (Revision ${revision})`;
  }
  if (status === "unchanged") return "Unverändert — kein Speichern nötig.";
  if (status === "conflict") return "Zwischenzeitlich geändert – bitte neu laden.";
  if (status === "invalid") return "Ungültige Angaben — bitte Eingaben prüfen.";
  if (status === "unavailable") return "Speichern vorübergehend nicht verfügbar.";
  if (status === "not_found") return "Angebotsstand nicht mehr verfügbar.";
  if (status === "denied") return "Keine Berechtigung zum Speichern des Overlays.";
  if (status === "unauthenticated") return "Sitzung abgelaufen — bitte erneut anmelden.";
  if (status === "gated") return "Overlay nur für Wohnbau-Angebote verfügbar.";
  return "Speichern fehlgeschlagen.";
}

function loadBlockedMessage(status: string): string {
  if (status === "gated") return "Overlay nur für Wohnbau-Angebote verfügbar.";
  if (status === "denied") return "Keine Berechtigung für das Schaltplan-Overlay.";
  if (status === "unauthenticated") return "Sitzung abgelaufen — bitte erneut anmelden.";
  if (status === "invalid") return "Overlay-Anfrage ungültig — Seite neu laden.";
  return "Overlay vorübergehend nicht verfügbar.";
}

const inputClassName =
  "mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500";

const labelClassName = "block text-xs font-semibold text-slate-700";

/**
 * F6-02a · Overlay-Formular (Formular-Modus, kein Drag-UI).
 * Lädt das Overlay per loadSchematicOverlayAction, pflegt Zeilen-State
 * (clientKey, kind, x, y, label/text/from/to) und speichert per
 * saveSchematicOverlayAction mit parentRevision=diagramRevision und
 * expectedRevision=overlayRevision (CAS, 0 = noch nie gespeichert).
 * Das Scope-Gate (nur residential) liegt beim Aufrufer in
 * offer-detail-view.tsx — diese Komponente rendert kein Gate.
 */
export function SchematicOverlayForm({
  workspaceId,
  offerId,
  variantRevision,
}: {
  workspaceId: string;
  offerId: string;
  variantRevision: number;
}) {
  const [phase, setPhase] = useState<OverlayPhase>({ name: "loading" });
  const [rows, setRows] = useState<readonly OverlayRow[]>([]);
  const [overlayRevision, setOverlayRevision] = useState<number | null>(null);
  const [diagramRevision, setDiagramRevision] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keyCounter = useRef(0);
  const router = useRouter();

  const nextKey = useCallback(() => {
    keyCounter.current += 1;
    return `neu-${keyCounter.current}`;
  }, []);

  // Overlay laden (initial + nach Save): legt Zeilen, Revisionen und
  // Phase an. diagramRevision null = Schaltplan noch nie gespeichert.
  // Fehlerbehandlung liegt hier (nicht im Effekt): lesender Zugriff,
  // idempotent, StrictMode-Doppelaufruf unkritisch.
  const loadOverlay = useCallback(async () => {
    let result: Awaited<ReturnType<typeof loadSchematicOverlayAction>>;
    try {
      result = await loadSchematicOverlayAction({ workspaceId, offerId, variantRevision });
    } catch {
      setPhase({ name: "blocked", message: "Overlay vorübergehend nicht verfügbar." });
      return;
    }
    if (result.status !== "loaded") {
      setPhase({ name: "blocked", message: loadBlockedMessage(result.status) });
      return;
    }
    const overlay = result.overlay;
    setDiagramRevision(result.diagramRevision);
    if (overlay === null) {
      setOverlayRevision(null);
      setRows([]);
    } else {
      setOverlayRevision(overlay.revision);
      const raw = (overlay.elements ?? []) as unknown as readonly LoadedOverlayElement[];
      setRows(raw.map((element, index) => toRow(element, `server-${index}`)));
    }
    setPhase(result.diagramRevision === null ? { name: "no-diagram" } : { name: "ready" });
  }, [workspaceId, offerId, variantRevision]);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    // F6-01-Muster (schematic-export.tsx): Server-Action direkt mit
    // .then-Erfolg/Fehler — setState nur in den Callbacks, kein Aufruf
    // einer setState-Funktion im Effekt-Rumpf. Zwilling von loadOverlay
    // (dort fuer das Neu-Laden nach Save). No-Diagram wird begrenzt
    // wiederholt: Der Erstöffnen-Save laeuft parallel zum ersten Laden
    // (Race), nach ~5s gilt fehlendes Diagramm als echt.
    const attempt = () => {
      loadSchematicOverlayAction({ workspaceId, offerId, variantRevision }).then(
        (result) => {
          if (cancelled) return;
          if (result.status === "loaded" && result.diagramRevision === null && attempts < 10) {
            attempts += 1;
            setTimeout(() => {
              if (!cancelled) attempt();
            }, 500);
            return;
          }
          if (result.status !== "loaded") {
            setPhase({ name: "blocked", message: loadBlockedMessage(result.status) });
            return;
          }
          const overlay = result.overlay;
          setDiagramRevision(result.diagramRevision);
          if (overlay === null) {
            setOverlayRevision(null);
            setRows([]);
          } else {
            setOverlayRevision(overlay.revision);
            const raw = (overlay.elements ?? []) as unknown as readonly LoadedOverlayElement[];
            setRows(raw.map((element, index) => toRow(element, `server-${index}`)));
          }
          setPhase(result.diagramRevision === null ? { name: "no-diagram" } : { name: "ready" });
        },
        () => {
          if (!cancelled) {
            setPhase({ name: "blocked", message: "Overlay vorübergehend nicht verfügbar." });
          }
        },
      );
    };
    attempt();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, offerId, variantRevision]);

  if (phase.name === "loading") {
    return (
      <section aria-label="Schaltplan-Overlay">
        <p
          data-testid="schematic-overlay-status"
          role="status"
          className="text-sm leading-6 text-slate-600"
        >
          Overlay wird geladen …
        </p>
      </section>
    );
  }

  if (phase.name === "blocked") {
    return (
      <section aria-label="Schaltplan-Overlay">
        <p
          data-testid="schematic-overlay-status"
          role="alert"
          className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700"
        >
          {phase.message}
        </p>
      </section>
    );
  }

  const disabled = saving || phase.name === "no-diagram";
  const atLimit = rows.length >= MAX_ELEMENTS;

  const updateRow = (clientKey: string, patch: Partial<OverlayRow>) => {
    setRows((current) =>
      current.map((row) => (row.clientKey === clientKey ? { ...row, ...patch } : row)),
    );
  };

  const addRow = () => {
    if (atLimit) return;
    setRows((current) => [...current, newRow(nextKey())]);
  };

  const removeRow = (clientKey: string) => {
    setRows((current) => current.filter((row) => row.clientKey !== clientKey));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || diagramRevision === null) return;
    setSaving(true);
    try {
      const elements = rows.map(toWire);
      type SaveInput = Parameters<typeof saveSchematicOverlayAction>[0];
      const result = await saveSchematicOverlayAction({
        workspaceId,
        offerId,
        variantRevision,
        parentRevision: diagramRevision,
        expectedRevision: overlayRevision ?? 0,
        elements: elements as unknown as SaveInput["elements"],
      });
      setStatus(saveStatusMessage(result.status, result.revision));
      // Nach Save bzw. Konflikt neu laden (frische Revision + Serverstand)
      // und Server-View aktualisieren (Diagramm-Merge); bei Eingabe-/
      // Rechte-/Verfügbarkeitsfehlern bleibt der Entwurf stehen, damit er
      // korrigiert werden kann.
      if (result.status === "saved" || result.status === "unchanged" || result.status === "conflict") {
        await loadOverlay();
        router.refresh();
      }
    } catch {
      setStatus("Speichern vorübergehend nicht verfügbar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Schaltplan-Overlay">
      <h3 className="text-base font-semibold text-slate-950">Overlay-Ergänzungen</h3>
      {overlayRevision === null ? null : (
        <p className="mt-1 text-sm text-slate-600">Overlay-Revision {overlayRevision}</p>
      )}
      {phase.name === "no-diagram" ? (
        <p
          role="status"
          className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
        >
          Schaltplan noch nicht gespeichert — das Overlay wird erst nach dem ersten
          Schaltplan-Speichern bearbeitbar.
        </p>
      ) : null}
      <form data-testid="schematic-overlay-form" onSubmit={save} className="mt-3">
        <fieldset disabled={disabled} className="min-w-0 border-0 p-0">
          <legend className="sr-only">Frei platzierbare Overlay-Elemente</legend>
          {rows.length === 0 ? (
            <p className="text-sm leading-6 text-slate-600">
              Noch keine Elemente — füge unten das erste hinzu.
            </p>
          ) : null}
          <ul className="grid list-none gap-3">
            {rows.map((row, index) => {
              const xHint =
                row.kind === "connector" ? null : coordinateHint(row.x, MAX_X, "X");
              const yHint =
                row.kind === "connector" ? null : coordinateHint(row.y, MAX_Y, "Y");
              const idFor = (field: string) => `schematic-overlay-${row.clientKey}-${field}`;
              return (
                <li
                  key={row.clientKey}
                  data-testid="schematic-overlay-row"
                  className="rounded-md border border-slate-200 bg-slate-50 p-3"
                >
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-44 flex-1">
                      <label htmlFor={idFor("kind")} className={labelClassName}>
                        {`Typ (Zeile ${index + 1})`}
                      </label>
                      <select
                        id={idFor("kind")}
                        name="kind"
                        value={row.kind}
                        onChange={(event) =>
                          updateRow(row.clientKey, {
                            kind: event.target.value as OverlayElementKind,
                          })
                        }
                        className={inputClassName}
                      >
                        {OVERLAY_KINDS.map((kind) => (
                          <option key={kind.value} value={kind.value}>
                            {kind.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    {row.kind === "connector" ? null : (
                      <>
                        <div className="w-28">
                          <label htmlFor={idFor("x")} className={labelClassName}>
                            X (0–640)
                          </label>
                          <input
                            id={idFor("x")}
                            name="x"
                            value={row.x}
                            onChange={(event) =>
                              updateRow(row.clientKey, { x: event.target.value })
                            }
                            inputMode="numeric"
                            autoComplete="off"
                            aria-describedby={xHint ? idFor("x-hint") : undefined}
                            className={inputClassName}
                          />
                        </div>
                        <div className="w-28">
                          <label htmlFor={idFor("y")} className={labelClassName}>
                            Y (0–300)
                          </label>
                          <input
                            id={idFor("y")}
                            name="y"
                            value={row.y}
                            onChange={(event) =>
                              updateRow(row.clientKey, { y: event.target.value })
                            }
                            inputMode="numeric"
                            autoComplete="off"
                            aria-describedby={yHint ? idFor("y-hint") : undefined}
                            className={inputClassName}
                          />
                        </div>
                      </>
                    )}
                    {row.kind === "generic" || row.kind === "connector" ? (
                      <div className="min-w-40 flex-1">
                        <label htmlFor={idFor("label")} className={labelClassName}>
                          Label
                        </label>
                        <input
                          id={idFor("label")}
                          name="label"
                          value={row.label}
                          onChange={(event) =>
                            updateRow(row.clientKey, { label: event.target.value })
                          }
                          autoComplete="off"
                          className={inputClassName}
                        />
                      </div>
                    ) : null}
                    {row.kind === "textbox" ? (
                      <div className="min-w-52 flex-1">
                        <label htmlFor={idFor("text")} className={labelClassName}>
                          Text
                        </label>
                        <textarea
                          id={idFor("text")}
                          name="text"
                          value={row.text}
                          onChange={(event) =>
                            updateRow(row.clientKey, { text: event.target.value })
                          }
                          rows={2}
                          className={inputClassName}
                        />
                      </div>
                    ) : null}
                    {row.kind === "connector" ? (
                      <>
                        <div className="min-w-32 flex-1">
                          <label htmlFor={idFor("from")} className={labelClassName}>
                            Von
                          </label>
                          <input
                            id={idFor("from")}
                            name="from"
                            value={row.from}
                            onChange={(event) =>
                              updateRow(row.clientKey, { from: event.target.value })
                            }
                            autoComplete="off"
                            className={inputClassName}
                          />
                        </div>
                        <div className="min-w-32 flex-1">
                          <label htmlFor={idFor("to")} className={labelClassName}>
                            Nach
                          </label>
                          <input
                            id={idFor("to")}
                            name="to"
                            value={row.to}
                            onChange={(event) =>
                              updateRow(row.clientKey, { to: event.target.value })
                            }
                            autoComplete="off"
                            className={inputClassName}
                          />
                        </div>
                      </>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => removeRow(row.clientKey)}
                      aria-label={`Zeile ${index + 1} entfernen`}
                      className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                    >
                      Entfernen
                    </button>
                  </div>
                  {xHint ? (
                    <p id={idFor("x-hint")} className="mt-1 text-sm leading-6 text-amber-800">
                      {xHint}
                    </p>
                  ) : null}
                  {yHint ? (
                    <p id={idFor("y-hint")} className="mt-1 text-sm leading-6 text-amber-800">
                      {yHint}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="schematic-overlay-add"
              onClick={addRow}
              disabled={disabled || atLimit}
              className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
            >
              Element hinzufügen
            </button>
            <button
              type="submit"
              data-testid="schematic-overlay-save"
              disabled={disabled}
              className="inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {saving ? "Wird gespeichert …" : "Overlay speichern"}
            </button>
          </div>
          {atLimit ? (
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Maximal 32 Elemente erreicht.
            </p>
          ) : null}
        </fieldset>
      </form>
      <p
        data-testid="schematic-overlay-status"
        role="status"
        className="mt-3 min-h-6 text-sm leading-6 text-slate-700"
      >
        {status ?? ""}
      </p>
    </section>
  );
}
