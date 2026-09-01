import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  getGlobalTaskInboxPage,
  GlobalTaskInboxContractError,
  type GlobalTaskInboxPageV1,
} from "@/modules/tasks";
import { DeniedState } from "../anfragen/[projectId]/_ui";
import {
  globalTaskInboxHref,
  parseGlobalTaskInboxRouteQuery,
} from "./query";
import { GlobalTaskInboxView } from "./task-inbox-view";

// Das Root-Layout trägt bereits die Vorlage "%s · WMEE Vertrieb". Die Marke
// gehört hier deshalb nicht noch einmal in den Titel.
export const metadata: Metadata = {
  title: "Aufgaben",
};

const routeSchema = z.strictObject({
  workspaceId: z.uuid().transform((value) => value.toLowerCase()),
});

type LoadResult =
  | { kind: "loaded"; page: GlobalTaskInboxPageV1 }
  | { kind: "unauthenticated" }
  | { kind: "denied" }
  | { kind: "invalid" };

async function loadInbox(
  workspaceId: string,
  query: Parameters<typeof getGlobalTaskInboxPage>[2],
): Promise<LoadResult> {
  try {
    const page = await authorizedQuery(
      workspaceId,
      "task.read",
      "global_task_inbox",
      (tx, ctx) => getGlobalTaskInboxPage(tx, ctx, query),
    );
    return { kind: "loaded", page };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    // Query- und Cursorfehler stammen aus der Anfrage und sind ein ehrliches
    // 404. Ein Projektionsfehler entsteht dagegen im Server: er muss zur Error
    // Boundary hochgehen, damit ein Defekt beobachtbar bleibt, statt sich als
    // "Seite gibt es nicht" zu tarnen.
    if (error instanceof GlobalTaskInboxContractError) {
      if (error.code === "invalid_global_task_inbox_projection") throw error;
      return { kind: "invalid" };
    }
    throw error;
  }
}

export default async function GlobalTasksPage({
  params,
  searchParams,
}: PageProps<"/w/[workspaceId]/aufgaben">) {
  const parsedRoute = routeSchema.safeParse(await params);
  if (!parsedRoute.success) notFound();
  const query = parseGlobalTaskInboxRouteQuery(await searchParams);
  if (query === null) notFound();

  const { workspaceId } = parsedRoute.data;
  const result = await loadInbox(workspaceId, query);
  if (result.kind === "unauthenticated") {
    // `safeInternalNextPath` dekodiert den Zielpfad wiederholt, bis er stabil
    // ist. Ein wörtliches Prozentzeichen im Suchbegriff lässt
    // `decodeURIComponent` dabei werfen, und der Nutzer landet fail-closed auf
    // "/" statt in der Inbox. Die geschlossenen Filter, `asOf` und der
    // base64url-Cursor sind davon nie betroffen; nur der freie Suchtext ist es.
    // Er wird deshalb aus dem Rücksprungziel entfernt, damit die Anmeldung
    // verlässlich in die Inbox zurückführt.
    const next = globalTaskInboxHref(workspaceId, { ...query, query: null });
    redirect(`/login?${new URLSearchParams({ next }).toString()}`);
  }
  if (result.kind === "denied") {
    return <DeniedState title="Die Aufgaben-Inbox ist für dich nicht freigegeben." />;
  }
  if (result.kind === "invalid") notFound();

  return (
    <GlobalTaskInboxView
      workspaceId={workspaceId}
      page={result.page}
      continuation={query.cursor !== null}
    />
  );
}
