export default function EnergyProfileLoading() {
  return (
    <main
      className="min-h-screen bg-slate-50"
      aria-busy="true"
      aria-label="Energieprofil wird geladen"
    >
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <div className="h-11 w-52 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
        <div className="mt-8 h-24 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" />
        <div className="mt-6 h-96 animate-pulse rounded bg-white shadow-sm motion-reduce:animate-none" />
        <p className="sr-only">Energieprofil wird geladen.</p>
      </div>
    </main>
  );
}
