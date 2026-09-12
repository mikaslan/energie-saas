// F8-10 · E-Rechnung CII-Download (Server-Komponente, reiner Lese-Link).
// BASIC-naher CII-Subset als reversible ESTIMATE-Näherung; keine amtliche
// Validierung, kein Versand, keine neue Permission (Route prüft invoicing.read).
export function CiiExportPanel({
  workspaceId,
  type,
  documentId,
}: {
  workspaceId: string;
  type: "invoice" | "credit_note";
  documentId: string;
}) {
  const href = `/w/${workspaceId}/rechnungen/${type}/${documentId}/cii`;
  return (
    <section
      aria-label="E-Rechnung"
      data-invoice-detail="cii"
      className="mt-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 className="text-base font-semibold text-slate-950">E-Rechnung</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        Maschinenlesbares CII-XML (BASIC-naher Subset, ESTIMATE — keine amtliche
        Validierung, kein Versand).
      </p>
      <a
        href={href}
        data-testid="cii-export-download"
        className="mt-3 inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
      >
        E-Rechnung herunterladen
      </a>
    </section>
  );
}
