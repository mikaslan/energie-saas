import type { Metadata } from "next";
import Link from "next/link";
import { MOBILE_MORE_LINKS } from "@/lib/mobile/tabs";

export const metadata: Metadata = {
  title: "Mehr | Energie-SaaS",
};

// F11-05: Hub-Seite des Mehr-Tabs — verlinkt nur bestehende Bereiche.
// Keine AR/Chat/Assistant-Einträge (Tote-Links-Verbot, s. Spec).
export default async function MorePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">
        Workspace
      </p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">Mehr</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
        Alle weiteren Bereiche dieses Workspace auf einen Blick.
      </p>
      <ul data-testid="more-links" className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {MOBILE_MORE_LINKS.map((link) => (
          <li
            key={link.segment}
            className="min-w-0 rounded-lg border border-slate-200 bg-white shadow-sm"
          >
            <Link
              href={`/w/${workspaceId}/${link.segment}`}
              className="flex min-h-11 items-center px-4 py-3 text-sm font-semibold text-slate-900 outline-none hover:text-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
