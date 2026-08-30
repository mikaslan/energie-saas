export default function OfferDetailLoading() {
  return (
    <main
      aria-busy="true"
      className="min-h-screen bg-slate-50 px-4 py-8 sm:px-6 lg:px-8"
    >
      <div className="mx-auto w-full max-w-[1480px] animate-pulse motion-reduce:animate-none">
        <span className="sr-only">Angebotsentwurf wird geladen</span>
        <div className="h-5 w-48 rounded bg-slate-200" />
        <div className="mt-7 h-10 w-72 max-w-full rounded bg-slate-300" />
        <div className="mt-3 h-5 w-96 max-w-full rounded bg-slate-200" />
        <div className="mt-8 flex gap-2" aria-hidden="true">
          <div className="h-11 w-32 rounded bg-slate-300" />
          <div className="h-11 w-32 rounded bg-slate-200" />
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]" aria-hidden="true">
          <div className="grid gap-4">
            <div className="h-32 rounded-lg border border-slate-200 bg-white" />
            <div className="h-72 rounded-lg border border-slate-200 bg-white" />
          </div>
          <div className="h-72 rounded-lg border border-slate-200 bg-white" />
        </div>
      </div>
    </main>
  );
}
