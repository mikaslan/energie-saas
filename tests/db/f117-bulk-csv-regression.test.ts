import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import type { AddressCandidate } from "@/lib/integrations/geocoding";
import { importManualLeadBulk } from "@/modules/projects/lead-bulk-import";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-17 csv-reg')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f117.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f117.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, viewerId };
}

const CANDIDATE: AddressCandidate = {
  placeId: "f117-reg-house-10115",
  formattedAddress: "Sonnenweg 3, 10115 Berlin",
  street: "Sonnenweg",
  houseNumber: "3",
  postalCode: "10115",
  city: "Berlin",
  countryCode: "DE",
  latitude: 52.5234,
  longitude: 13.4114,
  provider: "geoapify",
  precision: "house",
};

const MIXED_CSV = [
  "Name;E-Mail;Telefon;PLZ;Ort;Bereich;Quelle;Notiz",
  "Bulk Anna;anna@f117.test;0151 11111111;10115;Berlin;;;",
  "Ohne Weg;;;10115;Berlin;;;",
  "Falsche Mail;keine-mail;;10115;Berlin;;;",
  "Bereich Gewerbe;g@f117.test;0151 22222222;80331;München;Gewerbe;;",
].join("\n");

describe("F1-17 CSV-Regression (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  it("F117-DB-06: CSV ohne fileKind läuft wie F1-02, Report v2 additiv", async () => {
    const report = await asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      csvText: MIXED_CSV,
      defaultScope: "residential",
      dryRun: false,
    }));

    expect(report.schemaVersion).toBe(2);
    expect(report.totalRows).toBe(4);
    expect(report.createdCount).toBe(2);
    expect(report.rows.map((row) => row.status)).toEqual([
      "created", "invalid", "invalid", "created",
    ]);
    expect(report.rows[1]).toMatchObject({ line: 3, errors: ["missing-contact"] });
    expect(report.rows[2]).toMatchObject({ line: 4, errors: ["invalid-row"] });
    // Keine qualifizierte Zeile (Straße/Hausnummer fehlen, Gewerbe nie):
    // keine Calls, Zähler null/0, v1-Felder stabil.
    expect(report.geocodedCount).toBe(0);
    expect(report.geocodeFailedCount).toBe(0);
    expect(report.rows.every((row) => row.geocoded === null && row.geocodeError === null)).toBe(true);

    await expect(asViewer(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      csvText: "Name;E-Mail\nV;v@f117.test",
      defaultScope: "residential",
      dryRun: true,
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F117-DB-07: CSV nutzt dieselbe Geocode-Pipeline wie xlsx", async () => {
    const queries: string[] = [];
    const report = await asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      fileKind: "csv",
      csvText: [
        "Name;E-Mail;Straße;Hausnummer;PLZ;Ort",
        "CSV Geo;geo@f117.test;Sonnenweg;3;10115;Berlin",
      ].join("\n"),
      defaultScope: "residential",
      dryRun: false,
      geocode: {
        searchAddresses: async (query) => {
          queries.push(query);
          return { candidates: [CANDIDATE] };
        },
        resolveAddress: async () => CANDIDATE,
      },
    }));

    expect(report.createdCount).toBe(1);
    expect(report.geocodedCount).toBe(1);
    expect(report.rows[0]).toMatchObject({ status: "created", geocoded: true, geocodeError: null });
    expect(queries).toEqual(["Sonnenweg 3, 10115 Berlin"]);

    const mode = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const found = await tx.execute<{ address_mode: string }>(sql`
        select s.address_mode
          from project p
          join site s on s.workspace_id = p.workspace_id and s.id = p.site_id
         where p.workspace_id = ${fixture.workspaceId}::uuid
           and p.id = ${report.rows[0]!.projectId!}::uuid
      `);
      return found.rows[0]?.address_mode;
    });
    expect(mode).toBe("selected");
  });
});
