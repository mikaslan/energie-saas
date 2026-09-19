import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { withTenantOn } from "@/lib/db/tenant";
import {
  mergeRequestedPackages,
  ProjectRequirementsRechnerV1Schema,
  requestedPackagesSchema,
  SiteEnergyProfileV1Schema,
} from "@/lib/integrations/calculation/contract";
import { beforeAll, describe, expect, it } from "vitest";
import { testPool } from "../setup/test-db";

const PROFILE_SCHEMA_VERSION = "site-energy-profile.v1";
const NOW_ISO = "2026-08-29T12:00:00.000Z";

// Die DB-CHECK-Aussagen brauchen Migration 0232 (F1-19). Im T4-Fenster liegt
// sie als Scratch-Migration 9TMP_t4_energy an; nach dem zentralen Merge als
// echte 0232. Ohne sie bleiben die reinen CHECK-Tests deaktiviert, die
// Contract-Aussagen laufen immer.
const has0232Checks = await (async (): Promise<boolean> => {
  try {
    const { rows } = await testPool.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'site_energy_profile_contract_ck'",
    );
    return (rows[0]?.def ?? "").includes("property");
  } catch {
    return false;
  }
})();

function unknownField() {
  return { status: "unknown" as const, value: null, source: "not_collected" as const };
}

function baseProfile(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    inputMode: "consumption" as const,
    building: {
      type: unknownField(),
      year: unknownField(),
      heatedAreaM2: unknownField(),
    },
    roofs: [
      {
        id: "dach-1",
        areaM2: 52,
        azimuthDeg: 5,
        tiltDeg: 35,
        type: "pitched" as const,
        shading: unknownField(),
        source: "user_drawn" as const,
      },
    ],
    consumption: {
      householdKwhPerYear: {
        status: "known" as const,
        value: 4_200,
        source: "customer_metered" as const,
      },
      electricityPriceCentsPerKwh: {
        status: "known" as const,
        value: 36,
        source: "customer_input" as const,
      },
      annualPriceIncreasePercent: unknownField(),
      loadProfile: unknownField(),
      evKmPerYear: unknownField(),
      evChargingPattern: unknownField(),
      heatPumpKwhPerYear: unknownField(),
      coolingKwhPerYear: unknownField(),
      heatingAcKwhPerYear: unknownField(),
      hotWaterKwhPerYear: unknownField(),
    },
    existingAssets: {
      pv: { status: "known_absent" as const, source: "rechner_branch" as const },
      storage: { status: "unknown" as const, source: "not_collected" as const },
      wallbox: { status: "unknown" as const, source: "not_collected" as const },
      ev: { status: "unknown" as const, source: "not_collected" as const },
    },
    provenance: {
      source: "rechner_snapshot" as const,
      sourceSchemaVersion: "wmee-solar-snapshot.v1" as const,
      sourceEngine: "wmee-solar.v1" as const,
      roof: "user_drawn" as const,
      consumption: "metered_kwh" as const,
      electricityPrice: "customer" as const,
      annualPriceIncrease: "default" as const,
    },
    ...overrides,
  };
}

function baseRequirements(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "project-requirements.rechner.v1",
    source: "wmee-rechner-v3",
    branch: "new_installation",
    requestedProducts: {
      targetStorageKwh: 8,
      wallbox: false,
      bidirectionalCharging: false,
      backupPower: false,
    },
    ...overrides,
  };
}

function unsetPackages() {
  const entry = () => ({ wanted: false, paymentKind: null });
  return { solar: entry(), storage: entry(), wallbox: entry(), heating: entry() };
}

function room(name: string, areaM2: number, usage = "living", radiatorCount = 2) {
  return { name, areaM2, usage, radiatorCount };
}

type ProjectGraph = {
  workspaceId: string;
  actorId: string;
  contactId: string;
  siteId: string;
  projectId: string;
  receiptId: string;
  snapshotId: string;
  requirementId: string;
};

async function createProjectGraph(label: string): Promise<ProjectGraph> {
  const graph: ProjectGraph = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
  };
  const email = `${graph.actorId}@f1019.test`;
  const snapshot = {
    schemaVersion: "wmee-solar-snapshot.v1",
    calculatedAt: NOW_ISO,
    branch: "new_installation",
    questionnaireVariant: "short",
    resultIntegrity: "client_reported_unverified",
    inputs: {},
    provenance: { investment: "market_estimate" },
    result: { mode: "new_installation" },
  };

  await withTenantOn(testPool, graph.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${graph.workspaceId}::uuid, ${label})
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${graph.actorId}::uuid, ${email})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role)
      values (${graph.workspaceId}::uuid, ${graph.actorId}::uuid, 'editor')
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
      ) values (
        ${graph.contactId}::uuid, ${graph.workspaceId}::uuid, ${label}, 'Fixture', 'Contact',
        ${`${graph.contactId}@f1019.test`}, ${`${graph.contactId}@f1019.test`}
      )
    `);
    await tx.execute(sql`
      insert into site (
        id, workspace_id, contact_id, label, formatted_address,
        address_fingerprint, address_fingerprint_version, address_mode,
        street, house_number, postal_code, city, country, lat, lng,
        geocode_source, geocode_precision, address_follow_up_required,
        address_revision, pin_confirmed, pin_confirmed_address_revision,
        pin_adjusted
      ) values (
        ${graph.siteId}::uuid, ${graph.workspaceId}::uuid, ${graph.contactId}::uuid,
        ${label}, 'Mühlstraße 8, 69234 Dielheim',
        decode(repeat('ab', 32), 'hex'), 1, 'selected',
        'Mühlstraße', '8', '69234', 'Dielheim', 'DE', 49.28463, 8.73821,
        'photon', 'house', false, 1, true, 1, false
      )
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${graph.projectId}::uuid, ${graph.workspaceId}::uuid,
             ${graph.contactId}::uuid, ${graph.siteId}::uuid,
             board.id, intake_column.id, ${label}, 'wmee-rechner-v3'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
       and intake_column.board_id = board.id
       and intake_column.is_intake = true
       and intake_column.archived_at is null
      where board.workspace_id = ${graph.workspaceId}::uuid
        and board.scope = 'residential'
        and board.is_default = true
        and board.archived_at is null
    `);
    await tx.execute(sql`
      insert into inbound_receipt (
        id, workspace_id, source_key, submission_id, contract_version,
        body_sha256, auth_key_id, signed_at, submitted_at, received_at,
        producer_application, producer_git_revision, producer_environment,
        calculator_engine, acquisition, privacy_purpose, privacy_legal_basis,
        privacy_notice_version, privacy_notice_url, contact_resolution,
        contact_id, site_id, project_id
      ) values (
        ${graph.receiptId}::uuid, ${graph.workspaceId}::uuid,
        'wmee-rechner-v3', ${randomUUID()}::uuid, 'rechner-intake.v1',
        decode(repeat('00', 32), 'hex'), 'f1019-red', now(), now(), now(),
        'wmee-rechner-v3', ${"0".repeat(40)}, 'development', 'wmee-solar.v1',
        '{}'::jsonb, 'offer_request', 'art_6_1_b_precontractual', 'f1019',
        'https://example.test/privacy', 'created', ${graph.contactId}::uuid,
        ${graph.siteId}::uuid, ${graph.projectId}::uuid
      )
    `);
    await tx.execute(sql`
      insert into calculator_snapshot (
        id, workspace_id, receipt_id, project_id, schema_version,
        calculator_engine, result_integrity, investment_source,
        calculated_at, snapshot
      ) values (
        ${graph.snapshotId}::uuid, ${graph.workspaceId}::uuid,
        ${graph.receiptId}::uuid, ${graph.projectId}::uuid,
        'wmee-solar-snapshot.v1', 'wmee-solar.v1',
        'client_reported_unverified', 'market_estimate', now(),
        ${JSON.stringify(snapshot)}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into project_requirement (
        id, workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${graph.requirementId}::uuid, ${graph.workspaceId}::uuid,
        ${graph.projectId}::uuid, 1, 'project-requirements.rechner.v1',
        ${graph.snapshotId}::uuid, ${JSON.stringify(baseRequirements())}::jsonb
      )
    `);
  });

  return graph;
}

async function createSite(
  graph: ProjectGraph,
  label: string,
): Promise<string> {
  const siteId = randomUUID();
  await withTenantOn(testPool, graph.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into site (
        id, workspace_id, contact_id, label, formatted_address,
        address_fingerprint, address_fingerprint_version, address_mode,
        street, house_number, postal_code, city, country, lat, lng,
        geocode_source, geocode_precision, address_follow_up_required,
        address_revision, pin_confirmed, pin_confirmed_address_revision,
        pin_adjusted
      ) values (
        ${siteId}::uuid, ${graph.workspaceId}::uuid, ${graph.contactId}::uuid,
        ${label}, 'Mühlstraße 8, 69234 Dielheim',
        decode(md5(${siteId}::text) || md5(${label}), 'hex'), 1, 'selected',
        'Mühlstraße', '8', '69234', 'Dielheim', 'DE', 49.28463, 8.73821,
        'photon', 'house', false, 1, true, 1, false
      )
    `);
  });
  return siteId;
}

async function insertProfile(
  graph: ProjectGraph,
  siteId: string,
  inputMode: string,
  profile: Record<string, unknown>,
): Promise<void> {
  await withTenantOn(testPool, graph.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into site_energy_profile (
        id, workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256
      ) values (
        ${randomUUID()}::uuid, ${graph.workspaceId}::uuid, ${siteId}::uuid,
        1, ${PROFILE_SCHEMA_VERSION}, ${inputMode}, 'manual', null, null, 1,
        ${JSON.stringify(profile)}::jsonb, decode(repeat('11', 32), 'hex')
      )
    `);
  });
}

async function insertRequirement(
  graph: ProjectGraph,
  revision: number,
  requirements: Record<string, unknown>,
): Promise<void> {
  await withTenantOn(testPool, graph.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into project_requirement (
        id, workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${randomUUID()}::uuid, ${graph.workspaceId}::uuid,
        ${graph.projectId}::uuid, ${revision}, 'project-requirements.rechner.v1',
        ${graph.snapshotId}::uuid, ${JSON.stringify(requirements)}::jsonb
      )
    `);
  });
}

async function expectPgRejection(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught, "Das unzulässige Statement hätte scheitern müssen.").toBeInstanceOf(Error);
  const cause = (caught as { cause?: unknown }).cause;
  expect(`${String(caught)}\n${String(cause)}`).toMatch(/constraint/i);
}

beforeAll(async () => {
  await testPool.query("select 1");
});

describe("F1-19 Contract: Eingabemodi", () => {
  it("akzeptiert die consumption-Altzeile ohne Modus-Sektion", () => {
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile()).success).toBe(true);
  });

  it("lehnt einen unbekannten Modus ab", () => {
    const parsed = SiteEnergyProfileV1Schema.safeParse(
      baseProfile({ inputMode: "estimate" }),
    );
    expect(parsed.success).toBe(false);
  });

  it("akzeptiert property mit Heizart und Bewohnern", () => {
    const parsed = SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "property",
      propertyEstimate: { heatingType: "heat_pump", residentCount: 4 },
    }));
    expect(parsed.success).toBe(true);
  });

  it("lehnt property ohne oder mit halber Schaetzung ab", () => {
    expect(SiteEnergyProfileV1Schema.safeParse(
      baseProfile({ inputMode: "property" }),
    ).success).toBe(false);
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "property",
      propertyEstimate: { heatingType: "gas", residentCount: 0 },
    })).success).toBe(false);
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "property",
      propertyEstimate: { heatingType: "gas", residentCount: 21 },
    })).success).toBe(false);
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "property",
      propertyEstimate: { heatingType: "fernwaerme", residentCount: 2 },
    })).success).toBe(false);
  });

  it("lehnt modusfremde Sektionen ab", () => {
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "property",
      propertyEstimate: { heatingType: "oil", residentCount: 2 },
      rooms: [room("Wohnen", 24)],
    })).success).toBe(false);
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "consumption",
      propertyEstimate: { heatingType: "oil", residentCount: 2 },
    })).success).toBe(false);
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "consumption",
      rooms: [room("Wohnen", 24)],
    })).success).toBe(false);
  });

  it("akzeptiert roomwise mit 1..40 Raeumen", () => {
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "roomwise",
      rooms: [room("Wohnen", 24)],
    })).success).toBe(true);
    const forty = Array.from({ length: 40 }, (_, index) => room(`Raum ${index + 1}`, 12));
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "roomwise",
      rooms: forty,
    })).success).toBe(true);
  });

  it("lehnt roomwise ohne, leer oder mit 41 Raeumen ab", () => {
    expect(SiteEnergyProfileV1Schema.safeParse(
      baseProfile({ inputMode: "roomwise" }),
    ).success).toBe(false);
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "roomwise",
      rooms: [],
    })).success).toBe(false);
    const over = Array.from({ length: 41 }, (_, index) => room(`Raum ${index + 1}`, 12));
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "roomwise",
      rooms: over,
    })).success).toBe(false);
  });

  it("lehnt halb belegte Raumzeilen ab", () => {
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "roomwise",
      rooms: [room("", 24)],
    })).success).toBe(false);
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "roomwise",
      rooms: [room("Wohnen", 0)],
    })).success).toBe(false);
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "roomwise",
      rooms: [room("Wohnen", 24, "sauna")],
    })).success).toBe(false);
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "roomwise",
      rooms: [room("Wohnen", 24, "living", 51)],
    })).success).toBe(false);
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "roomwise",
      rooms: [room("Wohnen", 24), { name: "Bad" }],
    })).success).toBe(false);
  });

  it("koppelt manual an die Provenance operator_manual", () => {
    const manualProvenance = {
      ...(baseProfile({}).provenance as Record<string, unknown>),
      source: "operator_manual",
    };
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "manual",
      provenance: manualProvenance,
    })).success).toBe(true);
    expect(SiteEnergyProfileV1Schema.safeParse(
      baseProfile({ inputMode: "manual" }),
    ).success).toBe(false);
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      provenance: manualProvenance,
    })).success).toBe(false);
  });

  it("lehnt manual mit Modus-Sektion ab", () => {
    const manualProvenance = {
      ...(baseProfile({}).provenance as Record<string, unknown>),
      source: "operator_manual",
    };
    expect(SiteEnergyProfileV1Schema.safeParse(baseProfile({
      inputMode: "manual",
      provenance: manualProvenance,
      rooms: [room("Wohnen", 24)],
    })).success).toBe(false);
  });
});

describe("F1-19 Contract: Paket-Matrix", () => {
  it("akzeptiert Rechner-Zeilen ohne requestedPackages (Regression)", () => {
    expect(ProjectRequirementsRechnerV1Schema.safeParse(baseRequirements()).success).toBe(true);
  });

  it("akzeptiert die geschlossene Vierer-Matrix", () => {
    expect(requestedPackagesSchema.safeParse(unsetPackages()).success).toBe(true);
    expect(ProjectRequirementsRechnerV1Schema.safeParse(baseRequirements({
      requestedPackages: {
        solar: { wanted: true, paymentKind: "purchase" },
        storage: { wanted: true, paymentKind: "leasing" },
        wallbox: { wanted: false, paymentKind: null },
        heating: { wanted: true, paymentKind: "financing" },
      },
    })).success).toBe(true);
  });

  it("lehnt offene Schlüssel und falsche Zahlarten ab", () => {
    expect(ProjectRequirementsRechnerV1Schema.safeParse(baseRequirements({
      requestedPackages: {
        solar: { wanted: true, paymentKind: "purchase" },
      },
    })).success).toBe(false);
    expect(ProjectRequirementsRechnerV1Schema.safeParse(baseRequirements({
      requestedPackages: { ...unsetPackages(), carport: { wanted: false, paymentKind: null } },
    })).success).toBe(false);
    expect(ProjectRequirementsRechnerV1Schema.safeParse(baseRequirements({
      requestedPackages: {
        ...unsetPackages(),
        solar: { wanted: true, paymentKind: "barter" },
      },
    })).success).toBe(false);
  });

  it("lehnt entkoppelte wanted/paymentKind-Paare ab", () => {
    expect(requestedPackagesSchema.safeParse({
      ...unsetPackages(),
      solar: { wanted: true, paymentKind: null },
    }).success).toBe(false);
    expect(requestedPackagesSchema.safeParse({
      ...unsetPackages(),
      storage: { wanted: false, paymentKind: "purchase" },
    }).success).toBe(false);
  });

  it("mergt Formulardeltas mit Leer-bleibt-unveraendert", () => {
    const keep = {
      solar: { wanted: null, paymentKind: null },
      storage: { wanted: null, paymentKind: null },
      wallbox: { wanted: null, paymentKind: null },
      heating: { wanted: null, paymentKind: null },
    };
    expect(mergeRequestedPackages(unsetPackages(), keep)).toEqual(unsetPackages());
    expect(mergeRequestedPackages(undefined, keep)).toEqual(unsetPackages());
    const merged = mergeRequestedPackages(undefined, {
      ...keep,
      solar: { wanted: true, paymentKind: "purchase" as const },
    });
    expect(merged?.solar).toEqual({ wanted: true, paymentKind: "purchase" });
    const cleared = mergeRequestedPackages(
      { ...unsetPackages(), solar: { wanted: true, paymentKind: "leasing" as const } },
      { ...keep, solar: { wanted: false, paymentKind: null } },
    );
    expect(cleared?.solar).toEqual({ wanted: false, paymentKind: null });
  });

  it("verweigert unvollstaendige oder korrupte Paketstaende", () => {
    const keep = {
      solar: { wanted: null, paymentKind: null },
      storage: { wanted: null, paymentKind: null },
      wallbox: { wanted: null, paymentKind: null },
      heating: { wanted: null, paymentKind: null },
    };
    expect(mergeRequestedPackages(undefined, {
      ...keep,
      solar: { wanted: true, paymentKind: null },
    })).toBeNull();
    expect(mergeRequestedPackages({ solar: { wanted: true, paymentKind: null } }, keep)).toBeNull();
  });
});

describe.runIf(has0232Checks)("F1-19 DB: Profil-CHECKs je Modus", () => {
  it("nimmt consumption-Altzeilen weiter an (Regression)", async () => {
    const graph = await createProjectGraph("f1019 altzeile profil");
    await insertProfile(graph, graph.siteId, "consumption", baseProfile());
    const modes = await withTenantOn(testPool, graph.workspaceId, async (tx) => {
      const result = await tx.execute<{ input_mode: string }>(sql`
        select input_mode from site_energy_profile
      `);
      return result.rows.map((row) => row.input_mode);
    });
    expect(modes).toEqual(["consumption"]);
  });

  it("nimmt consumption-Minimalzeilen ohne Provenance-Quelle an", async () => {
    const graph = await createProjectGraph("f1019 minimal");
    await insertProfile(graph, graph.siteId, "consumption", {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      inputMode: "consumption",
      building: {},
      roofs: [{}],
      consumption: {},
      existingAssets: {},
      provenance: {},
    });
    const modes = await withTenantOn(testPool, graph.workspaceId, async (tx) => {
      const result = await tx.execute<{ input_mode: string }>(sql`
        select input_mode from site_energy_profile
      `);
      return result.rows.map((row) => row.input_mode);
    });
    expect(modes).toEqual(["consumption"]);
  });

  it("nimmt property, roomwise und manual mit Modusform an", async () => {
    const graph = await createProjectGraph("f1019 modi ok");
    const propertySite = await createSite(graph, "f1019 property");
    const roomwiseSite = await createSite(graph, "f1019 roomwise");
    const manualSite = await createSite(graph, "f1019 manual");
    await insertProfile(graph, propertySite, "property", baseProfile({
      inputMode: "property",
      propertyEstimate: { heatingType: "district_heating", residentCount: 3 },
    }));
    await insertProfile(graph, roomwiseSite, "roomwise", baseProfile({
      inputMode: "roomwise",
      rooms: [room("Wohnen", 24), room("Bad", 8, "bathroom", 1)],
    }));
    await insertProfile(graph, manualSite, "manual", baseProfile({
      inputMode: "manual",
      provenance: {
        ...(baseProfile({}).provenance as Record<string, unknown>),
        source: "operator_manual",
      },
    }));
    const modes = await withTenantOn(testPool, graph.workspaceId, async (tx) => {
      const result = await tx.execute<{ input_mode: string }>(sql`
        select input_mode from site_energy_profile order by input_mode
      `);
      return result.rows.map((row) => row.input_mode);
    });
    expect(modes).toEqual(["manual", "property", "roomwise"]);
  });

  it("verwirft einen fünften Modus an der Contract-CHECK", async () => {
    const graph = await createProjectGraph("f1019 modus reject");
    const siteId = await createSite(graph, "f1019 estimate");
    await expectPgRejection(
      insertProfile(graph, siteId, "estimate", baseProfile({ inputMode: "estimate" })),
    );
  });

  it("verwirft halb belegte Modusformen", async () => {
    const graph = await createProjectGraph("f1019 modus halb");
    const missing = await createSite(graph, "f1019 halb 1");
    await expectPgRejection(
      insertProfile(graph, missing, "property", baseProfile({ inputMode: "property" })),
    );
    const residents = await createSite(graph, "f1019 halb 2");
    await expectPgRejection(insertProfile(graph, residents, "property", baseProfile({
      inputMode: "property",
      propertyEstimate: { heatingType: "gas", residentCount: 0 },
    })));
    const heating = await createSite(graph, "f1019 halb 3");
    await expectPgRejection(insertProfile(graph, heating, "property", baseProfile({
      inputMode: "property",
      propertyEstimate: { heatingType: "kohle", residentCount: 2 },
    })));
    const emptyRooms = await createSite(graph, "f1019 halb 4");
    await expectPgRejection(insertProfile(graph, emptyRooms, "roomwise", baseProfile({
      inputMode: "roomwise",
      rooms: [],
    })));
    const manyRooms = await createSite(graph, "f1019 halb 5");
    const over = Array.from({ length: 41 }, (_, index) => room(`Raum ${index + 1}`, 10));
    await expectPgRejection(insertProfile(graph, manyRooms, "roomwise", baseProfile({
      inputMode: "roomwise",
      rooms: over,
    })));
  });

  it("verwirft modusfremde Sektionen und Provenance-Brüche", async () => {
    const graph = await createProjectGraph("f1019 modus kreuz");
    const foreign = await createSite(graph, "f1019 kreuz 1");
    await expectPgRejection(insertProfile(graph, foreign, "consumption", baseProfile({
      rooms: [room("Wohnen", 20)],
    })));
    const manualRechner = await createSite(graph, "f1019 kreuz 2");
    await expectPgRejection(
      insertProfile(graph, manualRechner, "manual", baseProfile({ inputMode: "manual" })),
    );
    const propertyManual = await createSite(graph, "f1019 kreuz 3");
    await expectPgRejection(insertProfile(graph, propertyManual, "property", baseProfile({
      inputMode: "property",
      propertyEstimate: { heatingType: "oil", residentCount: 2 },
      provenance: {
        ...(baseProfile({}).provenance as Record<string, unknown>),
        source: "operator_manual",
      },
    })));
  });
});

describe.runIf(has0232Checks)("F1-19 DB: Anforderungs-CHECKs mit Paket-Matrix", () => {
  it("nimmt Paket-Revisionen an und behält Altzeilen (Regression)", async () => {
    const graph = await createProjectGraph("f1019 pakete ok");
    await insertRequirement(graph, 2, baseRequirements({
      requestedPackages: {
        solar: { wanted: true, paymentKind: "purchase" },
        storage: { wanted: false, paymentKind: null },
        wallbox: { wanted: true, paymentKind: "leasing" },
        heating: { wanted: false, paymentKind: null },
      },
    }));
    const rows = await withTenantOn(testPool, graph.workspaceId, async (tx) => {
      const result = await tx.execute<{ revision: number; packages: unknown }>(sql`
        select revision, requirements->'requestedPackages' as packages
          from project_requirement
         where project_id = ${graph.projectId}::uuid
         order by revision
      `);
      return result.rows;
    });
    expect(rows.map((row) => row.revision)).toEqual([1, 2]);
    expect(rows[0]?.packages).toBeNull();
    expect(rows[1]?.packages).toMatchObject({ solar: { wanted: true, paymentKind: "purchase" } });
  });

  it("verwirft offene Schlüssel, falsche Zahlarten und Entkopplung", async () => {
    const graph = await createProjectGraph("f1019 pakete reject");
    await expectPgRejection(insertRequirement(graph, 2, baseRequirements({
      requestedPackages: {
        solar: { wanted: true, paymentKind: "purchase" },
      },
    })));
    await expectPgRejection(insertRequirement(graph, 2, baseRequirements({
      requestedPackages: { ...unsetPackages(), carport: { wanted: false, paymentKind: null } },
    })));
    await expectPgRejection(insertRequirement(graph, 2, baseRequirements({
      requestedPackages: {
        ...unsetPackages(),
        heating: { wanted: true, paymentKind: "miete" },
      },
    })));
    await expectPgRejection(insertRequirement(graph, 2, baseRequirements({
      requestedPackages: {
        ...unsetPackages(),
        solar: { wanted: true, paymentKind: null },
      },
    })));
    await expectPgRejection(insertRequirement(graph, 2, baseRequirements({
      requestedPackages: {
        ...unsetPackages(),
        wallbox: { wanted: false, paymentKind: "leasing" },
      },
    })));
  });
});
