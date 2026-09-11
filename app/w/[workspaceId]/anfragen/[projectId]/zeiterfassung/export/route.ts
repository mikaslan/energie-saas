import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { exportTimeEntries } from "@/modules/time-tracking";
import { TimeTrackingNotFoundError, TimeTrackingValidationError } from "@/modules/time-tracking";

export const dynamic = "force-dynamic";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const projectIdSchema = z.uuid();

// F9.4 Slice A CSV-Export: userId als wiederholter oder komma-getrennter
// Query-Param (max 50). Anders als die Listenansicht (tolerant) wirft der
// Export bei UNGÜLTIGEN UUIDs 400 statt still ALLE Nutzer zu exportieren
// (Review Welle 03: stiller Export-Filter-Fallback). F9-09: dazu
// startDate/endDate (YYYY-MM-DD) und eventTypeId (gleiche Strenge: ungültig
// → 400, vorhanden-aber-leer → kein Filter).
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

type ExportFilters = {
  userIds: string[];
  startDate?: string;
  endDate?: string;
  eventTypeIds: string[];
};

function parseUuidListStrict(raw: URLSearchParams, name: string): string[] {
  const values = raw.getAll(name);
  if (values.length === 0) return [];
  const tokens = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim());
  // F9.4-Semantik: vorhandener, aber leerer/ungültiger Param → 400
  // (kein stiller Fallback auf „alle“).
  if (tokens.length === 0 || tokens.some((value) => !z.uuid().safeParse(value).success)) {
    throw new TimeTrackingValidationError();
  }
  return [...new Set(tokens)].slice(0, 50);
}

function parseExportFilters(raw: URLSearchParams): ExportFilters {
  const parseDate = (name: string): string | undefined => {
    const value = raw.get(name);
    if (value === null || value === "") return undefined;
    if (!localDateSchema.safeParse(value).success) throw new TimeTrackingValidationError();
    return value;
  };
  return {
    userIds: parseUuidListStrict(raw, "userId"),
    startDate: parseDate("startDate"),
    endDate: parseDate("endDate"),
    eventTypeIds: parseUuidListStrict(raw, "eventTypeId"),
  };
}

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string; projectId: string }> },
): Promise<Response> {
  const route = z.object({ workspaceId: workspaceIdSchema, projectId: projectIdSchema })
    .safeParse(await context.params);
  if (!route.success) {
    return new Response("Nicht gefunden", { status: 404, headers: PRIVATE_HEADERS });
  }
  const { workspaceId, projectId } = route.data;

  try {
    const filters = parseExportFilters(new URL(request.url).searchParams);
    // Nur gesetzte F9-09-Filter weiterreichen (F9.4-Call-Shape unverändert,
    // wenn kein Datums-/Typ-Filter aktiv ist).
    const exportQuery: {
      projectId: string;
      userIds: string[];
      startDate?: string;
      endDate?: string;
      eventTypeIds?: string[];
    } = { projectId, userIds: filters.userIds };
    if (filters.startDate !== undefined) exportQuery.startDate = filters.startDate;
    if (filters.endDate !== undefined) exportQuery.endDate = filters.endDate;
    if (filters.eventTypeIds.length > 0) exportQuery.eventTypeIds = filters.eventTypeIds;
    const csv = await authorizedQuery(
      workspaceId,
      "time.read",
      "time_tracking_export",
      (tx, ctx) => exportTimeEntries(tx, ctx, exportQuery),
    );
    return new Response(csv.content, {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": csv.contentType,
        "Content-Disposition": `attachment; filename="${csv.fileName}"`,
        "Content-Security-Policy": "sandbox; default-src 'none'",
      },
    });
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return new Response("Nicht angemeldet", { status: 401, headers: PRIVATE_HEADERS });
    }
    if (error instanceof PermissionDeniedError) {
      return new Response("Nicht freigegeben", { status: 403, headers: PRIVATE_HEADERS });
    }
    if (error instanceof TimeTrackingValidationError) {
      return new Response("Ungültiger Filter", { status: 400, headers: PRIVATE_HEADERS });
    }
    if (error instanceof TimeTrackingNotFoundError) {
      return new Response("Nicht gefunden", { status: 404, headers: PRIVATE_HEADERS });
    }
    throw error;
  }
}
