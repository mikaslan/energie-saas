export default function OffersLoading() {
  return (
    <main
      aria-busy="true"
      className="min-h-screen bg-slate-100 px-4 py-8 sm:px-6 lg:px-8"
    >
      <div className="mx-auto w-full max-w-[1480px] animate-pulse motion-reduce:animate-none">
        <span className="sr-only">Angebote werden geladen</span>
        <div className="h-4 w-24 rounded bg-slate-200" />
        <div className="mt-3 h-9 w-56 rounded bg-slate-300" />
        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((column) => (
            <section
              key={column}
              aria-hidden="true"
              className="h-80 rounded-lg border border-slate-200 bg-white p-4"
            >
              <div className="h-5 w-32 rounded bg-slate-200" />
              <div className="mt-6 h-40 rounded-md bg-slate-100" />
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
