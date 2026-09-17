import { z } from "zod";

import { publicTokenCapsule } from "@/lib/action";
import {
  PROJECT_FILE_CONTENT_TYPES,
  PROJECT_FILE_NAME_MAX,
  ProjectFileIntegrityError,
  ProjectFileNotFoundError,
  ProjectFilePersistenceError,
  readPortalProjectFileByToken,
} from "@/modules/project-files";

export const dynamic = "force-dynamic";

// F10-17 Portal-Datei-Download (My-Files): anonymer GET auf eine
// freigeschaltete Projekt-Datei (F10-07-dokumente-Route exakt kopiert).
// Autorisierung ist allein das hoch-entropische Portal-Token
// (F10.1-Kapsel, kein Session-Kontext). Unbekannt/deformiert/entzogen/
// abgelaufen, fremde/unsichtbare Datei -> identischer 404-Endzustand
// (kein Orakel). Private Header + Attachment wie am internen Pfad;
// kein Caching sensibler Dateien.
const paramsSchema = z.strictObject({
  token: z.string().min(1),
  fileId: z.uuid().transform((value) => value.toLowerCase()),
});
// F10-17-Dateinamen-Guard (Review-Fund, SPEC-Abweichung dokumentiert):
// KEIN F10-07-ASCII-Pattern — der Upload prueft nur Laenge+Endung
// (case-insensitiv, service.ts), also sind "Rechnung März.PDF" oder
// "Foto vom Dach.JPG" DB-legal. ASCII-Strenge wuerde echte Dateien mit
// 503 verweigern (interner Download hat keinen Charset-Guard).
// Geprueft wird, was gefaehrlich ist: Laenge (DB-Spiegel 1..180,
// getrimmt wie der Upload), Allowlist-Endung (case-insensitiv wie die
// Upload-Toleranz), keine Steuerzeichen/Anfuehrungszeichen
// (Header-Sicherheit, Defense in Depth zur Disposition-Maske).
const PROJECT_FILE_EXTENSION_PATTERN = /\.(pdf|jpg|jpeg|png)$/iu;
const UNSAFE_FILENAME_CHARS_PATTERN = /[\u0000-\u001f\u007f"]/u;

export function isPortalProjectFilenameSafe(filename: string): boolean {
  if (filename.length < 1 || filename.length > PROJECT_FILE_NAME_MAX) return false;
  if (filename !== filename.trim()) return false;
  if (UNSAFE_FILENAME_CHARS_PATTERN.test(filename)) return false;
  return PROJECT_FILE_EXTENSION_PATTERN.test(filename);
}

// Disposition wie die interne Route (app/api/.../dateien): Fallback ohne
// Anfuehrungszeichen/Backslash/Steuerzeichen, UTF-8-Name RFC-5987-kodiert.
export function portalProjectFileDisposition(filename: string): string {
  const fallback = filename.replace(/["\\\r\n]/g, "_").slice(0, 100) || "datei";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "sandbox; default-src 'none'",
} as const;

function privateFailure(status: number): Response {
  return new Response(null, { status, headers: PRIVATE_HEADERS });
}

function magicBytesOk(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === "application/pdf") {
    return bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
      && /%%EOF[\t\r\n ]*$/u.test(
        bytes.subarray(Math.max(0, bytes.length - 1_024)).toString("latin1"),
      );
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  }
  return false;
}

export async function GET(
  _request: Request,
  context: {
    params: Promise<{ token: string; fileId: string }>;
  },
): Promise<Response> {
  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) return privateFailure(404);
  const { token, fileId } = parsed.data;

  try {
    const artifact = await publicTokenCapsule((pool) =>
      readPortalProjectFileByToken(pool, { token, fileId }),
    );
    // MIME aus der Allowlist (kein Echo ungepruefter DB-Werte).
    const mimeType: string = artifact.mimeType;
    if (
      !isPortalProjectFilenameSafe(artifact.filename)
      || !Object.prototype.hasOwnProperty.call(PROJECT_FILE_CONTENT_TYPES, mimeType)
      || !magicBytesOk(mimeType, artifact.bytes)
    ) return privateFailure(503);

    return new Response(new Uint8Array(artifact.bytes), {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": mimeType,
        "Content-Length": String(artifact.sizeBytes),
        "Content-Disposition": portalProjectFileDisposition(artifact.filename),
      },
    });
  } catch (error) {
    if (error instanceof ProjectFileNotFoundError) return privateFailure(404);
    if (
      error instanceof ProjectFileIntegrityError
      || error instanceof ProjectFilePersistenceError
    ) return privateFailure(503);
    throw error;
  }
}
