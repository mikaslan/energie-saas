import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type {
  TimeMemberOption,
  TimeUtilizationDto,
} from "@/lib/integrations/time-tracking/contract";
import { calendarDaySchema } from "@/lib/integrations/time-tracking/contract";
import {
  getWorkspaceTimeUtilization,
  listTimeMemberOptions,
} from "@/modules/time-tracking";
import { PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../_ui";
import { TeamFilterForm } from "./team-filter-form";

export const metadata: Metadata = {
  title: "Team-Auslastung",
};

const routeParamsSchema = z.object({
  workspaceId: z.uuid(),
});

// F9-11: userId als wiederholter oder komma-getrennter Query-Param; nur
// wohlgeformte UUIDs (max 50) erreichen den Service. startDate/endDate
// (YYYY-MM-DD) tolerant: ungueltig → leer, Service bleibt strikt.
const filterParamsSchema = z.object({
  userId: z.union([z.string(), z.array(z.string())]).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

type TeamAuslastungFilters = {
  userIds: string[];
  startDate?: string;
  endDate?: string;
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

function parseFilters(raw: unknown): TeamAuslastungFilters {
  const parsed = filterParamsSchema.safeParse(raw);
  if (!parsed.success) return { userIds: [] };
  // Tolerant (P1-Review): kalendarisch ungueltige Tage (z. B. 2026-02-30)
  // fallen auf leer zurueck statt 500 — gleiche Pruefung wie der Service.
  const startDate = parsed.data.startDate !== undefined && calendarDaySchema.safeParse(parsed.data.startDate).success
    ? parsed.data.startDate
    : undefined;
  const endDate = parsed.data.endDate !== undefined && calendarDaySchema.safeParse(parsed.data.endDate).success
    ? parsed.data.endDate
    : undefined;
  // Tolerant: umgekehrter Zeitraum → leer statt Service-Fehler.
  if (startDate !== undefined && endDate !== undefined && startDate > endDate) {
    return { userIds: parseUuidList(parsed.data.userId) };
  }
  return { userIds: parseUuidList(parsed.data.userId), startDate, endDate };
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} Std. ${m} Min.` : `${m} Min.`;
}

export default async function TeamAuslastungPage(
  props: PageProps<"/w/[workspaceId]/team-auslastung">,
) {
  const params = routeParamsSchema.safeParse(await props.params);
  if (!params.success) notFound();
  const { workspaceId } = params.data;
  const filters = parseFilters(await props.searchParams);

  let result:
    | { utilization: TimeUtilizationDto; members: TimeMemberOption[]; filters: TeamAuslastungFilters }
    | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "time.read",
      "time_tracking",
      async (tx, ctx) => {
        // Permission-Gate ZUERST: getWorkspaceTimeUtilization wirft fuer
        // externe Nutzer PermissionDeniedError — vor jedem weiteren Lookup.
        const utilization = await getWorkspaceTimeUtilization(tx, ctx, {
          userIds: filters.userIds,
          startDate: filters.startDate,
          endDate: filters.endDate,
        });
        const members = await listTimeMemberOptions(tx, ctx);
        return { utilization, members, filters };
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/team-auslastung`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Team-Auslastung ist für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Team-Auslastung konnte nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">
          Workspace
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Team-Auslastung</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Gebuchte Arbeitszeiten je Mitglied, über alle Projekte hinweg.
        </p>
      </div>

      <TeamFilterForm
        members={result.members}
        selectedUserIds={result.filters.userIds}
        startDate={result.filters.startDate ?? ""}
        endDate={result.filters.endDate ?? ""}
        resetHref={`/w/${workspaceId}/team-auslastung`}
      />

      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-950">Auslastung</h2>
        {result.utilization.rows.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Keine Einträge im Filter.
          </p>
        ) : (
          <table className="mt-3 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th scope="col" className="py-2 pr-3 font-semibold">Mitglied</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Einträge</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Summe</th>
                <th scope="col" className="py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {result.utilization.rows.map((row) => (
                <tr key={row.userId} className="border-b border-slate-100 last:border-0">
                  <td className="min-w-0 max-w-full break-all py-2 pr-3 font-semibold text-slate-900">{row.label}</td>
                  <td className="py-2 pr-3 text-slate-700">{row.entryCount}</td>
                  <td className="py-2 pr-3 text-slate-700">{formatDuration(row.totalWorkingMinutes)}</td>
                  <td className="py-2 text-slate-700">{row.running ? "läuft" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
