export default function PortalLinkInvalid() {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl items-center px-6 py-12">
      <section
        className="w-full rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
        role="status"
        aria-live="polite"
      >
        <p className="text-sm font-semibold text-blue-700">Kundenportal</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">Dieser Link ist ungültig.</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Der Link ist unbekannt, abgelaufen oder wurde zurückgezogen. Bitte wende dich an deine
          Ansprechperson für einen neuen Zugang. Es wurden keine Inhalte geladen.
        </p>
      </section>
    </main>
  );
}
