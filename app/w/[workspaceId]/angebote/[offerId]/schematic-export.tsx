"use client";

import { useEffect, useRef, useState } from "react";
import { schematicExportFilename } from "@/lib/integrations/schematic/export-filename";
import type { SingleLineSchematic } from "@/lib/integrations/schematic/single-line-v1";
import {
  saveSchematicFirstOpen,
  type SaveSchematicFirstOpenStatus,
} from "./schematic-actions";
import type { SchematicScope } from "./single-line-diagram";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export type SchematicSaveState =
  | "idle"
  | "pending"
  | "saved"
  | "already-saved"
  | "gated"
  | "denied"
  | "unavailable"
  | "error";

export type SchematicFirstOpen = {
  workspaceId: string;
  offerId: string;
  variantId: string;
  revision: number;
  schematic: SingleLineSchematic;
};

function mapSaveStatus(status: SaveSchematicFirstOpenStatus): SchematicSaveState {
  if (status === "saved") return "saved";
  if (status === "already_saved") return "already-saved";
  if (status === "gated") return "gated";
  if (status === "denied" || status === "unauthenticated") return "denied";
  if (status === "unavailable") return "unavailable";
  return "error";
}

/**
 * F6-02 · Schaltplan-Export als SVG-Datei (ESTIMATE-Abbildung, lesend).
 * Serialisiert das gerenderte SVG (setzt xmlns, bettet einen Titel mit
 * ESTIMATE-Hinweis ein) und lädt es als Blob herunter — kein
 * Server-Roundtrip, kein Storage, keine neue Permission.
 *
 * F6-01-Gate: Scope `commercial` verweigert den Export explizit (Fehler
 * statt Download). `firstOpen` löst zusätzlich genau einen
 * Erstöffnen-Save je Mount aus (serverseitig idempotent); ohne `firstOpen`
 * bleibt die Komponente rein lesend (M2-01-kompatibel). Die Wurzel trägt
 * `data-offer-schematic` + Save-State gemeinsam (E2E-Ein-Element-Vertrag).
 */
export function SchematicExport({
  offerNumber,
  variantName,
  scope = "residential",
  firstOpen = null,
  children,
}: {
  offerNumber: string;
  variantName: string;
  scope?: SchematicScope;
  firstOpen?: SchematicFirstOpen | null;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [refused, setRefused] = useState(false);
  const [saveState, setSaveState] = useState<SchematicSaveState>("idle");
  const saveAttemptedRef = useRef(false);
  const gated = scope === "commercial";

  useEffect(() => {
    if (gated || !firstOpen || saveAttemptedRef.current) return;
    saveAttemptedRef.current = true;
    setSaveState("pending");
    saveSchematicFirstOpen(firstOpen).then(
      (result) => setSaveState(mapSaveStatus(result.status)),
      () => setSaveState("error"),
    );
  }, [gated, firstOpen]);

  const download = () => {
    if (gated) {
      setRefused(true);
      return;
    }
    const svg = containerRef.current?.querySelector("svg");
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", SVG_NAMESPACE);
    const title = document.createElementNS(SVG_NAMESPACE, "title");
    title.textContent =
      `Einphasiges Übersichtsschaltbild (Entwurf, ESTIMATE) — ${offerNumber} / ${variantName}`;
    clone.insertBefore(title, clone.firstChild);
    const blob = new Blob(
      [`<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`],
      { type: "image/svg+xml" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = schematicExportFilename({ offerNumber, variantName });
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div data-offer-schematic="true" data-schematic-save-state={saveState}>
      <div ref={containerRef}>{children}</div>
      <button
        type="button"
        onClick={download}
        data-testid="schematic-export-download"
        className="mt-3 inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
      >
        SVG herunterladen
      </button>
      {refused && gated ? (
        <p
          role="alert"
          data-testid="schematic-export-refused"
          className="mt-2 text-sm leading-6 text-rose-700"
        >
          Export für Gewerbe- und B2B-Angebote nicht verfügbar. Das
          Schaltplanbild (ESTIMATE) wird nur für Wohnbau-Angebote erzeugt.
        </p>
      ) : null}
    </div>
  );
}
