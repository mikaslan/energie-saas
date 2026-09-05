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
import {
  getTimeUtilization,
  listTimeEntries,
  listTimeEntryRevisions,
  listTimeEventTypes,
  listTimeMemberOptions,
} from "@/modules/time-tracking";
import { UserFilterForm } from "./user-filter-form";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { sql } from "drizzle-orm";
import { DeniedState } from "../_ui";
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
// erzeugen; Service-Validation bleibt authoritative).
const filterParamsSchema = z.object({
  userId: z.union([z.string(), z.array(z.string())]).optional(),
});

function parseUserFilter(raw: unknown): string[] {
  const parsed = filterParamsSchema.safeParse(raw);
  if (!parsed.success || parsed.data.userId === undefined) return [];
  const values = Array.isArray(parsed.data.userId) ? parsed.data.userId : [parsed.data.userId];
  const ids = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => z.uuid().safeParse(value).success);
  return [...new Set(ids)].slice(0, 50);
}

export default async function ProjectTimeTrackingPage(
  props: PageProps<"/w/[workspaceId]/anfragen/[projectId]/zeiterfassung">,
) {
  const params = routeParamsSchema.safeParse(await props.params);
  if (!params.success) notFound();
  const { workspaceId, projectId } = params.data;
  const selectedUserIds = parseUserFilter(await props.searchParams);

  let result:
    | { projectName: string; list: TimeEntryListDto; types: TimeEventTypeDto[]; members: TimeMemberOption[]; revisionsByEntry: Record<string, TimeEntryRevisionDto[]>; utilization: TimeUtilizationDto; selectedUserIds: string[]; canWrite: boolean }
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
        const list = await listTimeEntries(tx, ctx, { projectId, userIds: selectedUserIds });
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
          types: await listTimeEventTypes(tx, ctx, { includeArchived: true }),
          members: await listTimeMemberOptions(tx, ctx),
          revisionsByEntry: visibleRevisionsByEntry,
          // F9.4 Slice D: gleicher Filter wie die Liste (WYSIWYG).
          utilization: await getTimeUtilization(tx, ctx, { projectId, userIds: selectedUserIds }),
          selectedUserIds,
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
        selectedUserIds={result.selectedUserIds}
        resetHref={`/w/${workspaceId}/anfragen/${projectId}/zeiterfassung`}
      />

      <div className="mt-4">
        <Link
          href={`/w/${workspaceId}/anfragen/${projectId}/zeiterfassung/export${
            result.selectedUserIds.length === 0
              ? ""
              : `?${result.selectedUserIds.map((id) => `userId=${encodeURIComponent(id)}`).join("&")}`
          }`}
          className="text-sm font-semibold text-blue-700 underline-offset-2 hover:underline"
        >
          CSV exportieren
        </Link>
      </div>

      <TimeEntryManager
        workspaceId={workspaceId}
        projectId={projectId}
        list={result.list}
        types={result.types}
        members={result.members}
        revisionsByEntry={result.revisionsByEntry}
        utilization={result.utilization}
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
