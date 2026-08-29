import Link from "next/link";

export default function Home() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-100 px-6 py-12">
      <section className="w-full max-w-3xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-8 p-8 sm:p-12">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-md bg-blue-700 text-sm font-bold text-white" aria-hidden="true">
              W
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-950">WMEE Vertrieb</p>
              <p className="text-xs text-slate-500">Geschützter Arbeitsbereich</p>
            </div>
          </div>
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">Rechner → Anfrage → Triage</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              Solarrechner-Leads sauber weiterbearbeiten.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-slate-600">
              Melde dich an und öffne den Arbeitsbereich-Link deiner Organisation. Rechnerwerte bleiben klar von späteren, freigegebenen Angebotspreisen getrennt.
            </p>
          </div>
          <div>
            <Link
              href="/login"
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-slate-900 px-5 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              Zum Login
            </Link>
          </div>
        </div>
        <div className="border-t border-slate-200 bg-slate-50 px-8 py-4 text-xs text-slate-500 sm:px-12">
          Zugriff nur mit bestätigter E-Mail und Workspace-Mitgliedschaft.
        </div>
      </section>
    </main>
  );
}
