"use client";

export default function RequestsError({ retry }: { error: Error; retry: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-6 py-16">
      <section className="w-full rounded-lg border border-rose-200 bg-white p-8 shadow-sm" role="alert">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-rose-700">WMEE Vertrieb</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">Board nicht verfügbar</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Die Anfragen konnten gerade nicht geladen werden. Es wurden keine Änderungen vorgenommen.
        </p>
        <button
          type="button"
          onClick={retry}
          className="mt-6 min-h-11 rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          Erneut versuchen
        </button>
      </section>
    </main>
  );
}
