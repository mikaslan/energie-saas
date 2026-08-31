import Link from "next/link";

export default function CatalogImportNotFound() {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12">
      <div role="alert" className="mx-auto max-w-xl rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-950">Import nicht gefunden</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">Der Import existiert nicht oder ist in diesem Workspace nicht sichtbar.</p>
        <Link href="../.." className="mt-5 inline-flex min-h-11 items-center font-semibold text-blue-700">Zum Produktkatalog</Link>
      </div>
    </main>
  );
}
