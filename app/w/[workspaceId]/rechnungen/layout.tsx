import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { InvoicingNav } from "./rechnungen-nav";

export const metadata: Metadata = {
  title: "Rechnungen & Dokumente | Energie-SaaS",
};

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function InvoicingAreaLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const parsed = workspaceIdSchema.safeParse((await params).workspaceId);
  if (!parsed.success) notFound();

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
          Rechnungen &amp; Dokumente
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          Belege ausstellen, versenden und auswerten
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Rechnungen, Gutschriften, Auftragsbestätigungen, Bestellungen,
          Lieferscheine und Briefe in einem Bereich verwalten.
        </p>
      </div>
      <InvoicingNav workspaceId={parsed.data} />
      {children}
    </main>
  );
}
