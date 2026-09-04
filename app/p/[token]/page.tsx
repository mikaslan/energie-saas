import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { publicTokenCapsule } from "@/lib/action";
import { derivePortalNextStep } from "@/lib/integrations/portal/portal-contract";
import { PortalNotFoundError, resolvePortalByToken } from "@/modules/portal";

export const metadata: Metadata = {
  title: "Kundenportal",
  robots: { index: false, follow: false },
};

// F10.1: öffentliche Projektion (read-only). Unbekannt/deformiert/entzogen/
// abgelaufen -> identischer 404-Endzustand („Link ungültig", kein Orakel).
export default async function PortalTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  let view;
  try {
    view = await publicTokenCapsule((pool) => resolvePortalByToken(pool, { token }));
  } catch (error) {
    if (error instanceof PortalNotFoundError) notFound();
    throw error;
  }
  const nextStep = derivePortalNextStep(view.project.phase, view.project.outcome);
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl items-center px-6 py-12">
      <section
        className="w-full rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
        aria-live="polite"
      >
        <p className="text-sm font-semibold text-blue-700">Kundenportal</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">{view.project.name}</h1>
        <dl className="mt-4 space-y-2 text-sm leading-6 text-slate-600">
          <div className="flex gap-2">
            <dt className="font-semibold text-slate-800">Stand:</dt>
            <dd>{nextStep}</dd>
          </div>
        </dl>
        <h2 className="mt-6 text-lg font-semibold text-slate-950">Dokumente</h2>
        {view.documents.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Aktuell liegen keine freigegebenen Dokumente vor.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-200 rounded-md border border-slate-200">
            {view.documents.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="text-sm font-medium text-slate-800">
                  Angebot {doc.offerNumber}
                </span>
                <span className="text-sm text-slate-500">{doc.documentDate}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
