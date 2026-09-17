// F10-04 Datei-Anfragen: reiner Client-/Server-Vertrag (Statusworte,
// Labels, Folgezustände, DTO-Form — keine Imports, kein I/O).
// Muster lib/follow-up.ts: Sektion (Client) und Service (Server)
// teilen sich diese Datei, ohne die Modul-Barrel mit Server-Code
// ins Client-Bundle zu ziehen.
export const fileRequestStatuses = [
  "offen",
  "hochgeladen",
  "erledigt",
  "storniert",
] as const;
export type FileRequestStatus = (typeof fileRequestStatuses)[number];

export const FILE_REQUEST_STATUS_LABEL: Record<FileRequestStatus, string> = {
  offen: "Offen",
  hochgeladen: "Hochgeladen",
  erledigt: "Erledigt",
  storniert: "Storniert",
};

// F10-13 Dateityp je Anfrage (Katalog F10.2 „Dateityp"): geschlossener
// Wortschatz, Anlage-Attribut (immutable). pdf = nur application/pdf,
// image = JPEG/PNG, any = globaler Vorrat wie bisher. ESTIMATE.
export const fileRequestFileTypes = ["any", "pdf", "image"] as const;
export type FileRequestFileType = (typeof fileRequestFileTypes)[number];

export const FILE_REQUEST_FILE_TYPE_LABEL: Record<FileRequestFileType, string> = {
  any: "Alle Dateitypen",
  pdf: "Nur PDF",
  image: "Nur Bild (JPG/PNG)",
};

// Portal-Hinweis je Typ (sprachneutral aus dem Typ selbst — keine
// Woerterbuch-Eintraege in 11 Sprachen noetig).
export const FILE_REQUEST_FILE_TYPE_HINT: Record<FileRequestFileType, string> = {
  any: "PDF, JPG, PNG",
  pdf: "PDF",
  image: "JPG, PNG",
};

// Dynamisches accept-Attribut je Typ (Spiegel des Guards).
export const FILE_REQUEST_FILE_TYPE_ACCEPT: Record<FileRequestFileType, string> = {
  any: ".pdf,.jpg,.jpeg,.png",
  pdf: ".pdf",
  image: ".jpg,.jpeg,.png",
};

// Storno nur aus offen (receipt-CHECK: storniert trägt nie Belegdaten);
// erledigt nur aus hochgeladen. hochgeladen setzt ausschließlich der
// Token-DEFINER (mit Beleg), nie die interne Transition.
const allowedTransitions: Record<FileRequestStatus, FileRequestStatus[]> = {
  offen: ["storniert"],
  hochgeladen: ["erledigt"],
  erledigt: [],
  storniert: [],
};

export function nextFileRequestStatuses(from: FileRequestStatus): FileRequestStatus[] {
  return allowedTransitions[from];
}

export type FileRequestUploadDto = {
  id: string;
  requestId: string;
  contentType: string | null;
  byteSize: number | null;
  originalFilename: string | null;
  uploadedAt: string;
};

export type FileRequestDto = {
  id: string;
  projectId: string;
  // F13-07: optionale Akten-Verknüpfung (BnD-Beleg); null = allgemeine Anfrage.
  subsidyCaseId: string | null;
  title: string;
  description: string | null;
  // F10-13: Dateityp-Einschraenkung (immutable Anlage-Attribut).
  fileType: FileRequestFileType;
  // F10-10: Allow-many — mehrere Belege je Anfrage (Folge-Belege als
  // FileRequestUploadDto, Erst-Beleg weiter in den Spalten).
  allowMany: boolean;
  uploads: FileRequestUploadDto[];
  status: FileRequestStatus;
  storageKey: string | null;
  fileSha256: string | null;
  contentType: string | null;
  byteSize: number | null;
  originalFilename: string | null;
  uploadedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
};
