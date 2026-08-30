import Link from "next/link";
import offerThemeStyles from "./offer-theme.module.css";

export type OfferListState = "loaded" | "empty" | "blocked" | "read_only";

export interface OfferListBlockerView {
  code: string;
  label: string;
}

export interface OfferListCardView {
  id: string;
  href: string;
  offerNumber: string;
  customerDisplayName: string;
  installationSiteLabel: string;
  variantCount: number;
  updatedAtLabel: string;
  outdated: boolean;
}

export interface OfferListColumnView {
  id: string;
  title: string;
  offers: readonly OfferListCardView[];
}

export interface OfferListSurfaceView {
  state: OfferListState;
  workspaceId: string;
  permissions: {
    canCreate: boolean;
  };
  blockers: readonly OfferListBlockerView[];
  columns: readonly OfferListColumnView[];
}

function OfferListHeader({
  workspaceId,
  canCreate,
}: {
  workspaceId: string;
  canCreate: boolean;
}) {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex w-full max-w-[1480px] flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-9 place-items-center rounded-md bg-blue-700 text-sm font-bold text-white"
          >
            W
          </span>
          <div>
            <p className="text-sm font-semibold leading-5 text-slate-950">WMEE Vertrieb</p>
            <p className="text-xs text-slate-500">Angebote</p>
          </div>
        </div>
        <nav aria-label="Bereichsnavigation" className="flex flex-wrap items-center gap-2">
          <Link
            href={`/w/${workspaceId}/anfragen`}
            className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Anfragen
          </Link>
          <Link
            href={`/w/${workspaceId}/katalog`}
            className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Produktkatalog
          </Link>
          {canCreate ? (
            <Link
              href={`/w/${workspaceId}/anfragen`}
              className="inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Angebot erstellen
            </Link>
          ) : null}
        </nav>
      </div>
    </header>
  );
}

function EmptyOfferList({ workspaceId }: { workspaceId: string }) {
  return (
    <section className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-14 text-center shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
        Angebotsphase
      </p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
        Noch keine Angebote
      </h2>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-slate-600">
        Ein Angebotsentwurf entsteht aus einer qualifizierten Anfrage. Preise und
        Produktstände werden dabei serverseitig aus der aktuellen Projektauflösung übernommen.
      </p>
      <Link
        href={`/w/${workspaceId}/anfragen`}
        className="mt-6 inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
      >
        Anfragen öffnen
      </Link>
    </section>
  );
}

function BlockedOfferList({ blockers }: { blockers: readonly OfferListBlockerView[] }) {
  return (
    <section
      role="alert"
      className="rounded-lg border border-amber-300 bg-amber-50 p-6 text-slate-950 shadow-sm sm:p-8"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-800">
        Konfiguration unvollständig
      </p>
      <h2 className="mt-2 text-xl font-semibold">Angebote können noch nicht geladen werden.</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">
        Der Workspace benötigt eine eindeutige aktive Angebotsspalte. Es wurden keine
        Angebotsdaten verändert.
      </p>
      <ul className="mt-5 grid list-none gap-2" aria-label="Offene Konfiguration">
        {blockers.map((blocker) => (
          <li
            key={blocker.code}
            className="rounded-md border border-amber-200 bg-white px-4 py-3 text-sm font-semibold text-amber-950"
          >
            {blocker.label}
          </li>
        ))}
      </ul>
    </section>
  );
}

function OfferColumn({ column }: { column: OfferListColumnView }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 shadow-sm">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-950">{column.title}</h2>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold tabular-nums text-slate-600">
          {column.offers.length}
        </span>
      </header>
      <ul className="grid list-none gap-3 p-3" aria-label={`Angebote in ${column.title}`}>
        {column.offers.length === 0 ? (
          <li className="rounded-md border border-dashed border-slate-300 bg-white/70 px-4 py-8 text-center text-sm text-slate-500">
            Keine Angebote in diesem Status
          </li>
        ) : null}
        {column.offers.map((offer) => (
          <li key={offer.id}>
            <article className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-blue-700">
                    {offer.offerNumber}
                  </p>
                  <h3 className="mt-1 break-words text-base font-semibold text-slate-950">
                    {offer.customerDisplayName}
                  </h3>
                </div>
                {offer.outdated ? (
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900">
                    Veraltet
                  </span>
                ) : null}
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-700">
                <span aria-hidden="true" className="mr-1.5">⌖</span>
                {offer.installationSiteLabel}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
                <div className="text-xs text-slate-500">
                  <p className="font-semibold text-slate-700">
                    {offer.variantCount} {offer.variantCount === 1 ? "Variante" : "Varianten"}
                  </p>
                  <p className="mt-0.5">Aktualisiert {offer.updatedAtLabel}</p>
                </div>
                <Link
                  href={offer.href}
                  className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold text-blue-700 outline-none hover:bg-blue-50 hover:text-blue-900 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                >
                  Öffnen
                </Link>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function OfferListView({ view }: { view: OfferListSurfaceView }) {
  const canCreate = view.state !== "read_only" && view.permissions.canCreate;

  return (
    <main
      data-offer-list-state={view.state}
      data-wmee-scope="offer"
      className={`${offerThemeStyles.offerTheme} min-h-screen bg-slate-100 text-slate-950`}
    >
      <a href="#offer-list-main" className="sr-only rounded bg-white px-3 py-2 font-semibold focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:ring-2 focus:ring-emerald-700">
        Zur Angebotsliste springen
      </a>
      <OfferListHeader workspaceId={view.workspaceId} canCreate={canCreate} />
      <div id="offer-list-main" className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
              Vertrieb
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Angebote</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Gespeicherte Angebotsstände prüfen und Varianten unabhängig weiterentwickeln.
            </p>
          </div>
          {view.state === "read_only" ? (
            <span className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600">
              Nur Lesezugriff
            </span>
          ) : null}
        </div>

        {view.state === "blocked" ? <BlockedOfferList blockers={view.blockers} /> : null}
        {view.state === "empty" ? <EmptyOfferList workspaceId={view.workspaceId} /> : null}
        {view.state === "loaded" || view.state === "read_only" ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 md:items-start">
            {view.columns.map((column) => <OfferColumn key={column.id} column={column} />)}
          </div>
        ) : null}
      </div>
    </main>
  );
}
