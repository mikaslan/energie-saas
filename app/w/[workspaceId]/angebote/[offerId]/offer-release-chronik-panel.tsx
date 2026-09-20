// F2-07b D4-07 Freigabe-Chronik — rein lesende Server Component (project.read).
// Spec: docs/spec/F2-07b-freigabe-ansichten.md. Keine Inputs/Forms, PII-frei.
import { authorizedQuery } from "@/lib/action";
import {
  listReleaseChronik,
  type ReleaseChronikEntry,
} from "@/modules/offers";

const CHRONIK_EVENT_LABELS: Record<string, string> = {
  "offer.release_candidate_requested": "Freigabekandidat angefordert",
  "offer.release_candidate_approved_not_issued":
    "Freigabekandidat freigegeben (nicht ausgestellt)",
  "offer.issuance_requested": "Ausstellungsfassung angefordert",
  "offer.issuance_first_approval_recorded":
    "Erste Freigabe der Ausstellungsfassung protokolliert",
  "offer.issuance_approved_for_archive_not_issued":
    "Ausstellungsfassung für das Archiv freigegeben (nicht ausgestellt)",
  "offer.issuance_withdrawn_before_archive":
    "Ausstellungsfassung vor Archivierung zurückgenommen",
};

function formatInstant(value: string): string {
  return new Date(value).toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
}

function ChronikItem({ entry }: { entry: ReleaseChronikEntry }) {
  const refs = [entry.candidateReference, entry.issuanceReference]
    .filter((ref): ref is string => ref !== null);
  return (
    <>
      <p className="font-medium text-slate-900">
        {CHRONIK_EVENT_LABELS[entry.eventType] ?? entry.eventType}
      </p>
      <p className="mt-1 text-sm text-slate-600">
        <time dateTime={entry.occurredAt}>{formatInstant(entry.occurredAt)}</time>
        {refs.length > 0 ? ` · ${refs.join(" · ")}` : ""}
      </p>
    </>
  );
}

export async function OfferReleaseChronikPanel(props: {
  workspaceId: string;
  offerId: string;
}) {
  let entries: ReleaseChronikEntry[];
  try {
    entries = await authorizedQuery(
      props.workspaceId,
      "project.read",
      "offer_release_views",
      (tx, ctx) => listReleaseChronik(tx, ctx, {
        workspaceId: props.workspaceId,
        offerId: props.offerId,
      }),
    );
  } catch {
    // Kein Leserecht (u. a. external_only) oder Offer fehlt → Sektion
    // ausblenden statt Fehler oder leere Hülle zu zeigen.
    return null;
  }
  const renderedAt = new Date().toISOString();
  return (
    <section
      id="offer-release-chronik"
      aria-labelledby="offer-release-chronik-heading"
      className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">
        Freigaben
      </p>
      <h2
        id="offer-release-chronik-heading"
        className="mt-1 text-lg font-semibold text-slate-950"
      >
        Freigabe-Chronik
      </h2>
      {entries.length === 0 ? (
        <ul className="mt-4 grid gap-3">
          <li className="rounded-lg border border-slate-200 p-4">
            <p className="text-sm text-slate-600">Noch keine Freigaben protokolliert.</p>
            <p className="mt-1 text-xs text-slate-500">
              Stand: <time dateTime={renderedAt}>{formatInstant(renderedAt)}</time>
            </p>
          </li>
        </ul>
      ) : (
        <ol className="mt-4 grid gap-3">
          {entries.map((entry, index) => (
            <li
              key={`${entry.eventType}-${entry.occurredAt}-${index}`}
              className="rounded-lg border border-slate-200 p-4"
            >
              <ChronikItem entry={entry} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
