function Line({ className = "" }: { className?: string }) {
  return <div className={`h-4 animate-pulse rounded bg-slate-200 motion-reduce:animate-none ${className}`} />;
}
export default function CatalogLoading() {
  return (
    <main className="min-h-screen bg-slate-50" aria-busy="true" aria-label="Produktkatalog wird geladen">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <span className="sr-only">Produktkatalog wird geladen …</span>
        <Line className="mb-8 w-44" />
        <Line className="mb-3 h-8 w-full max-w-md" />
        <Line className="mb-10 w-full max-w-2xl" />
        <div className="grid gap-5 md:grid-cols-2">
          {[0, 1, 2, 3].map((item) => <section key={item} className="rounded-lg border border-slate-200 bg-white p-6"><Line className="mb-5 h-5 w-2/3" /><Line className="mb-3 w-full" /><Line className="w-4/5" /></section>)}
        </div>
      </div>
    </main>
  );
}
