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

// F13-00 §3 Maschinen-Norm: jede Maschine exportiert next*-Folgezustände
// UND isAllowed*-Guard. Interne Transitions-Norm (hochgeladen setzt
// ausschließlich der Token-DEFINER, nie die interne Transition — der
// Guard spiegelt exakt die interne Kantentabelle oben).
export function isAllowedFileRequestTransition(
  from: FileRequestStatus,
  to: FileRequestStatus,
): boolean {
  return allowedTransitions[from].includes(to);
}

// F13-00 §4 Typisierte Datei-Slots: Slot-Typ-Enum pro Capability
// (ESTIMATE, Katalog F13.2-Rest). Pilot: Förderakte (bza_angebot,
// bza_vollmacht, bnd_rechnung, typenschild_foto). Strukturiertes Feld
// an file_request; F13-07-Titel-Konvention bleibt Portal-Darstellung.
export const fileRequestSlotTypes = [
  "bza_angebot",
  "bza_vollmacht",
  "bnd_rechnung",
  "typenschild_foto",
] as const;
export type FileRequestSlotType = (typeof fileRequestSlotTypes)[number];

export const FILE_REQUEST_SLOT_LABEL: Record<FileRequestSlotType, string> = {
  bza_angebot: "BzA-Angebot",
  bza_vollmacht: "BzA-Vollmacht",
  bnd_rechnung: "BnD-Rechnung",
  typenschild_foto: "Typenschild-Foto",
};

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
  // F13-00 §4: strukturierter Slot-Typ; null = Anfrage ohne Slot.
  slotType: FileRequestSlotType | null;
  title: string;
  description: string | null;
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
