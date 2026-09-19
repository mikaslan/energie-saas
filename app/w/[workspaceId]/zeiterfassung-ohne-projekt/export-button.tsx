"use client";

import Link from "next/link";

// F9-15 (R1b): CSV-Export-Link für die projektlose Zeiterfassung — Muster:
// Export-Link der Projekt-Zeiterfassungsseite (gleiche Labels/Klassen).
// `query` übernimmt optional aktive Listen-Filter (WYSIWYG, z. B. "?userId=…").
export function ProjectlessExportButton({
  workspaceId,
  query = "",
}: {
  workspaceId: string;
  query?: string;
}) {
  return (
    <Link
      href={`/w/${workspaceId}/zeiterfassung-ohne-projekt/export${query}`}
      className="text-sm font-semibold text-brand-800 underline-offset-2 hover:underline"
    >
      CSV exportieren
    </Link>
  );
}
