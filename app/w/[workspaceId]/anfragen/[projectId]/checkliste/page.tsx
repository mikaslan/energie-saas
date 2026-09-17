import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { ProjectChecklistDto } from "@/lib/integrations/checklists/contract";
import { getProjectChecklist, listChecklistTemplates } from "@/modules/checklists";
import {
  formatWorkbookComponentsText,
  getInstallationWorkbook,
  projectWorkbookComponentSections,
  projectWorkbookDatasheets,
  type WorkbookComponentSection,
  type WorkbookDatasheetRef,
} from "@/modules/installations";
import { OfferIntegrityError } from "@/modules/offers";
import type { ChecklistTemplateDto } from "@/lib/integrations/checklists/template-contract";
import type { TeamOption } from "@/lib/integrations/teams/contract";
import { listTeamOptions } from "@/modules/teams";
import { PermissionDeniedError } from "@/lib/permissions";
import { sql } from "drizzle-orm";
import { DeniedState } from "../_ui";
import { ApplyTemplateSection, ProjectChecklistManager, ReapplyTemplateSection } from "./project-checklist-manager";

export const metadata: Metadata = {
  title: "Checkliste | Energie-SaaS",
};

const routeParamsSchema = z.object({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
});

export default async function ProjectChecklistPage(
  props: PageProps<"/w/[workspaceId]/anfragen/[projectId]/checkliste">,
) {
  const params = routeParamsSchema.safeParse(await props.params);
  if (!params.success) notFound();
  const { workspaceId, projectId } = params.data;

  let result:
    | { projectName: string; customerName: string; today: string; checklist: ProjectChecklistDto; templates: ChecklistTemplateDto[] }
    | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "checklist.read",
      "project_checklist",
      async (tx, ctx) => {
        // Permission-Gate ZUERST (M1-09-external_select_scope-Falle, vgl. F9.1).
        const checklist = await getProjectChecklist(tx, ctx, projectId);
        const projectRow = await tx.execute<{ name: string; customer_name: string | null }>(sql`
          select project_record.name, contact_record.display_name as customer_name
            from project project_record
            left join contact contact_record
              on contact_record.id = project_record.contact_id
             and contact_record.workspace_id = project_record.workspace_id
           where project_record.workspace_id = ${ctx.workspaceId}::uuid
             and project_record.id = ${projectId}::uuid
           limit 1
        `);
        if (!projectRow.rows[0]) {
          throw new ProjectNotFound();
        }
        return {
          projectName: projectRow.rows[0].name,
          // F7-03C: Platzhalter-Kontext (Server-seitig = hydrationssicher).
          // Fehlender Kontakt → "" (Muster bleiben ehrlich stehen).
          customerName: projectRow.rows[0].customer_name ?? "",
          today: new Date().toLocaleDateString("de-DE", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            timeZone: "Europe/Berlin",
          }),
          checklist,
          templates: await listChecklistTemplates(tx, ctx),
        };
      },
    );
  } catch (error) {
    if (error instanceof ProjectNotFound) notFound();
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/anfragen/${projectId}/checkliste`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Checkliste ist für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Checkliste konnte nicht geladen werden");

  // F7-05b: Team-Optionen für die Block-Zuweisung (calendar.read; ohne Recht
  // leere Auswahl — zugewiesene Teams bleiben über die Checkliste lesbar).
  let teamOptions: TeamOption[] = [];
  try {
    teamOptions = await authorizedQuery(workspaceId, "calendar.read", "team", (tx, ctx) =>
      listTeamOptions(tx, ctx));
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/anfragen/${projectId}/checkliste`,
      }).toString()}`);
    }
    if (!(error instanceof PermissionDeniedError)) throw error;
  }

  // F7-03E: Workbook-Stückliste für {{komponenten}} (separate Query,
  // F7-05b-Muster). Ohne Bindung, ohne Recht oder bei Integritätsfehler
  // leerer Text — das Muster steht ehrlich, die Checkliste crasht nie.
  let componentsText = "";
  try {
    componentsText = await authorizedQuery(
      workspaceId,
      "installation.read",
      "installation",
      async (tx, ctx) => {
        const workbook = await getInstallationWorkbook(tx, ctx, { projectId });
        if (!workbook) return "";
        return formatWorkbookComponentsText(workbook.sections);
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/anfragen/${projectId}/checkliste`,
      }).toString()}`);
    }
    if (!(error instanceof PermissionDeniedError) && !(error instanceof OfferIntegrityError)) {
      throw error;
    }
  }

  // F7-02J: strukturierte Stückliste für den Komponentenlisten-Punkt
  // (eigene Query im 03e-Muster). Ohne Bindung, ohne Recht oder bei
  // Integritätsfehler null — der Manager zeigt ehrlich den Fallback.
  let componentSections: WorkbookComponentSection[] | null = null;
  try {
    componentSections = await authorizedQuery(
      workspaceId,
      "installation.read",
      "installation",
      async (tx, ctx) => {
        const workbook = await getInstallationWorkbook(tx, ctx, { projectId });
        if (!workbook) return null;
        return projectWorkbookComponentSections(workbook.sections);
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/anfragen/${projectId}/checkliste`,
      }).toString()}`);
    }
    if (!(error instanceof PermissionDeniedError) && !(error instanceof OfferIntegrityError)) {
      throw error;
    }
  }

  // F7-02K: Datenblatt-Referenzen für den Datenblatt-Punkt (eigene
  // Query im 02j-Muster). Ohne Bindung, ohne Recht oder bei
  // Integritätsfehler null — der Manager zeigt ehrlich den Fallback.
  let datasheetRefs: WorkbookDatasheetRef[] | null = null;
  try {
    datasheetRefs = await authorizedQuery(
      workspaceId,
      "installation.read",
      "installation",
      async (tx, ctx) => {
        const workbook = await getInstallationWorkbook(tx, ctx, { projectId });
        if (!workbook) return null;
        return projectWorkbookDatasheets(workbook.sections);
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/anfragen/${projectId}/checkliste`,
      }).toString()}`);
    }
    if (!(error instanceof PermissionDeniedError) && !(error instanceof OfferIntegrityError)) {
      throw error;
    }
  }

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">
          Projektakte
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Checkliste</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Baustellen-Checkliste am Projekt „{result.projectName}“.
        </p>
      </div>

      <ApplyTemplateSection
        workspaceId={workspaceId}
        projectId={projectId}
        templates={result.templates}
        canWrite={result.checklist.permissions.canWrite}
        checklistVersion={result.checklist.version}
      />

      <ReapplyTemplateSection
        workspaceId={workspaceId}
        projectId={projectId}
        templates={result.templates}
        canMerge={result.checklist.permissions.canConfigure}
        canReset={result.checklist.permissions.canUnlock}
        checklistVersion={result.checklist.version}
      />

      <ProjectChecklistManager
        workspaceId={workspaceId}
        projectId={projectId}
        checklist={result.checklist}
        teamOptions={teamOptions}
        customerName={result.customerName}
        today={result.today}
        componentsText={componentsText}
        componentSections={componentSections}
        datasheetRefs={datasheetRefs}
      />

      <div className="mt-6">
        <Link
          href={`/w/${workspaceId}/anfragen/${projectId}`}
          className="text-sm font-semibold text-brand-800 underline-offset-2 hover:underline"
        >
          Zurück zur Projektakte
        </Link>
      </div>
    </main>
  );
}

class ProjectNotFound extends Error {
  constructor() {
    super("project not found");
    this.name = "ProjectNotFound";
  }
}
