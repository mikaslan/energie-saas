export default function GlobalTaskInboxLoading() {
  return (
    <main aria-busy="true" className="min-h-screen bg-slate-100 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-6xl animate-pulse motion-reduce:animate-none">
        <span className="sr-only">Aufgaben-Inbox wird geladen</span>
        <div className="h-4 w-32 rounded bg-slate-200" />
        <div className="mt-3 h-9 w-56 rounded bg-slate-300" />
        <div className="mt-8 h-40 rounded-lg border border-slate-200 bg-white" />
        <div className="mt-4 h-48 rounded-lg border border-slate-200 bg-white" />
      </div>
    </main>
  );
}
