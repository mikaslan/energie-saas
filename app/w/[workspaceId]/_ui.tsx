import Link from "next/link";

export function YesNo({ value }: { value: boolean }) {
  return (
    <span
      className={
        value
          ? "inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-800"
          : "inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600"
      }
    >
      {value ? "Ja" : "Nein"}
    </span>
  );
}
export function DetailItem({
  term,
  children,
  numeric = false,
}: {
  term: string;
  children: React.ReactNode;
  numeric?: boolean;
}) {
  return (
    <div className="grid gap-1 border-b border-slate-100 py-3 last:border-b-0 sm:grid-cols-[minmax(9rem,0.8fr)_minmax(0,1.2fr)] sm:gap-5">
      <dt className="text-sm text-slate-500">{term}</dt>
      <dd
        className={`min-w-0 text-sm font-medium text-slate-900 ${
          numeric ? "tabular-nums" : ""
        }`}
      >
        {children}
      </dd>
    </div>
  );
}

export function Section({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-slate-950">{title}</h2>
        {intro ? <p className="mt-1 text-sm leading-6 text-slate-600">{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function DeniedState({
  title = "Diese Daten sind für dich nicht freigegeben.",
}: {
  title?: string;
}) {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl items-center px-6 py-12">
      <section className="w-full rounded-lg border border-amber-200 bg-amber-50 p-6 sm:p-8">
        <p className="text-sm font-semibold text-amber-800">Zugriff eingeschränkt</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">{title}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-700">
          Dir fehlt die Berechtigung für diesen Workspace. Es wurden keine
          Fachdaten geladen. Wende dich bei Bedarf an eine
          Workspace-Administration.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          Zur Startseite
        </Link>
      </section>
    </main>
  );
}
