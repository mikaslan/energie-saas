"use client";

import { useRef } from "react";
import { schematicExportFilename } from "@/lib/integrations/schematic/export-filename";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * F6-02 · Schaltplan-Export als SVG-Datei (ESTIMATE-Abbildung, lesend).
 * Serialisiert das gerenderte SVG (setzt xmlns, bettet einen Titel mit
 * ESTIMATE-Hinweis ein) und lädt es als Blob herunter — kein
 * Server-Roundtrip, kein Storage, keine neue Permission.
 */
export function SchematicExport({
  offerNumber,
  variantName,
  children,
}: {
  offerNumber: string;
  variantName: string;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const download = () => {
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
    <div>
      <div ref={containerRef}>{children}</div>
      <button
        type="button"
        onClick={download}
        data-testid="schematic-export-download"
        className="mt-3 inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
      >
        SVG herunterladen
      </button>
    </div>
  );
}
