import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { exportProjectlessTimeEntries } from "@/modules/time-tracking";
import { TimeTrackingNotFoundError, TimeTrackingValidationError } from "@/modules/time-tracking";

export const dynamic = "force-dynamic";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

// F9-15 (R1b): Muster Projekt-Export-Route — userId als wiederholter oder
// komma-getrennter Query-Param (max 50), dazu startDate/endDate (YYYY-MM-DD)
// und eventTypeId. Strenge-Semantik wie dort: vorhandener, aber
// leerer/ungültiger Param → 400 (kein stiller Fallback auf „alle").
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
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const route = z.object({ workspaceId: workspaceIdSchema })
    .safeParse(await context.params);
  if (!route.success) {
    return new Response("Nicht gefunden", { status: 404, headers: PRIVATE_HEADERS });
  }
  const { workspaceId } = route.data;

  try {
    const filters = parseExportFilters(new URL(request.url).searchParams);
    const exportQuery: {
      userIds: string[];
      startDate?: string;
      endDate?: string;
      eventTypeIds?: string[];
    } = { userIds: filters.userIds };
    if (filters.startDate !== undefined) exportQuery.startDate = filters.startDate;
    if (filters.endDate !== undefined) exportQuery.endDate = filters.endDate;
    if (filters.eventTypeIds.length > 0) exportQuery.eventTypeIds = filters.eventTypeIds;
    const csv = await authorizedQuery(
      workspaceId,
      "time.read",
      "time_tracking_export",
      (tx, ctx) => exportProjectlessTimeEntries(tx, ctx, exportQuery),
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
