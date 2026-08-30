"use client";

export default function OfferDetailError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-6 py-16">
      <section
        role="alert"
        className="w-full rounded-lg border border-rose-200 bg-white p-8 shadow-sm"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-rose-700">
          WMEE Vertrieb
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
          Angebotsentwurf nicht verfügbar
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Der gespeicherte Stand konnte gerade nicht geladen werden. Lokale Änderungen werden
          durch diesen Fehler nicht an den Server übertragen.
        </p>
        <button
          type="button"
          onClick={retry}
          className="mt-6 min-h-11 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          Erneut versuchen
        </button>
      </section>
    </main>
  );
}
