"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import {
  OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION,
  OFFER_RELEASE_PROFILE_REVISE_COMMAND_VERSION,
} from "@/lib/integrations/offers/release-contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  activateOfferReleaseProfile,
  OfferReleaseProfileConflictError,
  OfferReleaseProfileIntegrityError,
  OfferReleaseProfileNotFoundError,
  OfferReleaseProfilePersistenceError,
  OfferReleaseProfileValidationError,
  reviseOfferReleaseProfile,
} from "@/modules/offers";
import type { OfferReleaseProfileActionState } from "./action-state";

const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const WORKSPACE_ID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const CHECKED_SCHEMA = z.literal("true").transform(() => true as const);
const NULLABLE_TEXT = z.string().transform((value) => {
  const normalized = value.normalize("NFC").trim();
  return normalized === "" ? null : normalized;
});

const PROFILE_FIELDS = new Set([
  "schemaVersion",
  "workspaceId",
  "expectedCurrentRevision",
  "profileName",
  "legalName",
  "tradingName",
  "representedBy",
  "street",
  "houseNumber",
  "postalCode",
  "city",
  "country",
  "email",
  "phoneE164",
  "websiteHttpsUrl",
  "registerCourt",
  "registerNumber",
  "vatId",
  "termsTitle",
  "termsPlainText",
  "withdrawalInformationTitle",
  "withdrawalInformationPlainText",
  "privacyNoticeTitle",
  "privacyNoticePlainText",
]);

const ACTIVATION_FIELDS = new Set([
  "schemaVersion",
  "workspaceId",
  "profileId",
  "profileRevisionId",
  "expectedProfileRevision",
  "operatorReviewed",
]);

const profileFormSchema = z.strictObject({
  schemaVersion: z.literal(OFFER_RELEASE_PROFILE_REVISE_COMMAND_VERSION),
  workspaceId: WORKSPACE_ID_SCHEMA,
  expectedCurrentRevision: z.string().regex(INTEGER_PATTERN).transform(Number)
    .pipe(z.int().safe().min(0)),
  profileName: z.string(),
  legalName: z.string(),
  tradingName: NULLABLE_TEXT,
  representedBy: z.string(),
  street: z.string(),
  houseNumber: z.string(),
  postalCode: z.string(),
  city: z.string(),
  country: z.literal("DE"),
  email: z.string(),
  phoneE164: NULLABLE_TEXT,
  websiteHttpsUrl: NULLABLE_TEXT,
  registerCourt: NULLABLE_TEXT,
  registerNumber: NULLABLE_TEXT,
  vatId: NULLABLE_TEXT,
  termsTitle: z.string(),
  termsPlainText: z.string(),
  withdrawalInformationTitle: z.string(),
  withdrawalInformationPlainText: z.string(),
  privacyNoticeTitle: z.string(),
  privacyNoticePlainText: z.string(),
});

const activationFormSchema = z.strictObject({
  schemaVersion: z.literal(OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION),
  workspaceId: WORKSPACE_ID_SCHEMA,
  profileId: z.uuid().transform((value) => value.toLowerCase()),
  profileRevisionId: z.uuid().transform((value) => value.toLowerCase()),
  expectedProfileRevision: z.string().regex(/^[1-9]\d*$/u).transform(Number)
    .pipe(z.int().safe().min(1)),
  operatorReviewed: CHECKED_SCHEMA,
});

function workspaceForAdmission(formData: FormData): string | null {
  const values = formData.getAll("workspaceId");
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  const parsed = WORKSPACE_ID_SCHEMA.safeParse(values[0]);
  return parsed.success ? parsed.data : null;
}

function exactStringEntries(
  formData: FormData,
  allowedFields: ReadonlySet<string>,
): Record<string, string> | null {
  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return null;
    if (name.startsWith("$ACTION")) {
      if (!REACT_ACTION_FIELD_PATTERN.test(name)) return null;
      values.set(name, value);
      continue;
    }
    if (!allowedFields.has(name)) return null;
    values.set(name, value);
  }
  const domainEntries = [...values].filter(([name]) => !name.startsWith("$ACTION"));
  if (
    domainEntries.length !== allowedFields.size
    || ![...allowedFields].every((name) => values.has(name))
  ) return null;
  return Object.fromEntries(domainEntries);
}

function mapProfileError(error: unknown): OfferReleaseProfileActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof OfferReleaseProfileValidationError) {
    return error.paths.length === 0
      ? { status: "invalid" }
      : { status: "invalid", paths: error.paths };
  }
  if (error instanceof OfferReleaseProfileNotFoundError) return { status: "not_found" };
  if (error instanceof OfferReleaseProfileConflictError) {
    return error.currentRevision === undefined
      ? { status: "conflict" }
      : { status: "conflict", currentRevision: error.currentRevision };
  }
  if (
    error instanceof OfferReleaseProfileIntegrityError
    || error instanceof OfferReleaseProfilePersistenceError
  ) return { status: "unavailable" };
  return null;
}

export async function reviseOfferReleaseProfileAction(
  _previousState: OfferReleaseProfileActionState,
  formData: FormData,
): Promise<OfferReleaseProfileActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  const entries = exactStringEntries(formData, PROFILE_FIELDS);
  const parsed = entries === null ? null : profileFormSchema.safeParse(entries);
  if (!parsed || !parsed.success) return { status: "invalid" };

  try {
    const input = parsed.data;
    const result = await authorizedAction(
      workspaceId,
      "settings.manage",
      "offer_release_profile",
      (tx, ctx) => reviseOfferReleaseProfile(tx, ctx, {
        schemaVersion: input.schemaVersion,
        workspaceId: input.workspaceId,
        expectedCurrentRevision: input.expectedCurrentRevision,
        profileName: input.profileName,
        sender: {
          legalName: input.legalName,
          tradingName: input.tradingName,
          representedBy: input.representedBy,
          address: {
            street: input.street,
            houseNumber: input.houseNumber,
            postalCode: input.postalCode,
            city: input.city,
            country: input.country,
          },
          email: input.email,
          phoneE164: input.phoneE164,
          websiteHttpsUrl: input.websiteHttpsUrl,
          registerCourt: input.registerCourt,
          registerNumber: input.registerNumber,
          vatId: input.vatId,
        },
        legalDocuments: {
          terms: { title: input.termsTitle, plainText: input.termsPlainText },
          withdrawalInformation: {
            title: input.withdrawalInformationTitle,
            plainText: input.withdrawalInformationPlainText,
          },
          privacyNotice: {
            title: input.privacyNoticeTitle,
            plainText: input.privacyNoticePlainText,
          },
        },
      }),
    );
    revalidatePath(`/w/${workspaceId}/einstellungen/angebotsprofile`);
    return {
      status: "revised",
      profileId: result.profileId,
      profileRevisionId: result.profileRevisionId,
      revision: result.revision,
    };
  } catch (error) {
    const mapped = mapProfileError(error);
    if (mapped) return mapped;
    throw error;
  }
}

export async function activateOfferReleaseProfileAction(
  _previousState: OfferReleaseProfileActionState,
  formData: FormData,
): Promise<OfferReleaseProfileActionState> {
  const workspaceId = workspaceForAdmission(formData);
  if (!workspaceId) return { status: "invalid" };
  const entries = exactStringEntries(formData, ACTIVATION_FIELDS);
  const parsed = entries === null ? null : activationFormSchema.safeParse(entries);
  if (!parsed || !parsed.success) {
    const confirmations = formData.getAll("operatorReviewed");
    return confirmations.length === 1 && confirmations[0] === "true"
      ? { status: "invalid" }
      : { status: "invalid", paths: ["/operatorReviewed"] };
  }

  try {
    const result = await authorizedAction(
      workspaceId,
      "settings.manage",
      "offer_release_profile_activation",
      (tx, ctx) => activateOfferReleaseProfile(tx, ctx, {
        schemaVersion: parsed.data.schemaVersion,
        workspaceId: parsed.data.workspaceId,
        profileId: parsed.data.profileId,
        profileRevisionId: parsed.data.profileRevisionId,
        expectedProfileRevision: parsed.data.expectedProfileRevision,
      }),
    );
    revalidatePath(`/w/${workspaceId}/einstellungen/angebotsprofile`);
    return {
      status: "activated",
      profileId: result.profileId,
      profileRevisionId: result.profileRevisionId,
      revision: result.profileRevision,
    };
  } catch (error) {
    const mapped = mapProfileError(error);
    if (mapped) return mapped;
    throw error;
  }
}
