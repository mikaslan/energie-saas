import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { PackageTemplateDto } from "@/lib/integrations/offers/package-contract";
import { listPackageTemplates } from "@/modules/offers";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../../_ui";
import { PackageTemplateManager } from "./package-manager";

export const metadata: Metadata = {
  title: "Paket-Vorlagen | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function PackageTemplatesPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/paket-vorlagen">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let result:
    | {
      templates: PackageTemplateDto[];
      canWrite: boolean;
    }
    | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "discount_template.read",
      "package_template",
      async (tx, ctx) => ({
        templates: await listPackageTemplates(tx, ctx, { includeArchived: true }),
        canWrite: can(ctx, "discount_template.write"),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/paket-vorlagen`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Paket-Vorlagen sind für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Pakete konnten nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">
          Einstellungen
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Paket-Vorlagen</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Stücklisten-Presets je Paket — das Einsetzen an einer
          Angebotsvariante ersetzt die frei editierbare (Custom-)Ebene
          in einem Schritt; Katalog-Seed-Zeilen bleiben bestehen.
        </p>
      </div>

      <PackageTemplateManager
        workspaceId={workspaceId}
        templates={result.templates}
        canWrite={result.canWrite}
      />
    </main>
  );
}
