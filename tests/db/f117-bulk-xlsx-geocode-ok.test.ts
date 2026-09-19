import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { AddressCandidate } from "@/lib/integrations/geocoding";
import {
  importManualLeadBulk,
  MANUAL_LEAD_BULK_REPORT_VERSION,
} from "@/modules/projects/lead-bulk-import";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-17 xlsx-ok')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f117.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

function xlsxBytes(rows: Array<Array<string | number>>): Uint8Array {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Blatt1");
  const out = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  return new Uint8Array(out);
}

const CANDIDATE: AddressCandidate = {
  placeId: "f117-ok-house-69115",
  formattedAddress: "Musterweg 12, 69115 Heidelberg",
  street: "Musterweg",
  houseNumber: "12",
  postalCode: "69115",
  city: "Heidelberg",
  countryCode: "DE",
  latitude: 49.398752,
  longitude: 8.672434,
  provider: "geoapify",
  precision: "house",
};

describe("F1-17 Bulk-xlsx + Auto-Geocoding: xlsx-OK (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  it("F117-DB-01: xlsx-Zeile wird angelegt und auf selected geocodiert", async () => {
    const queries: string[] = [];
    const resolved: string[] = [];
    const report = await asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      fileKind: "xlsx",
      bytes: xlsxBytes([
        ["Name", "E-Mail", "Straße", "Hausnr", "PLZ", "Ort"],
        ["XLSX Anna", "anna@f117.test", "Musterweg", "12", "69115", "Heidelberg"],
      ]),
      defaultScope: "residential",
      dryRun: false,
      geocode: {
        searchAddresses: async (query) => {
          queries.push(query);
          return { candidates: [CANDIDATE] };
        },
        resolveAddress: async (placeId) => {
          resolved.push(placeId);
          return CANDIDATE;
        },
      },
    }));

    expect(MANUAL_LEAD_BULK_REPORT_VERSION).toBe(2);
    expect(report.schemaVersion).toBe(2);
    expect(report.dryRun).toBe(false);
    expect(report.totalRows).toBe(1);
    expect(report.createdCount).toBe(1);
    expect(report.geocodedCount).toBe(1);
    expect(report.geocodeFailedCount).toBe(0);
    expect(report.rows[0]).toMatchObject({
      line: 2,
      displayName: "XLSX Anna",
      status: "created",
      geocoded: true,
      geocodeError: null,
    });
    expect(report.rows[0]!.projectId).not.toBeNull();
    // Genau ein Search→Resolve-Paar, sequentiell, mit der Pin-Adresse.
    expect(queries).toEqual(["Musterweg 12, 69115 Heidelberg"]);
    expect(resolved).toEqual(["f117-ok-house-69115"]);

    const projectId = report.rows[0]!.projectId!;
    const detail = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const site = await tx.execute<{
        address_mode: string; address_revision: number; address_follow_up_required: boolean;
        pin_confirmed: boolean; lat: string | null; lng: string | null;
        geocode_source: string | null; geocode_place_id: string | null;
        geocode_precision: string | null; formatted_address: string | null;
      }>(sql`
        select s.address_mode, s.address_revision, s.address_follow_up_required,
               s.pin_confirmed, s.lat::text as lat, s.lng::text as lng,
               s.geocode_source, s.geocode_place_id, s.geocode_precision, s.formatted_address
          from project p
          join site s on s.workspace_id = p.workspace_id and s.id = p.site_id
         where p.workspace_id = ${fixture.workspaceId}::uuid
           and p.id = ${projectId}::uuid
      `);
      const events = await tx.execute<{ event_type: string }>(sql`
        select event_type from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid
           and aggregate_type = 'site'
      `);
      const audits = await tx.execute<{ action: string; resource: string }>(sql`
        select action, resource from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and resource = 'site_address'
      `);
      return { site: site.rows[0], events: events.rows, audits: audits.rows };
    });

    expect(detail.site).toMatchObject({
      address_mode: "selected",
      address_revision: 2,
      address_follow_up_required: false,
      pin_confirmed: false,
      geocode_source: "geoapify",
      geocode_place_id: "f117-ok-house-69115",
      geocode_precision: "house",
      formatted_address: "Musterweg 12, 69115 Heidelberg",
    });
    expect(Number(detail.site!.lat)).toBeCloseTo(49.398752, 6);
    expect(Number(detail.site!.lng)).toBeCloseTo(8.672434, 6);
    expect(detail.events.map((row) => row.event_type)).toContain("site.address_geocoded");
    expect(detail.audits).toContainEqual({ action: "project.write", resource: "site_address" });
  });
});
