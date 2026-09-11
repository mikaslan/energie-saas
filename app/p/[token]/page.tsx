import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { publicTokenCapsule } from "@/lib/action";
import type {
  PortalInstallationStatusFaqs,
  PortalInstallationStatusLabels,
} from "@/lib/integrations/portal/portal-contract";
import {
  formatPortalDate,
  formatPortalInstallationStatus,
  formatPortalRange,
  formatPortalSignatureStatus,
  formatPortalTimelineEntry,
  parsePortalLang,
  PORTAL_GRID_STATUS_WORD,
  PORTAL_LANG_COOKIE,
  PORTAL_SERVICE_STATUS_WORD,
  PORTAL_STRINGS,
  PORTAL_SUBSIDY_PROGRAM_WORD,
  PORTAL_SUBSIDY_STATUS_WORD,
  resolvePortalInstallationFaqKey,
  resolvePortalNextStep,
} from "@/lib/integrations/portal/portal-language";
import { PortalNotFoundError, resolvePortalByToken } from "@/modules/portal";

// F10-06 Portal-Sprachen (Slice 1, ESTIMATE): Titel je Sprache (?lang=,
// sonst Cookie, sonst Deutsch).
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string | string[] }>;
}) {
  const query = await searchParams;
  const cookieStore = await cookies();
  const lang = query.lang !== undefined
    ? parsePortalLang(query.lang)
    : parsePortalLang(cookieStore.get(PORTAL_LANG_COOKIE)?.value);
  return {
    title: PORTAL_STRINGS[lang].metaTitle,
    robots: { index: false, follow: false },
  };
}

// F10.1: öffentliche Projektion (read-only). Unbekannt/deformiert/entzogen/
// abgelaufen -> identischer 404-Endzustand („Link ungültig", kein Orakel).
// F10-06: Sprache per ?lang= (stateless, gewinnt), sonst Cookie
// „portal-lang" (von den anonymen POST-Routen gesetzt), sonst Deutsch.
// Unbekannte Werte fallen auf Deutsch zurück (kein 404, kein Orakel).
export default async function PortalTokenPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{
    tab?: string | string[];
    upload?: string | string[];
    confirm?: string | string[];
    chat?: string | string[];
    lang?: string | string[];
  }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const cookieStore = await cookies();
  const lang = query.lang !== undefined
    ? parsePortalLang(query.lang)
    : parsePortalLang(cookieStore.get(PORTAL_LANG_COOKIE)?.value);
  const t = PORTAL_STRINGS[lang];
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
    ? t.uploadOk
    : rawUpload === "ungueltig"
      ? t.uploadInvalid
      : rawUpload === "konflikt"
        ? t.uploadConflict
        : rawUpload === "fehler"
          ? t.uploadGone
          : null;
  const rawConfirm = Array.isArray(query.confirm) ? query.confirm[0] : query.confirm;
  const confirmHint = rawConfirm === "ok"
    ? t.confirmOk
    : rawConfirm === "bereits"
      ? t.confirmKnown
      : rawConfirm === "fehler"
        ? t.confirmGone
        : null;
  const rawChat = Array.isArray(query.chat) ? query.chat[0] : query.chat;
  const chatHint = rawChat === "ok"
    ? t.chatOk
    : rawChat === "fehler"
      ? t.chatGone
      : null;
  const nextStep = resolvePortalNextStep(view.project.phase, view.project.outcome, lang);
  // F10-09: FAQ genau des aktuellen Installationsstands (Abnahme >
  // Abschluss > laufend); ohne Eintrag kein Block.
  const installationFaq = view.installation === null
    ? null
    : (view.installation.statusFaq as PortalInstallationStatusFaqs)[
      resolvePortalInstallationFaqKey(view.installation.status, view.installation.handoverAt)
    ] ?? null;
  // F10-06: Sprache immer explizit weitergeben (stateless, kein JS nötig).
  const langQuery = `lang=${lang}`;
  const tabClass = (active: boolean): string =>
    `rounded-md px-3 py-1.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand-600 ${
      active ? "bg-brand-700 text-white" : "text-brand-700 hover:bg-brand-50"
    }`;
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl items-center px-6 py-12">
      <section
        className="w-full rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
        aria-live="polite"
        lang={lang}
      >
        <p className="text-sm font-semibold text-brand-700">{t.brand}</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">{view.project.name}</h1>
        <nav aria-label={t.navAria} className="mt-4 flex gap-2">
          <Link href={`/p/${token}?${langQuery}`} className={tabClass(activeTab === "uebersicht")}>
            {t.navOverview}
          </Link>
          <Link
            href={`/p/${token}?tab=termine&${langQuery}`}
            className={tabClass(activeTab === "termine")}
          >
            {t.navAppointments}{view.appointments.length > 0 ? ` (${view.appointments.length})` : ""}
          </Link>
          <Link
            href={`/p/${token}?tab=installation&${langQuery}`}
            className={tabClass(activeTab === "installation")}
          >
            {t.navInstallation}
          </Link>
          <Link
            href={`/p/${token}?tab=dateien&${langQuery}`}
            className={tabClass(activeTab === "dateien")}
          >
            {t.navFiles}{view.fileRequests.length > 0 ? ` (${view.fileRequests.length})` : ""}
          </Link>
        </nav>
        {activeTab === "installation" ? (
          <div className="mt-4">
            <h2 className="text-lg font-semibold text-slate-950">{t.installationHeading}</h2>
            {view.installation === null ? (
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {t.installationEmpty}
              </p>
            ) : (
              <>
              <dl className="mt-2 space-y-2 text-sm leading-6 text-slate-600">
                <div className="flex gap-2">
                  <dt className="font-semibold text-slate-800">{t.statusTerm}</dt>
                  <dd>{formatPortalInstallationStatus(
                    lang,
                    view.installation.status,
                    view.installation.completedAt,
                    view.installation.handoverAt,
                    view.installation.statusLabels as PortalInstallationStatusLabels,
                  )}</dd>
                </div>
              </dl>
              {installationFaq === null ? null : (
                <>
                  <h3 className="mt-4 text-sm font-semibold text-slate-950">{t.faqHeading}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{installationFaq}</p>
                </>
              )}
              <h3 className="mt-4 text-sm font-semibold text-slate-950">{t.historyHeading}</h3>
              {view.installation.timeline.length === 0 ? (
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  {t.historyEmpty}
                </p>
              ) : (
                <ol className="mt-1 space-y-1 text-sm leading-6 text-slate-600">
                  {view.installation.timeline.map((entry) => (
                    <li key={`${entry.type}-${entry.at}`}>
                      {formatPortalTimelineEntry(lang, entry.type, formatPortalDate(lang, entry.day))}
                    </li>
                  ))}
                </ol>
              )}
              </>
            )}
          </div>
        ) : activeTab === "termine" ? (
          <div className="mt-4">
            <h2 className="text-lg font-semibold text-slate-950">{t.appointmentsHeading}</h2>
            {view.appointments.length === 0 ? (
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {t.appointmentsEmpty}
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-200 rounded-md border border-slate-200">
                {view.appointments.map((appointment) => (
                  <li key={appointment.id} className="px-4 py-3">
                    <span className="block text-sm font-medium text-slate-800">
                      {appointment.title}
                    </span>
                    <span className="block text-sm text-slate-500">
                      {formatPortalRange(lang, appointment.startAt, appointment.endAt, appointment.allDay)}
                      {appointment.location ? ` · ${appointment.location}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : activeTab === "dateien" ? (
          <div className="mt-4" data-testid="file-requests-section">
            <h2 className="text-lg font-semibold text-slate-950">{t.filesHeading}</h2>
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
                {t.filesEmpty}
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
                        {t.uploadedWord}{req.originalFilename ? ` (${req.originalFilename})` : ""}
                        {req.allowMany && req.uploadCount > 0
                          ? ` · ${req.uploadCount + 1} ${t.uploadedCountWord}`
                          : ""}
                      </span>
                    ) : null}
                    {req.allowMany && req.status === "hochgeladen" && req.filenames.length > 0 ? (
                      <ul className="mt-1 space-y-0.5">
                        {req.filenames.map((name, index) => (
                          <li key={`${index}-${name}`} className="text-sm text-slate-500">
                            {name}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {req.status === "offen" || req.allowMany ? (
                      <form
                        action={`/p/${token}/file-requests`}
                        method="post"
                        encType="multipart/form-data"
                        className="mt-2 flex flex-wrap items-center gap-2"
                      >
                        <input type="hidden" name="requestId" value={req.id} />
                        <input type="hidden" name="lang" value={lang} />
                        <input
                          type="file"
                          name="datei"
                          required
                          accept=".pdf,.jpg,.jpeg,.png"
                          aria-label={`${t.uploadFileAriaPrefix} ${req.title}`}
                          className="text-sm text-slate-600"
                        />
                        <button
                          type="submit"
                          className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                        >
                          {t.uploadButton}
                        </button>
                      </form>
                    ) : null}
                    {req.allowMany && req.status === "hochgeladen" ? (
                      <span className="mt-1 block text-sm text-slate-500">
                        {t.uploadMoreHint}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <>
            <dl className="mt-4 space-y-2 text-sm leading-6 text-slate-600">
              <div className="flex gap-2">
                <dt className="font-semibold text-slate-800">{t.statusTerm}</dt>
                <dd>{nextStep}</dd>
              </div>
            </dl>
            {view.subsidy === null ? null : (
              <div className="mt-6" data-testid="portal-subsidy-section">
                <h2 className="text-lg font-semibold text-slate-950">{t.subsidyHeading}</h2>
                <dl className="mt-2 space-y-2 text-sm leading-6 text-slate-600">
                  <div className="flex gap-2">
                    <dt className="font-semibold text-slate-800">{t.statusTerm}</dt>
                    <dd data-testid="portal-subsidy-status">
                      {PORTAL_SUBSIDY_STATUS_WORD[lang][view.subsidy.status]}
                      {view.subsidy.program
                        ? ` (${PORTAL_SUBSIDY_PROGRAM_WORD[lang][view.subsidy.program]})`
                        : ""}
                    </dd>
                  </div>
                </dl>
                <h3 className="mt-4 text-sm font-semibold text-slate-950">{t.chatHeading}</h3>
                {chatHint ? (
                  <p
                    role={rawChat === "ok" ? "status" : "alert"}
                    data-testid="portal-chat-feedback"
                    className={`mt-2 text-sm font-semibold ${
                      rawChat === "fehler" ? "text-red-700" : "text-emerald-700"
                    }`}
                  >
                    {chatHint}
                  </p>
                ) : null}
                {view.subsidy.messages.length === 0 ? (
                  <p className="mt-1 text-sm leading-6 text-slate-600">{t.chatEmpty}</p>
                ) : (
                  <ul className="mt-2 divide-y divide-slate-200 rounded-md border border-slate-200">
                    {view.subsidy.messages.map((message, index) => (
                      <li key={`${message.at}-${index}`} className="px-4 py-3">
                        <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                          {message.side === "customer" ? t.chatSideCustomer : t.chatSideInternal}
                        </span>
                        <span className="block text-sm leading-6 text-slate-800">{message.body}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <form action={`/p/${token}/subsidy-chat`} method="post" className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="lang" value={lang} />
                  <label className="grid min-w-52 flex-1 gap-1 text-sm font-medium text-slate-700">
                    {t.chatHeading}
                    <textarea
                      name="body"
                      required
                      maxLength={2000}
                      rows={2}
                      data-testid="portal-chat-body"
                      className="min-h-11 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                    />
                  </label>
                  <button
                    type="submit"
                    data-testid="portal-chat-send"
                    className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                  >
                    {t.chatSend}
                  </button>
                </form>
              </div>
            )}
            {view.gridRegistration === null ? null : (
              <div className="mt-6" data-testid="portal-grid-section">
                <h2 className="text-lg font-semibold text-slate-950">{t.gridHeading}</h2>
                <dl className="mt-2 space-y-2 text-sm leading-6 text-slate-600">
                  <div className="flex gap-2">
                    <dt className="font-semibold text-slate-800">{t.statusTerm}</dt>
                    <dd data-testid="portal-grid-status">
                      {PORTAL_GRID_STATUS_WORD[lang][view.gridRegistration.status]}
                      {view.gridRegistration.operatorName
                        ? ` (${view.gridRegistration.operatorName})`
                        : ""}
                    </dd>
                  </div>
                </dl>
              </div>
            )}
            {view.service.length === 0 ? null : (
              <div className="mt-6" data-testid="portal-service-section">
                <h2 className="text-lg font-semibold text-slate-950">{t.serviceHeading}</h2>
                {confirmHint ? (
                  <p
                    role={rawConfirm === "ok" || rawConfirm === "bereits" ? "status" : "alert"}
                    data-testid="portal-service-confirm-feedback"
                    className={`mt-2 text-sm font-semibold ${
                      rawConfirm === "fehler" ? "text-red-700" : "text-emerald-700"
                    }`}
                  >
                    {confirmHint}
                  </p>
                ) : null}
                <ul className="mt-2 divide-y divide-slate-200 rounded-md border border-slate-200">
                  {view.service.map((item) => (
                    <li key={item.id} className="px-4 py-3">
                      <span className="block text-sm font-medium text-slate-800">
                        {item.title}
                      </span>
                      <span
                        className="block text-sm text-slate-500"
                        data-testid={`portal-service-status-${item.id}`}
                      >
                        {PORTAL_SERVICE_STATUS_WORD[lang][item.status]}
                        {item.status === "done" && item.confirmedAt !== null
                          ? ` ${t.acknowledgedSuffix}`
                          : ""}
                      </span>
                      {item.status === "done" && item.confirmedAt === null ? (
                        <form
                          action={`/p/${token}/service-cases`}
                          method="post"
                          className="mt-2"
                        >
                          <input type="hidden" name="caseId" value={item.id} />
                          <input type="hidden" name="lang" value={lang} />
                          <button
                            type="submit"
                            className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                          >
                            {t.acknowledgeButton}
                          </button>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {view.project.scope === "commercial" ? null : (
              <>
                <h2 className="mt-6 text-lg font-semibold text-slate-950">{t.documentsHeading}</h2>
                {view.documents.length === 0 ? (
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    {t.documentsEmpty}
                  </p>
                ) : (
                  <ul className="mt-2 divide-y divide-slate-200 rounded-md border border-slate-200">
                    {view.documents.map((doc) => (
                      <li key={doc.id} className="flex items-center justify-between gap-4 px-4 py-3">
                        <span className="text-sm font-medium text-slate-800">
                          {t.offerWord} {doc.offerNumber}
                          <span className="block text-xs font-normal text-slate-500">
                            {formatPortalSignatureStatus(lang, doc.signatureStatus, doc.signedAt)}
                          </span>
                        </span>
                        <span className="flex items-center gap-3">
                          <span className="text-sm text-slate-500">{doc.documentDate}</span>
                          <Link
                            href={`/p/${token}/dokumente/${doc.id}?lang=${lang}`}
                            className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-3 text-sm font-semibold text-brand-700 outline-none hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                          >
                            {t.downloadWord}
                          </Link>
                        </span>
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
