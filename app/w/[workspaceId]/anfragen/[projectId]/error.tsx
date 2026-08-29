"use client";

export default function ProjectDetailError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl items-center px-6 py-12">
      <section className="w-full rounded-lg border border-red-200 bg-red-50 p-6 sm:p-8">
        <p className="text-sm font-semibold text-red-800">Unerwarteter Fehler</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">
          Die Projektakte konnte nicht geladen werden.
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-700">
          Bitte versuche es erneut. Falls der Fehler bestehen bleibt,
          wende dich an die Administration.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-6 min-h-11 rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          Erneut versuchen
        </button>
      </section>
    </main>
  );
}
