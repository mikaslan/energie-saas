// F2-07b D4-01 Candidate-Historie + D4-03 Withdraw-Historie + D4-04
// Candidate-Prüfpunkte — rein lesende Server Component (project.read).
// Keine Inputs/Forms, nur Revisionsbindungen (keine Snapshots/Inhalte).
import { authorizedQuery } from "@/lib/action";
import {
  listCandidateApprovalHistory,
  listPruefpunkteProtokoll,
  listWithdrawalHistory,
  type CandidateApprovalHistoryEntry,
  type Pruefpunkt,
  type WithdrawalHistoryEntry,
} from "@/modules/offers";

function formatInstant(value: string): string {
  return new Date(value).toLocaleString("de-DE", { timeZone: "Europe/Berlin" });
}

function PruefpunkteList({ points }: { points: readonly Pruefpunkt[] }) {
  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
        Bestätigte Prüfpunkte
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
        {points.map((point) => (
          <li key={point.key}>
            {point.label} {point.checked ? "(bestätigt)" : "(offen)"}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CandidateItem({
  entry,
  points,
}: {
  entry: CandidateApprovalHistoryEntry;
  points: readonly Pruefpunkt[] | null;
}) {
  return (
    <>
      <p className="font-medium text-slate-900">{entry.candidateReference}</p>
      <p className="mt-1 text-sm text-slate-600">
        Variante Rev. {entry.variantRevision} · Profil Rev. {entry.profileRevision}
        {" · "}Empfänger Rev. {entry.recipientRevision}
      </p>
      <p className="mt-1 text-sm text-slate-600">
        Freigegeben: <time dateTime={entry.approvedAt}>{formatInstant(entry.approvedAt)}</time>
      </p>
      {points !== null ? <PruefpunkteList points={points} /> : null}
    </>
  );
}

export async function OfferCandidateHistoryPanel(props: {
  workspaceId: string;
  offerId: string;
}) {
  let data: {
    candidates: CandidateApprovalHistoryEntry[];
    candidatePoints: { points: Pruefpunkt[] }[];
    withdrawals: WithdrawalHistoryEntry[];
  };
  try {
    data = await authorizedQuery(
      props.workspaceId,
      "project.read",
      "offer_release_views",
      async (tx, ctx) => {
        const key = { workspaceId: props.workspaceId, offerId: props.offerId };
        const candidates = await listCandidateApprovalHistory(tx, ctx, key);
        // Gleiche Tabelle, gleiche Sortierung wie die Historie →
        // positionsgleiche Zuordnung je gespeicherter Freigabe.
        const candidatePoints = (await listPruefpunkteProtokoll(tx, ctx, key))
          .filter((entry) => entry.scope === "candidate");
        const withdrawals = await listWithdrawalHistory(tx, ctx, key);
        return { candidates, candidatePoints, withdrawals };
      },
    );
  } catch {
    // Kein Leserecht (u. a. external_only) oder Offer fehlt → Sektionen
    // ausblenden statt Fehler oder leere Hüllen zu zeigen.
    return null;
  }
  const renderedAt = new Date().toISOString();
  return (
    <>
      <section
        id="offer-candidate-history"
        aria-labelledby="offer-candidate-history-heading"
        className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">
          Freigaben
        </p>
        <h2
          id="offer-candidate-history-heading"
          className="mt-1 text-lg font-semibold text-slate-950"
        >
          Freigabehistorie der Kandidaten
        </h2>
        {data.candidates.length === 0 ? (
          <ul className="mt-4 grid gap-3">
            <li className="rounded-lg border border-slate-200 p-4">
              <p className="text-sm text-slate-600">Noch keine Freigaben protokolliert.</p>
              <p className="mt-1 text-xs text-slate-500">
                Stand: <time dateTime={renderedAt}>{formatInstant(renderedAt)}</time>
              </p>
            </li>
          </ul>
        ) : (
          <ul className="mt-4 grid gap-3">
            {data.candidates.map((entry, index) => (
              <li
                key={`${entry.candidateId}-${entry.approvedAt}`}
                className="rounded-lg border border-slate-200 p-4"
              >
                <CandidateItem
                  entry={entry}
                  points={data.candidatePoints[index]?.points ?? null}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section
        id="offer-withdraw-history"
        aria-labelledby="offer-withdraw-history-heading"
        className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">
          Freigaben
        </p>
        <h2
          id="offer-withdraw-history-heading"
          className="mt-1 text-lg font-semibold text-slate-950"
        >
          Rücknahmen
        </h2>
        {data.withdrawals.length === 0 ? (
          <ul className="mt-4 grid gap-3">
            <li className="rounded-lg border border-slate-200 p-4">
              <p className="text-sm text-slate-600">Noch keine Rücknahmen.</p>
              <p className="mt-1 text-xs text-slate-500">
                Stand: <time dateTime={renderedAt}>{formatInstant(renderedAt)}</time>
              </p>
            </li>
          </ul>
        ) : (
          <ul className="mt-4 grid gap-3">
            {data.withdrawals.map((entry, index) => (
              <li
                key={`${entry.issuanceId}-${entry.withdrawnAt}-${index}`}
                className="rounded-lg border border-slate-200 p-4"
              >
                <p className="font-medium text-slate-900">
                  {entry.issuanceReference} · {entry.reasonLabel}
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  Zurückgenommen:{" "}
                  <time dateTime={entry.withdrawnAt}>
                    {formatInstant(entry.withdrawnAt)}
                  </time>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
