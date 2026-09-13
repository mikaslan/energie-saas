"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  EMAIL_TEMPLATE_BODY_MAX,
  EMAIL_TEMPLATE_SCHEMA_VERSION,
  EMAIL_TEMPLATE_SUBJECT_MAX,
  isEmailTemplateKey,
  type EmailTemplateKey,
} from "@/lib/email-template";
import {
  archiveEmailTemplate,
  EmailTemplateNotFoundError,
  EmailTemplateValidationError,
  restoreEmailTemplate,
  updateEmailTemplate,
} from "@/modules/messaging";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export type EmailTemplateActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseWorkspace(formData: FormData): string | null {
  const value = formData.get("workspaceId");
  if (typeof value !== "string") return null;
  const parsed = workspaceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseKey(formData: FormData): EmailTemplateKey | null {
  const value = formData.get("key");
  if (typeof value !== "string" || !isEmailTemplateKey(value)) return null;
  return value;
}

function parseText(value: FormDataEntryValue | null, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").trim();
  if (text.length < 1 || text.length > max || /[\p{Cc}\p{Cf}]/u.test(text)) return null;
  return text;
}

// Mehrzeilig wie cleanBody im Vertrag: \n und \t erlaubt, Browser-CRLF
// wird zu LF normalisiert.
function parseBody(value: FormDataEntryValue | null, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (text.length < 1 || text.length > max) return null;
  if (/[^\P{Cc}\n\t]/u.test(text) || /[\p{Cf}]/u.test(text)) return null;
  return text;
}

function mapError(error: unknown): EmailTemplateActionState {
  if (error instanceof EmailTemplateValidationError) return { status: "invalid" };
  if (error instanceof EmailTemplateNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

const SETTINGS_PATH = (workspace: string): string => `/w/${workspace}/einstellungen/e-mail-vorlagen`;

export async function updateEmailTemplateAction(
  _previous: EmailTemplateActionState,
  formData: FormData,
): Promise<EmailTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const key = parseKey(formData);
  const subject = parseText(formData.get("subject"), EMAIL_TEMPLATE_SUBJECT_MAX);
  const body = parseBody(formData.get("body"), EMAIL_TEMPLATE_BODY_MAX);
  if (!workspace || !key || subject === null || body === null) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "project.write", "email_template", (tx, ctx) =>
      updateEmailTemplate(tx, ctx, {
        schemaVersion: EMAIL_TEMPLATE_SCHEMA_VERSION,
        key,
        subject,
        body,
      }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "E-Mail-Vorlage gespeichert." };
  } catch (error) {
    return mapError(error);
  }
}

async function setActive(
  formData: FormData,
  active: boolean,
  message: string,
): Promise<EmailTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const key = parseKey(formData);
  if (!workspace || !key) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "project.write", "email_template", (tx, ctx) =>
      active
        ? restoreEmailTemplate(tx, ctx, {
          schemaVersion: EMAIL_TEMPLATE_SCHEMA_VERSION,
          key,
          active,
        })
        : archiveEmailTemplate(tx, ctx, {
          schemaVersion: EMAIL_TEMPLATE_SCHEMA_VERSION,
          key,
          active,
        }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message };
  } catch (error) {
    return mapError(error);
  }
}

export async function archiveEmailTemplateAction(
  _previous: EmailTemplateActionState,
  formData: FormData,
): Promise<EmailTemplateActionState> {
  return setActive(formData, false, "E-Mail-Vorlage archiviert.");
}

export async function restoreEmailTemplateAction(
  _previous: EmailTemplateActionState,
  formData: FormData,
): Promise<EmailTemplateActionState> {
  return setActive(formData, true, "E-Mail-Vorlage reaktiviert.");
}
