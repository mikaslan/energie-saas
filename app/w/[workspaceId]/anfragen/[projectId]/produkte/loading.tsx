function Line({ className = "" }: { className?: string }) {
  return <div className={`h-4 animate-pulse rounded bg-slate-200 motion-reduce:animate-none ${className}`} />;
}
export default function ProductsLoading() {
  return (
    <main className="min-h-screen bg-slate-50" aria-busy="true" aria-label="Produktauflösung wird geladen">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <span className="sr-only">Produktauflösung wird geladen …</span>
        <Line className="mb-8 w-48" /><Line className="mb-3 h-8 w-full max-w-lg" /><Line className="mb-10 w-full max-w-2xl" />
        <div className="grid gap-6">{[0, 1, 2].map((item) => <section key={item} className="rounded-lg border border-slate-200 bg-white p-6"><Line className="mb-5 h-5 w-48" /><Line className="mb-3 w-full" /><Line className="w-4/5" /></section>)}</div>
      </div>
    </main>
  );
}
