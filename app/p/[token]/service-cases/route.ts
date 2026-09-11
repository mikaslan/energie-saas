import { redirect } from "next/navigation";
import { z } from "zod";
import { publicTokenCapsule } from "@/lib/action";
import {
  confirmServiceCaseByToken,
  ServiceCaseNotFoundError,
  ServiceCaseValidationError,
} from "@/modules/service-cases";
import { PortalNotFoundError } from "@/modules/portal";

// F13-06 Kundenbestätigung (zweiter anonymer Schreibpfad des Portals):
// Route statt Server-Action (Muster F10-04-Upload, ohne-JS-fähig).
// Autorisierung ist allein das hoch-entropische Portal-Token
// (F10.1-Kapsel, kein Session-Kontext). Ergebnis per ?confirm=
// (beobachtbar ohne JS). Fremd/nicht-erledigt fällt uniform auf
// „fehler" (kein Orakel über Existenz oder Stand).
const uuidSchema = z.uuid();

async function confirmOutcome(
  token: string,
  form: FormData | null,
): Promise<"ok" | "bereits" | "fehler"> {
  if (!form) return "fehler";
  const caseId = form.get("caseId");
  if (typeof caseId !== "string" || !uuidSchema.safeParse(caseId).success) {
    return "fehler";
  }
  try {
    const confirmed = await publicTokenCapsule((pool) =>
      confirmServiceCaseByToken(pool, { token, caseId }),
    );
    return confirmed.outcome === "ok" ? "ok" : "bereits";
  } catch (error) {
    if (error instanceof ServiceCaseValidationError) return "fehler";
    if (error instanceof ServiceCaseNotFoundError) return "fehler";
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
  const outcome = await confirmOutcome(token, form);
  redirect(`/p/${token}?confirm=${outcome}`);
}
