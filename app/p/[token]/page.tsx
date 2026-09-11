import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { publicTokenCapsule } from "@/lib/action";
import { derivePortalNextStep } from "@/lib/integrations/portal/portal-contract";
import { PortalNotFoundError, resolvePortalByToken } from "@/modules/portal";

export const metadata: Metadata = {
  title: "Kundenportal",
  robots: { index: false, follow: false },
};

const BERLIN_DATE = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const BERLIN_TIME = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
});

function formatBerlinRange(startAt: string, endAt: string, allDay: boolean): string {
  const start = new Date(startAt);
  const date = BERLIN_DATE.format(start);
  if (allDay) return `${date} · ganztägig`;
  return `${date} · ${BERLIN_TIME.format(start)}–${BERLIN_TIME.format(new Date(endAt))} Uhr`;
}

// F10-03: Installationsstand (festes Anzeige-Mapping, ESTIMATE;
// Admin-Mapping je Status bleibt offen). Nur Stand + Daten.
function formatInstallationStatus(
  status: "active" | "completed",
  completedAt: string | null,
  handoverAt: string | null,
): string {
  if (status === "completed" && handoverAt !== null) {
    return `Abgenommen am ${BERLIN_DATE.format(new Date(handoverAt))}`;
  }
  if (status === "completed") {
    return completedAt === null
      ? "Abgeschlossen"
      : `Abgeschlossen am ${BERLIN_DATE.format(new Date(completedAt))}`;
  }
  return "In Ausführung";
}

// F10.2 Slice B: Signatur-Status je Dokument (read-only, wörtlich aus der
// Projektion; keine internen Details — signer_name/Token/Grund nie).
function formatSignatureStatus(status: string, signedAt: string | null): string {
  switch (status) {
    case "pending": return "Signatur: ausstehend";
    case "signed":
      return signedAt === null
        ? "Signatur: signiert"
        : `Signiert am ${BERLIN_DATE.format(new Date(signedAt))}`;
    case "expired": return "Signatur: abgelaufen";
    case "withdrawn": return "Signatur: zurückgezogen";
    case "revoked_by_customer": return "Signatur: vom Kunden widerrufen";
    default: return "Signatur: nicht angefragt";
  }
}

// F10.1: öffentliche Projektion (read-only). Unbekannt/deformiert/entzogen/
// abgelaufen -> identischer 404-Endzustand („Link ungültig", kein Orakel).
// F10-03b: Timeline-Labels (nur Allowlist-Typen; Datum Berlin, keine Uhrzeit,
// keine Akteure — öffentliche Sicht ohne Login).
function formatTimelineEntry(type: string, day: string): string {
  switch (type) {
    case "created": return `Angelegt am ${day}`;
    case "completed": return `Abgeschlossen am ${day}`;
    case "handover_recorded": return `Abgenommen am ${day}`;
    default: return `Ereignis am ${day}`;
  }
}

// F10.2 Slice A: Tabs (Übersicht | Termine) per ?tab=, Server-Links ohne JS.
// F10-03: Tab „Installation" dazu (Stand oder ehrlicher Leerzustand).
// Unbekannter tab-Wert fällt auf Übersicht zurück (kein 404, kein Orakel).
export default async function PortalTokenPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ tab?: string | string[]; upload?: string | string[] }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const rawTab = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  let view;
  try {
    view = await publicTokenCapsule((pool) => resolvePortalByToken(pool, { token }));
  } catch (error) {
    if (error instanceof PortalNotFoundError) notFound();
    throw error;
  }
  const activeTab = rawTab === "termine"
    ? "termine"
    : rawTab === "installation"
      ? "installation"
      : rawTab === "dateien"
        ? "dateien"
        : "uebersicht";
  const rawUpload = Array.isArray(query.upload) ? query.upload[0] : query.upload;
  const uploadHint = rawUpload === "erfolg"
    ? "Vielen Dank — die Datei ist eingegangen."
    : rawUpload === "ungueltig"
      ? "Die Datei ist ungültig (PDF, JPG oder PNG, höchstens 10 MB)."
      : rawUpload === "konflikt"
        ? "Diese Anfrage ist bereits beantwortet."
        : rawUpload === "fehler"
          ? "Die Anfrage ist nicht mehr verfügbar."
          : null;
  const nextStep = derivePortalNextStep(view.project.phase, view.project.outcome);
  const tabClass = (active: boolean): string =>
    `rounded-md px-3 py-1.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
      active ? "bg-blue-700 text-white" : "text-blue-700 hover:bg-blue-50"
    }`;
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl items-center px-6 py-12">
      <section
        className="w-full rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
        aria-live="polite"
      >
        <p className="text-sm font-semibold text-blue-700">Kundenportal</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">{view.project.name}</h1>
        <nav aria-label="Portalbereiche" className="mt-4 flex gap-2">
          <Link href={`/p/${token}`} className={tabClass(activeTab === "uebersicht")}>
            Übersicht
          </Link>
          <Link
            href={`/p/${token}?tab=termine`}
            className={tabClass(activeTab === "termine")}
          >
            Termine{view.appointments.length > 0 ? ` (${view.appointments.length})` : ""}
          </Link>
          <Link
            href={`/p/${token}?tab=installation`}
            className={tabClass(activeTab === "installation")}
          >
            Installation
          </Link>
          <Link
            href={`/p/${token}?tab=dateien`}
            className={tabClass(activeTab === "dateien")}
          >
            Dateien{view.fileRequests.length > 0 ? ` (${view.fileRequests.length})` : ""}
          </Link>
        </nav>
        {activeTab === "installation" ? (
          <div className="mt-4">
            <h2 className="text-lg font-semibold text-slate-950">Installation</h2>
            {view.installation === null ? (
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Noch keine Installation hinterlegt.
              </p>
            ) : (
              <>
              <dl className="mt-2 space-y-2 text-sm leading-6 text-slate-600">
                <div className="flex gap-2">
                  <dt className="font-semibold text-slate-800">Stand:</dt>
                  <dd>{formatInstallationStatus(
                    view.installation.status,
                    view.installation.completedAt,
                    view.installation.handoverAt,
                  )}</dd>
                </div>
              </dl>
              <h3 className="mt-4 text-sm font-semibold text-slate-950">Verlauf</h3>
              {view.installation.timeline.length === 0 ? (
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Noch keine Ereignisse.
                </p>
              ) : (
                <ol className="mt-1 space-y-1 text-sm leading-6 text-slate-600">
                  {view.installation.timeline.map((entry) => (
                    <li key={`${entry.type}-${entry.at}`}>
                      {formatTimelineEntry(entry.type, entry.day)}
                    </li>
                  ))}
                </ol>
              )}
              </>
            )}
          </div>
        ) : activeTab === "termine" ? (
          <div className="mt-4">
            <h2 className="text-lg font-semibold text-slate-950">Termine</h2>
            {view.appointments.length === 0 ? (
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Aktuell liegen keine Termine vor.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-200 rounded-md border border-slate-200">
                {view.appointments.map((appointment) => (
                  <li key={appointment.id} className="px-4 py-3">
                    <span className="block text-sm font-medium text-slate-800">
                      {appointment.title}
                    </span>
                    <span className="block text-sm text-slate-500">
                      {formatBerlinRange(appointment.startAt, appointment.endAt, appointment.allDay)}
                      {appointment.location ? ` · ${appointment.location}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : activeTab === "dateien" ? (
          <div className="mt-4" data-testid="file-requests-section">
            <h2 className="text-lg font-semibold text-slate-950">Dateien</h2>
            {uploadHint ? (
              <p
                role={rawUpload === "erfolg" ? "status" : "alert"}
                data-testid="file-request-upload-feedback"
                className={`mt-2 text-sm font-semibold ${
                  rawUpload === "erfolg" ? "text-emerald-700" : "text-red-700"
                }`}
              >
                {uploadHint}
              </p>
            ) : null}
            {view.fileRequests.length === 0 ? (
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Aktuell werden keine Dateien benötigt.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-200 rounded-md border border-slate-200">
                {view.fileRequests.map((req) => (
                  <li key={req.id} className="px-4 py-3">
                    <span className="block text-sm font-medium text-slate-800">
                      {req.title}
                    </span>
                    {req.description ? (
                      <span className="block text-sm text-slate-500">{req.description}</span>
                    ) : null}
                    {req.status === "hochgeladen" ? (
                      <span className="mt-1 block text-sm font-semibold text-emerald-700">
                        Hochgeladen{req.originalFilename ? ` (${req.originalFilename})` : ""}
                      </span>
                    ) : (
                      <form
                        action={`/p/${token}/file-requests`}
                        method="post"
                        encType="multipart/form-data"
                        className="mt-2 flex flex-wrap items-center gap-2"
                      >
                        <input type="hidden" name="requestId" value={req.id} />
                        <input
                          type="file"
                          name="datei"
                          required
                          accept=".pdf,.jpg,.jpeg,.png"
                          aria-label={`Datei für ${req.title}`}
                          className="text-sm text-slate-600"
                        />
                        <button
                          type="submit"
                          className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                        >
                          Hochladen
                        </button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <>
            <dl className="mt-4 space-y-2 text-sm leading-6 text-slate-600">
              <div className="flex gap-2">
                <dt className="font-semibold text-slate-800">Stand:</dt>
                <dd>{nextStep}</dd>
              </div>
            </dl>
            {view.project.scope === "commercial" ? null : (
              <>
                <h2 className="mt-6 text-lg font-semibold text-slate-950">Dokumente</h2>
                {view.documents.length === 0 ? (
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Aktuell liegen keine freigegebenen Dokumente vor.
                  </p>
                ) : (
                  <ul className="mt-2 divide-y divide-slate-200 rounded-md border border-slate-200">
                    {view.documents.map((doc) => (
                      <li key={doc.id} className="flex items-center justify-between gap-4 px-4 py-3">
                        <span className="text-sm font-medium text-slate-800">
                          Angebot {doc.offerNumber}
                          <span className="block text-xs font-normal text-slate-500">
                            {formatSignatureStatus(doc.signatureStatus, doc.signedAt)}
                          </span>
                        </span>
                        <span className="text-sm text-slate-500">{doc.documentDate}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}
