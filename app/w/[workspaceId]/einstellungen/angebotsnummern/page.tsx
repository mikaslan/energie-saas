import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { OfferNumberFormatDto } from "@/lib/integrations/offers/contract";
import { getOfferNumberFormat } from "@/modules/offers";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../../_ui";
import { NumberFormatManager } from "./number-format-manager";

export const metadata: Metadata = {
  title: "Angebotsnummern | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function OfferNumberFormatPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/angebotsnummern">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let result: { format: OfferNumberFormatDto; canWrite: boolean } | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "offer_number_format.read",
      "workspace_offer_number_format",
      async (tx, ctx) => ({
        format: await getOfferNumberFormat(tx, ctx),
        canWrite: can(ctx, "offer_number_format.write"),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/angebotsnummern`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Das Nummernformat ist für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Nummernformat konnte nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">
          Einstellungen
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Angebotsnummern</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Prefix und Stellenanzahl für neue Angebotsnummern. Das Format gilt
          für neu angelegte Serien-Jahre; bestehende Nummern bleiben
          unverändert.
        </p>
      </div>
      <NumberFormatManager
        workspaceId={workspaceId}
        format={result.format}
        canWrite={result.canWrite}
      />
    </main>
  );
}
