import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  CONTACT_UPDATE_COMMAND_VERSION,
  getContactDataset,
  updateContact,
  ContactConflictError,
  ContactDeletedError,
  ContactValidationError,
  type ContactUpdateCommandV1,
} from "@/modules/contacts";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  projectId: string;
  contactId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
};

function monthsAgo(months: number): Date {
  const value = new Date();
  value.setUTCMonth(value.getUTCMonth() - months);
  return value;
}

async function seedFixture(options: { deleted?: boolean } = {}): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'M1-14 Contacts')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@m114.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@m114.test`}),
        (${externalId}::uuid, ${`external-${externalId}@m114.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid, 'admin', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, salutation,
        is_business, email_primary, email_normalized, email_secondary,
        phone_raw, phone_e164, phone_mobile, phone_reachability,
        marketing_consent, marketing_consent_policy_version, revision,
        deleted_at
      ) values (
        ${contactId}::uuid, ${workspaceId}::uuid, 'Erika Mustermann',
        'Erika', 'Mustermann', 'female', false,
        'erika@example.test', 'erika@example.test', null,
        '+49 30 123456', '+4930123456', null, 'afternoon',
        false, null, 1, ${options.deleted ? sql`now()` : sql`null`}
      )
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'M1-14 Site')
    `);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'M1-14 Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return { workspaceId, projectId, contactId, editorId, viewerId, externalId };
}

function command(fixture: Fixture, patch: Record<string, unknown>, expectedRevision = 1): ContactUpdateCommandV1 {
  return {
    schemaVersion: CONTACT_UPDATE_COMMAND_VERSION,
    projectId: fixture.projectId,
    expectedRevision,
    patch,
  };
}

async function runUpdate(actorId: string, fixture: Fixture, cmd: ContactUpdateCommandV1) {
  return withAuthorizedTenantOn(
    testPool,
    actorId,
    fixture.workspaceId,
    (tx, ctx) => updateContact(tx, ctx, cmd),
  );
}

describe("M1-14 Kontakt-Datensatz-Service (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("liest den vollständigen Kontakt-Datensatz als minimiertes DTO", async () => {
    const dataset = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getContactDataset(tx, ctx, fixture.projectId),
    );
    expect(dataset).not.toBeNull();
    expect(dataset!.name).toMatchObject({
      displayName: "Erika Mustermann",
      firstName: "Erika",
      lastName: "Mustermann",
      salutation: "female",
      isBusiness: false,
    });
    expect(dataset!.contactWays.primaryEmail).toBe("erika@example.test");
    expect(dataset!.contactWays.phone).toBe("+4930123456");
    expect(dataset!.revision).toBe(1);
    expect(dataset!.permissions.canWrite).toBe(true);
  });

  it("editiert Stammdaten revisionsgebunden mit Event + Audit (1-Tx)", async () => {
    const result = await runUpdate(fixture.editorId, fixture, command(fixture, {
      firstName: "Erika",
      lastName: "Musterfrau",
      salutation: "business",
      isBusiness: true,
      emailSecondary: "Sekundaer@Example.com",
      phoneMobile: "+491701234567",
      phoneReachability: "morning",
      addressStreet: "Testweg",
      addressHouseNumber: "7",
      addressPostalCode: "10115",
      addressCity: "Berlin",
      addressCountry: "DE",
      marketingConsentPolicyVersion: "v1",
      marketingConsentText: "Einwilligungstext",
      marketingConsentDataProtectionLink: "https://example.test/datenschutz",
      utmSource: "newsletter",
      utmMedium: "email",
      utmCampaign: "q1-2026",
      utmTerm: "solar",
      utmContent: "banner",
    }));

    expect(result.revision).toBe(2);
    expect(result.changedFields).toContain("lastName");
    expect(result.changedFields).toContain("emailSecondary");

    const dataset = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getContactDataset(tx, ctx, fixture.projectId),
    );
    expect(dataset!.name.displayName).toBe("Erika Musterfrau");
    expect(dataset!.name.isBusiness).toBe(true);
    expect(dataset!.contactWays.secondaryEmail).toBe("sekundaer@example.com");
    expect(dataset!.contactWays.phoneMobile).toBe("+491701234567");
    expect(dataset!.address.city).toBe("Berlin");
    expect(dataset!.marketingConsent.policyVersion).toBe("v1");
    expect(dataset!.utm.source).toBe("newsletter");
    expect(dataset!.revision).toBe(2);

    const counts = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const events = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid and event_type = 'contact.updated'
      `);
      const audits = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid and action = 'contact.update'
      `);
      const consent = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid
           and event_type = 'contact.marketing_consent_changed'
      `);
      return { events: events.rows[0]!.count, audits: audits.rows[0]!.count, consent: consent.rows[0]!.count };
    });
    expect(counts.events).toBe(1);
    expect(counts.audits).toBe(1);
    expect(counts.consent).toBe(1);
  });

  it("meldet Revisionskonflikte (CAS) und liefert die aktuelle Revision", async () => {
    await runUpdate(fixture.editorId, fixture, command(fixture, { lastName: "Musterfrau" }));
    await expect(
      runUpdate(fixture.editorId, fixture, command(fixture, { lastName: "Anders" }, 1)),
    ).rejects.toBeInstanceOf(ContactConflictError);
  });

  it("weist gelöschte Kontakte als deleted_contact ab", async () => {
    const deleted = await seedFixture({ deleted: true });
    await expect(
      runUpdate(deleted.editorId, deleted, command(deleted, { firstName: "Neu" })),
    ).rejects.toBeInstanceOf(ContactDeletedError);
  });

  it("validiert unvollständige Befehle als invalid", async () => {
    await expect(
      runUpdate(fixture.editorId, fixture, {
        schemaVersion: CONTACT_UPDATE_COMMAND_VERSION,
        projectId: fixture.projectId,
        expectedRevision: 1,
        patch: {},
      }),
    ).rejects.toBeInstanceOf(ContactValidationError);
  });

  it("Viewer/External werden abgewiesen; Fremdmandant liefert not_found", async () => {
    await expect(
      runUpdate(fixture.viewerId, fixture, command(fixture, { firstName: "X" })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(
      withAuthorizedTenantOn(
        testPool, fixture.externalId, fixture.workspaceId,
        (tx, ctx) => getContactDataset(tx, ctx, fixture.projectId),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const other = await seedFixture();
    const foreign = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => getContactDataset(tx, ctx, fixture.projectId),
    );
    expect(foreign).toBeNull();
  });

  it("kein Revisions-Bump bei unverändertem Patch", async () => {
    const result = await runUpdate(fixture.editorId, fixture, command(fixture, {
      firstName: "Erika",
      lastName: "Mustermann",
      salutation: "female",
      isBusiness: false,
    }));
    expect(result.changedFields).toEqual([]);
    expect(result.revision).toBe(1);
  });

  it("ERASURE-01: scrubbt nur neue PII, lässt is_business/revision/phone_reachability unverändert", async () => {
    // Kontakt mit altem updated_at für Erasure-Eligibility.
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const oldAt = monthsAgo(25);
      await tx.execute(sql`update contact set updated_at = ${oldAt} where id = ${fixture.contactId}::uuid and workspace_id = ${fixture.workspaceId}::uuid`);
      await tx.execute(sql`update site set updated_at = ${oldAt} where contact_id = ${fixture.contactId}::uuid and workspace_id = ${fixture.workspaceId}::uuid`);
      await tx.execute(sql`update project set updated_at = ${oldAt} where id = ${fixture.projectId}::uuid and workspace_id = ${fixture.workspaceId}::uuid`);
    });
    // PII-Spalten vorab setzen, damit der Scrub-Nachweis eindeutig ist.
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        update contact set
          salutation = 'diverse', email_secondary = 'sek@example.test',
          phone_mobile = '+491701234567', phone_reachability = 'fulltime',
          address_street = 'Testweg', address_house_number = '7',
          address_postal_code = '10115', address_city = 'Berlin', address_country = 'DE',
          marketing_consent_policy_version = 'v1', marketing_consent_text = 'Text',
          marketing_consent_data_protection_link = 'https://example.test/datenschutz',
          utm_source = 'source', utm_medium = 'medium', utm_campaign = 'campaign',
          utm_term = 'term', utm_content = 'content', is_business = false
        where id = ${fixture.contactId}::uuid and workspace_id = ${fixture.workspaceId}::uuid
      `);
    });

    const erasureClient = await testPool.connect();
    try {
      await erasureClient.query(
        "select public.erase_inactive_lead($1::uuid, $2::uuid, $3::uuid)",
        [fixture.workspaceId, fixture.contactId, randomUUID()],
      );
    } finally {
      erasureClient.release();
    }

    const row = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const r = await tx.execute<{
        display_name: string; first_name: string; last_name: string;
        salutation: string | null; email_secondary: string | null;
        phone_mobile: string | null; phone_reachability: string | null;
        is_business: boolean; revision: number; deleted_at: unknown;
        address_street: string | null; utm_source: string | null;
        marketing_consent_policy_version: string | null;
      }>(sql`
        select display_name, first_name, last_name, salutation, email_secondary,
               phone_mobile, phone_reachability, is_business, revision, deleted_at,
               address_street, utm_source, marketing_consent_policy_version
          from contact where id = ${fixture.contactId}::uuid and workspace_id = ${fixture.workspaceId}::uuid
      `);
      return r.rows[0]!;
    });

    expect(row.display_name).toBe(`geloescht-${fixture.contactId}`);
    expect(row.first_name).toBe(`geloescht-${fixture.contactId}`);
    expect(row.last_name).toBe(`geloescht-${fixture.contactId}`);
    expect(row.salutation).toBeNull();
    expect(row.email_secondary).toBeNull();
    expect(row.phone_mobile).toBeNull();
    expect(row.address_street).toBeNull();
    expect(row.utm_source).toBeNull();
    expect(row.marketing_consent_policy_version).toBeNull();
    // Nicht gescrubbt:
    expect(row.phone_reachability).toBe("fulltime");
    expect(row.is_business).toBe(false);
    expect(row.revision).toBe(1);
    expect(row.deleted_at).not.toBeNull();
  });

  it("P2-4: DTO trägt deletedAt; gelöschter Kontakt wird ausgewiesen", async () => {
    const deleted = await seedFixture({ deleted: true });
    const dataset = await withAuthorizedTenantOn(
      testPool, deleted.editorId, deleted.workspaceId,
      (tx, ctx) => getContactDataset(tx, ctx, deleted.projectId),
    );
    expect(dataset!.deletedAt).not.toBeNull();

    const active = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getContactDataset(tx, ctx, fixture.projectId),
    );
    expect(active!.deletedAt).toBeNull();
  });

  it("P2-1: cross-field-Invarianten (B2B, PLZ-DE) → invalid statt roh 23514", async () => {
    await expect(runUpdate(fixture.editorId, fixture, command(fixture, {
      salutation: "business",
      isBusiness: false,
    }))).rejects.toBeInstanceOf(ContactValidationError);

    await expect(runUpdate(fixture.editorId, fixture, command(fixture, {
      addressCountry: "DE",
      addressPostalCode: "ABC123",
    }))).rejects.toBeInstanceOf(ContactValidationError);
  });

  it("P1-2: consent=true ohne Version wird von der DB abgewiesen (NOT VALID CHECK)", async () => {
    let message = "";
    try {
      await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
        insert into contact (
          id, workspace_id, display_name, first_name, last_name,
          email_primary, email_normalized,
          marketing_consent, marketing_consent_at, marketing_consent_source
        ) values (
          ${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          'Consent Ohne Version', 'Consent', 'Ohne',
          'consent@example.test', 'consent@example.test',
          true, now(), 'test'
        )
      `));
    } catch (error) {
      const cause = (error as { cause?: unknown } | null)?.cause;
      message = `${String(error)} | ${String(cause)}`;
    }
    expect(message).toContain("contact_marketing_consent_version_ck");
  });

  it("M114-RACE-01: zwei parallele Edits — genau einer gewinnt, der andere Conflict", async () => {
    const results = await Promise.allSettled([
      runUpdate(fixture.editorId, fixture, command(fixture, { firstName: "Eins" })),
      runUpdate(fixture.editorId, fixture, command(fixture, { firstName: "Zwei" })),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ContactConflictError);

    const dataset = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getContactDataset(tx, ctx, fixture.projectId),
    );
    expect(dataset!.revision).toBe(2);
    expect(["Eins", "Zwei"]).toContain(dataset!.name.firstName);
    expect(dataset!.name.lastName).toBe("Mustermann");
  });

  it("M114-RACE-02: Edit↔Erasure serialisiert über den gemeinsamen Advisory-Lock", async () => {
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const oldAt = monthsAgo(25);
      await tx.execute(sql`update contact set updated_at = ${oldAt} where id = ${fixture.contactId}::uuid and workspace_id = ${fixture.workspaceId}::uuid`);
      await tx.execute(sql`update site set updated_at = ${oldAt} where contact_id = ${fixture.contactId}::uuid and workspace_id = ${fixture.workspaceId}::uuid`);
      await tx.execute(sql`update project set updated_at = ${oldAt} where id = ${fixture.projectId}::uuid and workspace_id = ${fixture.workspaceId}::uuid`);
    });

    const erasure = await testPool.connect();
    try {
      await erasure.query("begin");
      await erasure.query(`select set_config('app.workspace_id', $1, true)`, [fixture.workspaceId]);
      await erasure.query(
        `select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text || ':' || $2::text, 1701734770))`,
        [fixture.workspaceId, fixture.contactId],
      );
      await erasure.query(
        `update contact set deleted_at = now() where workspace_id = $1::uuid and id = $2::uuid`,
        [fixture.workspaceId, fixture.contactId],
      );

      const editPromise = runUpdate(fixture.editorId, fixture, command(fixture, { firstName: "Neu" }));
      // Der Edit blockiert am Advisory-Lock, bis die Erasure committet.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await erasure.query("commit");

      await expect(editPromise).rejects.toBeInstanceOf(ContactDeletedError);
    } finally {
      erasure.release();
    }
  });
});
