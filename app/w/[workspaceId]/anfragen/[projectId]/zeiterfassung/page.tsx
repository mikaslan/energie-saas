import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type {
  TimeEntryListDto,
  TimeEntryRevisionDto,
  TimeEventTypeDto,
  TimeMemberOption,
  TimeUtilizationDto,
} from "@/lib/integrations/time-tracking/contract";
import type { BillingRunBreakdownDto, BillingRunDto } from "@/lib/integrations/time-tracking/billing-contract";
import { BILLING_RUN_SCHEMA_VERSION } from "@/lib/integrations/time-tracking/billing-contract";
import {
  breakMinutesTotal,
  getBillingRunBreakdown,
  getTimeUtilization,
  listBillingRuns,
  listBreaks,
  listTimeEntries,
  listTimeEntryRevisions,
  listTimeEventTypes,
  listTimeMemberOptions,
  type BreakSegmentDto,
} from "@/modules/time-tracking";
import { UserFilterForm } from "./user-filter-form";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { sql } from "drizzle-orm";
import { DeniedState } from "../_ui";
import { BillingRunSection } from "./billing-run-section";
import { TimeEntryManager } from "./time-entry-manager";

export const metadata: Metadata = {
  title: "Zeiterfassung | Energie-SaaS",
};

const routeParamsSchema = z.object({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
});

// F9.3: userId als wiederholter oder komma-getrennter Query-Param; nur
// wohlgeformte UUIDs (max 50) erreichen den Service (UI kann nichts anderes
// erzeugen; Service-Validation bleibt authoritative). F9-09: dazu
// startDate/endDate (YYYY-MM-DD) und eventTypeId (wiederholt/kommagetrennt).
const filterParamsSchema = z.object({
  userId: z.union([z.string(), z.array(z.string())]).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  eventTypeId: z.union([z.string(), z.array(z.string())]).optional(),
});

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

type TimeTrackingFilters = {
  userIds: string[];
  startDate?: string;
  endDate?: string;
  eventTypeIds: string[];
};

function parseUuidList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  const ids = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => z.uuid().safeParse(value).success);
  return [...new Set(ids)].slice(0, 50);
}

function parseFilters(raw: unknown): TimeTrackingFilters {
  const parsed = filterParamsSchema.safeParse(raw);
  if (!parsed.success) return { userIds: [], eventTypeIds: [] };
  const startDate = parsed.data.startDate !== undefined && localDateSchema.safeParse(parsed.data.startDate).success
    ? parsed.data.startDate
    : undefined;
  const endDate = parsed.data.endDate !== undefined && localDateSchema.safeParse(parsed.data.endDate).success
    ? parsed.data.endDate
    : undefined;
  return {
    userIds: parseUuidList(parsed.data.userId),
    startDate,
    endDate,
    eventTypeIds: parseUuidList(parsed.data.eventTypeId),
  };
}

// F9-09: Export-Link übernimmt alle aktiven Listen-Filter (WYSIWYG).
function buildExportQuery(filters: TimeTrackingFilters): string {
  const params = new URLSearchParams();
  for (const id of filters.userIds) params.append("userId", id);
  if (filters.startDate !== undefined) params.set("startDate", filters.startDate);
  if (filters.endDate !== undefined) params.set("endDate", filters.endDate);
  for (const id of filters.eventTypeIds) params.append("eventTypeId", id);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

export default async function ProjectTimeTrackingPage(
  props: PageProps<"/w/[workspaceId]/anfragen/[projectId]/zeiterfassung">,
) {
  const params = routeParamsSchema.safeParse(await props.params);
  if (!params.success) notFound();
  const { workspaceId, projectId } = params.data;
  const filters = parseFilters(await props.searchParams);
  const selectedUserIds = filters.userIds;

  let result:
    | { projectName: string; list: TimeEntryListDto; types: TimeEventTypeDto[]; members: TimeMemberOption[]; revisionsByEntry: Record<string, TimeEntryRevisionDto[]>; breaksByEntry: Record<string, BreakSegmentDto[]>; breakTotalsByEntry: Record<string, { breakMinutes: number; openBreak: boolean }>; utilization: TimeUtilizationDto; runs: BillingRunDto[]; breakdowns: Record<string, BillingRunBreakdownDto>; filters: TimeTrackingFilters; canWrite: boolean }
    | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "time.read",
      "time_tracking",
      async (tx, ctx) => {
        // Permission-Gate ZUERST: listTimeEntries wirft fuer externe Nutzer
        // (time.read ist internalOnly) PermissionDeniedError — der rohe
        // Projekt-Lookup wuerde zuvor durch die restriktive M1-09-Policy
        // (project_external_select_scope) leer laufen und faelschlich die
        // 404-Projektseite rendern.
        const list = await listTimeEntries(tx, ctx, {
          projectId,
          userIds: selectedUserIds,
          startDate: filters.startDate,
          endDate: filters.endDate,
          eventTypeIds: filters.eventTypeIds,
        });
        const projectRow = await tx.execute<{ name: string }>(sql`
          select name from project
           where workspace_id = ${ctx.workspaceId}::uuid
             and id = ${projectId}::uuid
           limit 1
        `);
        if (!projectRow.rows[0]) {
          throw new ProjectNotFound();
        }
        // F9.4 Slice B: Verlauf je gelistetem Eintrag (Service-Pfad mit
        // RequireRead + NotFound-Schranke; Eintraege stammen aus derselben
        // Transaktion, daher existiert jede ID garantiert).
        const revisionsByEntry: Record<string, TimeEntryRevisionDto[]> = {};
        for (const entry of list.entries) {
          revisionsByEntry[entry.id] = (
            await listTimeEntryRevisions(tx, ctx, { entryId: entry.id })
          ).revisions;
        }
        // F9-06 Pausen-Segmente je gelistetem Eintrag (gleicher Read-Pfad).
        const breaksByEntry: Record<string, BreakSegmentDto[]> = {};
        const breakTotalsByEntry: Record<string, { breakMinutes: number; openBreak: boolean }> = {};
        for (const entry of list.entries) {
          breaksByEntry[entry.id] = await listBreaks(tx, ctx, { entryId: entry.id });
          const total = await breakMinutesTotal(tx, ctx, { entryId: entry.id });
          breakTotalsByEntry[entry.id] = {
            breakMinutes: total.breakMinutes,
            openBreak: total.openBreak,
          };
        }
        const writable = can(ctx, "time.write");
        // Review Welle 03 (GPS rollenabhängig sichtbar): Koordinaten sind
        // Mitarbeiter-Standortdaten — ohne time.write serverseitig
        // entfernen (UI rendert NULL als „keine Zeile").
        const visibleList = writable ? list : {
          ...list,
          entries: list.entries.map((entry) => ({ ...entry, startLat: null, startLng: null })),
        };
        const visibleRevisionsByEntry: Record<string, TimeEntryRevisionDto[]> = {};
        for (const [entryId, revisions] of Object.entries(revisionsByEntry)) {
          visibleRevisionsByEntry[entryId] = writable
            ? revisions
            : revisions.map((revision) => ({ ...revision, startLat: null, startLng: null }));
        }
        return {
          projectName: projectRow.rows[0].name,
          list: visibleList,
          breaksByEntry,
          breakTotalsByEntry,
          types: await listTimeEventTypes(tx, ctx, { includeArchived: true }),
          members: await listTimeMemberOptions(tx, ctx),
          revisionsByEntry: visibleRevisionsByEntry,
          // F9.4 Slice D: gleicher Filter wie die Liste (WYSIWYG).
          utilization: await getTimeUtilization(tx, ctx, { projectId, userIds: selectedUserIds }),
          // F9-07: Abrechnungsläufe (gleiche Read-Permission, kein eigener Gate).
          // F9-08: Aufschlüsselung je geschlossenem Lauf, sequenziell
          // (pg@9 weist überlappende client.query()-Aufrufe ab).
          ...(await (async () => {
            const runs = await listBillingRuns(tx, ctx);
            const breakdowns: Record<string, BillingRunBreakdownDto> = {};
            for (const run of runs) {
              if (run.status !== "closed") continue;
              breakdowns[run.id] = await getBillingRunBreakdown(tx, ctx, {
                schemaVersion: BILLING_RUN_SCHEMA_VERSION,
                billingRunId: run.id,
              });
            }
            return { runs, breakdowns };
          })()),
          filters,
          canWrite: writable,
        };
      },
    );
  } catch (error) {
    if (error instanceof ProjectNotFound) notFound();
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/anfragen/${projectId}/zeiterfassung`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Zeiterfassung ist für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Zeiterfassung konnte nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
          Projektakte
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Zeiterfassung</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Arbeitszeiten am Projekt „{result.projectName}“.
        </p>
      </div>

      <UserFilterForm
        members={result.members}
        types={result.types}
        selectedUserIds={result.filters.userIds}
        startDate={result.filters.startDate ?? ""}
        endDate={result.filters.endDate ?? ""}
        selectedEventTypeIds={result.filters.eventTypeIds}
        resetHref={`/w/${workspaceId}/anfragen/${projectId}/zeiterfassung`}
      />

      <div className="mt-4">
        <Link
          href={`/w/${workspaceId}/anfragen/${projectId}/zeiterfassung/export${buildExportQuery(result.filters)}`}
          className="text-sm font-semibold text-blue-700 underline-offset-2 hover:underline"
        >
          CSV exportieren
        </Link>
      </div>

      <TimeEntryManager
        workspaceId={workspaceId}
        projectId={projectId}
        list={result.list}
        breaksByEntry={result.breaksByEntry}
        breakTotalsByEntry={result.breakTotalsByEntry}
        types={result.types}
        members={result.members}
        revisionsByEntry={result.revisionsByEntry}
        utilization={result.utilization}
        canWrite={result.canWrite}
      />

      <BillingRunSection
        workspaceId={workspaceId}
        projectId={projectId}
        runs={result.runs}
        breakdowns={result.breakdowns}
        canWrite={result.canWrite}
      />

      <div className="mt-6">
        <Link
          href={`/w/${workspaceId}/anfragen/${projectId}`}
          className="text-sm font-semibold text-blue-700 underline-offset-2 hover:underline"
        >
          Zurück zur Projektakte
        </Link>
      </div>
    </main>
  );
}

class ProjectNotFound extends Error {
  constructor() {
    super("project not found");
    this.name = "ProjectNotFound";
  }
}
