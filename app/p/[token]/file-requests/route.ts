import { redirect } from "next/navigation";
import { z } from "zod";
import { publicTokenCapsule } from "@/lib/action";
import {
  FileRequestConflictError,
  FileRequestNotFoundError,
  FileRequestValidationError,
  fulfillFileRequestByToken,
} from "@/modules/file-requests";
import { PortalNotFoundError } from "@/modules/portal";

// F10-04 Datei-Upload (erster anonymer Schreibpfad des Portals):
// Route statt Server-Action, weil Uploads bis 10 MiB gehen und das
// globale 1-MB-Action-Limit unangetastet bleibt. Autorisierung ist
// allein das hoch-entropische Portal-Token (F10.1-Kapsel, kein
// Session-Kontext). Ergebnis per ?upload= (beobachtbar ohne JS).
const uuidSchema = z.uuid();

async function uploadOutcome(
  token: string,
  form: FormData | null,
): Promise<"erfolg" | "ungueltig" | "konflikt" | "fehler"> {
  if (!form) return "ungueltig";
  const requestId = form.get("requestId");
  const file = form.get("datei");
  if (typeof requestId !== "string" || !uuidSchema.safeParse(requestId).success) {
    return "ungueltig";
  }
  if (!(file instanceof File) || file.size === 0) return "ungueltig";
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return "ungueltig";
  }
  try {
    await publicTokenCapsule((pool) =>
      fulfillFileRequestByToken(pool, {
        token,
        requestId,
        filename: file.name,
        contentType: file.type,
        bytes,
      }),
    );
    return "erfolg";
  } catch (error) {
    if (error instanceof FileRequestValidationError) return "ungueltig";
    if (error instanceof FileRequestConflictError) return "konflikt";
    if (error instanceof FileRequestNotFoundError) return "fehler";
    if (error instanceof PortalNotFoundError) return "fehler";
    throw error;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<never> {
  const { token } = await params;
  const form = await request.formData().catch(() => null);
  const outcome = await uploadOutcome(token, form);
  redirect(`/p/${token}?tab=dateien&upload=${outcome}`);
}
