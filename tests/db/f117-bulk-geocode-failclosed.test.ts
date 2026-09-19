import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { AddressCandidate } from "@/lib/integrations/geocoding";
import { importManualLeadBulk } from "@/modules/projects/lead-bulk-import";
import type { BulkGeocodeDeps } from "@/modules/projects/lead-bulk-geocode";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-17 fail-closed')`);
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
  return new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
}

function candidateFor(placeId: string): AddressCandidate {
  return {
    placeId,
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
}

describe("F1-17 Auto-Geocoding: fail-closed + Dry-Run (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  async function siteModes(projectIds: string[]): Promise<string[]> {
    return withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const found = await tx.execute<{ id: string; address_mode: string }>(sql`
        select p.id, s.address_mode
          from project p
          join site s on s.workspace_id = p.workspace_id and s.id = p.site_id
         where p.workspace_id = ${fixture.workspaceId}::uuid
      `);
      const byId = new Map(found.rows.map((row) => [row.id, row.address_mode]));
      return projectIds.map((id) => byId.get(id) ?? "missing");
    });
  }

  it("F117-DB-04: Fehler je Zeile — created+legacy, Rest läuft weiter", async () => {
    const queries: string[] = [];
    const geocode: BulkGeocodeDeps = {
      searchAddresses: async (query) => {
        queries.push(query);
        if (query.includes("Nirgendweg")) return { candidates: [] };
        if (query.includes("Fehlerweg")) throw new Error("provider down");
        return { candidates: [candidateFor("f117-fc-ok")] };
      },
      resolveAddress: async (placeId) => candidateFor(placeId),
    };
    const report = await asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      fileKind: "xlsx",
      bytes: xlsxBytes([
        ["Name", "E-Mail", "Straße", "Hausnummer", "PLZ", "Ort", "Bereich"],
        ["Ok", "ok@f117.test", "Musterweg", "12", "69115", "Heidelberg", ""],
        ["Ohne Treffer", "ohne@f117.test", "Nirgendweg", "1", "00000", "Nirgendstadt", ""],
        ["Fehler", "fehler@f117.test", "Fehlerweg", "2", "10115", "Berlin", ""],
        ["Gewerbe", "gewerbe@f117.test", "Musterweg", "12", "69115", "Heidelberg", "Gewerbe"],
        ["Unvollständig", "unvoll@f117.test", "Musterweg", "", "69115", "Heidelberg", ""],
      ]),
      defaultScope: "residential",
      dryRun: false,
      geocode,
    }));

    expect(report.createdCount).toBe(5);
    expect(report.geocodedCount).toBe(1);
    expect(report.geocodeFailedCount).toBe(2);
    expect(report.rows.map((row) => [row.status, row.geocoded, row.geocodeError])).toEqual([
      ["created", true, null],
      ["created", false, "no-candidate"],
      ["created", false, "provider-error"],
      ["created", null, null],
      ["created", null, null],
    ]);
    // Nur qualifizierte Zeilen (residential + 4 Adresszellen) lösen Calls aus.
    expect(queries).toHaveLength(3);

    const modes = await siteModes(report.rows.map((row) => row.projectId!));
    expect(modes).toEqual(["selected", "legacy", "legacy", "legacy", "legacy"]);
  });

  it("F117-DB-05: Dry-Run ohne Geocode-Calls; Kollision fail-closed", async () => {
    let calls = 0;
    const geocode: BulkGeocodeDeps = {
      searchAddresses: async () => {
        calls += 1;
        return { candidates: [candidateFor("f117-fc-dup")] };
      },
      resolveAddress: async (placeId) => candidateFor(placeId),
    };
    const input = {
      fileKind: "xlsx" as const,
      bytes: xlsxBytes([
        ["Name", "E-Mail", "Straße", "Hausnummer", "PLZ", "Ort"],
        ["Dup", "dup@f117.test", "Musterweg", "12", "69115", "Heidelberg"],
      ]),
      defaultScope: "residential" as const,
      geocode,
    };
    const dry = await asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      ...input,
      dryRun: true,
    }));
    expect(dry.rows[0]).toMatchObject({ status: "valid", geocoded: null, geocodeError: null });
    expect(dry.geocodedCount).toBe(0);
    expect(dry.geocodeFailedCount).toBe(0);
    expect(calls).toBe(0);

    // Gleicher Kontakt (Dedupe), gleiche Adresse → zweiter Standort kollidiert.
    const report = await asEditor(fixture, (tx, ctx) => importManualLeadBulk(tx, ctx, {
      fileKind: "xlsx",
      bytes: xlsxBytes([
        ["Name", "E-Mail", "Straße", "Hausnummer", "PLZ", "Ort"],
        ["Dup Eins", "dup@f117.test", "Musterweg", "12", "69115", "Heidelberg"],
        ["Dup Zwei", "dup@f117.test", "Musterweg", "12", "69115", "Heidelberg"],
      ]),
      defaultScope: "residential",
      dryRun: false,
      geocode,
    }));
    expect(report.createdCount).toBe(2);
    expect(report.reusedCount).toBe(1);
    expect(report.rows.map((row) => [row.geocoded, row.geocodeError])).toEqual([
      [true, null],
      [false, "collision"],
    ]);
    const modes = await siteModes(report.rows.map((row) => row.projectId!));
    expect(modes).toEqual(["selected", "legacy"]);
  });
});
