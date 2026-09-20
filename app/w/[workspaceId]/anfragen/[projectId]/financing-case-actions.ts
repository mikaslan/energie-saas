"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError, publicTokenCapsule } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  createFinancingCase,
  FinancingCaseNotFoundError,
  FinancingCaseValidationError,
  postFinancingRequestByToken,
  setFinancingCaseStatus,
  type FinancingCaseStatus,
  type FinancingProdukttyp,
  type FinancingProvider,
} from "@/modules/financing-cases";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

// F13-15 §1/§2: Katalog-Vokabular, lokal gespiegelt bis lib/financing-case landet.
const produkttypen = ["ratenkauf", "kredit"] as const;
const providers = ["bees_bears", "psd_bank"] as const;
const statuses = [
  "beantragt",
  "bonitaet",
  "entschieden",
  "ausgezahlt",
  "abgeschlossen",
  "abgelehnt",
  "storniert",
] as const;

const RATENKAUF_LAUFZEIT_MIN = 1;
const RATENKAUF_LAUFZEIT_MAX = 25;
const RATENKAUF_VOLUMEN_MAX_EUR = 70_000;
const PROVIDER_REFERENZ_MAX = 200;

export type FinancingCaseActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseIds(formData: FormData): { workspaceId: string; projectId: string } | null {
  const workspaceId = workspaceIdSchema.safeParse(formData.get("workspaceId"));
  const projectId = uuidSchema.safeParse(formData.get("projectId"));
  if (!workspaceId.success || !projectId.success) return null;
  return { workspaceId: workspaceId.data, projectId: projectId.data };
}

function mapError(error: unknown): FinancingCaseActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof FinancingCaseNotFoundError) return { status: "not_found" };
  if (error instanceof FinancingCaseValidationError) return { status: "invalid" };
  throw error;
}

function detailPath(workspaceId: string, projectId: string): string {
  return `/w/${workspaceId}/anfragen/${projectId}`;
}

function parseIntField(value: FormDataEntryValue | null, maxDigits: number): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (!new RegExp(`^\\d{1,${maxDigits}}$`, "u").test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function optionalReferenz(value: FormDataEntryValue | null): string | null | "invalid" {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (value.trim().length > PROVIDER_REFERENZ_MAX) return "invalid";
  return value.trim();
}

// F13-15 §1: Katalogschranken serverseitig gespiegelt (fail-closed, Spiegel
// von validateFinancingTerms — Service-Guard bleibt Quelle der Wahrheit).
function guardsOk(
  produkttyp: string,
  laufzeitJahre: number,
  volumenEur: number,
  provider: string,
): boolean {
  if (produkttyp === "ratenkauf") {
    return (
      provider === "bees_bears"
      && laufzeitJahre >= RATENKAUF_LAUFZEIT_MIN
      && laufzeitJahre <= RATENKAUF_LAUFZEIT_MAX
      && volumenEur >= 1
      && volumenEur <= RATENKAUF_VOLUMEN_MAX_EUR
    );
  }
  return provider === "psd_bank" && laufzeitJahre >= 1 && volumenEur >= 1;
}

// F13-15 §1: Anlage (genau ein aktiver Vorgang je Projekt; Reopen nur via
// neuen Vorgang nach Terminal — Historie bleibt ehrlich, F13-01-Muster).
export async function createFinancingCaseAction(
  _previous: FinancingCaseActionState,
  formData: FormData,
): Promise<FinancingCaseActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const produkttypValue = formData.get("produkttyp");
  const providerValue = formData.get("provider");
  const produkttyp = typeof produkttypValue === "string" ? produkttypValue : "";
  const provider = typeof providerValue === "string" ? providerValue : "";
  if (!(produkttypen as readonly string[]).includes(produkttyp)) return { status: "invalid" };
  if (!(providers as readonly string[]).includes(provider)) return { status: "invalid" };
  const laufzeitJahre = parseIntField(formData.get("laufzeitJahre"), 3);
  const volumenEur = parseIntField(formData.get("volumenEur"), 9);
  if (laufzeitJahre === null || volumenEur === null) return { status: "invalid" };
  const providerReferenz = optionalReferenz(formData.get("providerReferenz"));
  if (providerReferenz === "invalid") return { status: "invalid" };
  if (!guardsOk(produkttyp, laufzeitJahre, volumenEur, provider)) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "financing_case", (tx, ctx) =>
      createFinancingCase(tx, ctx, {
        projectId: ids.projectId,
        produkttyp: produkttyp as FinancingProdukttyp,
        laufzeitJahre,
        volumenEurCents: volumenEur * 100,
        provider: provider as FinancingProvider,
        providerReferenz,
      }),
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: "Finanzierungsvorgang angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

// F13-15 §2/§3: Statuskette per Folge-Buttons; Referenz wird gemeinsam mit dem
// Statuswechsel hinterlegt (manueller Editor-Pfad nach Provider-Rückmeldung).
export async function setFinancingCaseStatusAction(
  _previous: FinancingCaseActionState,
  formData: FormData,
): Promise<FinancingCaseActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const idValue = formData.get("id");
  const statusValue = formData.get("status");
  const id = typeof idValue === "string" ? idValue : "";
  const status = typeof statusValue === "string" ? statusValue : "";
  if (!uuidSchema.safeParse(id).success) return { status: "invalid" };
  if (!(statuses as readonly string[]).includes(status)) return { status: "invalid" };
  const providerReferenz = optionalReferenz(formData.get("providerReferenz"));
  if (providerReferenz === "invalid") return { status: "invalid" };
  try {
    // Service schreibt die Referenz nur bei Übergabe (null = behalten).
    await authorizedAction(ids.workspaceId, "installation.write", "financing_case", (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, {
        id,
        status: status as FinancingCaseStatus,
        providerReferenz,
      }),
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: "Status geändert." };
  } catch (error) {
    if (error instanceof FinancingCaseValidationError) return { status: "conflict" };
    return mapError(error);
  }
}

// F13-15 §4: Portal-Antrag (Produkttyp + Wunschlaufzeit + Wunschvolumen, ohne
// Provider-Wahl, ohne Signaturbindung). Das Formular in
// app/p/[token]/financing-section.tsx postet hierher.
// F13-15 Portal-Antrag (Owner-verdrahtet, Muster confirmServiceCaseByToken,
// F13-06): Provider aus Produkttyp (geschlossene Paarung §1), Volumen
// EUR→Cent. Kapsel-NULL (toter Link, Guard-Verletzung, bereits aktiver
// Vorgang) fällt uniform auf not_found — kein Orakel.
export async function requestPortalFinancingAction(
  _previous: FinancingCaseActionState,
  formData: FormData,
): Promise<FinancingCaseActionState> {
  const tokenValue = formData.get("token");
  const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
  if (token === "") return { status: "invalid" };
  const produkttypValue = formData.get("produkttyp");
  const produkttyp = typeof produkttypValue === "string" ? produkttypValue : "";
  if (!(produkttypen as readonly string[]).includes(produkttyp)) return { status: "invalid" };
  const laufzeitJahre = parseIntField(formData.get("laufzeitJahre"), 3);
  const volumenEur = parseIntField(formData.get("volumenEur"), 9);
  if (laufzeitJahre === null || volumenEur === null) return { status: "invalid" };
  const boundsOk = produkttyp === "ratenkauf"
    ? laufzeitJahre >= RATENKAUF_LAUFZEIT_MIN
      && laufzeitJahre <= RATENKAUF_LAUFZEIT_MAX
      && volumenEur >= 1
      && volumenEur <= RATENKAUF_VOLUMEN_MAX_EUR
    : laufzeitJahre >= 1 && volumenEur >= 1;
  if (!boundsOk) return { status: "invalid" };
  const typedProdukttyp = produkttyp === "kredit" ? "kredit" : "ratenkauf";
  const provider = typedProdukttyp === "ratenkauf" ? "bees_bears" : "psd_bank";
  try {
    await publicTokenCapsule((pool) =>
      postFinancingRequestByToken(pool, {
        token,
        produkttyp: typedProdukttyp,
        laufzeitJahre,
        volumenCents: volumenEur * 100,
        provider,
      }),
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath(`/p/${token}`);
  return {
    status: "success",
    message: "Antrag eingegangen. Wir leiten Ihre Anfrage an den Partner weiter.",
  };
}
