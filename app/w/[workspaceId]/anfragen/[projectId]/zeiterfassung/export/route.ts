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
// (Review Welle 03: stiller Export-Filter-Fallback).
const filterParamsSchema = z.object({
  userId: z.union([z.string(), z.array(z.string())]).optional(),
});

function parseUserFilter(raw: URLSearchParams): string[] {
  const values = raw.getAll("userId");
  if (values.length === 0) return [];
  const parsed = filterParamsSchema.safeParse({ userId: values });
  if (!parsed.success || parsed.data.userId === undefined) throw new TimeTrackingValidationError();
  const rawValues = Array.isArray(parsed.data.userId) ? parsed.data.userId : [parsed.data.userId];
  const tokens = rawValues
    .flatMap((value) => value.split(","))
    .map((value) => value.trim());
  if (tokens.some((value) => !z.uuid().safeParse(value).success)) {
    throw new TimeTrackingValidationError();
  }
  return [...new Set(tokens)].slice(0, 50);
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
    const userIds = parseUserFilter(new URL(request.url).searchParams);
    const csv = await authorizedQuery(
      workspaceId,
      "time.read",
      "time_tracking_export",
      (tx, ctx) => exportTimeEntries(tx, ctx, { projectId, userIds }),
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
