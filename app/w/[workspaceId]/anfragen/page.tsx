import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { SignOutButton } from "@/app/_components/sign-out-button";
import {
  getDefaultRequestBoard,
  type RequestBoardCard,
  type RequestBoardColumn,
} from "@/modules/boards";
import {
  RequestBoardCard as RequestBoardCardClient,
  RequestBoardClient,
  RequestBoardColumn as RequestBoardColumnClient,
} from "./board-client";

const workspaceIdSchema = z.uuid();

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Berlin",
});

const numberFormatter = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 1,
});

function productLabels(card: RequestBoardCard): string[] {
  const labels: string[] = [];
  if (card.requestedProducts.photovoltaics) labels.push("Photovoltaik");
  if (card.requestedProducts.targetStorageKwh !== null) {
    labels.push(`Speicher ${numberFormatter.format(card.requestedProducts.targetStorageKwh)} kWh`);
  }
  if (card.requestedProducts.wallbox) labels.push("Wallbox");
  if (card.requestedProducts.bidirectionalCharging) labels.push("Bidirektionales Laden");
  if (card.requestedProducts.backupPower) labels.push("Ersatzstrom");
  return labels;
}

function blockerLabels(card: RequestBoardCard): string[] {
  const labels: string[] = [];
  if (card.blockers.dedupeReviewRequired) labels.push("Kontakt prüfen");
  if (card.blockers.addressFollowUpRequired) labels.push("Adresse nachfassen");
  if (card.blockers.pinConfirmationRequired) labels.push("Pin offen");
  if (card.blockers.catalogResolutionPending) labels.push("Produkte offen");
  return labels;
}

function columnTone(column: RequestBoardColumn): string {
  if (column.color === "blue") return "bg-blue-600";
  if (column.color === "amber") return "bg-amber-500";
  if (column.color === "green") return "bg-emerald-600";
  return "bg-slate-400";
}

function AccessDenied() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-6 py-16">
      <section className="w-full rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">WMEE Vertrieb</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">Kein Zugriff</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Für diesen Arbeitsbereich liegt keine passende Mitgliedschaft vor.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          Zur Startseite
        </Link>
      </section>
    </main>
  );
}

export default async function RequestsPage({
  params,
}: PageProps<"/w/[workspaceId]/anfragen">) {
  const { workspaceId } = await params;
  const parsedWorkspaceId = workspaceIdSchema.safeParse(workspaceId);
  if (!parsedWorkspaceId.success) notFound();
  const validWorkspaceId = parsedWorkspaceId.data;

  let board: Awaited<ReturnType<typeof getDefaultRequestBoard>> | undefined;
  let unauthenticated = false;
  let denied = false;
  try {
    board = await authorizedQuery(
      validWorkspaceId,
      "project.read",
      "kanban_board",
      (tx, ctx) => getDefaultRequestBoard(tx, ctx),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) unauthenticated = true;
    else if (error instanceof PermissionDeniedError) denied = true;
    else throw error;
  }

  if (unauthenticated) {
    const nextPath = `/w/${validWorkspaceId}/anfragen`;
    redirect(`/login?${new URLSearchParams({ next: nextPath }).toString()}`);
  }
  if (denied) return <AccessDenied />;
  if (!board) throw new Error("Anfrage-Board konnte nicht geladen werden");

  const columns = board.columns.map(({ id, name }) => ({ id, name }));
  const cards = board.columns.flatMap((column) =>
    column.cards.map((card) => ({ id: card.id, label: card.contactName })),
  );
  const totalCards = cards.length;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-[1480px] flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid size-9 place-items-center rounded-md bg-blue-700 text-sm font-bold text-white" aria-hidden="true">
              W
            </span>
            <div>
              <p className="text-sm font-semibold leading-5">WMEE Vertrieb</p>
              <p className="text-xs text-slate-500">Geschützter Arbeitsbereich</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {!board.permissions.canMoveCards ? (
              <span className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600">
                Nur Lesezugriff
              </span>
            ) : null}
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">Rechner-Leads</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">{board.name}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Neue Solarrechner-Anfragen prüfen, qualifizieren und in die nächste Vertriebsstufe bewegen.
            </p>
          </div>
          <div className="rounded-md border border-slate-200 bg-white px-4 py-3 text-right shadow-sm">
            <p className="text-2xl font-semibold tabular-nums">{totalCards}</p>
            <p className="text-xs text-slate-500">offene {totalCards === 1 ? "Anfrage" : "Anfragen"}</p>
          </div>
        </div>

        <RequestBoardClient
          workspaceId={validWorkspaceId}
          boardId={board.id}
          columns={columns}
          cards={cards}
          canMove={board.permissions.canMoveCards}
        >
          <div className="grid gap-4 md:grid-cols-3 md:items-start">
            {board.columns.map((column) => (
              <RequestBoardColumnClient key={column.id} columnId={column.id}>
                <header className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-t-lg border-b border-slate-200 bg-slate-50/95 px-4 py-3 backdrop-blur">
                  <div className="flex items-center gap-2">
                    <span className={`size-2.5 rounded-full ${columnTone(column)}`} aria-hidden="true" />
                    <h2 className="text-sm font-semibold">{column.name}</h2>
                  </div>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-600 ring-1 ring-slate-200">
                    {column.cards.length}
                  </span>
                </header>
                <ul className="grid list-none gap-3 p-3" aria-label={`Anfragen in ${column.name}`}>
                  {column.cards.length === 0 ? (
                    <li className="rounded-md border border-dashed border-slate-300 bg-white/60 px-4 py-8 text-center text-sm text-slate-500">
                      Keine Anfragen in diesem Status
                    </li>
                  ) : null}
                  {column.cards.map((card) => {
                    const products = productLabels(card);
                    const blockers = blockerLabels(card);
                    return (
                      <li key={card.id}>
                        <RequestBoardCardClient
                          projectId={card.id}
                          currentColumnId={column.id}
                          projectLabel={card.contactName}
                        >
                          <div className="pr-8">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-700">
                              {card.sourceLabel}
                            </p>
                            <h3 className="mt-1 text-base font-semibold leading-6 text-slate-950">
                              {card.contactName}
                            </h3>
                            <p className="mt-0.5 truncate text-xs text-slate-500">{card.name}</p>
                          </div>
                          <p className="mt-3 flex items-center gap-1.5 text-sm text-slate-700">
                            <span aria-hidden="true">⌖</span>
                            {card.locationLabel}
                          </p>
                          {products.length > 0 ? (
                            <ul className="mt-3 flex list-none flex-wrap gap-1.5" aria-label="Angefragte Produkte">
                              {products.map((label) => (
                                <li key={label} className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700">
                                  {label}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {blockers.length > 0 ? (
                            <ul className="mt-3 grid list-none gap-1.5" aria-label="Offene Prüfungen">
                              {blockers.map((label) => (
                                <li key={label} className="flex items-center gap-1.5 text-xs font-medium text-amber-800">
                                  <span aria-hidden="true">△</span>{label}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
                            <time dateTime={card.createdAt} className="text-[11px] tabular-nums text-slate-500">
                              {dateFormatter.format(new Date(card.createdAt))}
                            </time>
                            <Link
                              href={`/w/${validWorkspaceId}/anfragen/${card.id}`}
                              className="rounded text-xs font-semibold text-blue-700 outline-none hover:text-blue-900 hover:underline focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                            >
                              Projekt öffnen
                            </Link>
                          </div>
                        </RequestBoardCardClient>
                      </li>
                    );
                  })}
                </ul>
              </RequestBoardColumnClient>
            ))}
          </div>
        </RequestBoardClient>
      </div>
    </main>
  );
}
