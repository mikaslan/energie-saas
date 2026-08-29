import Link from "next/link";

export default function ProductsNotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl items-center px-6 py-12">
      <section className="w-full rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold text-blue-700">404 · Nicht gefunden</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">Die Projektauflösung ist nicht verfügbar.</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">Das Projekt existiert nicht oder gehört nicht zu diesem Workspace.</p>
        <Link href="/" className="mt-6 inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Zur Startseite</Link>
      </section>
    </main>
  );
}
