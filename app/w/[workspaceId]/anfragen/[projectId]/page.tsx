import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { SignOutButton } from "@/app/_components/sign-out-button";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
} from "@/lib/permissions";
import {
  getProjectCatalogResolutionContext,
  type ProjectCatalogResolutionContext,
} from "@/modules/catalog";
import {
  getProjectAssignmentContext,
  getProjectOutcomeContext,
  getProjectPageDetail,
  PROJECT_ASSIGNMENT_COMMAND_VERSION,
  PROJECT_OUTCOME_COMMAND_VERSION,
  type ProjectAssignmentContext,
  type ProjectOutcomeContext,
  type ProjectPageDetail,
} from "@/modules/projects";
import {
  getProjectEnergyContext,
  type ProjectEnergyContext,
} from "@/modules/energy";
import { listOffers } from "@/modules/offers";
import {
  getProjectTaskPage,
  projectTaskCursorTokenSchema,
  type ProjectActivityCursor,
  type ProjectTaskPageV1,
} from "@/modules/tasks";
import { DetailItem, DeniedState, Section, YesNo } from "./_ui";
import { AddressEditor } from "./address-editor";
import { AssignedExternalRequestView } from "./assigned-external-request-view";
import { EnergyCalculationSection } from "./energy-calculation-section";
import { EnergyProfileSection } from "./energy-profile-section";
import { OfferCreateEntry } from "./offer-create-entry";
import {
  buildOfferCreateView,
  type OfferCreateServerGate,
} from "./offer-create-view";
import { PinForm } from "./pin-form";
import { ProductResolutionSection } from "./product-resolution-section";
import { ProjectActivityPanel } from "./project-activity-panel";
import { ProjectAssignmentPanel } from "./project-assignment-panel";
import { ProjectOutcomePanel } from "./project-outcome-panel";
import { ProjectTasksSection } from "./project-tasks-section";

export const metadata: Metadata = {
  title: "Projektakte | Energie-SaaS",
};

const routeParamsSchema = z.object({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
});

const activityQuerySchema = z.strictObject({
  activityAt: z.iso.datetime({ offset: true }).optional(),
  activityId: z.uuid().optional(),
  taskCursor: projectTaskCursorTokenSchema.optional(),
  tasks: z.literal("archived").optional(),
}).superRefine((value, ctx) => {
  if ((value.activityAt === undefined) !== (value.activityId === undefined)) {
    ctx.addIssue({ code: "custom", message: "activity cursor must be complete" });
  }
});

type ActivityQuery = z.infer<typeof activityQuerySchema>;
type SearchParamValue = string | string[] | undefined;

function singleSearchParam(value: SearchParamValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeActivityQuery(rawSearch: {
  activityAt?: SearchParamValue;
  activityId?: SearchParamValue;
  taskCursor?: SearchParamValue;
  tasks?: SearchParamValue;
}): ActivityQuery {
  const parsed = activityQuerySchema.safeParse({
    activityAt: singleSearchParam(rawSearch.activityAt),
    activityId: singleSearchParam(rawSearch.activityId),
    taskCursor: singleSearchParam(rawSearch.taskCursor),
    tasks: singleSearchParam(rawSearch.tasks),
  });
  return parsed.success ? parsed.data : {};
}

const decimalFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const coordinateFormatter = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 5,
  maximumFractionDigits: 6,
});

const percentFormatter = new Intl.NumberFormat("de-DE", {
  style: "percent",
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

type LoadResult =
  | { kind: "loaded"; detail: ProjectPageDetail | null }
  | { kind: "unauthenticated" }
  | { kind: "denied" };

type AssignmentLoadResult =
  | { kind: "loaded"; context: ProjectAssignmentContext | null }
  | { kind: "unauthenticated" }
  | { kind: "denied" };

type OutcomeLoadResult =
  | { kind: "loaded"; context: ProjectOutcomeContext | null }
  | { kind: "unauthenticated" }
  | { kind: "denied" };

type EnergyLoadResult =
  | { kind: "loaded"; context: ProjectEnergyContext | null }
  | { kind: "unauthenticated" }
  | { kind: "denied" };

type OfferCreationLoadResult =
  | { kind: "loaded"; gate: OfferCreateServerGate }
  | { kind: "unauthenticated" }
  | { kind: "denied" };

type TaskPageLoadResult =
  | { kind: "loaded"; page: ProjectTaskPageV1 | null }
  | { kind: "unauthenticated" }
  | { kind: "denied" };

async function loadProjectDetail(
  workspaceId: string,
  projectId: string,
): Promise<LoadResult> {
  try {
    const detail = await authorizedQuery(
      workspaceId,
      "project.read",
      "project",
      (tx, ctx) => getProjectPageDetail(tx, ctx, projectId),
    );
    return { kind: "loaded", detail };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return { kind: "unauthenticated" };
    }
    if (error instanceof PermissionDeniedError) {
      return { kind: "denied" };
    }
    throw error;
  }
}

async function loadProjectAssignmentContext(
  workspaceId: string,
  projectId: string,
): Promise<AssignmentLoadResult> {
  try {
    const context = await authorizedQuery(
      workspaceId,
      "project.read",
      "project_assignment",
      (tx, ctx) => getProjectAssignmentContext(tx, ctx, projectId),
    );
    return { kind: "loaded", context };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

async function loadProjectOutcomeContext(
  workspaceId: string,
  projectId: string,
): Promise<OutcomeLoadResult> {
  try {
    const context = await authorizedQuery(
      workspaceId,
      "project.read",
      "project_outcome",
      (tx, ctx) => getProjectOutcomeContext(tx, ctx, projectId),
    );
    return { kind: "loaded", context };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

async function loadProjectTaskPage(
  workspaceId: string,
  projectId: string,
  showingArchived: boolean,
  taskCursor: string | null,
  activityCursor: ProjectActivityCursor | null,
): Promise<TaskPageLoadResult> {
  try {
    const page = await authorizedQuery(
      workspaceId,
      "task.read",
      "project_task_page",
      (tx, ctx) => getProjectTaskPage(tx, ctx, projectId, {
        archived: showingArchived,
        taskCursor,
        activityCursor,
      }),
    );
    return { kind: "loaded", page };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

async function loadProjectEnergy(
  workspaceId: string,
  projectId: string,
): Promise<EnergyLoadResult> {
  try {
    const context = await authorizedQuery(
      workspaceId,
      "project.read",
      "energy_profile",
      (tx, ctx) => getProjectEnergyContext(tx, ctx, projectId),
    );
    return { kind: "loaded", context };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return { kind: "unauthenticated" };
    }
    if (error instanceof PermissionDeniedError) {
      return { kind: "denied" };
    }
    throw error;
  }
}

function projectCatalogGate(
  context: ProjectCatalogResolutionContext | null,
): OfferCreateServerGate["catalog"] {
  if (context === null) return null;
  return {
    state: context.state,
    blocker: context.blocker,
    expectedRequirementRevision: context.currentRequirementRevision,
    expectedCalculationRevision: context.currentCalculationRevision,
    expectedResolutionRevision: context.latestResolution?.revision ?? null,
  };
}

async function loadOfferCreationGate(
  workspaceId: string,
  projectId: string,
): Promise<OfferCreationLoadResult> {
  try {
    const gate = await authorizedQuery(
      workspaceId,
      "project.read",
      "offer_creation_gate",
      async (tx, ctx): Promise<OfferCreateServerGate> => {
        const canCreate = !isExternalOnly(ctx)
          && can(ctx, "project.write")
          && can(ctx, "phase.convert")
          && can(ctx, "price.edit");
        if (!canCreate) {
          return { canCreate: false, configurationBlockers: [], catalog: null };
        }

        // TenantTx besitzt einen Client. Die Reads bleiben bewusst sequenziell.
        // An die Client-Island gehen nur Status und optimistic Revisionsnummern,
        // nie Preise, Katalogsnapshots oder private Hashes.
        const catalogContext = await getProjectCatalogResolutionContext(
          tx,
          ctx,
          projectId,
        );
        const offerList = await listOffers(tx, ctx);
        return {
          canCreate: offerList.permissions.canCreate,
          configurationBlockers: offerList.state === "blocked"
            ? offerList.blockers.map(({ code, label }) => ({ code, label }))
            : [],
          catalog: projectCatalogGate(catalogContext),
        };
      },
    );
    return { kind: "loaded", gate };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

function formatDate(value: string | null): string {
  if (!value) return "Nicht übermittelt";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Nicht übermittelt" : dateFormatter.format(date);
}

function formatNumber(value: number | null, unit?: string): string {
  if (value === null || !Number.isFinite(value)) return "–";
  const formatted = decimalFormatter.format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "–";
  return percentFormatter.format(value);
}

function formatCents(value: number | null): string {
  if (value === null || !Number.isSafeInteger(value)) return "–";

  const negative = value < 0;
  const absoluteCents = Math.abs(value);
  const euros = Math.floor(absoluteCents / 100);
  const remainder = (absoluteCents % 100).toString().padStart(2, "0");
  const groupedEuros = new Intl.NumberFormat("de-DE", {
    maximumFractionDigits: 0,
  }).format(euros);

  return `${negative ? "−" : ""}${groupedEuros},${remainder}\u00a0€`;
}

function formatInvestmentRange(low: number | null, high: number | null): string {
  const lowLabel = formatCents(low);
  const highLabel = formatCents(high);
  if (lowLabel === "–" && highLabel === "–") return "–";
  if (lowLabel === "–") return `bis ${highLabel}`;
  if (highLabel === "–") return `ab ${lowLabel}`;
  return `${lowLabel} – ${highLabel}`;
}

function phaseLabel(value: string): string {
  return value === "request" ? "Anfrage" : value;
}

function outcomeLabel(value: string): string {
  if (value === "open") return "Offen";
  if (value === "won") return "Gewonnen";
  if (value === "lost") return "Verloren";
  return value;
}

function branchLabel(value: string | null): string {
  if (value === "new_installation") return "Neuanlage";
  if (value === "existing_installation") return "Bestehende Anlage";
  return value ?? "Nicht übermittelt";
}

function addressModeLabel(value: string): string {
  if (value === "selected") return "Ausgewählte Adresse";
  if (value === "regional_estimate") return "Regionale Schätzung";
  return "Nicht klassifiziert";
}

function precisionLabel(value: string | null): string {
  if (value === "house") return "Hausgenau";
  if (value === "street") return "Straßengenau";
  if (value === "locality") return "Ortsgenau";
  if (value === "region") return "Regional";
  return "Nicht klassifiziert";
}

function integrityLabel(value: string | null): string {
  return value === "client_reported_unverified"
    ? "Vom Rechner gemeldet, ungeprüft"
    : value ?? "Nicht übermittelt";
}

function priceSourceLabel(value: string | null): string {
  return value === "market_estimate"
    ? "Marktschätzung"
    : value ?? "Nicht übermittelt";
}

function redirectToProjectLogin(detailPath: string): never {
  redirect(`/login?next=${encodeURIComponent(detailPath)}`);
}

export default async function ProjectTriagePage({
  params,
  searchParams,
}: PageProps<"/w/[workspaceId]/anfragen/[projectId]">) {
  const parsedParams = routeParamsSchema.safeParse(await params);
  if (!parsedParams.success) notFound();
  const rawSearch = await searchParams;
  const parsedActivityQuery = safeActivityQuery(rawSearch);
  const showingArchived = parsedActivityQuery.tasks === "archived";
  const taskCursor = parsedActivityQuery.taskCursor ?? null;
  const activityCursor: ProjectActivityCursor | null = parsedActivityQuery.activityAt
    && parsedActivityQuery.activityId
    ? {
        occurredAt: parsedActivityQuery.activityAt,
        id: parsedActivityQuery.activityId.toLowerCase(),
      }
    : null;

  const { workspaceId, projectId } = parsedParams.data;
  const detailPath = `/w/${workspaceId}/anfragen/${projectId}`;
  const result = await loadProjectDetail(workspaceId, projectId);

  if (result.kind === "unauthenticated") {
    redirectToProjectLogin(detailPath);
  }
  if (result.kind === "denied") return <DeniedState />;
  if (result.detail === null) notFound();

  const pageDetail = result.detail;
  if (pageDetail.audience === "assigned_external") {
    return (
      <AssignedExternalRequestView
        workspaceId={workspaceId}
        detail={pageDetail.record}
      />
    );
  }
  const detail = pageDetail.record;

  const outcomeResult = await loadProjectOutcomeContext(workspaceId, projectId);
  if (outcomeResult.kind === "unauthenticated") redirectToProjectLogin(detailPath);
  if (outcomeResult.kind === "denied") return <DeniedState />;
  if (outcomeResult.context === null) notFound();
  const outcomeContext = outcomeResult.context;

  const taskPageResult = await loadProjectTaskPage(
    workspaceId,
    projectId,
    showingArchived,
    taskCursor,
    activityCursor,
  );
  if (taskPageResult.kind === "unauthenticated") {
    redirectToProjectLogin(detailPath);
  }
  if (taskPageResult.kind === "denied") {
    return <DeniedState title="Aufgaben und interne Aktivität sind für dich nicht freigegeben." />;
  }
  if (taskPageResult.page === null) notFound();
  const taskWorkspace = taskPageResult.page.workspace;
  const projectActivity = taskPageResult.page.activity;
  const nextTaskHref = taskWorkspace.nextTaskCursor === null
    ? null
    : `${detailPath}?${new URLSearchParams({
        ...(showingArchived ? { tasks: "archived" } : {}),
        taskCursor: taskWorkspace.nextTaskCursor,
      }).toString()}#project-tasks`;
  const latestTaskHref = taskCursor === null
    ? null
    : `${detailPath}${showingArchived ? "?tasks=archived" : ""}#project-tasks`;
  const activityNextHref = projectActivity.nextCursor === null
    ? null
    : `${detailPath}?${new URLSearchParams({
         ...(showingArchived ? { tasks: "archived" } : {}),
         ...(taskCursor ? { taskCursor } : {}),
        activityAt: projectActivity.nextCursor.occurredAt,
        activityId: projectActivity.nextCursor.id,
      }).toString()}#project-activity`;
  const activityLatestHref = activityCursor === null
    ? null
    : `${detailPath}?${new URLSearchParams({
        ...(showingArchived ? { tasks: "archived" } : {}),
        ...(taskCursor ? { taskCursor } : {}),
      }).toString()}#project-activity`;

  const assignmentResult = await loadProjectAssignmentContext(workspaceId, projectId);
  if (assignmentResult.kind === "unauthenticated") {
    redirectToProjectLogin(detailPath);
  }
  if (assignmentResult.kind === "denied") return <DeniedState />;
  if (assignmentResult.context === null) notFound();
  const assignmentContext = assignmentResult.context;

  // Die Projektakte und das Energie-Readmodel werden bewusst nacheinander
  // autorisiert. So entsteht weder ein paralleler Session-Race noch ein
  // Energie-Read vor der bestehenden Projektgrenze.
  const energyResult = await loadProjectEnergy(workspaceId, projectId);
  if (energyResult.kind === "unauthenticated") {
    redirectToProjectLogin(detailPath);
  }
  if (energyResult.kind === "denied") return <DeniedState />;
  const energyContext = energyResult.context;
  const offerCreationResult = await loadOfferCreationGate(workspaceId, projectId);
  if (offerCreationResult.kind === "unauthenticated") {
    redirectToProjectLogin(detailPath);
  }
  if (offerCreationResult.kind === "denied") {
    return <DeniedState title="Die Angebotsbereitschaft ist für dich nicht freigegeben." />;
  }
  const offerCreateView = buildOfferCreateView({
    workspaceId,
    projectId,
    detailPath,
    detail: {
      phase: detail.project.phase,
      outcome: outcomeContext.outcome,
      sourceLabel: detail.source.label,
      submittedAt: detail.source.submittedAt,
      customerDisplayName: detail.contact.displayName,
      installationSiteLabel: detail.site.formattedAddress,
      blockers: detail.blockers,
    },
    gate: offerCreationResult.gate,
  });
  const activeBlockers = [
    detail.blockers.dedupeReviewRequired
      ? "Mögliche Dublette muss geprüft werden"
      : null,
    detail.blockers.addressFollowUpRequired
      ? "Adresse muss nachbearbeitet werden"
      : null,
    detail.blockers.pinConfirmationRequired
      ? "Planungs-Pin ist noch nicht bestätigt"
      : null,
    detail.blockers.catalogResolutionPending
      ? "Katalogzuordnung ist noch offen"
      : null,
  ].filter((blocker): blocker is string => blocker !== null);
  const coordinates =
    detail.site.latitude !== null
    && detail.site.longitude !== null
    && Number.isFinite(detail.site.latitude)
    && Number.isFinite(detail.site.longitude)
      ? `${coordinateFormatter.format(detail.site.latitude)}, ${coordinateFormatter.format(detail.site.longitude)}`
      : "Nicht verfügbar";
  const requestListPath = outcomeContext.outcome === "won" || outcomeContext.outcome === "lost"
    ? `/w/${workspaceId}/anfragen/abgeschlossen`
    : `/w/${workspaceId}/anfragen`;

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <nav aria-label="Brotkrumen" className="mb-6 flex items-start justify-between gap-4">
          <div className="flex flex-wrap gap-x-5">
            <Link
              href={requestListPath}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              <span aria-hidden="true" className="mr-2">←</span>
              Zurück zu den Anfragen
            </Link>
            <Link
              href={`/w/${workspaceId}/katalog`}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-slate-700 outline-none hover:text-slate-950 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Produktkatalog
            </Link>
          </div>
          <SignOutButton />
        </nav>

        <header className="mb-8 border-b border-slate-200 pb-7">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-blue-700">Projektakte</p>
              <h1 className="mt-1 break-words text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
                {detail.contact.displayName}
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                {detail.project.name} · Erstellt am {formatDate(detail.project.createdAt)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2" aria-label="Projektstatus">
              <span className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
                {phaseLabel(detail.project.phase)}
              </span>
              <span className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-800">
                {outcomeLabel(outcomeContext.outcome)} · {detail.project.columnName}
              </span>
            </div>
          </div>
        </header>

        <div className="mb-6 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)] lg:items-start">
          <ProjectTasksSection
            workspaceId={workspaceId}
            projectId={projectId}
            workspace={taskWorkspace}
            showingArchived={showingArchived}
            nextTaskHref={nextTaskHref}
            latestTaskHref={latestTaskHref}
          />
          <ProjectActivityPanel
            activity={projectActivity}
            nextHref={activityNextHref}
            latestHref={activityLatestHref}
          />
        </div>

        <div className="mb-6">
          <OfferCreateEntry view={offerCreateView} />
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)] lg:items-start">
          <div className="grid min-w-0 gap-6">
            <Section title="Identität und Kontakt">
              <dl>
                <DetailItem term="Ansprechperson">{detail.contact.displayName}</DetailItem>
                <DetailItem term="E-Mail">
                  {detail.contact.email ?? "Nicht übermittelt"}
                </DetailItem>
                <DetailItem term="Telefon">
                  {detail.contact.phone ?? "Nicht übermittelt"}
                </DetailItem>
                <DetailItem term="Projekt-ID">
                  <code className="break-all font-mono text-xs font-normal text-slate-700">
                    {detail.project.id}
                  </code>
                </DetailItem>
              </dl>
            </Section>

            <div id="standort-und-pin" className="scroll-mt-6">
              <Section
                title="Adresse und Qualität"
                intro="Die Qualitätsangaben bestimmen, ob der Standort als Planungs-Pin bestätigt werden darf."
              >
              <dl>
                <DetailItem term="Adresse">
                  {detail.site.formattedAddress ?? "Nicht übermittelt"}
                </DetailItem>
                <DetailItem term="Adressmodus">
                  {addressModeLabel(detail.site.addressMode)}
                </DetailItem>
                <DetailItem term="Genauigkeit">
                  {precisionLabel(detail.site.precision)}
                </DetailItem>
                <DetailItem term="Koordinaten" numeric>{coordinates}</DetailItem>
                <DetailItem term="Planungs-Pin">
                  {detail.site.pinConfirmed ? "Bestätigt" : "Nicht bestätigt"}
                </DetailItem>
                <DetailItem term="Adressrevision" numeric>
                  {detail.site.addressRevision}
                </DetailItem>
                <DetailItem term="Pinlage">
                  {detail.site.addressMode !== "selected"
                    ? "Noch nicht hausgenau bewertet"
                    : detail.site.pinAdjusted
                      ? "Gegenüber dem Hauspunkt angepasst"
                      : "Am ermittelten Hauspunkt"}
                </DetailItem>
                <DetailItem term="Adressprüfung">
                  {detail.site.addressFollowUpRequired
                    ? "Nachbearbeitung erforderlich"
                    : "Keine Nachbearbeitung markiert"}
                </DetailItem>
              </dl>
              {detail.permissions.canCorrectAddress ? (
                <div className="mt-5 border-t border-slate-200 pt-5">
                  <AddressEditor
                    workspaceId={workspaceId}
                    projectId={projectId}
                    addressRevision={detail.site.addressRevision}
                  />
                </div>
              ) : null}
              </Section>
            </div>

            <div id="bedarf" className="scroll-mt-6">
              <Section title="Bedarf">
                <dl>
                  <DetailItem term="Vorhaben">{branchLabel(detail.requirements.branch)}</DetailItem>
                  <DetailItem term="Gewünschter Speicher" numeric>
                    {formatNumber(detail.requirements.targetStorageKwh, "kWh")}
                  </DetailItem>
                  <DetailItem term="Wallbox"><YesNo value={detail.requirements.wallbox} /></DetailItem>
                  <DetailItem term="Bidirektionales Laden">
                    <YesNo value={detail.requirements.bidirectionalCharging} />
                  </DetailItem>
                  <DetailItem term="Ersatzstrom"><YesNo value={detail.requirements.backupPower} /></DetailItem>
                </dl>
              </Section>
            </div>

            <EnergyProfileSection
              workspaceId={workspaceId}
              projectId={projectId}
              context={energyContext}
            />

            <EnergyCalculationSection context={energyContext} />

            <ProductResolutionSection
              workspaceId={workspaceId}
              projectId={projectId}
              pending={detail.blockers.catalogResolutionPending}
              energyContext={energyContext}
            />

            <Section title="Importierte Rechner-Schätzung (ungeprüft)">
              <div
                role="note"
                className="mb-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3"
              >
                <p className="font-semibold text-amber-950">
                  {detail.calculatorEstimate.label}
                </p>
                <p className="mt-1 text-sm leading-6 text-amber-900">
                  Diese Werte wurden noch nicht fachlich geprüft und dürfen
                  nicht als Angebots- oder Preisgrundlage verwendet werden.
                </p>
              </div>
              <dl>
                <DetailItem term="PV-Leistung" numeric>
                  {formatNumber(detail.calculatorEstimate.systemPeakPowerKwp, "kWp")}
                </DetailItem>
                <DetailItem term="Speicherkapazität" numeric>
                  {formatNumber(detail.calculatorEstimate.storageCapacityKwh, "kWh")}
                </DetailItem>
                <DetailItem term="Autarkiegrad" numeric>
                  {formatPercent(detail.calculatorEstimate.autonomyRate)}
                </DetailItem>
                <DetailItem term="Investitionsrahmen" numeric>
                  {formatInvestmentRange(
                    detail.calculatorEstimate.investmentLowCents,
                    detail.calculatorEstimate.investmentHighCents,
                  )}
                </DetailItem>
                <DetailItem term="Amortisation" numeric>
                  {formatNumber(detail.calculatorEstimate.amortizationYears, "Jahre")}
                </DetailItem>
              </dl>
            </Section>

            <Section title="Quelle und technische Provenienz">
              <dl>
                <DetailItem term="Quelle">{detail.source.label}</DetailItem>
                <DetailItem term="Eingegangen">{formatDate(detail.source.submittedAt)}</DetailItem>
                <DetailItem term="Rechner-Engine">
                  {detail.source.calculatorEngine ?? "Nicht übermittelt"}
                </DetailItem>
                <DetailItem term="Producer-Revision">
                  <span className="break-all font-mono text-xs font-normal">
                    {detail.source.producerRevision ?? "Nicht übermittelt"}
                  </span>
                </DetailItem>
                <DetailItem term="Ergebnisqualität">
                  {integrityLabel(detail.calculatorEstimate.integrity)}
                </DetailItem>
                <DetailItem term="Preisquelle">
                  {priceSourceLabel(detail.calculatorEstimate.priceSource)}
                </DetailItem>
              </dl>
            </Section>
          </div>

          <aside className="grid gap-6 lg:sticky lg:top-6">
            <ProjectOutcomePanel
              workspaceId={workspaceId}
              commandVersion={PROJECT_OUTCOME_COMMAND_VERSION}
              context={outcomeContext}
            />

            <ProjectAssignmentPanel
              workspaceId={workspaceId}
              projectId={projectId}
              commandVersion={PROJECT_ASSIGNMENT_COMMAND_VERSION}
              assignment={assignmentContext}
            />

            <Section title="Blocker">
              {activeBlockers.length > 0 ? (
                <ul className="grid gap-2">
                  {activeBlockers.map((blocker) => (
                    <li
                      key={blocker}
                      className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm leading-5 text-amber-950"
                    >
                      <span aria-hidden="true" className="font-bold">!</span>
                      <span>{blocker}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
                  Keine offenen Triage-Blocker.
                </p>
              )}
            </Section>

            <Section title="Standortfreigabe">
              {detail.permissions.canConfirmPin ? (
                <PinForm
                  workspaceId={workspaceId}
                  projectId={projectId}
                  addressRevision={detail.site.addressRevision}
                />
              ) : !detail.permissions.canMoveCard ? (
                <div
                  role="status"
                  className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3"
                >
                  <p className="text-sm font-semibold text-slate-900">Nur Lesezugriff</p>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    Du kannst die Projektakte ansehen, aber keine Pin-Bestätigung ausführen.
                  </p>
                </div>
              ) : detail.site.pinConfirmed ? (
                <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm font-semibold text-emerald-900">
                  Der Planungs-Pin ist bestätigt.
                </p>
              ) : (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm leading-6 text-amber-950">
                  Die aktuelle Adressqualität erlaubt noch keine Pin-Bestätigung.
                </p>
              )}
            </Section>
          </aside>
        </div>
      </div>
    </main>
  );
}
