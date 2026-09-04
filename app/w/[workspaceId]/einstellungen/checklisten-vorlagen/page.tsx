import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { ChecklistTemplateDto } from "@/lib/integrations/checklists/template-contract";
import { listChecklistTemplates } from "@/modules/checklists";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { sql } from "drizzle-orm";
import { DeniedState } from "../../_ui";
import { ChecklistTemplateManager } from "./template-manager";

export const metadata: Metadata = {
  title: "Checklisten-Vorlagen | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function ChecklistTemplatesPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/checklisten-vorlagen">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let result:
    | { templates: ChecklistTemplateDto[]; components: Array<{ id: string; sku: string }>; canWrite: boolean }
    | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "checklist.read",
      "checklist_template",
      async (tx, ctx) => {
        const componentRows = await tx.execute<{ id: string; internal_sku: string }>(sql`
          select id, internal_sku from catalog_component
           where workspace_id = ${ctx.workspaceId}::uuid
             and archived_at is null
           order by internal_sku asc, id asc
           limit 200
        `);
        return {
          templates: await listChecklistTemplates(tx, ctx, { includeArchived: true }),
          components: componentRows.rows.map((row) => ({ id: row.id, sku: row.internal_sku })),
          canWrite: can(ctx, "checklist.write"),
        };
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/checklisten-vorlagen`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Checklisten-Vorlagen sind für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Vorlagen konnten nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
          Einstellungen
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Checklisten-Vorlagen</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Vorlagen aus deinem Katalog — am Projekt wird daraus eine
          Material-Checkliste erzeugt.
        </p>
      </div>

      <ChecklistTemplateManager
        workspaceId={workspaceId}
        templates={result.templates}
        components={result.components}
        canWrite={result.canWrite}
      />

      <div className="mt-6">
        <Link
          href={`/w/${workspaceId}/einstellungen/ereignistypen`}
          className="text-sm font-semibold text-blue-700 underline-offset-2 hover:underline"
        >
          Zu den Ereignistypen
        </Link>
      </div>
    </main>
  );
}
