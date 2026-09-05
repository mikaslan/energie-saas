import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { PaymentOptionDto } from "@/lib/integrations/offers/contract";
import { listPaymentOptions } from "@/modules/offers";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../../_ui";
import { PaymentOptionManager } from "./payment-option-manager";

export const metadata: Metadata = {
  title: "Zahlarten | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function PaymentOptionsPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/zahlarten">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let result: { options: PaymentOptionDto[]; canWrite: boolean } | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "payment_option.read",
      "payment_option",
      async (tx, ctx) => ({
        options: await listPaymentOptions(tx, ctx, { includeArchived: true }),
        // Explizit vom Server: eine leere Liste trägt sonst keine
        // Schreibrechts-Auskunft in sich.
        canWrite: can(ctx, "payment_option.write"),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/zahlarten`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Zahlarten sind für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Zahlarten konnten nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
          Einstellungen
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Zahlarten</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Kauf, Finanzierung oder Leasing — reine Anzeige an der
          Angebotsvariante, ohne Provider-Anbindung und ohne
          Ratenberechnung.
        </p>
      </div>
      <PaymentOptionManager
        workspaceId={workspaceId}
        options={result.options}
        canWrite={result.canWrite}
      />
    </main>
  );
}
