import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withTenantOn } from "@/lib/db/tenant";
import type { ServiceCtx } from "@/lib/permissions";
import { PermissionDeniedError } from "@/lib/permissions";
import type {
  RechnerIntakeMeta,
  RechnerIntakeV1,
} from "@/lib/integrations/rechner/types";
import {
  RECHNER_INTAKE_PATH,
  sha256Hex,
  signatureMessage,
  verifyRechnerSignature,
  type VerifiedRechnerIdentity,
} from "@/lib/integrations/rechner/signature";
import { processRechnerIntake } from "@/modules/intake";
import {
  confirmProjectSitePin,
  correctProjectSiteAddress,
  getProjectAddressCorrectionContext,
  getProjectTriageDetail,
  SiteAddressCollisionError,
  SiteAddressConflictError,
  SiteAddressNotEditableError,
  SiteAddressSharedError,
  SitePinNotConfirmableError,
  SitePinOutOfRangeError,
} from "@/modules/projects";
import { testPool } from "../setup/test-db";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const EARTH_RADIUS_METERS = 6_371_008.8;
const GOLDEN = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/rechner-intake.v1.json"),
  "utf8",
)) as RechnerIntakeV1;

type LeadGraph = {
  receiptId: string;
  projectId: string;
  contactId: string;
  siteId: string;
  snapshotId: string;
  requirementId: string;
};

type PreservedGraph = {
  receipt_id: string;
  receipt_project_id: string;
  receipt_site_id: string;
  project_id: string;
  project_site_id: string;
  phase: string;
  outcome: string;
  column_id: string;
  snapshot_id: string;
  snapshot: unknown;
  requirement_id: string;
  requirements: unknown;
};

function editorCtx(workspaceId: string): ServiceCtx {
  return {
    workspaceId,
    actor: randomUUID(),
    role: "editor",
    capabilities: {},
    featureFlags: {},
  };
}

function viewerCtx(workspaceId: string): ServiceCtx {
  return { ...editorCtx(workspaceId), role: "viewer" };
}

function externalCtx(workspaceId: string): ServiceCtx {
  return {
    ...editorCtx(workspaceId),
    capabilities: { external_only: true },
  };
}

function verifiedIdentity(workspaceId: string): VerifiedRechnerIdentity {
  const keyId = `address-correction-${randomUUID()}`;
  const secret = Buffer.alloc(32, 17);
  const body = Buffer.from("{}", "utf8");
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const idempotencyKey = randomUUID();
  const contentSha256 = sha256Hex(body);
  const signature = createHmac("sha256", secret)
    .update(signatureMessage({
      method: "POST",
      path: RECHNER_INTAKE_PATH,
      keyId,
      timestamp,
      idempotencyKey,
      contentSha256,
    }))
    .digest("base64url");

  return verifyRechnerSignature({
    method: "POST",
    path: RECHNER_INTAKE_PATH,
    body,
    nowSeconds: Number(timestamp),
    credentialsJson: JSON.stringify([{
      keyId,
      workspaceId,
      scope: "rechner-intake.write",
      secretBase64: secret.toString("base64"),
    }]),
    headers: {
      keyId,
      timestamp,
      idempotencyKey,
      contentSha256,
      signature: `v1=${signature}`,
    },
  });
}

function payload(): RechnerIntakeV1 {
  const value = structuredClone(GOLDEN);
  value.submissionId = randomUUID();
  value.submittedAt = NOW.toISOString();
  value.calculation.calculatedAt = NOW.toISOString();
  return value;
}

function regionalPayload(): RechnerIntakeV1 {
  const value = payload();
  value.site = {
    addressMode: "regional_estimate",
    formattedAddress: "Region Rhein-Neckar",
    street: null,
    houseNumber: null,
    postalCode: null,
    city: null,
    countryCode: "DE",
    latitude: 49.4,
    longitude: 8.7,
    geocodeSource: "regional_default",
    precision: "region",
  };
  return value;
}

function meta(value: RechnerIntakeV1): RechnerIntakeMeta {
  return {
    payloadSha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    signedAt: NOW,
    receivedAt: NOW,
  };
}

function resolvedAddress(overrides: Partial<{
  placeId: string;
  formattedAddress: string;
  street: string;
  houseNumber: string;
  postalCode: string;
  city: string;
  latitude: number;
  longitude: number;
}> = {}) {
  return {
    provider: "geoapify" as const,
    placeId: overrides.placeId ?? `geoapify:${randomUUID()}`,
    formattedAddress: overrides.formattedAddress ?? "Mühlstraße 8, 69234 Dielheim",
    street: overrides.street ?? "Mühlstraße",
    houseNumber: overrides.houseNumber ?? "8",
    postalCode: overrides.postalCode ?? "69234",
    city: overrides.city ?? "Dielheim",
    countryCode: "DE" as const,
    latitude: overrides.latitude ?? 49.28463,
    longitude: overrides.longitude ?? 8.73821,
    precision: "house" as const,
  };
}

function pinNear(address: ReturnType<typeof resolvedAddress>) {
  return {
    latitude: address.latitude + 0.00005,
    longitude: address.longitude + 0.00005,
  };
}

function pinNorthAtDistance(
  address: ReturnType<typeof resolvedAddress>,
  meters: number,
) {
  return {
    latitude: address.latitude + (meters / EARTH_RADIUS_METERS) * (180 / Math.PI),
    longitude: address.longitude,
  };
}

async function createWorkspace(name = "Adresskorrektur Test"): Promise<string> {
  const workspaceId = randomUUID();
  await withTenantOn(testPool, workspaceId, (tx) => tx.execute(sql`
    insert into workspace (id, name)
    values (${workspaceId}::uuid, ${name})
  `));
  return workspaceId;
}

async function submit(
  workspaceId: string,
  value: RechnerIntakeV1,
): Promise<LeadGraph> {
  const receipt = await withTenantOn(testPool, workspaceId, (tx) =>
    processRechnerIntake(tx, verifiedIdentity(workspaceId), value, meta(value)));
  const graph = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
    receipt_id: string;
    project_id: string;
    contact_id: string;
    site_id: string;
    snapshot_id: string;
    requirement_id: string;
    [key: string]: unknown;
  }>(sql`
    select receipt.id as receipt_id, receipt.project_id, receipt.contact_id,
           receipt.site_id, snapshot.id as snapshot_id,
           requirement.id as requirement_id
    from inbound_receipt receipt
    join calculator_snapshot snapshot
      on snapshot.workspace_id = receipt.workspace_id
     and snapshot.receipt_id = receipt.id
    join project_requirement requirement
      on requirement.workspace_id = receipt.workspace_id
     and requirement.project_id = receipt.project_id
    where receipt.id = ${receipt.receiptId}::uuid
  `));
  const row = graph.rows[0];
  return {
    receiptId: row.receipt_id,
    projectId: row.project_id,
    contactId: row.contact_id,
    siteId: row.site_id,
    snapshotId: row.snapshot_id,
    requirementId: row.requirement_id,
  };
}

function createRegionalLead(workspaceId: string): Promise<LeadGraph> {
  return submit(workspaceId, regionalPayload());
}

async function addProjectSharingSite(
  workspaceId: string,
  graph: LeadGraph,
): Promise<string> {
  const sharedProjectId = randomUUID();
  await withTenantOn(testPool, workspaceId, (tx) => tx.execute(sql`
    insert into project (
      id, workspace_id, contact_id, site_id, kanban_board_id,
      kanban_column_id, name, phase, outcome, source_key,
      dedupe_review_required, catalog_resolution_status
    )
    select ${sharedProjectId}::uuid, workspace_id, contact_id, site_id,
           kanban_board_id, kanban_column_id, 'Geteiltes Site-Projekt',
           phase, outcome, source_key, dedupe_review_required,
           catalog_resolution_status
    from project
    where id = ${graph.projectId}::uuid
  `));
  return sharedProjectId;
}

async function preservedGraph(
  workspaceId: string,
  projectId: string,
): Promise<PreservedGraph> {
  const result = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<
    PreservedGraph & { [key: string]: unknown }
  >(sql`
    select receipt.id as receipt_id,
           receipt.project_id as receipt_project_id,
           receipt.site_id as receipt_site_id,
           project_row.id as project_id,
           project_row.site_id as project_site_id,
           project_row.phase,
           project_row.outcome,
           project_row.kanban_column_id as column_id,
           snapshot.id as snapshot_id,
           snapshot.snapshot,
           requirement.id as requirement_id,
           requirement.requirements
    from project project_row
    join inbound_receipt receipt
      on receipt.workspace_id = project_row.workspace_id
     and receipt.project_id = project_row.id
    join calculator_snapshot snapshot
      on snapshot.workspace_id = project_row.workspace_id
     and snapshot.project_id = project_row.id
    join project_requirement requirement
      on requirement.workspace_id = project_row.workspace_id
     and requirement.project_id = project_row.id
    where project_row.id = ${projectId}::uuid
  `));
  return result.rows[0];
}

async function correctRegionalLead(
  workspaceId: string,
  projectId: string,
  ctx = editorCtx(workspaceId),
  address = resolvedAddress(),
) {
  await withTenantOn(testPool, workspaceId, (tx) => correctProjectSiteAddress(
    tx,
    ctx,
    {
      projectId,
      expectedAddressRevision: 1,
      resolvedAddress: address,
      pin: pinNear(address),
    },
  ));
  return address;
}

describe("M1-06 Adresskorrektur", () => {
  it("liefert einen minimalen, schreibgeschützten Korrekturkontext", async () => {
    const workspaceId = await createWorkspace();
    const graph = await createRegionalLead(workspaceId);

    const context = await withTenantOn(testPool, workspaceId, (tx) =>
      getProjectAddressCorrectionContext(tx, editorCtx(workspaceId), graph.projectId));

    expect(context).toEqual({
      projectId: graph.projectId,
      siteId: graph.siteId,
      addressRevision: 1,
      editable: true,
    });
  });

  it("korrigiert eine regionale Site, erhoeht die Revision und laesst den Intake-Graph unveraendert", async () => {
    const workspaceId = await createWorkspace();
    const graph = await createRegionalLead(workspaceId);
    const before = await preservedGraph(workspaceId, graph.projectId);
    const address = resolvedAddress();
    const pin = pinNear(address);

    await withTenantOn(testPool, workspaceId, (tx) => correctProjectSiteAddress(
      tx,
      editorCtx(workspaceId),
      {
        projectId: graph.projectId,
        expectedAddressRevision: 1,
        resolvedAddress: address,
        pin,
      },
    ));

    expect(await preservedGraph(workspaceId, graph.projectId)).toEqual(before);
    const site = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      address_revision: number;
      address_mode: string;
      formatted_address: string;
      street: string;
      house_number: string;
      postal_code: string;
      city: string;
      country: string;
      geocode_source: string;
      geocode_place_id: string;
      geocode_precision: string;
      lat: number;
      lng: number;
      address_follow_up_required: boolean;
      pin_confirmed: boolean;
      pin_confirmed_address_revision: number | null;
      pin_adjusted: boolean;
      [key: string]: unknown;
    }>(sql`
      select address_revision, address_mode, formatted_address, street,
             house_number, postal_code, city, country, geocode_source,
             geocode_place_id, geocode_precision, lat, lng,
             address_follow_up_required, pin_confirmed,
             pin_confirmed_address_revision, pin_adjusted
      from site
      where id = ${graph.siteId}::uuid
    `));
    expect(site.rows[0]).toEqual({
      address_revision: 2,
      address_mode: "selected",
      formatted_address: address.formattedAddress,
      street: address.street,
      house_number: address.houseNumber,
      postal_code: address.postalCode,
      city: address.city,
      country: "DE",
      geocode_source: "geoapify",
      geocode_place_id: address.placeId,
      geocode_precision: "house",
      lat: pin.latitude,
      lng: pin.longitude,
      address_follow_up_required: false,
      pin_confirmed: false,
      pin_confirmed_address_revision: null,
      pin_adjusted: true,
    });
  });

  it("bindet die Pin-Bestaetigung an die Revision und bleibt beim Replay idempotent", async () => {
    const workspaceId = await createWorkspace();
    const graph = await createRegionalLead(workspaceId);
    await correctRegionalLead(workspaceId, graph.projectId);

    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      confirmProjectSitePin(tx, editorCtx(workspaceId), {
        projectId: graph.projectId,
        expectedAddressRevision: 1,
      }))).rejects.toBeInstanceOf(SiteAddressConflictError);

    await withTenantOn(testPool, workspaceId, (tx) =>
      confirmProjectSitePin(tx, editorCtx(workspaceId), {
        projectId: graph.projectId,
        expectedAddressRevision: 2,
      }));
    await withTenantOn(testPool, workspaceId, (tx) =>
      confirmProjectSitePin(tx, editorCtx(workspaceId), {
        projectId: graph.projectId,
        expectedAddressRevision: 2,
      }));

    const state = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      address_revision: number;
      pin_confirmed: boolean;
      pin_confirmed_address_revision: number | null;
      confirmation_events: number;
      confirmation_audits: number;
      [key: string]: unknown;
    }>(sql`
      select site_row.address_revision, site_row.pin_confirmed,
             site_row.pin_confirmed_address_revision,
        (select count(*)::int from domain_events event
          where event.aggregate_id = site_row.id
            and event.event_type = 'site.pin_confirmed') as confirmation_events,
        (select count(*)::int from audit_log audit
          where audit.action = 'project.write'
            and audit.resource = 'site_pin'
            and audit.allowed = true
            and audit.details->>'siteId' = site_row.id::text) as confirmation_audits
      from site site_row where site_row.id = ${graph.siteId}::uuid
    `));
    expect(state.rows[0]).toEqual({
      address_revision: 2,
      pin_confirmed: true,
      pin_confirmed_address_revision: 2,
      confirmation_events: 1,
      confirmation_audits: 1,
    });
  });

  it("liefert nach Korrektur und Bestaetigung denselben persistierten Stand an die Projektakte", async () => {
    const workspaceId = await createWorkspace();
    const graph = await createRegionalLead(workspaceId);
    const ctx = editorCtx(workspaceId);
    const address = await correctRegionalLead(workspaceId, graph.projectId, ctx);

    const corrected = await withTenantOn(testPool, workspaceId, (tx) =>
      getProjectTriageDetail(tx, ctx, graph.projectId));
    expect(corrected?.site).toMatchObject({
      id: graph.siteId,
      formattedAddress: address.formattedAddress,
      addressMode: "selected",
      precision: "house",
      geocodeSource: "geoapify",
      addressRevision: 2,
      pinConfirmed: false,
      pinAdjusted: true,
    });
    expect(corrected?.blockers).toMatchObject({
      addressFollowUpRequired: false,
      pinConfirmationRequired: true,
    });
    expect(corrected?.permissions).toMatchObject({
      canCorrectAddress: false,
      canConfirmPin: true,
    });

    await withTenantOn(testPool, workspaceId, (tx) =>
      confirmProjectSitePin(tx, ctx, {
        projectId: graph.projectId,
        expectedAddressRevision: 2,
      }));
    const confirmed = await withTenantOn(testPool, workspaceId, (tx) =>
      getProjectTriageDetail(tx, ctx, graph.projectId));
    expect(confirmed?.site).toMatchObject({
      addressRevision: 2,
      pinConfirmed: true,
    });
    expect(confirmed?.blockers.pinConfirmationRequired).toBe(false);
    expect(confirmed?.permissions.canConfirmPin).toBe(false);
  });

  it("verweigert Kontext und Mutation fuer Viewer und external_only fail-closed", async () => {
    const workspaceId = await createWorkspace();
    const graph = await createRegionalLead(workspaceId);
    const address = resolvedAddress();
    const input = {
      projectId: graph.projectId,
      expectedAddressRevision: 1,
      resolvedAddress: address,
      pin: pinNear(address),
    };

    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      getProjectAddressCorrectionContext(tx, viewerCtx(workspaceId), graph.projectId)))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      correctProjectSiteAddress(tx, viewerCtx(workspaceId), input)))
      .rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      getProjectAddressCorrectionContext(tx, externalCtx(workspaceId), graph.projectId)))
      .rejects.toMatchObject({
        name: "PermissionDeniedError",
        reason: "external_only_without_assignment",
      });
    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      correctProjectSiteAddress(tx, externalCtx(workspaceId), input)))
      .rejects.toMatchObject({
        name: "PermissionDeniedError",
        reason: "external_only_without_assignment",
      });
  });

  it("liefert fuer einen fremden Tenant keine Projektdaten und mutiert nichts", async () => {
    const ownerWorkspaceId = await createWorkspace("Eigentuemer");
    const foreignWorkspaceId = await createWorkspace("Fremder Workspace");
    const graph = await createRegionalLead(ownerWorkspaceId);
    const address = resolvedAddress();

    const context = await withTenantOn(testPool, foreignWorkspaceId, (tx) =>
      getProjectAddressCorrectionContext(tx, editorCtx(foreignWorkspaceId), graph.projectId));
    expect(context).toBeNull();
    await expect(withTenantOn(testPool, foreignWorkspaceId, (tx) =>
      correctProjectSiteAddress(tx, editorCtx(foreignWorkspaceId), {
        projectId: graph.projectId,
        expectedAddressRevision: 1,
        resolvedAddress: address,
        pin: pinNear(address),
      }))).rejects.toBeInstanceOf(SiteAddressNotEditableError);

    const ownerState = await withTenantOn(testPool, ownerWorkspaceId, (tx) => tx.execute<{
      address_mode: string;
      address_revision: number;
      [key: string]: unknown;
    }>(sql`
      select address_mode, address_revision
      from site where id = ${graph.siteId}::uuid
    `));
    expect(ownerState.rows[0]).toEqual({
      address_mode: "regional_estimate",
      address_revision: 1,
    });
  });

  it("weist eine stale expectedAddressRevision ohne zweiten Seiteneffekt zurueck", async () => {
    const workspaceId = await createWorkspace();
    const graph = await createRegionalLead(workspaceId);
    const first = resolvedAddress();
    await correctRegionalLead(workspaceId, graph.projectId, editorCtx(workspaceId), first);
    const second = resolvedAddress({
      placeId: `geoapify:${randomUUID()}`,
      formattedAddress: "Mühlstraße 10, 69234 Dielheim",
      houseNumber: "10",
    });

    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      correctProjectSiteAddress(tx, editorCtx(workspaceId), {
        projectId: graph.projectId,
        expectedAddressRevision: 1,
        resolvedAddress: second,
        pin: pinNear(second),
      }))).rejects.toBeInstanceOf(SiteAddressConflictError);

    const state = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      address_revision: number;
      house_number: string;
      correction_events: number;
      [key: string]: unknown;
    }>(sql`
      select site_row.address_revision, site_row.house_number,
        (select count(*)::int from domain_events event
          where event.aggregate_id = site_row.id
            and event.event_type = 'site.address_corrected') as correction_events
      from site site_row where site_row.id = ${graph.siteId}::uuid
    `));
    expect(state.rows[0]).toEqual({
      address_revision: 2,
      house_number: first.houseNumber,
      correction_events: 1,
    });
  });

  it("laesst eine bereits exakte Site nicht ueber den Regional-Korrekturpfad umschreiben", async () => {
    const workspaceId = await createWorkspace();
    const graph = await submit(workspaceId, payload());
    const context = await withTenantOn(testPool, workspaceId, (tx) =>
      getProjectAddressCorrectionContext(tx, editorCtx(workspaceId), graph.projectId));
    expect(context).toEqual({
      projectId: graph.projectId,
      siteId: graph.siteId,
      addressRevision: 1,
      editable: false,
    });
    const different = resolvedAddress({
      formattedAddress: "Mühlstraße 10, 69234 Dielheim",
      houseNumber: "10",
    });

    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      correctProjectSiteAddress(tx, editorCtx(workspaceId), {
        projectId: graph.projectId,
        expectedAddressRevision: 1,
        resolvedAddress: different,
        pin: pinNear(different),
      }))).rejects.toBeInstanceOf(SiteAddressNotEditableError);
  });

  it("lehnt eine von mehreren Projekten geteilte Site ohne Seiteneffekt ab", async () => {
    const workspaceId = await createWorkspace();
    const graph = await createRegionalLead(workspaceId);
    const sharedProjectId = await addProjectSharingSite(workspaceId, graph);
    const before = await preservedGraph(workspaceId, graph.projectId);
    const address = resolvedAddress();

    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      correctProjectSiteAddress(tx, editorCtx(workspaceId), {
        projectId: graph.projectId,
        expectedAddressRevision: 1,
        resolvedAddress: address,
        pin: pinNear(address),
      }))).rejects.toBeInstanceOf(SiteAddressSharedError);

    expect(await preservedGraph(workspaceId, graph.projectId)).toEqual(before);
    const state = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      address_revision: number;
      address_mode: string;
      referencing_projects: number;
      correction_events: number;
      correction_audits: number;
      [key: string]: unknown;
    }>(sql`
      select site_row.address_revision, site_row.address_mode,
        (select count(*)::int from project project_row
          where project_row.site_id = site_row.id) as referencing_projects,
        (select count(*)::int from domain_events event
          where event.aggregate_id = site_row.id
            and event.event_type = 'site.address_corrected') as correction_events,
        (select count(*)::int from audit_log audit
          where audit.action = 'project.write'
            and audit.resource = 'site_address'
            and audit.allowed = true
            and audit.details->>'siteId' = site_row.id::text) as correction_audits
      from site site_row where site_row.id = ${graph.siteId}::uuid
    `));
    expect(state.rows[0]).toEqual({
      address_revision: 1,
      address_mode: "regional_estimate",
      referencing_projects: 2,
      correction_events: 0,
      correction_audits: 0,
    });
    expect(sharedProjectId).not.toBe(graph.projectId);
  });

  it.each([
    { distanceMeters: 0, pinAdjusted: false },
    { distanceMeters: 0.5, pinAdjusted: false },
    { distanceMeters: 0.51, pinAdjusted: true },
    { distanceMeters: 150, pinAdjusted: true },
  ])(
    "akzeptiert $distanceMeters m und setzt pin_adjusted=$pinAdjusted reproduzierbar",
    async ({ distanceMeters, pinAdjusted }) => {
      const workspaceId = await createWorkspace();
      const graph = await createRegionalLead(workspaceId);
      const address = resolvedAddress();
      const pin = pinNorthAtDistance(address, distanceMeters);

      await withTenantOn(testPool, workspaceId, (tx) => correctProjectSiteAddress(
        tx,
        editorCtx(workspaceId),
        {
          projectId: graph.projectId,
          expectedAddressRevision: 1,
          resolvedAddress: address,
          pin,
        },
      ));

      const state = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
        address_revision: number;
        pin_adjusted: boolean;
        lat: number;
        lng: number;
        [key: string]: unknown;
      }>(sql`
        select address_revision, pin_adjusted, lat, lng
        from site where id = ${graph.siteId}::uuid
      `));
      expect(state.rows[0]).toMatchObject({
        address_revision: 2,
        pin_adjusted: pinAdjusted,
      });
      expect(state.rows[0].lat).toBeCloseTo(pin.latitude, 10);
      expect(state.rows[0].lng).toBeCloseTo(pin.longitude, 10);
    },
  );

  it("weist einen Pin knapp jenseits der inklusiven 150-Meter-Grenze zurueck", async () => {
    const workspaceId = await createWorkspace();
    const graph = await createRegionalLead(workspaceId);
    const address = resolvedAddress();

    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      correctProjectSiteAddress(tx, editorCtx(workspaceId), {
        projectId: graph.projectId,
        expectedAddressRevision: 1,
        resolvedAddress: address,
        pin: pinNorthAtDistance(address, 150.01),
      }))).rejects.toBeInstanceOf(SitePinOutOfRangeError);

    const state = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      address_revision: number;
      address_mode: string;
      [key: string]: unknown;
    }>(sql`
      select address_revision, address_mode
      from site where id = ${graph.siteId}::uuid
    `));
    expect(state.rows[0]).toEqual({
      address_revision: 1,
      address_mode: "regional_estimate",
    });
  });

  it("weist eine gleiche contactgebundene Adress-Fingerprint-Kollision bewusst zurueck", async () => {
    const workspaceId = await createWorkspace();
    const exact = await submit(workspaceId, payload());
    const regional = await createRegionalLead(workspaceId);
    expect(regional.contactId).toBe(exact.contactId);
    expect(regional.siteId).not.toBe(exact.siteId);
    const duplicate = resolvedAddress({
      formattedAddress: GOLDEN.site.formattedAddress,
      street: GOLDEN.site.street!,
      houseNumber: GOLDEN.site.houseNumber!,
      postalCode: GOLDEN.site.postalCode!,
      city: GOLDEN.site.city!,
      latitude: GOLDEN.site.latitude,
      longitude: GOLDEN.site.longitude,
    });

    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      correctProjectSiteAddress(tx, editorCtx(workspaceId), {
        projectId: regional.projectId,
        expectedAddressRevision: 1,
        resolvedAddress: duplicate,
        pin: pinNear(duplicate),
      }))).rejects.toBeInstanceOf(SiteAddressCollisionError);

    const state = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      address_revision: number;
      address_mode: string;
      [key: string]: unknown;
    }>(sql`
      select address_revision, address_mode
      from site where id = ${regional.siteId}::uuid
    `));
    expect(state.rows[0]).toEqual({
      address_revision: 1,
      address_mode: "regional_estimate",
    });
  });

  it("schreibt genau ein PII-freies Korrektur-Event und einen atomaren Erfolgs-Audit", async () => {
    const workspaceId = await createWorkspace();
    const graph = await createRegionalLead(workspaceId);
    const address = resolvedAddress();
    const pin = pinNear(address);

    await withTenantOn(testPool, workspaceId, (tx) => correctProjectSiteAddress(
      tx,
      editorCtx(workspaceId),
      {
        projectId: graph.projectId,
        expectedAddressRevision: 1,
        resolvedAddress: address,
        pin,
      },
    ));

    const records = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      kind: string;
      value: string;
      [key: string]: unknown;
    }>(sql`
      select event.event_type as kind, event.payload::text as value
      from domain_events event
      where event.aggregate_id = ${graph.siteId}::uuid
        and event.event_type = 'site.address_corrected'
      union all
      select audit.resource as kind, audit.details::text as value
      from audit_log audit
      where audit.action = 'project.write'
        and audit.resource = 'site_address'
        and audit.allowed = true
        and audit.details->>'siteId' = ${graph.siteId}
    `));
    expect(records.rows.map((row) => row.kind).sort()).toEqual([
      "site.address_corrected",
      "site_address",
    ]);
    const serialized = records.rows.map((row) => row.value).join("\n");
    for (const forbidden of [
      address.placeId,
      address.formattedAddress,
      address.street,
      address.postalCode,
      address.city,
      GOLDEN.customer.displayName,
      GOLDEN.customer.email,
      GOLDEN.customer.phoneRaw,
      String(address.latitude),
      String(address.longitude),
      String(pin.latitude),
      String(pin.longitude),
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const forbiddenJson of [
      `"houseNumber":"${address.houseNumber}"`,
      `"house_number":"${address.houseNumber}"`,
    ]) {
      expect(serialized).not.toContain(forbiddenJson);
    }
    expect(serialized).toContain(graph.projectId);
    expect(serialized).toContain(graph.siteId);
  });

  it("serialisiert parallele Contact/Fingerprint-Kollisionen auf genau einen Gewinner", async () => {
    const workspaceId = await createWorkspace();
    const first = await createRegionalLead(workspaceId);
    const second = await createRegionalLead(workspaceId);
    expect(second.contactId).toBe(first.contactId);
    expect(second.siteId).not.toBe(first.siteId);
    const address = resolvedAddress();
    const ctx = editorCtx(workspaceId);
    const attempt = (graph: LeadGraph) =>
      withTenantOn(testPool, workspaceId, (tx) => correctProjectSiteAddress(tx, ctx, {
        projectId: graph.projectId,
        expectedAddressRevision: 1,
        resolvedAddress: address,
        pin: pinNear(address),
      }));

    const outcomes = await Promise.allSettled([attempt(first), attempt(second)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(SiteAddressCollisionError);

    const state = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      winners: number;
      losers: number;
      correction_events: number;
      correction_audits: number;
      [key: string]: unknown;
    }>(sql`
      select
        count(*) filter (
          where site_row.address_revision = 2
            and site_row.address_mode = 'selected'
        )::int as winners,
        count(*) filter (
          where site_row.address_revision = 1
            and site_row.address_mode = 'regional_estimate'
        )::int as losers,
        (select count(*)::int from domain_events event
          where event.aggregate_id in (${first.siteId}::uuid, ${second.siteId}::uuid)
            and event.event_type = 'site.address_corrected') as correction_events,
        (select count(*)::int from audit_log audit
          where audit.action = 'project.write'
            and audit.resource = 'site_address'
            and audit.allowed = true
            and audit.details->>'siteId' in (${first.siteId}, ${second.siteId}))
          as correction_audits
      from site site_row
      where site_row.id in (${first.siteId}::uuid, ${second.siteId}::uuid)
    `));
    expect(state.rows[0]).toEqual({
      winners: 1,
      losers: 1,
      correction_events: 1,
      correction_audits: 1,
    });
  });
});

describe("M1-06 Pin-/Revisionsconstraints in PostgreSQL", () => {
  it("erzwingt bestaetigten Pin, aktuelle Revision und selected/house gemeinsam", async () => {
    const workspaceId = await createWorkspace();
    const graph = await createRegionalLead(workspaceId);
    await correctRegionalLead(workspaceId, graph.projectId);
    await withTenantOn(testPool, workspaceId, (tx) =>
      confirmProjectSitePin(tx, editorCtx(workspaceId), {
        projectId: graph.projectId,
        expectedAddressRevision: 2,
      }));

    await expect(withTenantOn(testPool, workspaceId, (tx) => tx.execute(sql`
      update site
      set pin_confirmed_address_revision = null
      where id = ${graph.siteId}::uuid
    `))).rejects.toThrow();
    await expect(withTenantOn(testPool, workspaceId, (tx) => tx.execute(sql`
      update site
      set pin_confirmed_address_revision = address_revision - 1
      where id = ${graph.siteId}::uuid
    `))).rejects.toThrow();
    await expect(withTenantOn(testPool, workspaceId, (tx) => tx.execute(sql`
      update site
      set address_revision = address_revision + 1
      where id = ${graph.siteId}::uuid
    `))).rejects.toThrow();
    await expect(withTenantOn(testPool, workspaceId, (tx) => tx.execute(sql`
      update site
      set pin_confirmed = false
      where id = ${graph.siteId}::uuid
    `))).rejects.toThrow();
    await expect(withTenantOn(testPool, workspaceId, (tx) => tx.execute(sql`
      update site
      set geocode_precision = 'street'
      where id = ${graph.siteId}::uuid
    `))).rejects.toThrow();
    await expect(withTenantOn(testPool, workspaceId, (tx) => tx.execute(sql`
      update site
      set address_mode = 'regional_estimate',
          street = null,
          house_number = null,
          postal_code = null,
          city = null,
          address_fingerprint = null,
          address_fingerprint_version = null,
          geocode_source = 'regional_default',
          geocode_place_id = null,
          geocode_precision = 'region',
          address_follow_up_required = true
      where id = ${graph.siteId}::uuid
    `))).rejects.toThrow();
  });

  it("laesst eine Pin-Bestaetigung bei ungeeigneter Site weiterhin fachlich scheitern", async () => {
    const workspaceId = await createWorkspace();
    const graph = await createRegionalLead(workspaceId);

    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      confirmProjectSitePin(tx, editorCtx(workspaceId), {
        projectId: graph.projectId,
        expectedAddressRevision: 1,
      }))).rejects.toBeInstanceOf(SitePinNotConfirmableError);
  });
});
