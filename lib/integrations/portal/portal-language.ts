// F10-06 Portal-Sprachen (Slice 1: DE/EN; Slice 2: Katalog-11, ESTIMATE):
// Kundenportal in elf Sprachen. Reine Darstellungsschicht ohne Migration,
// ohne neue Permission, ohne I/O. Slice-2-Katalog (ESTIMATE, reversibel,
// kein Reonic-Referenzbeleg — Vault-Antwort Q-WEITERBAU-20260914 auf dieser
// Maschine nicht auffindbar): DE vorangestellt (Default) + EN
// (Verkehrssprache) + die neun übrigen meistgesprochenen EU-Amtssprachen
// (cs/el/es/fr/hu/it/nl/pl/ro; Gleichstand cs/pt/sv zugunsten cs
// entschieden). Austausch einzelner Katalogeinträge später ist datenrein
// (kein Vertragsumbau).
//
// Umfang: Portal-Chrome (Navigation, Überschriften, Hinweise, Buttons,
// Leerstände), seitenlokale Statusworte (Signatur/Service/Timeline/
// Next-Step), Installations-Fallbackworte (nur ohne Admin-Override)
// sowie Förder-/Netzstatus (BzA/BnD/KfW/BAFA als Eigennamen unverändert).
// Bewusst NICHT übersetzt: Admin-Statuslabels (F10-05, Kundendaten wie
// erfasst), Projekt-/Termin-/Dateinamen, Betreiber- und Dateinamen,
// interne Modul-Labelmaps (interne App bleibt deutsch).

export const PORTAL_LANGUAGE_VERSION = "portal-language.v2" as const;

export const PORTAL_LANG_COOKIE = "portal-lang" as const;
export const PORTAL_LANG_COOKIE_MAX_AGE = 31536000 as const; // 1 Jahr

export const portalLangs = [
  "de",
  "en",
  "cs",
  "el",
  "es",
  "fr",
  "hu",
  "it",
  "nl",
  "pl",
  "ro",
] as const;
export type PortalLang = (typeof portalLangs)[number];

// Fail-closed: alles außer exakt einem Katalogeintrag (nach trim/lowercase,
// erster Wert bei Mehrfachnennung) fällt auf Deutsch zurück — kein Orakel,
// kein 404.
export function parsePortalLang(value: unknown): PortalLang {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string") return "de";
  const candidate = first.trim().toLowerCase();
  return (portalLangs as readonly string[]).includes(candidate)
    ? (candidate as PortalLang)
    : "de";
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
  // F10-02c: Portal-Signatur schreiben (Annehmen/Widerrufen je Dokument).
  signButton: string;
  revokeButton: string;
  signOk: string;
  signKnown: string;
  signGone: string;
  revokeOk: string;
  revokeKnown: string;
  revokeGone: string;
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

// BCP-47-Locale je Katalogsprache (EUR-Raum, Berliner Zeitzone).
const PORTAL_LOCALES: Record<PortalLang, string> = {
  de: "de-DE",
  en: "en-GB",
  cs: "cs-CZ",
  el: "el-GR",
  es: "es-ES",
  fr: "fr-FR",
  hu: "hu-HU",
  it: "it-IT",
  nl: "nl-NL",
  pl: "pl-PL",
  ro: "ro-RO",
};

function buildFormatters(): {
  date: Record<PortalLang, Intl.DateTimeFormat>;
  time: Record<PortalLang, Intl.DateTimeFormat>;
  euro: Record<PortalLang, Intl.NumberFormat>;
} {
  const date = {} as Record<PortalLang, Intl.DateTimeFormat>;
  const time = {} as Record<PortalLang, Intl.DateTimeFormat>;
  const euro = {} as Record<PortalLang, Intl.NumberFormat>;
  for (const lang of portalLangs) {
    const locale = PORTAL_LOCALES[lang];
    date[lang] = new Intl.DateTimeFormat(locale, {
      timeZone: BERLIN_TZ,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    time[lang] = new Intl.DateTimeFormat(locale, {
      timeZone: BERLIN_TZ,
      hour: "2-digit",
      minute: "2-digit",
    });
    euro[lang] = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });
  }
  return { date, time, euro };
}

const { date: dateFormatters, time: timeFormatters, euro: euroFormatters } = buildFormatters();

export function formatPortalDate(lang: PortalLang, at: string | Date): string {
  return dateFormatters[lang].format(new Date(at));
}

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

// Datums-Fügewörter je Sprache ("am"/"on"-Äquivalent; "" = ohne Füger,
// dann einfache Leerzeichen-Fügung). ESTIMATE wie alle Slice-2-Worte.
const PORTAL_DATE_JOINER: Record<PortalLang, string> = {
  de: "am",
  en: "on",
  cs: "dne",
  el: "στις",
  es: "el",
  fr: "le",
  hu: "",
  it: "il",
  nl: "op",
  pl: "dnia",
  ro: "la",
};

// Bereichsanzeige Berlin (Datum + Uhrzeit); nur DE mit „Uhr"-Suffix,
// ganztägig aus der Worttabelle (t.allDayWord).
export function formatPortalRange(
  lang: PortalLang,
  startAt: string,
  endAt: string,
  allDay: boolean,
): string {
  const start = new Date(startAt);
  const date = dateFormatters[lang].format(start);
  const t = PORTAL_STRINGS[lang];
  if (allDay) {
    return `${date} · ${t.allDayWord}`;
  }
  const span = `${timeFormatters[lang].format(start)}–${timeFormatters[lang].format(new Date(endAt))}`;
  return lang === "de" ? `${date} · ${span} Uhr` : `${date} · ${span}`;
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
  cs: {
    none: "Podpis: nepožadován",
    pending: "Podpis: čeká",
    signed: "Podpis: podepsán",
    expired: "Podpis: vypršel",
    withdrawn: "Podpis: stažen",
    revoked_by_customer: "Podpis: zákazníkem odvolán",
  },
  el: {
    none: "Υπογραφή: δεν ζητήθηκε",
    pending: "Υπογραφή: σε εκκρεμότητα",
    signed: "Υπογραφή: υπογράφηκε",
    expired: "Υπογραφή: έληξε",
    withdrawn: "Υπογραφή: αποσύρθηκε",
    revoked_by_customer: "Υπογραφή: ανακλήθηκε από τον πελάτη",
  },
  es: {
    none: "Firma: no solicitada",
    pending: "Firma: pendiente",
    signed: "Firma: firmada",
    expired: "Firma: caducada",
    withdrawn: "Firma: retirada",
    revoked_by_customer: "Firma: revocada por el cliente",
  },
  fr: {
    none: "Signature : non demandée",
    pending: "Signature : en attente",
    signed: "Signature : signée",
    expired: "Signature : expirée",
    withdrawn: "Signature : retirée",
    revoked_by_customer: "Signature : révoquée par le client",
  },
  hu: {
    none: "Aláírás: nem kért",
    pending: "Aláírás: függőben",
    signed: "Aláírás: aláírva",
    expired: "Aláírás: lejárt",
    withdrawn: "Aláírás: visszavonva",
    revoked_by_customer: "Aláírás: ügyfél által visszavonva",
  },
  it: {
    none: "Firma: non richiesta",
    pending: "Firma: in attesa",
    signed: "Firma: firmata",
    expired: "Firma: scaduta",
    withdrawn: "Firma: ritirata",
    revoked_by_customer: "Firma: revocata dal cliente",
  },
  nl: {
    none: "Handtekening: niet aangevraagd",
    pending: "Handtekening: in afwachting",
    signed: "Handtekening: ondertekend",
    expired: "Handtekening: verlopen",
    withdrawn: "Handtekening: ingetrokken",
    revoked_by_customer: "Handtekening: door klant ingetrokken",
  },
  pl: {
    none: "Podpis: nie wymagany",
    pending: "Podpis: oczekujący",
    signed: "Podpis: podpisany",
    expired: "Podpis: wygasł",
    withdrawn: "Podpis: wycofany",
    revoked_by_customer: "Podpis: odwołany przez klienta",
  },
  ro: {
    none: "Semnătură: nesolicitată",
    pending: "Semnătură: în așteptare",
    signed: "Semnătură: semnată",
    expired: "Semnătură: expirată",
    withdrawn: "Semnătură: retrasă",
    revoked_by_customer: "Semnătură: revocată de client",
  },
};

// "Signiert"-Partizip je Sprache (ESTIMATE).
const PORTAL_SIGNED_WORD: Record<PortalLang, string> = {
  de: "Signiert",
  en: "Signed",
  cs: "Podepsáno",
  el: "Υπογράφηκε",
  es: "Firmado",
  fr: "Signé",
  hu: "Aláírva",
  it: "Firmato",
  nl: "Ondertekend",
  pl: "Podpisano",
  ro: "Semnat",
};

export function formatPortalSignatureStatus(
  lang: PortalLang,
  status: string,
  signedAt: string | null,
): string {
  if (status === "signed" && signedAt !== null) {
    const when = formatPortalDate(lang, signedAt);
    const joiner = PORTAL_DATE_JOINER[lang];
    return joiner === "" ? `${PORTAL_SIGNED_WORD[lang]} ${when}` : `${PORTAL_SIGNED_WORD[lang]} ${joiner} ${when}`;
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
  cs: { open: "Otevřeno", in_progress: "Probíhá", done: "Hotovo" },
  el: { open: "Ανοιχτό", in_progress: "Σε εξέλιξη", done: "Ολοκληρώθηκε" },
  es: { open: "Abierto", in_progress: "En curso", done: "Terminado" },
  fr: { open: "Ouvert", in_progress: "En cours", done: "Terminé" },
  hu: { open: "Nyitott", in_progress: "Folyamatban", done: "Kész" },
  it: { open: "Aperto", in_progress: "In corso", done: "Completato" },
  nl: { open: "Open", in_progress: "In behandeling", done: "Afgerond" },
  pl: { open: "Otwarte", in_progress: "W trakcie", done: "Ukończone" },
  ro: { open: "Deschis", in_progress: "În curs", done: "Finalizat" },
};

// F10-03b: Timeline-Worte je Sprache (Allowlist-Typen wie bisher, ESTIMATE).
const PORTAL_TIMELINE_WORD: Record<
  PortalLang,
  { created: string; completed: string; handover: string; other: string }
> = {
  de: { created: "Angelegt", completed: "Abgeschlossen", handover: "Abgenommen", other: "Ereignis" },
  en: { created: "Created", completed: "Completed", handover: "Accepted", other: "Event" },
  cs: { created: "Vytvořeno", completed: "Dokončeno", handover: "Převzato", other: "Událost" },
  el: { created: "Δημιουργήθηκε", completed: "Ολοκληρώθηκε", handover: "Παραλήφθηκε", other: "Συμβάν" },
  es: { created: "Creado", completed: "Completado", handover: "Aceptado", other: "Evento" },
  fr: { created: "Créé", completed: "Terminé", handover: "Accepté", other: "Événement" },
  hu: { created: "Létrehozva", completed: "Befejezve", handover: "Átvéve", other: "Esemény" },
  it: { created: "Creato", completed: "Completato", handover: "Accettato", other: "Evento" },
  nl: { created: "Aangemaakt", completed: "Voltooid", handover: "Geaccepteerd", other: "Gebeurtenis" },
  pl: { created: "Utworzono", completed: "Ukończono", handover: "Odebrano", other: "Zdarzenie" },
  ro: { created: "Creat", completed: "Finalizat", handover: "Acceptat", other: "Eveniment" },
};

export function formatPortalTimelineEntry(lang: PortalLang, type: string, day: string): string {
  const words = PORTAL_TIMELINE_WORD[lang];
  const word = type === "created"
    ? words.created
    : type === "completed"
      ? words.completed
      : type === "handover_recorded"
        ? words.handover
        : words.other;
  const joiner = PORTAL_DATE_JOINER[lang];
  return joiner === "" ? `${word} ${day}` : `${word} ${joiner} ${day}`;
}

// Abgeleiteter Next-Step je Sprache (Phasen/Outcomes wie
// PORTAL_PHASE_NEXT_STEP in portal-contract; ESTIMATE außer DE/EN).
const PORTAL_NEXT_STEP_WORD: Record<
  PortalLang,
  { won: string; closed: string; request: string; offer: string; installation: string; other: string }
> = {
  de: { won: "Auftrag bestätigt", closed: "Vorgang abgeschlossen", request: "Anfrage in Prüfung", offer: "Angebot liegt vor", installation: "Installation läuft", other: "Stand in Klärung" },
  en: { won: "Order confirmed", closed: "Case closed", request: "Enquiry under review", offer: "Offer available", installation: "Installation in progress", other: "Status being clarified" },
  cs: { won: "Objednávka potvrzena", closed: "Případ uzavřen", request: "Poptávka se kontroluje", offer: "Nabídka je k dispozici", installation: "Probíhá instalace", other: "Stav se upřesňuje" },
  el: { won: "Η παραγγελία επιβεβαιώθηκε", closed: "Η υπόθεση έκλεισε", request: "Το αίτημα εξετάζεται", offer: "Διαθέσιμη προσφορά", installation: "Η εγκατάσταση βρίσκεται σε εξέλιξη", other: "Η κατάσταση διευκρινίζεται" },
  es: { won: "Pedido confirmado", closed: "Caso cerrado", request: "Solicitud en revisión", offer: "Oferta disponible", installation: "Instalación en curso", other: "Estado en aclaración" },
  fr: { won: "Commande confirmée", closed: "Dossier clôturé", request: "Demande en cours d'examen", offer: "Offre disponible", installation: "Installation en cours", other: "Statut en cours de clarification" },
  hu: { won: "Megrendelés megerősítve", closed: "Ügy lezárva", request: "Megkeresés elbírálás alatt", offer: "Ajánlat elérhető", installation: "Telepítés folyamatban", other: "Státusz tisztázás alatt" },
  it: { won: "Ordine confermato", closed: "Pratica chiusa", request: "Richiesta in esame", offer: "Offerta disponibile", installation: "Installazione in corso", other: "Stato in chiarimento" },
  nl: { won: "Order bevestigd", closed: "Zaak gesloten", request: "Aanvraag in beoordeling", offer: "Offerte beschikbaar", installation: "Installatie loopt", other: "Status wordt verduidelijkt" },
  pl: { won: "Zamówienie potwierdzone", closed: "Sprawa zamknięta", request: "Zapytanie w przeglądzie", offer: "Oferta dostępna", installation: "Instalacja w toku", other: "Status w wyjaśnianiu" },
  ro: { won: "Comandă confirmată", closed: "Caz închis", request: "Solicitare în examinare", offer: "Ofertă disponibilă", installation: "Instalare în curs", other: "Stare în clarificare" },
};

export function resolvePortalNextStep(phase: string, outcome: string, lang: PortalLang): string {
  const words = PORTAL_NEXT_STEP_WORD[lang];
  if (outcome === "won") return words.won;
  if (outcome === "lost" || outcome === "cannot_fulfill") return words.closed;
  switch (phase) {
    case "request": return words.request;
    case "offer": return words.offer;
    case "installation": return words.installation;
    default: return words.other;
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
  cs: { active: "Probíhá", completed: "Dokončeno", handover: "Převzato" },
  el: { active: "Σε εξέλιξη", completed: "Ολοκληρώθηκε", handover: "Παραλήφθηκε" },
  es: { active: "En curso", completed: "Completado", handover: "Aceptado" },
  fr: { active: "En cours", completed: "Terminé", handover: "Accepté" },
  hu: { active: "Folyamatban", completed: "Befejezve", handover: "Átvéve" },
  it: { active: "In corso", completed: "Completato", handover: "Accettato" },
  nl: { active: "In uitvoering", completed: "Voltooid", handover: "Geaccepteerd" },
  pl: { active: "W toku", completed: "Ukończono", handover: "Odebrano" },
  ro: { active: "În curs", completed: "Finalizat", handover: "Acceptat" },
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
  const joinDate = (word: string, at: string): string => {
    const joiner = PORTAL_DATE_JOINER[lang];
    const date = formatPortalDate(lang, at);
    return joiner === "" ? `${word} ${date}` : `${word} ${joiner} ${date}`;
  };
  if (status === "completed" && handoverAt !== null) {
    const word = statusLabels.handover ?? fallback.handover;
    return joinDate(word, handoverAt);
  }
  if (status === "completed") {
    const word = statusLabels.completed ?? fallback.completed;
    return completedAt === null ? word : joinDate(word, completedAt);
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
  cs: {
    vorbereitung: "V přípravě",
    bza_eingereicht: "BzA odesláno",
    korrektur: "Oprava",
    bza_bewilligt: "BzA schváleno",
    bnd_eingereicht: "BnD odesláno",
    abgeschlossen: "Dokončeno",
    storniert: "Zrušeno",
  },
  el: {
    vorbereitung: "Σε προετοιμασία",
    bza_eingereicht: "BzA υποβλήθηκε",
    korrektur: "Διόρθωση",
    bza_bewilligt: "BzA εγκρίθηκε",
    bnd_eingereicht: "BnD υποβλήθηκε",
    abgeschlossen: "Ολοκληρώθηκε",
    storniert: "Ακυρώθηκε",
  },
  es: {
    vorbereitung: "En preparación",
    bza_eingereicht: "BzA enviado",
    korrektur: "Corrección",
    bza_bewilligt: "BzA aprobado",
    bnd_eingereicht: "BnD enviado",
    abgeschlossen: "Completado",
    storniert: "Cancelado",
  },
  fr: {
    vorbereitung: "En préparation",
    bza_eingereicht: "BzA envoyé",
    korrektur: "Correction",
    bza_bewilligt: "BzA approuvé",
    bnd_eingereicht: "BnD envoyé",
    abgeschlossen: "Terminé",
    storniert: "Annulé",
  },
  hu: {
    vorbereitung: "Előkészítés alatt",
    bza_eingereicht: "BzA beküldve",
    korrektur: "Javítás",
    bza_bewilligt: "BzA jóváhagyva",
    bnd_eingereicht: "BnD beküldve",
    abgeschlossen: "Befejezve",
    storniert: "Törölve",
  },
  it: {
    vorbereitung: "In preparazione",
    bza_eingereicht: "BzA inviato",
    korrektur: "Correzione",
    bza_bewilligt: "BzA approvato",
    bnd_eingereicht: "BnD inviato",
    abgeschlossen: "Completato",
    storniert: "Annullato",
  },
  nl: {
    vorbereitung: "In voorbereiding",
    bza_eingereicht: "BzA verzonden",
    korrektur: "Correctie",
    bza_bewilligt: "BzA goedgekeurd",
    bnd_eingereicht: "BnD verzonden",
    abgeschlossen: "Voltooid",
    storniert: "Geannuleerd",
  },
  pl: {
    vorbereitung: "W przygotowaniu",
    bza_eingereicht: "BzA wysłany",
    korrektur: "Korekta",
    bza_bewilligt: "BzA zatwierdzony",
    bnd_eingereicht: "BnD wysłany",
    abgeschlossen: "Ukończono",
    storniert: "Anulowano",
  },
  ro: {
    vorbereitung: "În pregătire",
    bza_eingereicht: "BzA trimis",
    korrektur: "Corecție",
    bza_bewilligt: "BzA aprobat",
    bnd_eingereicht: "BnD trimis",
    abgeschlossen: "Finalizat",
    storniert: "Anulat",
  },
};

export type PortalSubsidyProgramWord = "kfw" | "bafa" | "sonstige";

export const PORTAL_SUBSIDY_PROGRAM_WORD: Record<PortalLang, Record<PortalSubsidyProgramWord, string>> = {
  de: { kfw: "KfW", bafa: "BAFA", sonstige: "Sonstige" },
  en: { kfw: "KfW", bafa: "BAFA", sonstige: "Other" },
  cs: { kfw: "KfW", bafa: "BAFA", sonstige: "Ostatní" },
  el: { kfw: "KfW", bafa: "BAFA", sonstige: "Άλλο" },
  es: { kfw: "KfW", bafa: "BAFA", sonstige: "Otro" },
  fr: { kfw: "KfW", bafa: "BAFA", sonstige: "Autre" },
  hu: { kfw: "KfW", bafa: "BAFA", sonstige: "Egyéb" },
  it: { kfw: "KfW", bafa: "BAFA", sonstige: "Altro" },
  nl: { kfw: "KfW", bafa: "BAFA", sonstige: "Overig" },
  pl: { kfw: "KfW", bafa: "BAFA", sonstige: "Inne" },
  ro: { kfw: "KfW", bafa: "BAFA", sonstige: "Altele" },
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
  cs: {
    vorbereitung: "V přípravě",
    eingereicht: "Odesláno",
    genehmigt: "Schváleno",
    fertiggemeldet: "Nahlášeno dokončení",
    abgeschlossen: "Dokončeno",
    storniert: "Zrušeno",
  },
  el: {
    vorbereitung: "Σε προετοιμασία",
    eingereicht: "Υποβλήθηκε",
    genehmigt: "Εγκρίθηκε",
    fertiggemeldet: "Δηλώθηκε ολοκλήρωση",
    abgeschlossen: "Ολοκληρώθηκε",
    storniert: "Ακυρώθηκε",
  },
  es: {
    vorbereitung: "En preparación",
    eingereicht: "Enviado",
    genehmigt: "Aprobado",
    fertiggemeldet: "Finalización comunicada",
    abgeschlossen: "Completado",
    storniert: "Cancelado",
  },
  fr: {
    vorbereitung: "En préparation",
    eingereicht: "Envoyé",
    genehmigt: "Approuvé",
    fertiggemeldet: "Achèvement signalé",
    abgeschlossen: "Terminé",
    storniert: "Annulé",
  },
  hu: {
    vorbereitung: "Előkészítés alatt",
    eingereicht: "Beküldve",
    genehmigt: "Jóváhagyva",
    fertiggemeldet: "Készre jelentve",
    abgeschlossen: "Befejezve",
    storniert: "Törölve",
  },
  it: {
    vorbereitung: "In preparazione",
    eingereicht: "Inviato",
    genehmigt: "Approvato",
    fertiggemeldet: "Fine lavori comunicata",
    abgeschlossen: "Completato",
    storniert: "Annullato",
  },
  nl: {
    vorbereitung: "In voorbereiding",
    eingereicht: "Verzonden",
    genehmigt: "Goedgekeurd",
    fertiggemeldet: "Gereed gemeld",
    abgeschlossen: "Voltooid",
    storniert: "Geannuleerd",
  },
  pl: {
    vorbereitung: "W przygotowaniu",
    eingereicht: "Wysłany",
    genehmigt: "Zatwierdzony",
    fertiggemeldet: "Zgłoszono ukończenie",
    abgeschlossen: "Ukończono",
    storniert: "Anulowano",
  },
  ro: {
    vorbereitung: "În pregătire",
    eingereicht: "Trimis",
    genehmigt: "Aprobat",
    fertiggemeldet: "Finalizare comunicată",
    abgeschlossen: "Finalizat",
    storniert: "Anulat",
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
    signButton: "Angebot annehmen",
    revokeButton: "Widerrufen",
    signOk: "Vielen Dank — das Angebot ist angenommen.",
    signKnown: "Dieses Angebot ist bereits angenommen.",
    signGone: "Das Angebot ist nicht mehr verfügbar.",
    revokeOk: "Der Vertrag ist widerrufen.",
    revokeKnown: "Dieser Vertrag ist bereits widerrufen.",
    revokeGone: "Der Vertrag ist nicht mehr verfügbar.",
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
    signButton: "Accept offer",
    revokeButton: "Withdraw",
    signOk: "Thank you — the offer has been accepted.",
    signKnown: "This offer has already been accepted.",
    signGone: "This offer is no longer available.",
    revokeOk: "The contract has been withdrawn.",
    revokeKnown: "This contract has already been withdrawn.",
    revokeGone: "This contract is no longer available.",
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
  cs: {
    metaTitle: "Zákaznický portál",
    brand: "Zákaznický portál",
    navAria: "Sekce portálu",
    navOverview: "Přehled",
    navAppointments: "Termíny",
    navInstallation: "Instalace",
    navFiles: "Soubory",
    statusTerm: "Stav:",
    installationHeading: "Instalace",
    installationEmpty: "Zatím není evidována žádná instalace.",
    faqHeading: "Dobré vědět",
    chatHeading: "Zprávy o dotacích",
    chatEmpty: "Zatím žádné zprávy.",
    chatSend: "Odeslat",
    chatOk: "Zpráva odeslána.",
    chatGone: "Zprávu se nepodařilo odeslat.",
    chatSideInternal: "Energetický poradce",
    chatSideCustomer: "Vy",
    historyHeading: "Historie",
    historyEmpty: "Zatím žádné události.",
    appointmentsHeading: "Termíny",
    appointmentsEmpty: "Nejsou naplánovány žádné termíny.",
    allDayWord: "celý den",
    filesHeading: "Soubory",
    filesEmpty: "Momentálně nejsou vyžadovány žádné soubory.",
    uploadedWord: "Nahráno",
    uploadedCountWord: "obdržených souborů",
    uploadMoreHint: "Můžete doplnit další soubory.",
    uploadFileAriaPrefix: "Soubor pro",
    uploadButton: "Nahrát",
    uploadOk: "Děkujeme — soubor byl přijat.",
    uploadInvalid: "Soubor je neplatný (PDF, JPG nebo PNG, max. 10 MB).",
    uploadConflict: "Na tento požadavek již bylo odpovězeno.",
    uploadGone: "Tento požadavek již není k dispozici.",
    documentsHeading: "Dokumenty",
    documentsEmpty: "Nejsou k dispozici žádné zveřejněné dokumenty.",
    offerWord: "Nabídka",
    downloadWord: "Stáhnout",
    signButton: "Přijmout nabídku",
    revokeButton: "Odvolat",
    signOk: "Děkujeme — nabídka byla přijata.",
    signKnown: "Tato nabídka již byla přijata.",
    signGone: "Tato nabídka již není k dispozici.",
    revokeOk: "Smlouva byla odvolána.",
    revokeKnown: "Tato smlouva již byla odvolána.",
    revokeGone: "Tato smlouva již není k dispozici.",
    invoicesHeading: "Faktury",
    invoicesEmpty: "Nejsou k dispozici žádné faktury.",
    invoiceWord: "Faktura",
    creditNoteWord: "Dobropis",
    invoicePaymentUnpaid: "Nezaplacená",
    invoicePaymentPartiallyPaid: "Částečně zaplacená",
    invoicePaymentPaid: "Zaplacená",
    invoicePaymentOverdue: "Po splatnosti",
    invoicePaymentUncollectable: "Nevymahatelná",
    invoicePaymentUnknown: "–",
    subsidyHeading: "Dotace",
    gridHeading: "Připojení k síti",
    serviceHeading: "Servis",
    acknowledgedSuffix: "· Vzato na vědomí",
    acknowledgeButton: "Vzít na vědomí",
    confirmOk: "Děkujeme — dokončení bylo vzato na vědomí.",
    confirmKnown: "Tato operace již byla vzata na vědomí.",
    confirmGone: "Tato operace již není k dispozici.",
    invalidTitle: "Tento odkaz je neplatný.",
    invalidBody:
      "Odkaz je neznámý, jeho platnost vypršela, nebo byl stažen. Obraťte se " +
      "na svou kontaktní osobu pro nový přístup. Nebyl načten žádný obsah.",
  },
  el: {
    metaTitle: "Πύλη πελατών",
    brand: "Πύλη πελατών",
    navAria: "Ενότητες πύλης",
    navOverview: "Επισκόπηση",
    navAppointments: "Ραντεβού",
    navInstallation: "Εγκατάσταση",
    navFiles: "Αρχεία",
    statusTerm: "Κατάσταση:",
    installationHeading: "Εγκατάσταση",
    installationEmpty: "Δεν υπάρχει ακόμη καταχωρισμένη εγκατάσταση.",
    faqHeading: "Χρήσιμες πληροφορίες",
    chatHeading: "Μηνύματα επιδότησης",
    chatEmpty: "Δεν υπάρχουν ακόμη μηνύματα.",
    chatSend: "Αποστολή",
    chatOk: "Το μήνυμα εστάλη.",
    chatGone: "Το μήνυμα δεν μπόρεσε να σταλεί.",
    chatSideInternal: "Ενεργειακός σύμβουλος",
    chatSideCustomer: "Εσείς",
    historyHeading: "Ιστορικό",
    historyEmpty: "Δεν υπάρχουν ακόμη συμβάντα.",
    appointmentsHeading: "Ραντεβού",
    appointmentsEmpty: "Δεν υπάρχουν προγραμματισμένα ραντεβού.",
    allDayWord: "ολοήμερο",
    filesHeading: "Αρχεία",
    filesEmpty: "Δεν απαιτούνται προς το παρόν αρχεία.",
    uploadedWord: "Μεταφορτώθηκε",
    uploadedCountWord: "αρχεία που ελήφθησαν",
    uploadMoreHint: "Μπορείτε να προσθέσετε επιπλέον αρχεία.",
    uploadFileAriaPrefix: "Αρχείο για",
    uploadButton: "Μεταφόρτωση",
    uploadOk: "Ευχαριστούμε — το αρχείο ελήφθη.",
    uploadInvalid: "Το αρχείο δεν είναι έγκυρο (PDF, JPG ή PNG, έως 10 MB).",
    uploadConflict: "Αυτό το αίτημα έχει ήδη απαντηθεί.",
    uploadGone: "Αυτό το αίτημα δεν είναι πλέον διαθέσιμο.",
    documentsHeading: "Έγγραφα",
    documentsEmpty: "Δεν υπάρχουν δημοσιευμένα έγγραφα.",
    offerWord: "Προσφορά",
    downloadWord: "Λήψη",
    signButton: "Αποδοχή προσφοράς",
    revokeButton: "Ανάκληση",
    signOk: "Ευχαριστούμε — η προσφορά έγινε αποδεκτή.",
    signKnown: "Αυτή η προσφορά έχει ήδη γίνει αποδεκτή.",
    signGone: "Αυτή η προσφορά δεν είναι πλέον διαθέσιμη.",
    revokeOk: "Η σύμβαση ανακλήθηκε.",
    revokeKnown: "Αυτή η σύμβαση έχει ήδη ανακληθεί.",
    revokeGone: "Αυτή η σύμβαση δεν είναι πλέον διαθέσιμη.",
    invoicesHeading: "Τιμολόγια",
    invoicesEmpty: "Δεν υπάρχουν τιμολόγια.",
    invoiceWord: "Τιμολόγιο",
    creditNoteWord: "Πιστωτικό σημείωμα",
    invoicePaymentUnpaid: "Απλήρωτο",
    invoicePaymentPartiallyPaid: "Μερικώς εξοφλημένο",
    invoicePaymentPaid: "Εξοφλημένο",
    invoicePaymentOverdue: "Ληξιπρόθεσμο",
    invoicePaymentUncollectable: "Ανεπίδεκτο είσπραξης",
    invoicePaymentUnknown: "–",
    subsidyHeading: "Επιδότηση",
    gridHeading: "Σύνδεση δικτύου",
    serviceHeading: "Συντήρηση",
    acknowledgedSuffix: "· Λήφθηκε υπόψη",
    acknowledgeButton: "Λήψη υπόψη",
    confirmOk: "Ευχαριστούμε — η ολοκλήρωση λήφθηκε υπόψη.",
    confirmKnown: "Αυτή η ενέργεια έχει ήδη ληφθεί υπόψη.",
    confirmGone: "Αυτή η ενέργεια δεν είναι πλέον διαθέσιμη.",
    invalidTitle: "Αυτός ο σύνδεσμος δεν είναι έγκυρος.",
    invalidBody:
      "Ο σύνδεσμος είναι άγνωστος, έχει λήξει ή έχει αποσυρθεί. Επικοινωνήστε " +
      "με τον εκπρόσωπό σας για νέα πρόσβαση. Δεν φορτώθηκε περιεχόμενο.",
  },
  es: {
    metaTitle: "Portal del cliente",
    brand: "Portal del cliente",
    navAria: "Secciones del portal",
    navOverview: "Resumen",
    navAppointments: "Citas",
    navInstallation: "Instalación",
    navFiles: "Archivos",
    statusTerm: "Estado:",
    installationHeading: "Instalación",
    installationEmpty: "Todavía no hay ninguna instalación registrada.",
    faqHeading: "Conviene saber",
    chatHeading: "Mensajes de subvención",
    chatEmpty: "Todavía no hay mensajes.",
    chatSend: "Enviar",
    chatOk: "Mensaje enviado.",
    chatGone: "El mensaje no pudo enviarse.",
    chatSideInternal: "Asesor energético",
    chatSideCustomer: "Usted",
    historyHeading: "Historial",
    historyEmpty: "Todavía no hay eventos.",
    appointmentsHeading: "Citas",
    appointmentsEmpty: "No hay citas programadas.",
    allDayWord: "todo el día",
    filesHeading: "Archivos",
    filesEmpty: "Actualmente no se requieren archivos.",
    uploadedWord: "Subido",
    uploadedCountWord: "archivos recibidos",
    uploadMoreHint: "Puede añadir más archivos.",
    uploadFileAriaPrefix: "Archivo para",
    uploadButton: "Subir",
    uploadOk: "Gracias — el archivo fue recibido.",
    uploadInvalid: "El archivo no es válido (PDF, JPG o PNG, máx. 10 MB).",
    uploadConflict: "Esta solicitud ya fue respondida.",
    uploadGone: "Esta solicitud ya no está disponible.",
    documentsHeading: "Documentos",
    documentsEmpty: "No hay documentos publicados.",
    offerWord: "Oferta",
    downloadWord: "Descargar",
    signButton: "Aceptar oferta",
    revokeButton: "Revocar",
    signOk: "Gracias — la oferta fue aceptada.",
    signKnown: "Esta oferta ya fue aceptada.",
    signGone: "Esta oferta ya no está disponible.",
    revokeOk: "El contrato fue revocado.",
    revokeKnown: "Este contrato ya fue revocado.",
    revokeGone: "Este contrato ya no está disponible.",
    invoicesHeading: "Facturas",
    invoicesEmpty: "No hay facturas disponibles.",
    invoiceWord: "Factura",
    creditNoteWord: "Nota de crédito",
    invoicePaymentUnpaid: "Sin pagar",
    invoicePaymentPartiallyPaid: "Pagada parcialmente",
    invoicePaymentPaid: "Pagada",
    invoicePaymentOverdue: "Vencida",
    invoicePaymentUncollectable: "Incobrable",
    invoicePaymentUnknown: "–",
    subsidyHeading: "Subvención",
    gridHeading: "Conexión a la red",
    serviceHeading: "Servicio",
    acknowledgedSuffix: "· Recibido",
    acknowledgeButton: "Marcar como recibido",
    confirmOk: "Gracias — la finalización fue registrada.",
    confirmKnown: "Esta acción ya fue registrada.",
    confirmGone: "Esta acción ya no está disponible.",
    invalidTitle: "Este enlace no es válido.",
    invalidBody:
      "El enlace es desconocido, ha caducado o ha sido retirado. Póngase en " +
      "contacto con su representante para obtener un nuevo acceso. No se cargó contenido.",
  },
  fr: {
    metaTitle: "Portail client",
    brand: "Portail client",
    navAria: "Sections du portail",
    navOverview: "Aperçu",
    navAppointments: "Rendez-vous",
    navInstallation: "Installation",
    navFiles: "Fichiers",
    statusTerm: "Statut :",
    installationHeading: "Installation",
    installationEmpty: "Aucune installation enregistrée pour le moment.",
    faqHeading: "Bon à savoir",
    chatHeading: "Messages de subvention",
    chatEmpty: "Aucun message pour le moment.",
    chatSend: "Envoyer",
    chatOk: "Message envoyé.",
    chatGone: "Le message n'a pas pu être envoyé.",
    chatSideInternal: "Conseiller énergie",
    chatSideCustomer: "Vous",
    historyHeading: "Historique",
    historyEmpty: "Aucun événement pour le moment.",
    appointmentsHeading: "Rendez-vous",
    appointmentsEmpty: "Aucun rendez-vous planifié.",
    allDayWord: "toute la journée",
    filesHeading: "Fichiers",
    filesEmpty: "Aucun fichier requis pour le moment.",
    uploadedWord: "Téléversé",
    uploadedCountWord: "fichiers reçus",
    uploadMoreHint: "Vous pouvez ajouter d'autres fichiers.",
    uploadFileAriaPrefix: "Fichier pour",
    uploadButton: "Téléverser",
    uploadOk: "Merci — le fichier a bien été reçu.",
    uploadInvalid: "Le fichier n'est pas valide (PDF, JPG ou PNG, max. 10 Mo).",
    uploadConflict: "Cette demande a déjà reçu une réponse.",
    uploadGone: "Cette demande n'est plus disponible.",
    documentsHeading: "Documents",
    documentsEmpty: "Aucun document publié.",
    offerWord: "Offre",
    downloadWord: "Télécharger",
    signButton: "Accepter l'offre",
    revokeButton: "Révoquer",
    signOk: "Merci — l'offre a été acceptée.",
    signKnown: "Cette offre a déjà été acceptée.",
    signGone: "Cette offre n'est plus disponible.",
    revokeOk: "Le contrat a été révoqué.",
    revokeKnown: "Ce contrat a déjà été révoqué.",
    revokeGone: "Ce contrat n'est plus disponible.",
    invoicesHeading: "Factures",
    invoicesEmpty: "Aucune facture disponible.",
    invoiceWord: "Facture",
    creditNoteWord: "Avoir",
    invoicePaymentUnpaid: "Impayée",
    invoicePaymentPartiallyPaid: "Partiellement payée",
    invoicePaymentPaid: "Payée",
    invoicePaymentOverdue: "En retard",
    invoicePaymentUncollectable: "Irrécouvrable",
    invoicePaymentUnknown: "–",
    subsidyHeading: "Subvention",
    gridHeading: "Raccordement au réseau",
    serviceHeading: "Service",
    acknowledgedSuffix: "· Pris en compte",
    acknowledgeButton: "Prendre en compte",
    confirmOk: "Merci — l'achèvement a été pris en compte.",
    confirmKnown: "Cette action a déjà été prise en compte.",
    confirmGone: "Cette action n'est plus disponible.",
    invalidTitle: "Ce lien n'est pas valide.",
    invalidBody:
      "Le lien est inconnu, a expiré ou a été retiré. Veuillez contacter votre " +
      "interlocuteur pour un nouvel accès. Aucun contenu n'a été chargé.",
  },
  hu: {
    metaTitle: "Ügyfélportál",
    brand: "Ügyfélportál",
    navAria: "Portálszakaszok",
    navOverview: "Áttekintés",
    navAppointments: "Időpontok",
    navInstallation: "Telepítés",
    navFiles: "Fájlok",
    statusTerm: "Állapot:",
    installationHeading: "Telepítés",
    installationEmpty: "Még nincs rögzített telepítés.",
    faqHeading: "Jó tudni",
    chatHeading: "Támogatási üzenetek",
    chatEmpty: "Még nincsenek üzenetek.",
    chatSend: "Küldés",
    chatOk: "Üzenet elküldve.",
    chatGone: "Az üzenetet nem sikerült elküldeni.",
    chatSideInternal: "Energiatanácsadó",
    chatSideCustomer: "Ön",
    historyHeading: "Előzmények",
    historyEmpty: "Még nincsenek események.",
    appointmentsHeading: "Időpontok",
    appointmentsEmpty: "Nincs tervezett időpont.",
    allDayWord: "egész napos",
    filesHeading: "Fájlok",
    filesEmpty: "Jelenleg nincs szükség fájlra.",
    uploadedWord: "Feltöltve",
    uploadedCountWord: "beérkezett fájl",
    uploadMoreHint: "További fájlokat is hozzáadhat.",
    uploadFileAriaPrefix: "Fájl ehhez:",
    uploadButton: "Feltöltés",
    uploadOk: "Köszönjük — a fájl megérkezett.",
    uploadInvalid: "A fájl érvénytelen (PDF, JPG vagy PNG, max. 10 MB).",
    uploadConflict: "Erre a kérésre már válasz érkezett.",
    uploadGone: "Ez a kérés már nem érhető el.",
    documentsHeading: "Dokumentumok",
    documentsEmpty: "Nincs közzétett dokumentum.",
    offerWord: "Ajánlat",
    downloadWord: "Letöltés",
    signButton: "Ajánlat elfogadása",
    revokeButton: "Visszavonás",
    signOk: "Köszönjük — az ajánlat elfogadásra került.",
    signKnown: "Ezt az ajánlatot már elfogadták.",
    signGone: "Ez az ajánlat már nem érhető el.",
    revokeOk: "A szerződés visszavonásra került.",
    revokeKnown: "Ezt a szerződést már visszavonták.",
    revokeGone: "Ez a szerződés már nem érhető el.",
    invoicesHeading: "Számlák",
    invoicesEmpty: "Nincs elérhető számla.",
    invoiceWord: "Számla",
    creditNoteWord: "Jóváíró számla",
    invoicePaymentUnpaid: "Kifizetetlen",
    invoicePaymentPartiallyPaid: "Részben kifizetett",
    invoicePaymentPaid: "Kifizetett",
    invoicePaymentOverdue: "Lejárt",
    invoicePaymentUncollectable: "Behajthatatlan",
    invoicePaymentUnknown: "–",
    subsidyHeading: "Támogatás",
    gridHeading: "Hálózati csatlakozás",
    serviceHeading: "Szerviz",
    acknowledgedSuffix: "· Nyugtázva",
    acknowledgeButton: "Nyugtázom",
    confirmOk: "Köszönjük — a befejezés nyugtázva.",
    confirmKnown: "Ez a művelet már nyugtázva lett.",
    confirmGone: "Ez a művelet már nem érhető el.",
    invalidTitle: "Ez a hivatkozás érvénytelen.",
    invalidBody:
      "A hivatkozás ismeretlen, lejárt vagy visszavonásra került. Kérjen új " +
      "hozzáférést kapcsolattartójától. Nem töltődött be tartalom.",
  },
  it: {
    metaTitle: "Portale clienti",
    brand: "Portale clienti",
    navAria: "Sezioni del portale",
    navOverview: "Panoramica",
    navAppointments: "Appuntamenti",
    navInstallation: "Installazione",
    navFiles: "File",
    statusTerm: "Stato:",
    installationHeading: "Installazione",
    installationEmpty: "Nessuna installazione registrata al momento.",
    faqHeading: "Buono a sapersi",
    chatHeading: "Messaggi di incentivazione",
    chatEmpty: "Nessun messaggio al momento.",
    chatSend: "Invia",
    chatOk: "Messaggio inviato.",
    chatGone: "Il messaggio non è stato inviato.",
    chatSideInternal: "Consulente energetico",
    chatSideCustomer: "Voi",
    historyHeading: "Cronologia",
    historyEmpty: "Nessun evento al momento.",
    appointmentsHeading: "Appuntamenti",
    appointmentsEmpty: "Nessun appuntamento programmato.",
    allDayWord: "tutto il giorno",
    filesHeading: "File",
    filesEmpty: "Al momento non sono richiesti file.",
    uploadedWord: "Caricato",
    uploadedCountWord: "file ricevuti",
    uploadMoreHint: "È possibile aggiungere altri file.",
    uploadFileAriaPrefix: "File per",
    uploadButton: "Carica",
    uploadOk: "Grazie — il file è stato ricevuto.",
    uploadInvalid: "Il file non è valido (PDF, JPG o PNG, max. 10 MB).",
    uploadConflict: "A questa richiesta è già stata data risposta.",
    uploadGone: "Questa richiesta non è più disponibile.",
    documentsHeading: "Documenti",
    documentsEmpty: "Nessun documento pubblicato.",
    offerWord: "Offerta",
    downloadWord: "Scarica",
    signButton: "Accetta l'offerta",
    revokeButton: "Revoca",
    signOk: "Grazie — l'offerta è stata accettata.",
    signKnown: "Questa offerta è già stata accettata.",
    signGone: "Questa offerta non è più disponibile.",
    revokeOk: "Il contratto è stato revocato.",
    revokeKnown: "Questo contratto è già stato revocato.",
    revokeGone: "Questo contratto non è più disponibile.",
    invoicesHeading: "Fatture",
    invoicesEmpty: "Nessuna fattura disponibile.",
    invoiceWord: "Fattura",
    creditNoteWord: "Nota di credito",
    invoicePaymentUnpaid: "Non pagata",
    invoicePaymentPartiallyPaid: "Pagata in parte",
    invoicePaymentPaid: "Pagata",
    invoicePaymentOverdue: "Scaduta",
    invoicePaymentUncollectable: "Inesigibile",
    invoicePaymentUnknown: "–",
    subsidyHeading: "Incentivo",
    gridHeading: "Connessione alla rete",
    serviceHeading: "Assistenza",
    acknowledgedSuffix: "· Preso atto",
    acknowledgeButton: "Prendi atto",
    confirmOk: "Grazie — il completamento è stato registrato.",
    confirmKnown: "Questa azione è già stata registrata.",
    confirmGone: "Questa azione non è più disponibile.",
    invalidTitle: "Questo link non è valido.",
    invalidBody:
      "Il link è sconosciuto, è scaduto o è stato ritirato. Contattare il " +
      "proprio referente per un nuovo accesso. Nessun contenuto caricato.",
  },
  nl: {
    metaTitle: "Klantportaal",
    brand: "Klantportaal",
    navAria: "Portaalsecties",
    navOverview: "Overzicht",
    navAppointments: "Afspraken",
    navInstallation: "Installatie",
    navFiles: "Bestanden",
    statusTerm: "Status:",
    installationHeading: "Installatie",
    installationEmpty: "Nog geen installatie geregistreerd.",
    faqHeading: "Goed om te weten",
    chatHeading: "Subsidieberichten",
    chatEmpty: "Nog geen berichten.",
    chatSend: "Versturen",
    chatOk: "Bericht verzonden.",
    chatGone: "Het bericht kon niet worden verzonden.",
    chatSideInternal: "Energieadviseur",
    chatSideCustomer: "U",
    historyHeading: "Geschiedenis",
    historyEmpty: "Nog geen gebeurtenissen.",
    appointmentsHeading: "Afspraken",
    appointmentsEmpty: "Geen afspraken gepland.",
    allDayWord: "hele dag",
    filesHeading: "Bestanden",
    filesEmpty: "Er zijn momenteel geen bestanden vereist.",
    uploadedWord: "Geüpload",
    uploadedCountWord: "ontvangen bestanden",
    uploadMoreHint: "U kunt extra bestanden toevoegen.",
    uploadFileAriaPrefix: "Bestand voor",
    uploadButton: "Uploaden",
    uploadOk: "Bedankt — het bestand is ontvangen.",
    uploadInvalid: "Het bestand is ongeldig (PDF, JPG of PNG, max. 10 MB).",
    uploadConflict: "Dit verzoek is al beantwoord.",
    uploadGone: "Dit verzoek is niet meer beschikbaar.",
    documentsHeading: "Documenten",
    documentsEmpty: "Geen gepubliceerde documenten.",
    offerWord: "Offerte",
    downloadWord: "Downloaden",
    signButton: "Offerte accepteren",
    revokeButton: "Intrekken",
    signOk: "Bedankt — de offerte is geaccepteerd.",
    signKnown: "Deze offerte is al geaccepteerd.",
    signGone: "Deze offerte is niet meer beschikbaar.",
    revokeOk: "De overeenkomst is ingetrokken.",
    revokeKnown: "Deze overeenkomst is al ingetrokken.",
    revokeGone: "Deze overeenkomst is niet meer beschikbaar.",
    invoicesHeading: "Facturen",
    invoicesEmpty: "Geen facturen beschikbaar.",
    invoiceWord: "Factuur",
    creditNoteWord: "Creditnota",
    invoicePaymentUnpaid: "Onbetaald",
    invoicePaymentPartiallyPaid: "Gedeeltelijk betaald",
    invoicePaymentPaid: "Betaald",
    invoicePaymentOverdue: "Achterstallig",
    invoicePaymentUncollectable: "Oninbaar",
    invoicePaymentUnknown: "–",
    subsidyHeading: "Subsidie",
    gridHeading: "Netaansluiting",
    serviceHeading: "Service",
    acknowledgedSuffix: "· Kennisgenomen",
    acknowledgeButton: "Kennisnemen",
    confirmOk: "Bedankt — de oplevering is genoteerd.",
    confirmKnown: "Deze actie is al genoteerd.",
    confirmGone: "Deze actie is niet meer beschikbaar.",
    invalidTitle: "Deze link is ongeldig.",
    invalidBody:
      "De link is onbekend, verlopen of ingetrokken. Neem contact op met uw " +
      "contactpersoon voor nieuwe toegang. Er is geen inhoud geladen.",
  },
  pl: {
    metaTitle: "Portal klienta",
    brand: "Portal klienta",
    navAria: "Sekcje portalu",
    navOverview: "Przegląd",
    navAppointments: "Terminy",
    navInstallation: "Instalacja",
    navFiles: "Pliki",
    statusTerm: "Status:",
    installationHeading: "Instalacja",
    installationEmpty: "Nie zarejestrowano jeszcze instalacji.",
    faqHeading: "Warto wiedzieć",
    chatHeading: "Wiadomości o dotacjach",
    chatEmpty: "Brak wiadomości.",
    chatSend: "Wyślij",
    chatOk: "Wiadomość wysłana.",
    chatGone: "Nie udało się wysłać wiadomości.",
    chatSideInternal: "Doradca energetyczny",
    chatSideCustomer: "Ty",
    historyHeading: "Historia",
    historyEmpty: "Brak zdarzeń.",
    appointmentsHeading: "Terminy",
    appointmentsEmpty: "Brak zaplanowanych terminów.",
    allDayWord: "całodniowy",
    filesHeading: "Pliki",
    filesEmpty: "Obecnie nie są wymagane żadne pliki.",
    uploadedWord: "Przesłano",
    uploadedCountWord: "otrzymanych plików",
    uploadMoreHint: "Można dodać dodatkowe pliki.",
    uploadFileAriaPrefix: "Plik dla",
    uploadButton: "Prześlij",
    uploadOk: "Dziękujemy — plik został odebrany.",
    uploadInvalid: "Plik jest nieprawidłowy (PDF, JPG lub PNG, maks. 10 MB).",
    uploadConflict: "Na to żądanie już odpowiedziano.",
    uploadGone: "To żądanie nie jest już dostępne.",
    documentsHeading: "Dokumenty",
    documentsEmpty: "Brak opublikowanych dokumentów.",
    offerWord: "Oferta",
    downloadWord: "Pobierz",
    signButton: "Przyjmij ofertę",
    revokeButton: "Odwołaj",
    signOk: "Dziękujemy — oferta została przyjęta.",
    signKnown: "Ta oferta została już przyjęta.",
    signGone: "Ta oferta nie jest już dostępna.",
    revokeOk: "Umowa została odwołana.",
    revokeKnown: "Ta umowa została już odwołana.",
    revokeGone: "Ta umowa nie jest już dostępna.",
    invoicesHeading: "Faktury",
    invoicesEmpty: "Brak dostępnych faktur.",
    invoiceWord: "Faktura",
    creditNoteWord: "Nota kredytowa",
    invoicePaymentUnpaid: "Nieopłacona",
    invoicePaymentPartiallyPaid: "Częściowo opłacona",
    invoicePaymentPaid: "Opłacona",
    invoicePaymentOverdue: "Zaległa",
    invoicePaymentUncollectable: "Nieściągalna",
    invoicePaymentUnknown: "–",
    subsidyHeading: "Dotacja",
    gridHeading: "Przyłączenie do sieci",
    serviceHeading: "Serwis",
    acknowledgedSuffix: "· Przyjęto do wiadomości",
    acknowledgeButton: "Przyjmij do wiadomości",
    confirmOk: "Dziękujemy — ukończenie zostało odnotowane.",
    confirmKnown: "Ta czynność została już odnotowana.",
    confirmGone: "Ta czynność nie jest już dostępna.",
    invalidTitle: "Ten link jest nieprawidłowy.",
    invalidBody:
      "Link jest nieznany, wygasł lub został wycofany. Skontaktuj się ze " +
      "swoim opiekunem w celu uzyskania nowego dostępu. Nie załadowano treści.",
  },
  ro: {
    metaTitle: "Portalul clientului",
    brand: "Portalul clientului",
    navAria: "Secțiuni portal",
    navOverview: "Prezentare generală",
    navAppointments: "Programări",
    navInstallation: "Instalare",
    navFiles: "Fișiere",
    statusTerm: "Stare:",
    installationHeading: "Instalare",
    installationEmpty: "Nu există încă nicio instalare înregistrată.",
    faqHeading: "Bine de știut",
    chatHeading: "Mesaje de subvenție",
    chatEmpty: "Nu există încă mesaje.",
    chatSend: "Trimite",
    chatOk: "Mesaj trimis.",
    chatGone: "Mesajul nu a putut fi trimis.",
    chatSideInternal: "Consilier energetic",
    chatSideCustomer: "Dvs.",
    historyHeading: "Istoric",
    historyEmpty: "Nu există încă evenimente.",
    appointmentsHeading: "Programări",
    appointmentsEmpty: "Nu există programări planificate.",
    allDayWord: "toată ziua",
    filesHeading: "Fișiere",
    filesEmpty: "Nu sunt necesare fișiere momentan.",
    uploadedWord: "Încărcat",
    uploadedCountWord: "fișiere primite",
    uploadMoreHint: "Puteți adăuga fișiere suplimentare.",
    uploadFileAriaPrefix: "Fișier pentru",
    uploadButton: "Încarcă",
    uploadOk: "Mulțumim — fișierul a fost primit.",
    uploadInvalid: "Fișierul nu este valid (PDF, JPG sau PNG, max. 10 MB).",
    uploadConflict: "La această solicitare s-a răspuns deja.",
    uploadGone: "Această solicitare nu mai este disponibilă.",
    documentsHeading: "Documente",
    documentsEmpty: "Nu există documente publicate.",
    offerWord: "Ofertă",
    downloadWord: "Descarcă",
    signButton: "Acceptă oferta",
    revokeButton: "Revocă",
    signOk: "Mulțumim — oferta a fost acceptată.",
    signKnown: "Această ofertă a fost deja acceptată.",
    signGone: "Această ofertă nu mai este disponibilă.",
    revokeOk: "Contractul a fost revocat.",
    revokeKnown: "Acest contract a fost deja revocat.",
    revokeGone: "Acest contract nu mai este disponibil.",
    invoicesHeading: "Facturi",
    invoicesEmpty: "Nu există facturi disponibile.",
    invoiceWord: "Factură",
    creditNoteWord: "Notă de credit",
    invoicePaymentUnpaid: "Neachitată",
    invoicePaymentPartiallyPaid: "Achitată parțial",
    invoicePaymentPaid: "Achitată",
    invoicePaymentOverdue: "Restantă",
    invoicePaymentUncollectable: "Nerecuperabilă",
    invoicePaymentUnknown: "–",
    subsidyHeading: "Subvenție",
    gridHeading: "Racordare la rețea",
    serviceHeading: "Service",
    acknowledgedSuffix: "· Luat la cunoștință",
    acknowledgeButton: "Ia la cunoștință",
    confirmOk: "Mulțumim — finalizarea a fost înregistrată.",
    confirmKnown: "Această acțiune a fost deja înregistrată.",
    confirmGone: "Această acțiune nu mai este disponibilă.",
    invalidTitle: "Acest link nu este valid.",
    invalidBody:
      "Linkul este necunoscut, a expirat sau a fost retras. Contactați " +
      "reprezentantul dvs. pentru un nou acces. Nu a fost încărcat conținut.",
  },
};
