import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { SignOutButton } from "@/app/_components/sign-out-button";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { assertCatalogImportAccess } from "@/modules/catalog";
import { DeniedState } from "../../_ui";
import { ImportWizard } from "./import-wizard";

export const metadata: Metadata = { title: "CSV-Katalogimport | Energie-SaaS" };

const paramsSchema = z.strictObject({ workspaceId: z.uuid() });

async function authorizeImportPage(workspaceId: string): Promise<
  "allowed" | "unauthenticated" | "denied"
> {
  try {
    return await authorizedQuery(
      workspaceId,
      "catalog.manage",
      "catalog_import_page",
      async (_tx, ctx) => {
        assertCatalogImportAccess(ctx);
        return "allowed" as const;
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return "unauthenticated";
    if (error instanceof PermissionDeniedError) return "denied";
    throw error;
  }
}

export default async function CatalogImportPage({
  params,
}: PageProps<"/w/[workspaceId]/katalog/import">) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { workspaceId } = parsed.data;
  const pagePath = `/w/${workspaceId}/katalog/import`;
  const access = await authorizeImportPage(workspaceId);
  if (access === "unauthenticated") {
    redirect(`/login?next=${encodeURIComponent(pagePath)}`);
  }
  if (access === "denied") {
    return <DeniedState title="Der CSV-Katalogimport ist für dich nicht freigegeben." />;
  }

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <nav aria-label="Bereichsnavigation" className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <Link href={`/w/${workspaceId}/katalog`} className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
            <span aria-hidden="true" className="mr-2">←</span>
            Zum Produktkatalog
          </Link>
          <SignOutButton />
        </nav>

        <header className="mb-8 border-b border-slate-200 pb-7">
          <p className="text-sm font-semibold text-blue-700">Eigene oder autorisierte Produktdaten</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
            Produktkatalog aus CSV vorbereiten
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Prüfe Datei, Zeichencodierung und Spaltenzuordnung, bevor ein
            revisionsgebundener Import angelegt wird. Die Rohdatei wird für
            Prüfen und Vorschau verschlüsselt übertragen, aber nicht gespeichert.
          </p>
        </header>

        <div className="mb-6 flex flex-wrap gap-3">
          <a href={`${pagePath}/vorlage`} className="inline-flex min-h-11 items-center rounded-md border border-blue-700 bg-white px-4 py-2 text-sm font-semibold text-blue-800 outline-none hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
            CSV-Vorlage herunterladen
          </a>
        </div>

        <ImportWizard workspaceId={workspaceId} />
      </div>
    </main>
  );
}
