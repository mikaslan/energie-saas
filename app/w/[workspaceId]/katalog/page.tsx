import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { SignOutButton } from "@/app/_components/sign-out-button";
import { DeniedState, Section } from "../_ui";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { can, PermissionDeniedError } from "@/lib/permissions";
import {
  listCatalogComponents,
  type CatalogComponentReadModel,
  type CatalogListFilters,
} from "@/modules/catalog";
import { ProductForm } from "./product-form";

export const metadata: Metadata = { title: "Produktkatalog | Energie-SaaS" };

const routeParamsSchema = z.object({ workspaceId: z.uuid() });
const filterSchema = z.strictObject({
  status: z.enum(["draft", "active", "archived"]).optional(),
  componentType: z.enum([
    "module", "inverter", "battery", "wallbox", "heat_pump", "mounting", "other",
  ]).optional(),
  query: z.string().max(120).optional(),
});

const typeLabels: Record<string, string> = {
  module: "PV-Modul",
  inverter: "Wechselrichter",
  battery: "Speicher",
  wallbox: "Wallbox",
  heat_pump: "Wärmepumpe",
  mounting: "Montagesystem",
  other: "Sonstiges",
};
const statusLabels = { draft: "Entwurf", active: "Aktiv", archived: "Archiviert" } as const;

type CatalogLoad =
  | {
      kind: "loaded";
      components: CatalogComponentReadModel[];
      canManage: boolean;
      canReadPurchasePrice: boolean;
    }
  | { kind: "unauthenticated" }
  | { kind: "denied" };

async function loadCatalog(workspaceId: string, filters: CatalogListFilters): Promise<CatalogLoad> {
  try {
    return await authorizedQuery(
      workspaceId,
      "catalog.read",
      "catalog_component",
      async (tx, ctx) => ({
        kind: "loaded" as const,
        components: await listCatalogComponents(tx, ctx, filters),
        canManage: can(ctx, "catalog.manage"),
        canReadPurchasePrice: can(ctx, "price.read_purchase"),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function formatCents(value: number | undefined): string {
  if (value === undefined) return "Ausgeblendet";
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
  }).format(value / 100);
}

function technicalSummary(component: CatalogComponentReadModel): string {
  const data = component.current.technicalData;
  if (data.schemaVersion === "module.v1") return `${data.nominalPowerWatts.toLocaleString("de-DE")} W`;
  if (data.schemaVersion === "inverter.v1") return `${data.nominalAcPowerWatts.toLocaleString("de-DE")} W AC`;
  if (data.schemaVersion === "battery.v1") return `${data.usableCapacityWh.toLocaleString("de-DE")} Wh nutzbar`;
  if (data.schemaVersion === "wallbox.v1") return `${data.maxChargingPowerWatts.toLocaleString("de-DE")} W`;
  if (data.schemaVersion === "heat_pump.v1") return `${data.nominalHeatingPowerWatts.toLocaleString("de-DE")} W Heizleistung`;
  if (data.schemaVersion === "mounting.v1") return data.systemName;
  return `${data.attributes.length} Attribute`;
}

export default async function CatalogPage({
  params,
  searchParams,
}: PageProps<"/w/[workspaceId]/katalog">) {
  const parsedParams = routeParamsSchema.safeParse(await params);
  if (!parsedParams.success) notFound();
  const rawSearch = await searchParams;
  const parsedFilters = filterSchema.safeParse({
    status: firstQueryValue(rawSearch.status) || undefined,
    componentType: firstQueryValue(rawSearch.type) || undefined,
    query: firstQueryValue(rawSearch.q)?.trim() || undefined,
  });
  const filters = parsedFilters.success ? parsedFilters.data : {};
  const { workspaceId } = parsedParams.data;
  const catalogPath = `/w/${workspaceId}/katalog`;
  const result = await loadCatalog(workspaceId, filters);
  if (result.kind === "unauthenticated") {
    redirect(`/login?next=${encodeURIComponent(catalogPath)}`);
  }
  if (result.kind === "denied") {
    return <DeniedState title="Der Produktkatalog ist für dich nicht freigegeben." />;
  }

  const filtered = Boolean(filters.status || filters.componentType || filters.query);
  const listState = result.components.length === 0
    ? filtered ? "empty_filtered" : "empty"
    : result.components.length === 200 ? "capped" : result.canManage ? "loaded" : "read_only";

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <nav aria-label="Bereichsnavigation" className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <Link href={`/w/${workspaceId}/anfragen`} className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
            <span aria-hidden="true" className="mr-2">←</span>
            Zu den Anfragen
          </Link>
          <SignOutButton />
        </nav>

        <header className="mb-8 border-b border-slate-200 pb-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-blue-700">Eigener Workspace-Bestand</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">Produktkatalog</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                Eigene Produkte werden revisionsgebunden geführt. Nur aktive,
                vollständig bepreiste Produkte sind in Projekten auswählbar.
              </p>
            </div>
            {!result.canManage ? <span className="rounded-full bg-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700">Nur Lesezugriff</span> : null}
          </div>
        </header>

        <div className="grid gap-6">
          <Section title="Katalog filtern" intro="Filter bleiben in der URL erhalten und können geteilt werden.">
            <form method="get" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_2fr_auto]">
              <label className="grid gap-1.5 text-sm font-medium text-slate-800">
                Status
                <select name="status" defaultValue={filters.status ?? ""} className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200">
                  <option value="">Alle sichtbaren</option>
                  {result.canManage ? <option value="draft">Entwurf</option> : null}
                  <option value="active">Aktiv</option>
                  <option value="archived">Archiviert</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-slate-800">
                Typ
                <select name="type" defaultValue={filters.componentType ?? ""} className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200">
                  <option value="">Alle Typen</option>
                  {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium text-slate-800">
                SKU oder Name
                <input name="q" maxLength={120} defaultValue={filters.query ?? ""} className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200" />
              </label>
              <button type="submit" className="min-h-11 self-end rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Anwenden</button>
            </form>
          </Section>

          <section data-catalog-list-state={listState} aria-labelledby="catalog-list-title" className="grid gap-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="catalog-list-title" className="text-lg font-semibold text-slate-950">Produkte</h2>
                <p className="mt-1 text-sm text-slate-600">{result.components.length} sichtbare {result.components.length === 1 ? "Position" : "Positionen"}</p>
              </div>
              {filtered ? <Link href={catalogPath} className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 hover:text-blue-900">Filter zurücksetzen</Link> : null}
            </div>

            {result.components.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
                <h3 className="text-base font-semibold text-slate-950">{filtered ? "Keine passenden Produkte" : "Der Katalog ist noch leer"}</h3>
                <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">
                  {filtered
                    ? "Ändere oder entferne die Filter. Es wurden keine Produktdaten verändert."
                    : result.canManage
                      ? "Lege unten den ersten eigenen, belegbaren Produktentwurf an. Es werden keine Fremdprodukte erfunden oder übernommen."
                      : "Eine Katalogverwaltung muss zuerst eigene Produkte anlegen und freigeben."}
                </p>
              </div>
            ) : (
              <ul className="grid gap-4 md:grid-cols-2">
                {result.components.map((component) => {
                  const commercial = component.current.commercial;
                  const purchase = commercial && "purchasePriceNetCents" in commercial
                    ? commercial.purchasePriceNetCents
                    : undefined;
                  return (
                    <li key={component.id} className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-mono text-xs font-semibold text-blue-700">{component.current.identity.internalSku}</p>
                          <h3 className="mt-1 truncate text-base font-semibold text-slate-950">{component.current.presentation.displayName}</h3>
                          <p className="mt-1 text-sm text-slate-600">{component.current.presentation.manufacturer} · {component.current.presentation.model}</p>
                        </div>
                        <span className={component.status === "active" ? "rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800" : component.status === "draft" ? "rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800" : "rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600"}>{statusLabels[component.status]}</span>
                      </div>
                      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                        <div><dt className="text-slate-500">Typ</dt><dd className="mt-0.5 font-medium text-slate-900">{typeLabels[component.current.identity.componentType]}</dd></div>
                        <div><dt className="text-slate-500">Revision</dt><dd className="mt-0.5 font-medium tabular-nums text-slate-900">{component.currentRevision}</dd></div>
                        <div><dt className="text-slate-500">Technik</dt><dd className="mt-0.5 font-medium tabular-nums text-slate-900">{technicalSummary(component)}</dd></div>
                        <div><dt className="text-slate-500">VK netto</dt><dd className="mt-0.5 font-medium tabular-nums text-slate-900">{commercial ? formatCents(commercial.salesPriceNetCents) : "Noch offen"}</dd></div>
                        {result.canReadPurchasePrice ? <div><dt className="text-slate-500">EK netto</dt><dd className="mt-0.5 font-medium tabular-nums text-slate-900">{commercial ? formatCents(purchase) : "Noch offen"}</dd></div> : null}
                      </dl>
                      <Link href={`${catalogPath}/${component.id}`} className="mt-5 inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Produkt öffnen <span aria-hidden="true" className="ml-2">→</span></Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {result.components.length === 200 ? <p role="note" className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950">Es werden höchstens 200 Produkte angezeigt. Grenze die Filter für weitere Treffer ein.</p> : null}
          </section>

          {result.canManage ? (
            <details className="rounded-lg border border-slate-200 bg-white shadow-sm">
              <summary className="min-h-11 cursor-pointer px-5 py-4 text-sm font-semibold text-slate-950 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600 sm:px-6">Neuen Produktentwurf anlegen</summary>
              <div className="border-t border-slate-200 p-5 sm:p-6"><ProductForm workspaceId={workspaceId} /></div>
            </details>
          ) : null}
        </div>
      </div>
    </main>
  );
}
