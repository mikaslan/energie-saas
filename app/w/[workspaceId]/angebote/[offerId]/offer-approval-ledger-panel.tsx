// F2-07b D4-02 4-Augen-Ledger + D4-04 Issuance-Prüfpunkte — rein lesende
// Server Component (project.read). Keine Inputs/Forms, Ordinale statt Identität.
import { authorizedQuery } from "@/lib/action";
import {
  listApprovalLedger,
  listPruefpunkteProtokoll,
  type ApprovalLedgerEntry,
  type Pruefpunkt,
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

function LedgerItem({
  entry,
  points,
}: {
  entry: ApprovalLedgerEntry;
  points: readonly Pruefpunkt[] | null;
}) {
  return (
    <>
      <p className="font-medium text-slate-900">
        {entry.ordinalLabel} ({entry.ordinal} von {entry.total}) · {entry.issuanceReference}
      </p>
      <p className="mt-1 text-sm text-slate-600">
        <time dateTime={entry.approvedAt}>{formatInstant(entry.approvedAt)}</time>
        {" · "}Freigabestand {entry.approvalVersion}
      </p>
      {points !== null ? <PruefpunkteList points={points} /> : null}
    </>
  );
}

export async function OfferApprovalLedgerPanel(props: {
  workspaceId: string;
  offerId: string;
}) {
  let data: { entries: ApprovalLedgerEntry[]; issuancePoints: { points: Pruefpunkt[] }[] };
  try {
    data = await authorizedQuery(
      props.workspaceId,
      "project.read",
      "offer_release_views",
      async (tx, ctx) => {
        const key = { workspaceId: props.workspaceId, offerId: props.offerId };
        const entries = await listApprovalLedger(tx, ctx, key);
        // Gleiche Tabelle, gleiche Sortierung wie der Ledger → positionsgleiche
        // Zuordnung je gespeicherter Freigabe.
        const issuancePoints = (await listPruefpunkteProtokoll(tx, ctx, key))
          .filter((entry) => entry.scope === "issuance");
        return { entries, issuancePoints };
      },
    );
  } catch {
    // Kein Leserecht (u. a. external_only) oder Offer fehlt → Sektion
    // ausblenden statt Fehler oder leere Hülle zu zeigen.
    return null;
  }
  const renderedAt = new Date().toISOString();
  return (
    <section
      id="offer-approval-ledger"
      aria-labelledby="offer-approval-ledger-heading"
      className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">
        Freigaben
      </p>
      <h2
        id="offer-approval-ledger-heading"
        className="mt-1 text-lg font-semibold text-slate-950"
      >
        4-Augen-Ledger
      </h2>
      {data.entries.length === 0 ? (
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
          {data.entries.map((entry, index) => (
            <li
              key={`${entry.issuanceId}-${entry.ordinal}`}
              className="rounded-lg border border-slate-200 p-4"
            >
              <LedgerItem
                entry={entry}
                points={data.issuancePoints[index]?.points ?? null}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
