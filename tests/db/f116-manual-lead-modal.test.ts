import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { suggestContacts } from "@/modules/contacts/contact-suggest";
import { ContactValidationError } from "@/modules/contacts/errors";
import {
  createManualLead,
  ManualLeadValidationError,
} from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-16 Modal')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f116.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f116.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f116.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid, 'viewer', '{"external_only": true}'::jsonb)
    `);
  });
  return { workspaceId, editorId, viewerId, externalId };
}

type SeedContactInput = {
  displayName: string;
  email?: string;
  phoneRaw?: string;
  phoneE164?: string;
  street?: string;
  houseNumber?: string;
  postalCode?: string;
  city?: string;
  deleted?: boolean;
};

async function seedContact(fx: Fixture, input: SeedContactInput): Promise<string> {
  const id = randomUUID();
  const parts = input.displayName.trim().split(/\s+/u);
  const firstName = parts[0] ?? input.displayName;
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : parts[0]!;
  const emailNormalized = input.email === undefined ? null : input.email.trim().toLowerCase();
  await withTenantOn(testPool, fx.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name,
        email_primary, email_normalized, phone_raw, phone_e164,
        address_street, address_house_number, address_postal_code, address_city,
        dedupe_review_required, deleted_at
      ) values (
        ${id}::uuid, ${fx.workspaceId}::uuid, ${input.displayName}::text,
        ${firstName}::text, ${lastName}::text,
        ${input.email ?? null}::text, ${emailNormalized}::text,
        ${input.phoneRaw ?? null}::text, ${input.phoneE164 ?? null}::text,
        ${input.street ?? null}::text, ${input.houseNumber ?? null}::text,
        ${input.postalCode ?? null}::text, ${input.city ?? null}::text,
        false, ${input.deleted === true ? sql`statement_timestamp()` : null}
      )
    `);
  });
  return id;
}

describe("F1-16 Manuelle Anfrage als Modal (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;
  const asExternal = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.externalId, fx.workspaceId, fn as never) as Promise<T>;

  it("F116-DB-01: Reuse via contactId nutzt den gewählten Kontakt", async () => {
    const first = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "F116 Auswahl",
      email: "auswahl@f116.test",
      phone: "0151 23456789",
    }));
    const second = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "F116 Auswahl Zweitprojekt",
      email: "auswahl@f116.test",
      contactId: first.contactId,
    }));
    expect(second.contactReused).toBe(true);
    expect(second.dedupeReviewRequired).toBe(true);
    expect(second.contactId).toBe(first.contactId.toLowerCase());
    expect(second.projectId).not.toBe(first.projectId.toLowerCase());

    const rows = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const found = await tx.execute<{ contact_id: string; dedupe: boolean }>(sql`
        select contact_id, dedupe_review_required as dedupe from project
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${second.projectId}::uuid
      `);
      const contacts = await tx.execute<{ id: string }>(sql`
        select id from contact
         where workspace_id = ${fixture.workspaceId}::uuid
           and email_normalized = 'auswahl@f116.test'
      `);
      return { project: found.rows[0], contactCount: contacts.rows.length };
    });
    expect(rows.project?.contact_id).toBe(first.contactId.toLowerCase());
    expect(rows.project?.dedupe).toBe(true);
    expect(rows.contactCount).toBe(1);
  });

  it("F116-DB-02: Drift (E-Mail nach Auswahl geändert) ignoriert contactId, Dedupe läuft normal", async () => {
    const chosen = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "F116 Drift Auswahl",
      email: "drift-a@f116.test",
    }));
    // Frische E-Mail: neuer Kontakt trotz contactId.
    const drifted = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "F116 Drift Neu",
      email: "drift-b@f116.test",
      contactId: chosen.contactId,
    }));
    expect(drifted.contactReused).toBe(false);
    expect(drifted.contactId).not.toBe(chosen.contactId.toLowerCase());

    // E-Mail eines ANDEREN Kontakts: Dedupe gewinnt über contactId.
    const other = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "F116 Drift Anderer",
      email: "drift-c@f116.test",
    }));
    const rerouted = await asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "F116 Drift Umgeleitet",
      email: "drift-c@f116.test",
      contactId: chosen.contactId,
    }));
    expect(rerouted.contactReused).toBe(true);
    expect(rerouted.contactId).toBe(other.contactId.toLowerCase());
  });

  it("F116-DB-03: fremde, gelöschte oder unbekannte contactId scheitert fail-closed", async () => {
    const foreign = await seedFixture();
    const foreignContact = await asEditor(foreign, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "F116 Fremd",
      email: "fremd@f116.test",
    }));
    await expect(asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "F116 Fremdversuch",
      email: "fremd@f116.test",
      contactId: foreignContact.contactId,
    }))).rejects.toBeInstanceOf(ManualLeadValidationError);

    const deletedId = await seedContact(fixture, {
      displayName: "F116 Geloescht",
      email: "geloescht@f116.test",
      deleted: true,
    });
    await expect(asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "F116 Geloeschtversuch",
      email: "geloescht@f116.test",
      contactId: deletedId,
    }))).rejects.toBeInstanceOf(ManualLeadValidationError);

    await expect(asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "F116 Unbekannt",
      email: "unbekannt@f116.test",
      contactId: randomUUID(),
    }))).rejects.toBeInstanceOf(ManualLeadValidationError);

    await expect(asEditor(fixture, (tx, ctx) => createManualLead(tx, ctx, {
      scope: "residential",
      displayName: "F116 Ungueltig",
      email: "ungueltig@f116.test",
      contactId: "keine-uuid",
    }))).rejects.toBeInstanceOf(ManualLeadValidationError);
  });

  it("F116-DB-04: Suggest ist Tenant-lokal, blendet Gelöschte aus und deckelt auf 8", async () => {
    const other = await seedFixture();
    for (let index = 0; index < 10; index += 1) {
      await seedContact(fixture, {
        displayName: `F116 Familie ${String(index).padStart(2, "0")}`,
        email: `familie-${index}@f116.test`,
        phoneRaw: `0151 1000000${index}`,
        phoneE164: `+491511000000${index}`,
        street: "Familienweg",
        houseNumber: `${index + 1}`,
        postalCode: "10115",
        city: "Berlin",
      });
    }
    await seedContact(fixture, {
      displayName: "F116 Familie Geloescht",
      email: "familie-geloescht@f116.test",
      deleted: true,
    });
    await seedContact(other, {
      displayName: "F116 Familie Fremd",
      email: "familie-fremd@f116.test",
    });

    const suggestions = await asEditor(fixture, (tx, ctx) =>
      suggestContacts(tx, ctx, { query: "F116 Familie" }));
    expect(suggestions).toHaveLength(8);
    expect(suggestions.map((entry) => entry.displayName)).toEqual([
      "F116 Familie 00",
      "F116 Familie 01",
      "F116 Familie 02",
      "F116 Familie 03",
      "F116 Familie 04",
      "F116 Familie 05",
      "F116 Familie 06",
      "F116 Familie 07",
    ]);
    expect(suggestions[0]).toMatchObject({
      email: "familie-0@f116.test",
      street: "Familienweg",
      postalCode: "10115",
      city: "Berlin",
    });

    // E-Mail- und Telefon-Treffer lösen ebenfalls auf.
    const byEmail = await asEditor(fixture, (tx, ctx) =>
      suggestContacts(tx, ctx, { query: "familie-9@f116" }));
    expect(byEmail.map((entry) => entry.displayName)).toEqual(["F116 Familie 09"]);
    const byPhone = await asEditor(fixture, (tx, ctx) =>
      suggestContacts(tx, ctx, { query: "10000005" }));
    expect(byPhone.map((entry) => entry.displayName)).toEqual(["F116 Familie 05"]);

    // LIKE-Metazeichen suchen wörtlich, nicht als Muster.
    const literal = await asEditor(fixture, (tx, ctx) =>
      suggestContacts(tx, ctx, { query: "F116 Familie %" }));
    expect(literal).toHaveLength(0);

    // Unter zwei Zeichen keine Suche.
    await expect(asEditor(fixture, (tx, ctx) =>
      suggestContacts(tx, ctx, { query: "F" }))).rejects.toBeInstanceOf(ContactValidationError);

    // Interner Viewer darf suchen (contact.read ab viewer).
    const asViewerResult = await asViewer(fixture, (tx, ctx) =>
      suggestContacts(tx, ctx, { query: "F116 Familie 01" }));
    expect(asViewerResult.map((entry) => entry.displayName)).toEqual(["F116 Familie 01"]);
  });

  it("F116-DB-05: Suggest ohne contact.read wird verweigert", async () => {
    await seedContact(fixture, {
      displayName: "F116 Verweigert",
      email: "verweigert@f116.test",
    });
    await expect(asExternal(fixture, (tx, ctx) =>
      suggestContacts(tx, ctx, { query: "F116 Verweigert" }))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });
});
