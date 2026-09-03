import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { GroupsOverview } from "./groups-overview";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { listDocumentGroups } from "@/modules/invoicing";
import { DeniedState } from "../_ui";

export const metadata: Metadata = {
  title: "Rechnungen & Dokumente | Energie-SaaS",
};

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function InvoicingGroupsPage(
  props: PageProps<"/w/[workspaceId]/rechnungen">,
) {
  const parsed = workspaceIdSchema.safeParse((await props.params).workspaceId);
  if (!parsed.success) notFound();
  const workspaceId = parsed.data;

  let groups;
  let canWrite = false;
  try {
    groups = await authorizedQuery(
      workspaceId,
      "invoicing.read",
      "commercial_document_group_list",
      (tx, ctx) => listDocumentGroups(tx, ctx),
    );
    // UI-Gating nur für die Schreibflächen — die Server-Actions bleiben die
    // eigentliche Sicherheitsgrenze.
    canWrite = await authorizedQuery(
      workspaceId,
      "invoicing.read",
      "commercial_document_group_list",
      async (tx, ctx) => can(ctx, "invoicing.write"),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({ next: `/w/${workspaceId}/rechnungen` }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Dokumentübersicht ist für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!groups) throw new Error("Gruppenübersicht konnte nicht geladen werden");

  return <GroupsOverview groups={groups} workspaceId={workspaceId} canWrite={canWrite} />;
}
