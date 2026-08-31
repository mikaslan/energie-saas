export default function CatalogImportDetailsLoading() {
  return (
    <main className="min-h-screen bg-slate-50" aria-busy="true">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="animate-pulse motion-reduce:animate-none h-6 w-40 rounded bg-slate-200" />
        <div className="mt-8 h-40 animate-pulse rounded-lg border border-slate-200 bg-white motion-reduce:animate-none" />
        <div className="mt-6 h-72 animate-pulse rounded-lg border border-slate-200 bg-white motion-reduce:animate-none" />
        <p className="sr-only">Importstatus wird geladen.</p>
      </div>
    </main>
  );
}
