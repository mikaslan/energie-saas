// F3-02 Dachquellen-Registry: Angebots-Planungsblock. F3-01-Muster
// (offer-editor.tsx): Quick verwaltet nur Komponenten/Preise — der Block
// rendert im Quick-Modus nichts (null), in 2D/3D die Quellen-Kurzliste.
// Wiring-Hinweis: mit dem gespeicherten Snapshot-Modus rendern, z. B.
// `<PlanningSourcesOfferBlock planningMode={snapshot.planningMode}
// sources={sources} />`. Absichtlich presentational (kein "use client"),
// damit Server- und Client-Wiring denselben Baustein nutzen.
export type PlanningSourcesOfferEntry = {
  id: string;
  kind: string;
  filename: string | null;
};

// Serverseitig geladene Planungsdaten für die Angebotsseite (Threading:
// page → OfferDetailView → OfferVariantEditor, Modus kommt aus dem Draft).
export type OfferPlanningData = {
  workspaceId: string;
  projectId: string;
  sources: readonly PlanningSourcesOfferEntry[];
  sourceId: string | null;
  initialRoof: import("../../anfragen/[projectId]/planning-roof-model").PlanningRoofDto | null;
  canWrite: boolean;
  solarLatitude: number | null;
  solarLongitude: number | null;
};

function kindLabel(kind: string): string {
  if (kind === "upload") return "Upload";
  if (kind === "self_drawn") return "Selbstzeichnung";
  return kind;
}

export function PlanningSourcesOfferBlock({
  planningMode,
  sources,
}: {
  planningMode: "quick" | "2d" | "3d";
  sources: readonly PlanningSourcesOfferEntry[];
}) {
  if (planningMode === "quick") return null;
  return (
    <section
      data-testid="planning-sources-offer-block"
      aria-label="Dachquellen-Planungsblock"
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-slate-900">Dachquellen</h2>
      {sources.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">Noch keine Dachquelle hinterlegt.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm text-slate-700">
          {sources.map((source) => (
            <li key={source.id}>
              <span className="font-semibold">{kindLabel(source.kind)}</span>
              {source.filename ? <span className="ml-2 text-slate-600">{source.filename}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
