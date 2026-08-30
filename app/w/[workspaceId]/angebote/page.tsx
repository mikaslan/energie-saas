import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { DeniedState } from "../anfragen/[projectId]/_ui";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { listOffers } from "@/modules/offers";
import { OfferListView } from "./offer-list-view";

export const metadata: Metadata = {
  title: "Angebote | WMEE Vertrieb",
};

const workspaceIdSchema = z.uuid();

export default async function OffersPage(
  props: PageProps<"/w/[workspaceId]/angebote">,
) {
  const { workspaceId } = await props.params;
  const parsedWorkspaceId = workspaceIdSchema.safeParse(workspaceId);
  if (!parsedWorkspaceId.success) notFound();
  const validWorkspaceId = parsedWorkspaceId.data;

  let view: Awaited<ReturnType<typeof listOffers>> | undefined;
  try {
    view = await authorizedQuery(
      validWorkspaceId,
      "project.read",
      "offer_list",
      (tx, ctx) => listOffers(tx, ctx),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      const nextPath = `/w/${validWorkspaceId}/angebote`;
      redirect(`/login?${new URLSearchParams({ next: nextPath }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Angebotsübersicht ist für dich nicht freigegeben." />;
    }
    throw error;
  }

  if (!view) throw new Error("Angebotsübersicht konnte nicht geladen werden");
  return <OfferListView view={view} />;
}
