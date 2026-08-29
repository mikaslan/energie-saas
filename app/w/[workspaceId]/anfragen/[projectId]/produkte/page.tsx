import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { SignOutButton } from "@/app/_components/sign-out-button";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  getProjectCatalogResolutionContext,
  type ProjectCatalogResolutionContext,
} from "@/modules/catalog";
import { DeniedState, DetailItem, Section, YesNo } from "../_ui";
import {
  ResolutionForm,
  type ResolutionSelectableComponent,
} from "./resolution-form";

export const metadata: Metadata = { title: "Produkte zuordnen | Energie-SaaS" };

const routeParamsSchema = z.object({ workspaceId: z.uuid(), projectId: z.uuid() });
const staleLabels: Record<ProjectCatalogResolutionContext["staleReasons"][number], string> = {
  project_status_pending: "Das Projekt wurde nach der Bestätigung wieder als offen markiert.",
  requirement_changed: "Der aktuelle Bedarf gehört zu einer neueren Revision.",
  calculation_changed: "Die Planungsrechnung wurde erneuert oder ist nicht mehr aktuell.",
  catalog_component_changed: "Mindestens ein Produkt wurde revidiert oder archiviert.",
};
const warningLabels: Record<string, string> = {
  calculation_not_sku_specific: "Die Planungsrechnung ist generisch und nicht SKU-spezifisch.",
  pv_capacity_differs: "Die bestätigte PV-Modulleistung weicht vom Ziel ab.",
  storage_capacity_differs: "Die bestätigte Speicherkapazität weicht vom Ziel ab.",
  backup_compatibility_unverified: "Ersatzstrom-Kompatibilität wurde noch nicht technisch verifiziert.",
  bidirectional_compatibility_unverified: "Bidirektionale Kompatibilität wurde noch nicht technisch verifiziert.",
  cross_component_compatibility_unverified: "Komponenten-Kompatibilität wurde noch nicht technisch verifiziert.",
};
const blockerLabels: Record<NonNullable<ProjectCatalogResolutionContext["blocker"]>, string> = {
  missing_requirement: "Für das Projekt fehlt ein revisionsgebundener Bedarf.",
  missing_calculation: "Für den aktuellen Bedarf fehlt eine Planungsrechnung.",
  calculation_not_current: "Die Planungsrechnung ist nicht mehr an den aktuellen Projektstand gebunden.",
  calculation_invalid: "Die Planungsrechnung ist nicht konsistent genug für eine Produktauflösung.",
};

type LoadResult =
  | { kind: "loaded"; context: ProjectCatalogResolutionContext | null }
  | { kind: "unauthenticated" }
  | { kind: "denied" };

async function loadContext(workspaceId: string, projectId: string): Promise<LoadResult> {
  try {
    const context = await authorizedQuery(
      workspaceId,
      "project.read",
      "project_catalog_resolution",
      (tx, ctx) => getProjectCatalogResolutionContext(tx, ctx, projectId),
    );
    return { kind: "loaded", context };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

function formatCents(value: number): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(value / 100);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(new Date(value));
}

function selectableComponents(context: ProjectCatalogResolutionContext): ResolutionSelectableComponent[] {
  return context.activeComponents.map((component) => {
    const commercial = component.current.commercial;
    if (!commercial) throw new Error("active catalog component has no commercial snapshot");
    const purchase = "purchasePriceNetCents" in commercial
      ? commercial.purchasePriceNetCents
      : undefined;
    return {
      id: component.id,
      revision: component.currentRevision,
      sku: component.current.identity.internalSku,
      name: component.current.presentation.displayName,
      manufacturer: component.current.presentation.manufacturer,
      model: component.current.presentation.model,
      componentType: component.current.identity.componentType,
      technicalData: component.current.technicalData,
      salesPriceNetCents: commercial.salesPriceNetCents,
      ...(purchase === undefined ? {} : { purchasePriceNetCents: purchase }),
    };
  });
}

export default async function ProjectProductsPage({
  params,
}: PageProps<"/w/[workspaceId]/anfragen/[projectId]/produkte">) {
  const parsed = routeParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { workspaceId, projectId } = parsed.data;
  const projectPath = `/w/${workspaceId}/anfragen/${projectId}`;
  const productsPath = `${projectPath}/produkte`;
  const result = await loadContext(workspaceId, projectId);
  if (result.kind === "unauthenticated") redirect(`/login?next=${encodeURIComponent(productsPath)}`);
  if (result.kind === "denied") return <DeniedState title="Die Produktauflösung ist für dich nicht freigegeben." />;
  if (!result.context) notFound();
  const context = result.context;
  const latest = context.latestResolution;
  const displayState = context.blocker
    ? "blocked"
    : !context.permissions.canResolve
      ? "read_only"
      : context.activeComponents.length === 0
        ? "no_active_products"
        : context.state;
  const initialSelections = Object.fromEntries(
    (latest?.lines ?? []).map((line) => [line.catalogComponentId, line.quantity]),
  );

  return (
    <main className="min-h-screen bg-slate-50" data-catalog-resolution-state={displayState}>
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <nav aria-label="Brotkrumen" className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-wrap gap-x-5">
            <Link href={projectPath} className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"><span aria-hidden="true" className="mr-2">←</span>Zurück zur Projektakte</Link>
            <Link href={`/w/${workspaceId}/katalog`} className="inline-flex min-h-11 items-center text-sm font-semibold text-slate-700 outline-none hover:text-slate-950 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Produktkatalog</Link>
          </div>
          <SignOutButton />
        </nav>

        <header className="mb-8 border-b border-slate-200 pb-7">
          <p className="text-sm font-semibold text-blue-700">Projektakte · Angebotsvorbereitung</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">Produkte revisionssicher zuordnen</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Die Planungsschätzung ist generisch. Diese Auflösung kopiert
            Produktwerte und Preise fest – sie rechnet die Planung nicht neu.
          </p>
        </header>

        <div className="grid gap-6">
          <Section title="Bindungsstand" intro="Nur genau diese Requirement- und Calculation-Revision darf bestätigt werden.">
            <div role="note" className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
              Ergebnisqualität: serverseitig reproduzierte Schätzung, noch
              nicht gegen eine F4-Referenz validiert.
            </div>
            <dl>
              <DetailItem term="Requirement-Revision" numeric>{context.currentRequirementRevision ?? "–"}</DetailItem>
              <DetailItem term="Calculation-Revision" numeric>{context.currentCalculationRevision ?? "–"}</DetailItem>
              <DetailItem term="Projektstatus">{context.state === "current" ? "Aktuelle Auflösung" : context.state === "stale" ? "Historische Auflösung – erneute Prüfung nötig" : context.state === "pending" ? "Produktauswahl offen" : "Blockiert"}</DetailItem>
            </dl>
          </Section>

          {context.requested ? (
            <Section title="Berechnetes Ziel" intro="Zielwerte stammen aus der aktuellen Planung und sind auf volle W beziehungsweise Wh gerundet.">
              <dl>
                <DetailItem term="Vorhaben">{context.requested.branch === "new_installation" ? "Neuanlage" : "Bestehende Anlage"}</DetailItem>
                <DetailItem term="PV-Ziel" numeric>{context.requested.pvPeakPowerWatts.toLocaleString("de-DE")} W · {(context.requested.pvPeakPowerWatts / 1000).toLocaleString("de-DE", { maximumFractionDigits: 3 })} kWp</DetailItem>
                <DetailItem term="Speicherziel" numeric>{context.requested.storageCapacityWh.toLocaleString("de-DE")} Wh · {(context.requested.storageCapacityWh / 1000).toLocaleString("de-DE", { maximumFractionDigits: 3 })} kWh</DetailItem>
                <DetailItem term="Wallbox"><YesNo value={context.requested.wallbox} /></DetailItem>
                <DetailItem term="Ersatzstrom"><YesNo value={context.requested.backupPower} /></DetailItem>
                <DetailItem term="Bidirektionales Laden"><YesNo value={context.requested.bidirectionalCharging} /></DetailItem>
              </dl>
            </Section>
          ) : null}

          {context.blocker ? (
            <Section title="Produktauflösung blockiert">
              <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">{blockerLabels[context.blocker]}</div>
              <Link href={context.blocker === "missing_requirement" ? projectPath : `${projectPath}/energieprofil`} className="mt-5 inline-flex min-h-11 items-center rounded-md border border-blue-700 bg-white px-4 text-sm font-semibold text-blue-800 outline-none hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Voraussetzungen prüfen</Link>
            </Section>
          ) : null}

          {context.state === "current" && latest ? <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm font-semibold text-emerald-950">Projektauflösung Revision {latest.revision} ist aktuell.</div> : null}
          {context.state === "stale" && latest ? (
            <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-5 py-4 text-amber-950">
              <p className="text-sm font-semibold">Die letzte Auflösung ist historisch und nicht mehr aktuell.</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6">{context.staleReasons.map((reason) => <li key={reason}>{staleLabels[reason]}</li>)}</ul>
            </div>
          ) : null}

          {latest ? (
            <Section title={`Gespeicherter Snapshot · Revision ${latest.revision}`} intro="Produktdaten und Preise dieses Stands bleiben unverändert, auch wenn der Katalog später revidiert wird.">
              <div role="region" aria-label="Gespeicherte Produktpositionen" tabIndex={0} className="overflow-x-auto rounded-md border border-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
                <table className="min-w-[760px] w-full border-collapse text-left text-sm">
                  <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600"><tr><th className="px-4 py-3">Pos.</th><th className="px-4 py-3">Produkt</th><th className="px-4 py-3">Rev.</th><th className="px-4 py-3 text-right">Menge</th><th className="px-4 py-3 text-right">VK netto</th></tr></thead>
                  <tbody>{latest.lines.map((line) => {
                    const product = line.componentSnapshot;
                    const price = product.commercial?.salesPriceNetCents ?? 0;
                    return <tr key={line.lineId} className="border-t border-slate-200"><td className="px-4 py-3 tabular-nums">{line.position}</td><td className="px-4 py-3"><span className="font-semibold text-slate-950">{product.presentation.displayName}</span><span className="mt-0.5 block font-mono text-xs text-slate-500">{product.identity.internalSku}</span></td><td className="px-4 py-3 tabular-nums">{line.catalogComponentRevision}</td><td className="px-4 py-3 text-right tabular-nums">{line.quantity}</td><td className="px-4 py-3 text-right font-medium tabular-nums">{formatCents(price * line.quantity)}</td></tr>;
                  })}</tbody>
                </table>
              </div>
              <dl className="mt-5">
                <DetailItem term="VK-Summe netto" numeric>{formatCents(latest.totals.salesPriceNetCents)}</DetailItem>
                {latest.totals.purchasePriceNetCents !== undefined ? <DetailItem term="EK-Summe netto" numeric>{formatCents(latest.totals.purchasePriceNetCents)}</DetailItem> : null}
                <DetailItem term="Bestätigt am">{formatDate(latest.confirmedAt)}</DetailItem>
                {latest.sourceResolutionSha256 !== undefined ? (
                  <DetailItem term="Resolution-Hash"><span className="break-all font-mono text-xs">{latest.sourceResolutionSha256}</span></DetailItem>
                ) : null}
              </dl>
              <ul className="mt-5 grid gap-2 border-t border-slate-200 pt-5">{latest.warnings.map((warning) => <li key={warning} className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-950">{warningLabels[warning] ?? warning}</li>)}</ul>
            </Section>
          ) : null}

          {!context.blocker && context.activeComponents.length === 0 ? (
            <Section title="Noch keine aktiven Produkte">
              <p className="text-sm leading-6 text-slate-600">Lege eigene Produkte mit vollständigem Preisstand an und aktiviere sie. Erst dann können sie revisionssicher ausgewählt werden.</p>
              <Link href={`/w/${workspaceId}/katalog`} className="mt-5 inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Zum Produktkatalog</Link>
            </Section>
          ) : null}

          {!context.blocker && context.requested && context.permissions.canResolve && context.activeComponents.length > 0 && context.currentRequirementRevision && context.currentCalculationRevision ? (
            <Section title={latest ? "Neue Auflösung bestätigen" : "Produkte auswählen"} intro="Auswahl und Bestätigungen werden atomar als neue, unveränderliche Revision gespeichert.">
              <ResolutionForm
                workspaceId={workspaceId}
                projectId={projectId}
                expectedResolutionRevision={latest?.revision ?? 0}
                expectedRequirementRevision={context.currentRequirementRevision}
                expectedCalculationRevision={context.currentCalculationRevision}
                requested={context.requested}
                components={selectableComponents(context)}
                initialSelections={initialSelections}
              />
            </Section>
          ) : !context.blocker && !context.permissions.canResolve ? (
            <Section title="Nur Lesezugriff"><p className="text-sm leading-6 text-slate-600">Du kannst den gespeicherten Produktstand sehen, aber keine Auswahl bestätigen oder revidieren.</p></Section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
