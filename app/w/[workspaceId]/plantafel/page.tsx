import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Fragment } from "react";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { can, PermissionDeniedError } from "@/lib/permissions";
import {
  getPlanningBoard,
  listAppointmentProjectOptions,
  listVisibleCalendars,
  type CalendarItemV1,
  type PlanningBoardDto,
  type PlanningBoardProjectOption,
} from "@/modules/calendar";
import { AppointmentValidationError } from "@/modules/calendar";
import { listTeamMemberships, listTeamOptions, type TeamMembership, type TeamOption } from "@/modules/teams";
import { DeniedState } from "../_ui";
import { PlanningBoardAssignForm } from "./planning-board-assign-form";
import { PlanningBoardCreateForm } from "./planning-board-create-form";

export const metadata: Metadata = {
  title: "Plantafel",
};

type BoardSection = {
  key: string;
  title: string;
  rows: PlanningBoardDto["rows"];
};

// F7-07: Spaltengruppierung je Primär-Team (erster Teamname alphabetisch —
// der Service liefert nach Teamname sortiert; Mehrfach-Mitglieder erscheinen
// einmal). null = ohne Leserecht → flache Ansicht wie bisher (kein
// vorgetäuschtes Wissen). Leere Zuordnung → ebenfalls flach (kein Rauschen).
function groupBoardRows(
  rows: PlanningBoardDto["rows"],
  memberships: TeamMembership[] | null,
): BoardSection[] | null {
  if (memberships === null || memberships.length === 0) return null;
  const primary = new Map<string, { teamId: string; teamName: string }>();
  for (const membership of memberships) {
    if (!primary.has(membership.membershipId)) {
      primary.set(membership.membershipId, {
        teamId: membership.teamId,
        teamName: membership.teamName,
      });
    }
  }
  const sections = new Map<string, BoardSection>();
  const unassigned: PlanningBoardDto["rows"] = [];
  for (const row of rows) {
    if (row.membershipId === null) {
      unassigned.push(row);
      continue;
    }
    const team = primary.get(row.membershipId);
    const key = team ? `team:${team.teamId}` : "noteam";
    const title = team ? team.teamName : "Ohne Team";
    const section = sections.get(key) ?? { key, title, rows: [] };
    section.rows.push(row);
    sections.set(key, section);
  }
  const ordered = [...sections.values()].sort((a, b) =>
    a.title === "Ohne Team"
      ? 1
      : b.title === "Ohne Team"
        ? -1
        : a.title.localeCompare(b.title, "de"),
  );
  if (unassigned.length > 0) {
    ordered.push({ key: "unassigned", title: "Nicht zugeordnet", rows: unassigned });
  }
  return ordered;
}

const workspaceIdSchema = z.uuid();
const eventIdSchema = z.uuid();

const calendarDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((v) => {
    const [year, month, day] = v.split("-").map(Number);
    const probe = new Date(Date.UTC(year!, month! - 1, day!));
    return probe.getUTCFullYear() === year
      && probe.getUTCMonth() === month! - 1
      && probe.getUTCDate() === day;
  });

// F7-05 Plantafel (Slice 1, Lesepfad): Wochengrid je Mitglied aus
// bestehenden Terminen + Event-Drawer mit Projekt-Link. ?week= ist ein
// beliebiger Tag der Woche (Service normalisiert auf Montag, Berlin);
// ungültig → laufende Woche (tolerant wie F9-Listenfilter).
const berlinWeekdayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  weekday: "short",
});

const MONDAY_BASED = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function berlinMondayOf(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const anchorMs = Date.UTC(year!, month! - 1, date!, 12);
  const weekday = berlinWeekdayFormatter.format(new Date(anchorMs));
  const sinceMonday = MONDAY_BASED.indexOf(weekday as (typeof MONDAY_BASED)[number]);
  const safeOffset = sinceMonday < 0 ? 0 : sinceMonday;
  return new Date(anchorMs - safeOffset * 86_400_000).toISOString().slice(0, 10);
}

function addDays(day: string, offset: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date!, 12) + offset * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function berlinToday(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "01";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const dayHeaderFormatter = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  timeZone: "UTC",
});

function dayHeader(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return dayHeaderFormatter.format(new Date(Date.UTC(year!, month! - 1, date!, 12)));
}

function wallTime(wall: string): string {
  return wall.length >= 16 ? wall.slice(11, 16) : wall;
}

const APPOINTMENT_TYPE_LABELS: Record<string, string> = {
  on_site: "Vor Ort",
  phone: "Telefon",
  installation: "Installation",
  maintenance: "Wartung",
  consultation: "Beratung",
  other: "Sonstiges",
};

export default async function PlanningBoardPage(
  props: PageProps<"/w/[workspaceId]/plantafel">,
) {
  const params = z.object({ workspaceId: workspaceIdSchema }).safeParse(await props.params);
  if (!params.success) notFound();
  const { workspaceId } = params.data;
  const query = await props.searchParams;
  const rawWeek = Array.isArray(query.week) ? query.week[0] : query.week;
  const rawEvent = Array.isArray(query.event) ? query.event[0] : query.event;
  const monday = berlinMondayOf(
    rawWeek !== undefined && calendarDaySchema.safeParse(rawWeek).success
      ? rawWeek
      : berlinToday(),
  );
  const selectedEventId = rawEvent !== undefined && eventIdSchema.safeParse(rawEvent).success
    ? rawEvent.toLowerCase()
    : null;
  const rawCreate = Array.isArray(query.create) ? query.create[0] : query.create;
  const rawMember = Array.isArray(query.member) ? query.member[0] : query.member;
  const createDate = rawCreate !== undefined && calendarDaySchema.safeParse(rawCreate).success
    ? rawCreate
    : null;
  const createMemberId = rawMember !== undefined && eventIdSchema.safeParse(rawMember).success
    ? rawMember.toLowerCase()
    : null;

  let board: PlanningBoardDto;
  let calendars: CalendarItemV1[];
  let projectOptions: PlanningBoardProjectOption[];
  let teams: TeamOption[];
  let memberships: TeamMembership[] | null;
  let canWrite = false;
  try {
    const loaded = await authorizedQuery(
      workspaceId,
      "appointment.read",
      "planning_board",
      async (tx, ctx) => {
        const loadedBoard = await getPlanningBoard(tx, ctx, { weekStart: monday });
        // Kalender-/Projekt-/Teamlisten sind eigene Grants: fehlt einer,
        // bleibt das Board lesbar und nur die jeweilige Steuerung entfällt.
        const loadedCalendars = await listVisibleCalendars(tx, ctx).catch((error: unknown) => {
          if (error instanceof PermissionDeniedError) return [];
          throw error;
        });
        const loadedOptions = await listAppointmentProjectOptions(tx, ctx).catch((error: unknown) => {
          if (error instanceof PermissionDeniedError) return [];
          throw error;
        });
        const loadedTeams = await listTeamOptions(tx, ctx).catch((error: unknown) => {
          if (error instanceof PermissionDeniedError) return [];
          throw error;
        });
        // F7-07: Zugehörigkeit für die Spaltengruppierung; ohne Grant ehrlich
        // flach (null), nicht geraten.
        const loadedMemberships = await listTeamMemberships(tx, ctx).catch((error: unknown) => {
          if (error instanceof PermissionDeniedError) return null;
          throw error;
        });
        return {
          board: loadedBoard,
          calendars: loadedCalendars,
          projectOptions: loadedOptions,
          teams: loadedTeams,
          memberships: loadedMemberships,
          canWrite: can(ctx, "appointment.write"),
        };
      },
    );
    board = loaded.board;
    calendars = loaded.calendars;
    projectOptions = loaded.projectOptions;
    teams = loaded.teams;
    memberships = loaded.memberships;
    canWrite = loaded.canWrite;
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({ next: `/w/${workspaceId}/plantafel` }).toString()}`);
    }
    if (error instanceof PermissionDeniedError || error instanceof AppointmentValidationError) {
      return <DeniedState title="Die Plantafel ist für dich nicht freigegeben." />;
    }
    throw error;
  }

  const selected = selectedEventId === null
    ? null
    : board.rows.flatMap((row) =>
        row.days.flatMap((day) =>
          day.entries.map((entry) => ({ row, day, entry })),
        ),
      ).find((item) => item.entry.id === selectedEventId) ?? null;

  const basePath = `/w/${workspaceId}/plantafel`;
  const prevWeek = addDays(board.weekStart, -7);
  const nextWeek = addDays(board.weekStart, 7);

  // F7-07: Zeilengruppierung je Primär-Team (null = flach wie bisher).
  const sections = groupBoardRows(board.rows, memberships);

  // F7-05 Slice 2: Anlageziel nur aus sichtbaren Zeilen/Tagen (kein Orakel,
  // keine wochenfremden Daten) — sonst kein Formular.
  const createRow = createMemberId === null
    ? null
    : board.rows.find((row) => row.membershipId === createMemberId) ?? null;
  const createDay = createDate === null || createRow === null
    ? null
    : createRow.days.find((day) => day.date === createDate) ?? null;
  const showCreateForm = canWrite && createRow !== null && createDay !== null;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <div className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8">
        <p className="text-sm text-slate-500">Ressourcen-Übersicht</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Plantafel</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Termine der Woche je Mitglied, gruppiert nach Team. Einträge tragen
          ihr Team als Chip; Zuweisung im Detail oder bei Anlage.
        </p>

        <nav aria-label="Woche wählen" className="mt-4 flex flex-wrap items-center gap-3">
          <Link
            href={`${basePath}?week=${prevWeek}`}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            ← Vorwoche
          </Link>
          <Link
            href={basePath}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Diese Woche
          </Link>
          <Link
            href={`${basePath}?week=${nextWeek}`}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Folgewoche →
          </Link>
          <span className="text-sm text-slate-600" aria-live="polite">
            Woche {board.weekStart} bis {board.weekEnd}
          </span>
        </nav>

        {board.rows.length === 0 ? (
          <p className="mt-6 rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-600">
            Keine Mitglieder gefunden.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th scope="col" className="w-56 px-3 py-2 text-left font-semibold text-slate-700">
                    Mitglied
                  </th>
                  {board.rows[0]!.days.map((day) => (
                    <th key={day.date} scope="col" className="px-2 py-2 text-left font-semibold text-slate-700">
                      {dayHeader(day.date)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(sections === null
                  ? [{ key: "flat", title: null as string | null, rows: board.rows }]
                  : sections
                ).map((section) => (
                  <Fragment key={section.key}>
                    {section.title !== null && (
                      <tr className="border-b border-slate-200 bg-emerald-50">
                        <th
                          scope="rowgroup"
                          colSpan={board.rows[0]!.days.length + 1}
                          data-testid={`planning-board-team-section-${section.key}`}
                          className="px-3 py-1.5 text-left text-xs font-bold uppercase tracking-wide text-emerald-900"
                        >
                          {section.title}
                        </th>
                      </tr>
                    )}
                    {section.rows.map((row) => (
                    <tr key={row.membershipId ?? "unassigned"} className="border-b border-slate-100 last:border-0">
                    <th scope="row" className="px-3 py-2 text-left font-medium text-slate-900">
                      {row.label}
                    </th>
                    {row.days.map((day) => (
                      <td key={day.date} className="px-2 py-2 align-top">
                        {day.entries.length === 0 && !(canWrite && row.membershipId !== null) ? (
                          <span className="text-xs text-slate-400">—</span>
                        ) : (
                          <ul className="flex flex-col gap-1">
                            {day.entries.map((entry) => (
                              <li key={entry.id}>
                                <Link
                                  href={`${basePath}?week=${board.weekStart}&event=${entry.id}`}
                                  className="block rounded border border-brand-200 bg-brand-50 px-2 py-1 text-xs text-brand-900 hover:bg-brand-100"
                                  title={`${entry.title} (${entry.projectName})${entry.teamName ? ` — Team ${entry.teamName}` : ""}`}
                                >
                                  <span className="font-semibold">
                                    {entry.allDay ? "Ganztägig" : wallTime(entry.start)}
                                  </span>{" "}
                                  <span>{entry.title}</span>
                                  {entry.teamName !== null && (
                                    <span
                                      data-testid={`planning-board-team-chip-${entry.id}`}
                                      className="ml-1 inline-block rounded bg-emerald-100 px-1 font-semibold text-emerald-900"
                                    >
                                      {entry.teamName}
                                    </span>
                                  )}
                                </Link>
                              </li>
                            ))}
                            {canWrite && row.membershipId !== null && (
                              <li>
                                <Link
                                  href={`${basePath}?week=${board.weekStart}&create=${day.date}&member=${row.membershipId}`}
                                  className="block rounded border border-dashed border-slate-300 px-2 py-1 text-center text-xs font-semibold text-slate-500 hover:bg-slate-50"
                                  aria-label={`Termin am ${day.date} für ${row.label} anlegen`}
                                >
                                  ＋
                                </Link>
                              </li>
                            )}
                          </ul>
                        )}
                      </td>
                    ))}
                    </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {showCreateForm && (
          <PlanningBoardCreateForm
            workspaceId={workspaceId}
            date={createDay!.date}
            memberId={createRow!.membershipId!}
            memberLabel={createRow!.label}
            projects={projectOptions}
            calendars={calendars}
            teams={teams}
            cancelHref={`${basePath}?week=${board.weekStart}`}
          />
        )}

        {selectedEventId !== null && (
          <section aria-label="Termindetails" className="mt-6 rounded-md border border-slate-200 bg-white px-4 py-4">
            {selected === null ? (
              <p className="text-sm text-slate-600">
                Dieser Termin ist nicht verfügbar (unbekannt oder nicht freigegeben).
              </p>
            ) : (
              <div>
                <h2 className="text-lg font-semibold text-slate-900">{selected.entry.title}</h2>
                <dl className="mt-2 grid max-w-2xl grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div className="flex gap-2">
                    <dt className="font-medium text-slate-500">Zeitraum:</dt>
                    <dd className="text-slate-900">
                      {selected.entry.allDay
                        ? `Ganztägig ab ${selected.day.date}`
                        : `${selected.day.date}, ${wallTime(selected.entry.start)}–${wallTime(selected.entry.end)} Uhr`}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium text-slate-500">Art:</dt>
                    <dd className="text-slate-900">
                      {APPOINTMENT_TYPE_LABELS[selected.entry.type] ?? selected.entry.type}
                    </dd>
                  </div>
                  {selected.entry.location !== null && (
                    <div className="flex gap-2">
                      <dt className="font-medium text-slate-500">Ort:</dt>
                      <dd className="text-slate-900">{selected.entry.location}</dd>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <dt className="font-medium text-slate-500">Kalender:</dt>
                    <dd className="text-slate-900">{selected.entry.calendarName ?? "—"}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium text-slate-500">Zugeordnet:</dt>
                    <dd className="text-slate-900">{selected.row.label}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium text-slate-500">Team:</dt>
                    <dd className="text-slate-900" data-testid="planning-board-drawer-team">
                      {selected.entry.teamName ?? "Ohne Team"}
                    </dd>
                  </div>
                </dl>
                {canWrite && (teams.length > 0 || selected.entry.teamId !== null) && (
                  <PlanningBoardAssignForm
                    workspaceId={workspaceId}
                    projectId={selected.entry.projectId}
                    appointmentId={selected.entry.id}
                    revision={selected.entry.revision}
                    start={selected.entry.start}
                    end={selected.entry.end}
                    currentTeamId={selected.entry.teamId}
                    currentTeamName={selected.entry.teamName}
                    teams={teams}
                  />
                )}
                <p className="mt-3 text-sm">
                  <Link
                    href={`/w/${workspaceId}/anfragen/${selected.entry.projectId}`}
                    className="font-semibold text-brand-700 underline-offset-2 hover:underline"
                  >
                    Zum Projekt „{selected.entry.projectName}“
                  </Link>
                </p>
                <p className="mt-2 text-sm">
                  <Link
                    href={`${basePath}?week=${board.weekStart}`}
                    className="text-slate-600 underline-offset-2 hover:underline"
                  >
                    Details schließen
                  </Link>
                </p>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
