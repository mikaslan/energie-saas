import { z } from "zod";

import { publicTokenCapsule } from "@/lib/action";
import {
  PROJECT_FILE_CONTENT_TYPES,
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
// F10-07-Strenge (ASCII-Start, 1..200, Allowlist-Endung), erweitert auf
// die Ablage-Typen pdf/jpg/jpeg/png (DB-CHECK-Spiegel: 1..180).
const SAFE_PROJECT_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(pdf|jpg|jpeg|png)$/u;
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
      !SAFE_PROJECT_FILE_PATTERN.test(artifact.filename)
      || !Object.prototype.hasOwnProperty.call(PROJECT_FILE_CONTENT_TYPES, mimeType)
      || !magicBytesOk(mimeType, artifact.bytes)
    ) return privateFailure(503);

    const disposition = `attachment; filename="${artifact.filename}"; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`;
    return new Response(new Uint8Array(artifact.bytes), {
      status: 200,
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": mimeType,
        "Content-Length": String(artifact.sizeBytes),
        "Content-Disposition": disposition,
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
