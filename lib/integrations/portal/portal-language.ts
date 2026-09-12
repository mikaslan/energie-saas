// F10-06 Portal-Sprachen (Slice 1, ESTIMATE): Kundenportal wahlweise
// Deutsch/Englisch. Reine Darstellungsschicht ohne Migration, ohne neue
// Permission, ohne I/O. Die englischen Worte sind eine reversible eigene
// Näherung (ESTIMATE, kein Reonic-Referenzbeleg).
//
// Umfang: Portal-Chrome (Navigation, Überschriften, Hinweise, Buttons,
// Leerstände), seitenlokale Statusworte (Signatur/Service/Timeline/
// Next-Step), Installations-Fallbackworte (nur EN, nur ohne Admin-Override)
// sowie Förder-/Netzstatus (BzA/BnD/KfW/BAFA als Eigennamen unverändert).
// Bewusst NICHT übersetzt: Admin-Statuslabels (F10-05, Kundendaten wie
// erfasst), Projekt-/Termin-/Dateinamen, Betreiber- und Dateinamen,
// interne Modul-Labelmaps (interne App bleibt deutsch).

export const PORTAL_LANGUAGE_VERSION = "portal-language.v1" as const;

export const PORTAL_LANG_COOKIE = "portal-lang" as const;
export const PORTAL_LANG_COOKIE_MAX_AGE = 31536000 as const; // 1 Jahr

export const portalLangs = ["de", "en"] as const;
export type PortalLang = (typeof portalLangs)[number];

// Fail-closed: alles außer exakt "en" (nach trim/lowercase, erster Wert
// bei Mehrfachnennung) fällt auf Deutsch zurück — kein Orakel, kein 404.
export function parsePortalLang(value: unknown): PortalLang {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string") return "de";
  return first.trim().toLowerCase() === "en" ? "en" : "de";
}

export interface PortalStrings {
  metaTitle: string;
  brand: string;
  navAria: string;
  navOverview: string;
  navAppointments: string;
  navInstallation: string;
  navFiles: string;
  statusTerm: string;
  installationHeading: string;
  installationEmpty: string;
  faqHeading: string;
  historyHeading: string;
  historyEmpty: string;
  chatHeading: string;
  chatEmpty: string;
  chatSend: string;
  chatOk: string;
  chatGone: string;
  chatSideInternal: string;
  chatSideCustomer: string;
  appointmentsHeading: string;
  appointmentsEmpty: string;
  allDayWord: string;
  filesHeading: string;
  filesEmpty: string;
  uploadedWord: string;
  // F10-10: Allow-many — Zähler + Hinweis auf weitere Dateien.
  uploadedCountWord: string;
  uploadMoreHint: string;
  uploadFileAriaPrefix: string;
  uploadButton: string;
  uploadOk: string;
  uploadInvalid: string;
  uploadConflict: string;
  uploadGone: string;
  documentsHeading: string;
  documentsEmpty: string;
  offerWord: string;
  downloadWord: string;
  // F8-15: Portal-Rechnungssicht (Nummer/Art/Brutto/Zahlstand).
  invoicesHeading: string;
  invoicesEmpty: string;
  invoiceWord: string;
  creditNoteWord: string;
  invoicePaymentUnpaid: string;
  invoicePaymentPartiallyPaid: string;
  invoicePaymentPaid: string;
  invoicePaymentOverdue: string;
  invoicePaymentUncollectable: string;
  invoicePaymentUnknown: string;
  subsidyHeading: string;
  gridHeading: string;
  serviceHeading: string;
  acknowledgedSuffix: string;
  acknowledgeButton: string;
  confirmOk: string;
  confirmKnown: string;
  confirmGone: string;
  invalidTitle: string;
  invalidBody: string;
}

const BERLIN_TZ = "Europe/Berlin";

const dateFormatters: Record<PortalLang, Intl.DateTimeFormat> = {
  de: new Intl.DateTimeFormat("de-DE", {
    timeZone: BERLIN_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }),
  en: new Intl.DateTimeFormat("en-GB", {
    timeZone: BERLIN_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }),
};

const timeFormatters: Record<PortalLang, Intl.DateTimeFormat> = {
  de: new Intl.DateTimeFormat("de-DE", {
    timeZone: BERLIN_TZ,
    hour: "2-digit",
    minute: "2-digit",
  }),
  en: new Intl.DateTimeFormat("en-GB", {
    timeZone: BERLIN_TZ,
    hour: "2-digit",
    minute: "2-digit",
  }),
};

export function formatPortalDate(lang: PortalLang, at: string | Date): string {
  return dateFormatters[lang].format(new Date(at));
}

const euroFormatters: Record<PortalLang, Intl.NumberFormat> = {
  de: new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }),
  en: new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" }),
};

// F8-15: Brutto-Anzeige je Portal-Rechnung (Cent → Euro, Sprach-Locale).
export function formatPortalEuro(lang: PortalLang, cents: number): string {
  return euroFormatters[lang].format(cents / 100);
}

// F8-15: Zahlstand-Wort je Portal-Rechnung (null = ehrlich unbekannt).
export function formatPortalInvoicePayment(
  lang: PortalLang,
  status: "unpaid" | "partially_paid" | "paid" | "overdue" | "uncollectable" | null,
): string {
  const t = PORTAL_STRINGS[lang];
  switch (status) {
    case "unpaid": return t.invoicePaymentUnpaid;
    case "partially_paid": return t.invoicePaymentPartiallyPaid;
    case "paid": return t.invoicePaymentPaid;
    case "overdue": return t.invoicePaymentOverdue;
    case "uncollectable": return t.invoicePaymentUncollectable;
    default: return t.invoicePaymentUnknown;
  }
}

// Bereichsanzeige Berlin (Datum + Uhrzeit); EN ohne „Uhr"-Suffix.
export function formatPortalRange(
  lang: PortalLang,
  startAt: string,
  endAt: string,
  allDay: boolean,
): string {
  const start = new Date(startAt);
  const date = dateFormatters[lang].format(start);
  if (allDay) {
    return lang === "en" ? `${date} · all day` : `${date} · ganztägig`;
  }
  const span = `${timeFormatters[lang].format(start)}–${timeFormatters[lang].format(new Date(endAt))}`;
  return lang === "en" ? `${date} · ${span}` : `${date} · ${span} Uhr`;
}

// F10.2 Slice B: Signatur-Statusworte je Sprache (Schlüssel aus
// portal-contract, nie interne Details).
export type PortalSignatureStatusWord =
  | "none"
  | "pending"
  | "signed"
  | "expired"
  | "withdrawn"
  | "revoked_by_customer";

export const PORTAL_SIGNATURE_STATUS_WORD: Record<PortalLang, Record<PortalSignatureStatusWord, string>> = {
  de: {
    none: "Signatur: nicht angefragt",
    pending: "Signatur: ausstehend",
    signed: "Signatur: signiert",
    expired: "Signatur: abgelaufen",
    withdrawn: "Signatur: zurückgezogen",
    revoked_by_customer: "Signatur: vom Kunden widerrufen",
  },
  en: {
    none: "Signature: not requested",
    pending: "Signature: pending",
    signed: "Signature: signed",
    expired: "Signature: expired",
    withdrawn: "Signature: withdrawn",
    revoked_by_customer: "Signature: revoked by customer",
  },
};

export function formatPortalSignatureStatus(
  lang: PortalLang,
  status: string,
  signedAt: string | null,
): string {
  if (status === "signed" && signedAt !== null) {
    const when = formatPortalDate(lang, signedAt);
    return lang === "en" ? `Signed on ${when}` : `Signiert am ${when}`;
  }
  const word = (PORTAL_SIGNATURE_STATUS_WORD[lang] as Record<string, string>)[status]
    ?? PORTAL_SIGNATURE_STATUS_WORD[lang].none;
  return word;
}

// F13-06: Service-Stand je Sprache (Schlüssel wie intern).
export type PortalServiceStatusWord = "open" | "in_progress" | "done";

export const PORTAL_SERVICE_STATUS_WORD: Record<PortalLang, Record<PortalServiceStatusWord, string>> = {
  de: { open: "Offen", in_progress: "In Arbeit", done: "Erledigt" },
  en: { open: "Open", in_progress: "In progress", done: "Completed" },
};

// F10-03b: Timeline-Worte je Sprache (Allowlist-Typen wie bisher).
export function formatPortalTimelineEntry(lang: PortalLang, type: string, day: string): string {
  if (lang === "en") {
    switch (type) {
      case "created": return `Created on ${day}`;
      case "completed": return `Completed on ${day}`;
      case "handover_recorded": return `Accepted on ${day}`;
      default: return `Event on ${day}`;
    }
  }
  switch (type) {
    case "created": return `Angelegt am ${day}`;
    case "completed": return `Abgeschlossen am ${day}`;
    case "handover_recorded": return `Abgenommen am ${day}`;
    default: return `Ereignis am ${day}`;
  }
}

// Abgeleiteter Next-Step je Sprache (Phasen/Outcomes wie
// PORTAL_PHASE_NEXT_STEP in portal-contract; Default DE-kompatibel).
export function resolvePortalNextStep(phase: string, outcome: string, lang: PortalLang): string {
  if (lang === "en") {
    if (outcome === "won") return "Order confirmed";
    if (outcome === "lost" || outcome === "cannot_fulfill") return "Case closed";
    switch (phase) {
      case "request": return "Enquiry under review";
      case "offer": return "Offer available";
      case "installation": return "Installation in progress";
      default: return "Status being clarified";
    }
  }
  if (outcome === "won") return "Auftrag bestätigt";
  if (outcome === "lost" || outcome === "cannot_fulfill") return "Vorgang abgeschlossen";
  switch (phase) {
    case "request": return "Anfrage in Prüfung";
    case "offer": return "Angebot liegt vor";
    case "installation": return "Installation läuft";
    default: return "Stand in Klärung";
  }
}

// F10-05-Fallbackworte je Sprache (nur ohne Admin-Override; Overrides
// bleiben Kundendaten und werden nie übersetzt).
export const PORTAL_INSTALLATION_FALLBACK_WORD: Record<
  PortalLang,
  { active: string; completed: string; handover: string }
> = {
  de: { active: "In Ausführung", completed: "Abgeschlossen", handover: "Abgenommen" },
  en: { active: "In progress", completed: "Completed", handover: "Accepted" },
};

// F10-09: Anzeigeschlüssel für die FAQ (gleiche Ableitung wie das
// Statuswort: Abnahme schlägt Abschluss schlägt laufend).
export function resolvePortalInstallationFaqKey(
  status: "active" | "completed",
  handoverAt: string | null,
): "active" | "completed" | "handover" {
  if (status === "completed" && handoverAt !== null) return "handover";
  if (status === "completed") return "completed";
  return "active";
}

export function formatPortalInstallationStatus(
  lang: PortalLang,
  status: "active" | "completed",
  completedAt: string | null,
  handoverAt: string | null,
  statusLabels: { active?: string; completed?: string; handover?: string },
): string {
  const fallback = PORTAL_INSTALLATION_FALLBACK_WORD[lang];
  const joiner = lang === "en" ? "on" : "am";
  if (status === "completed" && handoverAt !== null) {
    const word = statusLabels.handover ?? fallback.handover;
    return `${word} ${joiner} ${formatPortalDate(lang, handoverAt)}`;
  }
  if (status === "completed") {
    const word = statusLabels.completed ?? fallback.completed;
    return completedAt === null ? word : `${word} ${joiner} ${formatPortalDate(lang, completedAt)}`;
  }
  return statusLabels.active ?? fallback.active;
}

// F13-04: Förderstatus/-programme je Sprache (BzA/BnD/KfW/BAFA Eigennamen).
export type PortalSubsidyStatusWord =
  | "vorbereitung"
  | "bza_eingereicht"
  | "korrektur"
  | "bza_bewilligt"
  | "bnd_eingereicht"
  | "abgeschlossen"
  | "storniert";

export const PORTAL_SUBSIDY_STATUS_WORD: Record<PortalLang, Record<PortalSubsidyStatusWord, string>> = {
  de: {
    vorbereitung: "In Vorbereitung",
    bza_eingereicht: "BzA eingereicht",
    korrektur: "Korrektur",
    bza_bewilligt: "BzA bewilligt",
    bnd_eingereicht: "BnD eingereicht",
    abgeschlossen: "Abgeschlossen",
    storniert: "Storniert",
  },
  en: {
    vorbereitung: "In preparation",
    bza_eingereicht: "BzA submitted",
    korrektur: "Correction",
    bza_bewilligt: "BzA approved",
    bnd_eingereicht: "BnD submitted",
    abgeschlossen: "Completed",
    storniert: "Cancelled",
  },
};

export type PortalSubsidyProgramWord = "kfw" | "bafa" | "sonstige";

export const PORTAL_SUBSIDY_PROGRAM_WORD: Record<PortalLang, Record<PortalSubsidyProgramWord, string>> = {
  de: { kfw: "KfW", bafa: "BAFA", sonstige: "Sonstige" },
  en: { kfw: "KfW", bafa: "BAFA", sonstige: "Other" },
};

// F13-09: Netzstatus je Sprache.
export type PortalGridStatusWord =
  | "vorbereitung"
  | "eingereicht"
  | "genehmigt"
  | "fertiggemeldet"
  | "abgeschlossen"
  | "storniert";

export const PORTAL_GRID_STATUS_WORD: Record<PortalLang, Record<PortalGridStatusWord, string>> = {
  de: {
    vorbereitung: "In Vorbereitung",
    eingereicht: "Eingereicht",
    genehmigt: "Genehmigt",
    fertiggemeldet: "Fertig gemeldet",
    abgeschlossen: "Abgeschlossen",
    storniert: "Storniert",
  },
  en: {
    vorbereitung: "In preparation",
    eingereicht: "Submitted",
    genehmigt: "Approved",
    fertiggemeldet: "Completion reported",
    abgeschlossen: "Completed",
    storniert: "Cancelled",
  },
};

export const PORTAL_STRINGS: Record<PortalLang, PortalStrings> = {
  de: {
    metaTitle: "Kundenportal",
    brand: "Kundenportal",
    navAria: "Portalbereiche",
    navOverview: "Übersicht",
    navAppointments: "Termine",
    navInstallation: "Installation",
    navFiles: "Dateien",
    statusTerm: "Stand:",
    installationHeading: "Installation",
    installationEmpty: "Noch keine Installation hinterlegt.",
    faqHeading: "Gut zu wissen",
    chatHeading: "Nachrichten zur Förderung",
    chatEmpty: "Noch keine Nachrichten.",
    chatSend: "Senden",
    chatOk: "Nachricht gesendet.",
    chatGone: "Nachricht konnte nicht gesendet werden.",
    chatSideInternal: "Energieberatung",
    chatSideCustomer: "Sie",
    historyHeading: "Verlauf",
    historyEmpty: "Noch keine Ereignisse.",
    appointmentsHeading: "Termine",
    appointmentsEmpty: "Aktuell liegen keine Termine vor.",
    allDayWord: "ganztägig",
    filesHeading: "Dateien",
    filesEmpty: "Aktuell werden keine Dateien benötigt.",
    uploadedWord: "Hochgeladen",
    uploadedCountWord: "Dateien erhalten",
    uploadMoreHint: "Sie können weitere Dateien nachreichen.",
    uploadFileAriaPrefix: "Datei für",
    uploadButton: "Hochladen",
    uploadOk: "Vielen Dank — die Datei ist eingegangen.",
    uploadInvalid: "Die Datei ist ungültig (PDF, JPG oder PNG, höchstens 10 MB).",
    uploadConflict: "Diese Anfrage ist bereits beantwortet.",
    uploadGone: "Die Anfrage ist nicht mehr verfügbar.",
    documentsHeading: "Dokumente",
    documentsEmpty: "Aktuell liegen keine freigegebenen Dokumente vor.",
    offerWord: "Angebot",
    downloadWord: "Herunterladen",
    invoicesHeading: "Rechnungen",
    invoicesEmpty: "Aktuell liegen keine Rechnungen vor.",
    invoiceWord: "Rechnung",
    creditNoteWord: "Gutschrift",
    invoicePaymentUnpaid: "Offen",
    invoicePaymentPartiallyPaid: "Teilweise bezahlt",
    invoicePaymentPaid: "Bezahlt",
    invoicePaymentOverdue: "Überfällig",
    invoicePaymentUncollectable: "Uneinbringlich",
    invoicePaymentUnknown: "–",
    subsidyHeading: "Förderung",
    gridHeading: "Netzanmeldung",
    serviceHeading: "Service",
    acknowledgedSuffix: "· Zur Kenntnis genommen",
    acknowledgeButton: "Zur Kenntnis nehmen",
    confirmOk: "Vielen Dank — die Erledigung ist zur Kenntnis genommen.",
    confirmKnown: "Dieser Vorgang ist bereits zur Kenntnis genommen.",
    confirmGone: "Der Vorgang ist nicht mehr verfügbar.",
    invalidTitle: "Dieser Link ist ungültig.",
    invalidBody:
      "Der Link ist unbekannt, abgelaufen oder wurde zurückgezogen. Bitte wende dich an deine " +
      "Ansprechperson für einen neuen Zugang. Es wurden keine Inhalte geladen.",
  },
  en: {
    metaTitle: "Customer portal",
    brand: "Customer portal",
    navAria: "Portal sections",
    navOverview: "Overview",
    navAppointments: "Appointments",
    navInstallation: "Installation",
    navFiles: "Files",
    statusTerm: "Status:",
    installationHeading: "Installation",
    installationEmpty: "No installation recorded yet.",
    faqHeading: "Good to know",
    chatHeading: "Subsidy messages",
    chatEmpty: "No messages yet.",
    chatSend: "Send",
    chatOk: "Message sent.",
    chatGone: "Message could not be sent.",
    chatSideInternal: "Energy advisor",
    chatSideCustomer: "You",
    historyHeading: "History",
    historyEmpty: "No events yet.",
    appointmentsHeading: "Appointments",
    appointmentsEmpty: "No appointments scheduled.",
    allDayWord: "all day",
    filesHeading: "Files",
    filesEmpty: "No files are currently required.",
    uploadedWord: "Uploaded",
    uploadedCountWord: "files received",
    uploadMoreHint: "You may submit additional files.",
    uploadFileAriaPrefix: "File for",
    uploadButton: "Upload",
    uploadOk: "Thank you — your file has been received.",
    uploadInvalid: "The file is invalid (PDF, JPG or PNG, max 10 MB).",
    uploadConflict: "This request has already been answered.",
    uploadGone: "This request is no longer available.",
    documentsHeading: "Documents",
    documentsEmpty: "No released documents available.",
    offerWord: "Offer",
    downloadWord: "Download",
    invoicesHeading: "Invoices",
    invoicesEmpty: "No invoices available.",
    invoiceWord: "Invoice",
    creditNoteWord: "Credit note",
    invoicePaymentUnpaid: "Open",
    invoicePaymentPartiallyPaid: "Partially paid",
    invoicePaymentPaid: "Paid",
    invoicePaymentOverdue: "Overdue",
    invoicePaymentUncollectable: "Uncollectible",
    invoicePaymentUnknown: "–",
    subsidyHeading: "Subsidy",
    gridHeading: "Grid registration",
    serviceHeading: "Service",
    acknowledgedSuffix: "· Acknowledged",
    acknowledgeButton: "Acknowledge",
    confirmOk: "Thank you — completion acknowledged.",
    confirmKnown: "This case has already been acknowledged.",
    confirmGone: "This case is no longer available.",
    invalidTitle: "This link is invalid.",
    invalidBody:
      "The link is unknown, expired or has been withdrawn. Please contact your " +
      "representative for new access. No content was loaded.",
  },
};
