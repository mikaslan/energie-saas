import "server-only";

import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  contactDatasetV1Schema,
  contactUpdateCommandV1Schema,
  CONTACT_DATASET_VERSION,
  type ContactDatasetV1,
  type ContactUpdateCommandV1,
  type ContactUpdateResult,
} from "./contract";
import {
  ContactConflictError,
  ContactDeletedError,
  ContactNotFoundError,
  ContactValidationError,
} from "./errors";

const ERASURE_ADVISORY_LOCK_KEY = 1701734770;

type ContactRow = {
  id: string;
  revision: number;
  display_name: string;
  first_name: string;
  last_name: string;
  salutation: string | null;
  is_business: boolean;
  email_primary: string | null;
  email_secondary: string | null;
  phone_e164: string | null;
  phone_mobile: string | null;
  phone_reachability: string | null;
  address_street: string | null;
  address_house_number: string | null;
  address_postal_code: string | null;
  address_city: string | null;
  address_country: string | null;
  marketing_consent: boolean;
  marketing_consent_at: Date | string | null;
  marketing_consent_source: string | null;
  marketing_consent_policy_version: string | null;
  marketing_consent_text: string | null;
  marketing_consent_data_protection_link: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  deleted_at: Date | string | null;
  [key: string]: unknown;
};

function requireContactRead(ctx: ServiceCtx): void {
  if (!can(ctx, "contact.read")) {
    throw new PermissionDeniedError("contact.read", "contact", undefined, ctx.actor);
  }
}

function requireContactWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "contact.write")) {
    throw new PermissionDeniedError("contact.write", "contact", undefined, ctx.actor);
  }
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function trimOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeEmailSecondary(value: string | null | undefined): string | null {
  return trimOrNull(value)?.toLowerCase() ?? null;
}

const READ_COLUMNS = sql`
  contact_record.id,
  contact_record.revision,
  contact_record.display_name,
  contact_record.first_name,
  contact_record.last_name,
  contact_record.salutation,
  contact_record.is_business,
  contact_record.email_primary,
  contact_record.email_secondary,
  contact_record.phone_e164,
  contact_record.phone_mobile,
  contact_record.phone_reachability,
  contact_record.address_street,
  contact_record.address_house_number,
  contact_record.address_postal_code,
  contact_record.address_city,
  contact_record.address_country,
  contact_record.marketing_consent,
  contact_record.marketing_consent_at,
  contact_record.marketing_consent_source,
  contact_record.marketing_consent_policy_version,
  contact_record.marketing_consent_text,
  contact_record.marketing_consent_data_protection_link,
  contact_record.utm_source,
  contact_record.utm_medium,
  contact_record.utm_campaign,
  contact_record.utm_term,
  contact_record.utm_content,
  contact_record.deleted_at
`;

async function readContactIdForProject(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<string> {
  // R1-01/P1-1: reiner Vorab-Lese ohne Zeilensperre. Der Advisory-Lock muss
  // der ERSTE Synchronisationspunkt sein (Spec §8/DEC-M114-10). Ein FOR SHARE
  // hier würde SHARE(project)+Advisory gegen FOR UPDATE(project) kreuzen und
  // bei zwei parallelen Edits denselben Kontakts deadlocken. Die Bindung wird
  // nach dem Advisory-Lock in lockBoundProject FOR UPDATE re-verifiziert.
  const projectRow = await tx.execute<{ contact_id: string; [key: string]: unknown }>(sql`
    select project_record.contact_id
      from project project_record
     where project_record.workspace_id = ${ctx.workspaceId}::uuid
       and project_record.id = ${projectId}::uuid
     limit 1
  `);
  const contactId = projectRow.rows[0]?.contact_id;
  if (!contactId) throw new ContactNotFoundError();
  return contactId;
}

async function acquireContactAdvisoryLock(
  tx: TenantTx,
  workspaceId: string,
  contactId: string,
): Promise<void> {
  await tx.execute(sql`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        ${workspaceId}::text || ':' || ${contactId}::text,
        ${ERASURE_ADVISORY_LOCK_KEY}
      )
    )
  `);
}

async function lockContact(
  tx: TenantTx,
  ctx: ServiceCtx,
  contactId: string,
): Promise<ContactRow> {
  const result = await tx.execute<ContactRow>(sql`
    select ${READ_COLUMNS}
      from contact contact_record
     where contact_record.workspace_id = ${ctx.workspaceId}::uuid
       and contact_record.id = ${contactId}::uuid
     for update
  `);
  const row = result.rows[0];
  if (!row) throw new ContactNotFoundError();
  return row;
}

async function lockBoundProject(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  contactId: string,
): Promise<void> {
  const result = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select project_record.id
      from project project_record
     where project_record.workspace_id = ${ctx.workspaceId}::uuid
       and project_record.id = ${projectId}::uuid
       and project_record.contact_id = ${contactId}::uuid
     for update
  `);
  if (!result.rows[0]) throw new ContactNotFoundError();
}

type ColumnAssignment = Partial<Record<keyof ContactRow, string | boolean | null>>;

const PATCH_COLUMN_MAP: Record<string, keyof ContactRow> = {
  firstName: "first_name",
  lastName: "last_name",
  salutation: "salutation",
  isBusiness: "is_business",
  emailSecondary: "email_secondary",
  phoneMobile: "phone_mobile",
  phoneReachability: "phone_reachability",
  addressStreet: "address_street",
  addressHouseNumber: "address_house_number",
  addressPostalCode: "address_postal_code",
  addressCity: "address_city",
  addressCountry: "address_country",
  marketingConsentPolicyVersion: "marketing_consent_policy_version",
  marketingConsentText: "marketing_consent_text",
  marketingConsentDataProtectionLink: "marketing_consent_data_protection_link",
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  utmTerm: "utm_term",
  utmContent: "utm_content",
};

function deriveDisplayName(
  firstName: string,
  lastName: string,
): string {
  return `${firstName} ${lastName}`.trim();
}

// P2-1: Die DB-CHECKs sind die letzte Verteidigungslinie, aber ein 23514 wäre
// für den Aufrufer ein unklassifizierter Fehler. Die cross-field-Invarianten
// werden deshalb gegen die EFFEKTIVEN Werte (aktueller Zustand + Patch)
// vorgeprüft und als ContactValidationError (invalid) gemeldet.
function validateEffectiveInvariants(
  current: ContactRow,
  assignments: ColumnAssignment,
): void {
  const effectiveSalutation = assignments.salutation === undefined
    ? current.salutation
    : (assignments.salutation as string | null);
  const effectiveIsBusiness = assignments.is_business === undefined
    ? current.is_business
    : (assignments.is_business as boolean);
  const effectiveCountry = assignments.address_country === undefined
    ? current.address_country
    : (assignments.address_country as string | null);
  const effectivePostalCode = assignments.address_postal_code === undefined
    ? current.address_postal_code
    : (assignments.address_postal_code as string | null);

  if (effectiveSalutation === "business" && effectiveIsBusiness !== true) {
    throw new ContactValidationError();
  }
  if (effectivePostalCode !== null) {
    const isDe = effectiveCountry === null || effectiveCountry === "DE";
    if (isDe) {
      if (!/^[0-9]{5}$/.test(effectivePostalCode)) throw new ContactValidationError();
    } else {
      const trimmed = effectivePostalCode.trim();
      if (trimmed.length < 1 || trimmed.length > 20) throw new ContactValidationError();
    }
  }
}

export async function getContactDataset(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ContactDatasetV1 | null> {
  requireContactRead(ctx);
  const result = await tx.execute<ContactRow>(sql`
    select ${READ_COLUMNS}
      from project project_record
      join contact contact_record
        on contact_record.workspace_id = project_record.workspace_id
       and contact_record.id = project_record.contact_id
     where project_record.workspace_id = ${ctx.workspaceId}::uuid
       and project_record.id = ${projectId}::uuid
     limit 1
  `);
  const row = result.rows[0];
  if (!row) return null;

  return contactDatasetV1Schema.parse({
    schemaVersion: CONTACT_DATASET_VERSION,
    contactId: row.id,
    revision: row.revision,
    deletedAt: iso(row.deleted_at),
    name: {
      displayName: row.display_name,
      firstName: row.first_name,
      lastName: row.last_name,
      salutation: row.salutation,
      isBusiness: row.is_business,
    },
    contactWays: {
      primaryEmail: row.email_primary,
      secondaryEmail: row.email_secondary,
      phone: row.phone_e164,
      phoneMobile: row.phone_mobile,
      phoneReachability: row.phone_reachability,
    },
    address: {
      street: row.address_street,
      houseNumber: row.address_house_number,
      postalCode: row.address_postal_code,
      city: row.address_city,
      country: row.address_country,
    },
    marketingConsent: {
      granted: row.marketing_consent,
      grantedAt: iso(row.marketing_consent_at),
      source: row.marketing_consent_source,
      policyVersion: row.marketing_consent_policy_version,
      text: row.marketing_consent_text,
      dataProtectionLink: row.marketing_consent_data_protection_link,
    },
    utm: {
      source: row.utm_source,
      medium: row.utm_medium,
      campaign: row.utm_campaign,
      term: row.utm_term,
      content: row.utm_content,
    },
    permissions: { canWrite: can(ctx, "contact.write") },
  });
}

export async function updateContact(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ContactUpdateCommandV1,
): Promise<ContactUpdateResult> {
  requireContactWrite(ctx);
  const parsed = contactUpdateCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new ContactValidationError();
  const command = parsed.data;

  const contactId = await readContactIdForProject(tx, ctx, command.projectId);
  await acquireContactAdvisoryLock(tx, ctx.workspaceId, contactId);

  const current = await lockContact(tx, ctx, contactId);
  if (current.deleted_at !== null) throw new ContactDeletedError();
  if (current.revision !== command.expectedRevision) {
    throw new ContactConflictError(current.revision);
  }
  await lockBoundProject(tx, ctx, command.projectId, contactId);

  const assignments: ColumnAssignment = {};
  const changedFields: string[] = [];
  for (const [patchKey, columnName] of Object.entries(PATCH_COLUMN_MAP)) {
    const value = (command.patch as Record<string, unknown>)[patchKey];
    if (value === undefined) continue;
    let normalized: string | boolean | null;
    if (columnName === "email_secondary") {
      normalized = normalizeEmailSecondary(value as string | null);
    } else if (typeof value === "string") {
      normalized = trimOrNull(value as string);
    } else {
      normalized = value as boolean | null;
    }
    if (normalized === (current[columnName] as string | boolean | null)) continue;
    assignments[columnName] = normalized;
    changedFields.push(patchKey);
  }

  const firstName = assignments.first_name as string | undefined;
  const lastName = assignments.last_name as string | undefined;
  const nameChanged = firstName !== undefined || lastName !== undefined;
  if (nameChanged) {
    const nextFirstName = firstName ?? current.first_name;
    const nextLastName = lastName ?? current.last_name;
    assignments.first_name = nextFirstName;
    assignments.last_name = nextLastName;
    assignments.display_name = deriveDisplayName(nextFirstName, nextLastName);
    if (!changedFields.includes("firstName")) changedFields.push("firstName");
    if (!changedFields.includes("lastName")) changedFields.push("lastName");
  }

  // Kein echter Feldwechsel: kein Revisions-Bump, kein Event/Audit.
  if (changedFields.length === 0) {
    return { contactId, revision: current.revision, changedFields: [] };
  }

  validateEffectiveInvariants(current, assignments);

  const updateColumns = Object.keys(assignments);
  const setChunk = sql.join(
    updateColumns.map((columnName) =>
      sql`${sql.identifier(columnName)} = ${assignments[columnName as keyof ColumnAssignment]}`,
    ),
    sql`, `,
  );
  const updated = await tx.execute<{ revision: number; [key: string]: unknown }>(sql`
    update contact
       set ${setChunk},
           revision = revision + 1,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${contactId}::uuid
       and revision = ${command.expectedRevision}
       and deleted_at is null
     returning revision
  `);
  const nextRevision = updated.rows[0]?.revision;
  if (!nextRevision) throw new ContactConflictError(current.revision);

  const evidence = { contactId, revision: nextRevision, changedFields };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "contact",
    aggregateId: contactId,
    eventType: "contact.updated",
    actor: ctx.actor,
    payload: evidence,
  });

  const consentChanged = changedFields.some((field) =>
    field === "marketingConsentPolicyVersion"
    || field === "marketingConsentText"
    || field === "marketingConsentDataProtectionLink",
  );
  if (consentChanged) {
    const nextPolicyVersion = assignments.marketing_consent_policy_version
      ?? current.marketing_consent_policy_version
      ?? null;
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "contact",
      aggregateId: contactId,
      eventType: "contact.marketing_consent_changed",
      actor: ctx.actor,
      payload: {
        contactId,
        policyVersion: nextPolicyVersion,
      },
    });
  }

  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "contact.update",
    resource: `contact:${contactId}`,
    allowed: true,
    details: evidence,
  });

  return { contactId, revision: nextRevision, changedFields };
}
