import Link from "next/link";
import { SignOutButton } from "@/app/_components/sign-out-button";
import type { AssignedExternalRequestDetail } from "@/modules/projects";

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

const numberFormatter = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 1,
});

function valueOrFallback(value: string | null): string {
  return value ?? "Nicht übermittelt";
}

function yesNo(value: boolean): string {
  return value ? "Ja" : "Nein";
}

function branchLabel(value: string | null): string {
  if (value === "new_installation") return "Neuanlage";
  if (value === "existing_installation") return "Bestehende Anlage";
  return valueOrFallback(value);
}

export function AssignedExternalRequestView({
  workspaceId,
  detail,
}: {
  workspaceId: string;
  detail: AssignedExternalRequestDetail;
}) {
  const blockerLabels = [
    detail.blockers.dedupeReviewRequired ? "Kontaktprüfung offen" : null,
    detail.blockers.addressFollowUpRequired ? "Adressprüfung offen" : null,
    detail.blockers.pinConfirmationRequired ? "Standortbestätigung offen" : null,
    detail.blockers.catalogResolutionPending ? "Produktprüfung offen" : null,
  ].filter((value): value is string => value !== null);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <nav aria-label="Seitennavigation" className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <Link
            href={`/w/${workspaceId}/anfragen`}
            className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            <span aria-hidden="true" className="mr-2">←</span>
            Zurück zu den Anfragen
          </Link>
          <SignOutButton />
        </nav>

        <header className="rounded-xl border border-blue-200 bg-blue-50 p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-blue-800">Zugewiesene Anfrage</p>
              <h1 className="mt-1 break-words text-2xl font-semibold tracking-tight sm:text-3xl">
                {detail.contact.displayName}
              </h1>
              <p className="mt-2 break-words text-sm leading-6 text-slate-700">
                {detail.project.name} · Erstellt am {dateFormatter.format(new Date(detail.project.createdAt))}
              </p>
            </div>
            <span className="rounded-full border border-blue-300 bg-white px-3 py-1.5 text-xs font-semibold text-blue-900">
              Nur Lesezugriff
            </span>
          </div>
          <p className="mt-5 max-w-2xl text-sm leading-6 text-slate-700">
            Du siehst ausschließlich die dir direkt zugewiesene, offene Kundenanfrage.
          </p>
        </header>

        <div className="mt-6 grid min-w-0 gap-6 md:grid-cols-2">
          <section aria-labelledby="external-contact" className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <h2 id="external-contact" className="text-lg font-semibold">Kontakt</h2>
            <dl className="mt-4 grid gap-4 text-sm">
              <div>
                <dt className="font-medium text-slate-500">Name</dt>
                <dd className="mt-1 break-words text-slate-900">{detail.contact.displayName}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">E-Mail</dt>
                <dd className="mt-1 break-all text-slate-900">{valueOrFallback(detail.contact.email)}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Telefon</dt>
                <dd className="mt-1 break-words text-slate-900">{valueOrFallback(detail.contact.phone)}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Projektadresse</dt>
                <dd className="mt-1 break-words text-slate-900">{valueOrFallback(detail.site.formattedAddress)}</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="external-request" className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <h2 id="external-request" className="text-lg font-semibold">Angefragte Lösung</h2>
            <dl className="mt-4 grid gap-4 text-sm">
              <div>
                <dt className="font-medium text-slate-500">Produktgruppe</dt>
                <dd className="mt-1 text-slate-900">{detail.requirements.productGroupLabel}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Vorhaben</dt>
                <dd className="mt-1 text-slate-900">{branchLabel(detail.requirements.branch)}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Gewünschter Speicher</dt>
                <dd className="mt-1 tabular-nums text-slate-900">
                  {detail.requirements.targetStorageKwh === null
                    ? "Nicht übermittelt"
                    : `${numberFormatter.format(detail.requirements.targetStorageKwh)} kWh`}
                </dd>
              </div>
              <div><dt className="font-medium text-slate-500">Wallbox</dt><dd className="mt-1">{yesNo(detail.requirements.wallbox)}</dd></div>
              <div><dt className="font-medium text-slate-500">Bidirektionales Laden</dt><dd className="mt-1">{yesNo(detail.requirements.bidirectionalCharging)}</dd></div>
              <div><dt className="font-medium text-slate-500">Ersatzstrom</dt><dd className="mt-1">{yesNo(detail.requirements.backupPower)}</dd></div>
            </dl>
          </section>
        </div>

        <section aria-labelledby="external-status" className="mt-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 id="external-status" className="text-lg font-semibold">Bearbeitungsstand</h2>
          <p className="mt-2 text-sm text-slate-600">
            Status: Offen · {detail.project.columnName}
          </p>
          {blockerLabels.length > 0 ? (
            <ul className="mt-4 flex list-none flex-wrap gap-2" aria-label="Offene Prüfungen">
              {blockerLabels.map((label) => (
                <li key={label} className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900">
                  {label}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              Keine offenen Prüfhinweise.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
