import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { OfferTemplateDto } from "@/lib/integrations/offers/template-contract";
import { listOfferTemplates } from "@/modules/offers";
import { listPaymentOptions } from "@/modules/offers";
import { listDiscountTemplates } from "@/modules/discounts";
import { listSubsidyTemplates } from "@/modules/subsidies";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../../_ui";
import { OfferTemplateManager, type OfferTemplatePresetOption } from "./template-manager";

export const metadata: Metadata = {
  title: "Angebots-Vorlagen | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function OfferTemplatesPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/angebots-vorlagen">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let result:
    | {
      templates: OfferTemplateDto[];
      paymentOptions: OfferTemplatePresetOption[];
      discountTemplates: OfferTemplatePresetOption[];
      subsidyTemplates: OfferTemplatePresetOption[];
      canWrite: boolean;
    }
    | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "discount_template.read",
      "offer_template",
      async (tx, ctx) => ({
        templates: await listOfferTemplates(tx, ctx, { includeArchived: true }),
        paymentOptions: (await listPaymentOptions(tx, ctx, { includeArchived: true })).map((option) => ({
          id: option.id,
          label: option.label,
          detail: option.kind,
          usable: option.archivedAt === null,
        })),
        discountTemplates: (await listDiscountTemplates(tx, ctx, { includeArchived: true })).map((template) => ({
          id: template.id,
          label: template.kind === "percent_bps" && template.percentBps !== null
            ? `${template.name} (${(template.percentBps / 100).toLocaleString("de-DE")} %)`
            : template.kind === "fix_cents" && template.amountCents !== null
              ? `${template.name} (${(template.amountCents / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" })})`
              : template.name,
          detail: template.kind,
          usable: template.active,
        })),
        subsidyTemplates: (await listSubsidyTemplates(tx, ctx, { includeArchived: true })).map((template) => ({
          id: template.id,
          label: template.kind === "percent_bps" && template.percentBps !== null
            ? `${template.name} (${(template.percentBps / 100).toLocaleString("de-DE")} %)`
            : template.kind === "fix_cents" && template.amountCents !== null
              ? `${template.name} (${(template.amountCents / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" })})`
              : template.name,
          detail: template.kind,
          usable: template.active,
        })),
        canWrite: can(ctx, "discount_template.write"),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/angebots-vorlagen`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Angebots-Vorlagen sind für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Vorlagen konnten nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">
          Einstellungen
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Angebots-Vorlagen</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Zahlart-, Rabatt- und Förder-Presets je Vorlage — das Anwenden an einer
          Angebotsvariante setzt Zahlart, Global-Rabatt und Förderung in einem Schritt.
        </p>
      </div>

      <OfferTemplateManager
        workspaceId={workspaceId}
        templates={result.templates}
        paymentOptions={result.paymentOptions}
        discountTemplates={result.discountTemplates}
        subsidyTemplates={result.subsidyTemplates}
        canWrite={result.canWrite}
      />
    </main>
  );
}
