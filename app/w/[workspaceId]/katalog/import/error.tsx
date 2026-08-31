"use client";

export default function CatalogImportError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12">
      <div role="alert" className="mx-auto max-w-xl rounded-lg border border-red-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-950">Der CSV-Import konnte nicht geladen werden.</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">Es wurden keine Produktdaten verändert. Versuche den geschützten Abruf erneut.</p>
        <button type="button" onClick={reset} className="mt-5 min-h-11 rounded-md bg-slate-900 px-4 text-sm font-semibold text-white">Erneut versuchen</button>
      </div>
    </main>
  );
}
