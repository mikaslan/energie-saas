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

export type FileRequestDto = {
  id: string;
  projectId: string;
  // F13-07: optionale Akten-Verknüpfung (BnD-Beleg); null = allgemeine Anfrage.
  subsidyCaseId: string | null;
  title: string;
  description: string | null;
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
