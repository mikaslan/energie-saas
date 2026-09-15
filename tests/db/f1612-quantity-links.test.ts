import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  OFFER_CREATE_COMMAND_VERSION,
  OFFER_VARIANT_REVISE_COMMAND_VERSION,
  type CreateOfferCommandV1,
  type ReviseOfferVariantOperationV1,
} from "@/lib/integrations/offers/contract";
import {
  createOfferFromRequest,
  OfferValidationError,
  reviseOfferVariant,
} from "@/modules/offers";
import { seedM201ReadyProject } from "../e2e/m2-01-fixture";
import { testPool } from "../setup/test-db";

/**
 * F16-12 Mengenverknüpfung („Linked amounts", Katalog F16.2).
 * Freie Zeilen folgen einer Quellzeile mal Faktor (Revise-Ops mit
 * Revisions-CAS); verknüpfte Mengen sind abgeleitet (fail-closed),
 * Kaskaden laufen transitiv, Zyklen/Verwaiste/ Self-Links werden
 * abgewiesen. Ohne Migration — quantityLink ist optional, linklose
 * Snapshots bleiben byte-identisch.
 */

type Members = { workspaceId: string; operatorId: string };

async function createMembers(): Promise<Members> {
  const members = { workspaceId: randomUUID(), operatorId: randomUUID() };
  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${members.workspaceId}::uuid, 'F16-12 Mengenverknuepfung')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${members.operatorId}::uuid, ${`${members.operatorId}@f1612.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (
        ${members.workspaceId}::uuid, ${members.operatorId}::uuid, 'editor',
        '{"manage_catalog":true,"edit_prices":true,"convert_phase":true,
           "discounts":true,"see_purchase_prices":true}'::jsonb
      )
    `);
  });
  return members;
}

function offerCreateCommand(projectId: string): CreateOfferCommandV1 {
  return {
    schemaVersion: OFFER_CREATE_COMMAND_VERSION,
    projectId,
    expectedRequirementRevision: 1,
    expectedCalculationRevision: 1,
    expectedResolutionRevision: 1,
    forecastValueNetCents: 1_250_000,
    priceAudience: "b2c",
    priceAudienceConfirmation: { code: "b2c_operator_confirmed", confirmed: true },
    taxTreatment: "standard_19",
  };
}

type LinkedOffer = {
  members: Members;
  offerId: string;
  variantId: string;
  catalogLineId: string;
};

async function createLinkedOffer(): Promise<LinkedOffer> {
  const members = await createMembers();
  const databaseUrl = process.env.POSTGRES_URL_TEST;
  if (!databaseUrl) throw new Error("POSTGRES_URL_TEST fehlt.");
  const seed = await seedM201ReadyProject(databaseUrl, {
    workspaceId: members.workspaceId,
    editorIdentityId: members.operatorId,
    skuSuffix: `F1612-${randomUUID().slice(0, 8)}`,
  });
  const created = await withAuthorizedTenantOn(
    testPool, members.operatorId, members.workspaceId,
    (tx, ctx) => createOfferFromRequest(tx, ctx, offerCreateCommand(seed.projectId)),
  );
  const sections = await readSections(members.workspaceId, created.offerId, created.variantId, 1);
  const catalogLineId = sections.flatMap((section) => section.lines)
    .find((line) => line.source.kind === "catalog")?.lineDomainId;
  if (!catalogLineId) throw new Error("Seed-Angebot ohne Katalogzeile.");
  return { members, offerId: created.offerId, variantId: created.variantId, catalogLineId };
}

type SnapshotLine = {
  lineDomainId: string;
  quantityMilli: number;
  product: { kind: string; displayName?: string };
  source: { kind: string };
  quantityLink?: { sourceLineDomainId: string; factorMilli: number };
};

async function readSections(
  workspaceId: string,
  offerId: string,
  variantId: string,
  revision: number,
): Promise<Array<{ sectionDomainId: string; lines: SnapshotLine[] }>> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<{ sections: unknown }>(sql`
      select revision_snapshot -> 'sections' as sections
        from offer_variant_revision
       where workspace_id = ${workspaceId}::uuid
         and offer_id = ${offerId}::uuid
         and variant_id = ${variantId}::uuid
         and revision = ${revision}
    `);
    const row = result.rows[0];
    if (!row) throw new Error(`revision ${revision} not found`);
    return row.sections as Array<{ sectionDomainId: string; lines: SnapshotLine[] }>;
  });
}

async function readRawSnapshot(
  workspaceId: string,
  offerId: string,
  variantId: string,
  revision: number,
): Promise<string> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<{ snapshot: unknown }>(sql`
      select revision_snapshot as snapshot
        from offer_variant_revision
       where workspace_id = ${workspaceId}::uuid
         and offer_id = ${offerId}::uuid
         and variant_id = ${variantId}::uuid
         and revision = ${revision}
    `);
    const row = result.rows[0];
    if (!row) throw new Error(`revision ${revision} not found`);
    return JSON.stringify(row.snapshot);
  });
}

function findLine(sections: Array<{ lines: SnapshotLine[] }>, lineDomainId: string): SnapshotLine {
  const line = sections.flatMap((section) => section.lines)
    .find((entry) => entry.lineDomainId === lineDomainId);
  if (!line) throw new Error(`line ${lineDomainId} not found`);
  return line;
}

async function revise(
  offer: LinkedOffer,
  expectedRevision: number,
  operations: ReviseOfferVariantOperationV1[],
): Promise<number> {
  const result = await withAuthorizedTenantOn(
    testPool, offer.members.operatorId, offer.members.workspaceId,
    (tx, ctx) => reviseOfferVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
      offerId: offer.offerId,
      variantId: offer.variantId,
      expectedRevision,
      operations,
    }),
  );
  return result.revision;
}

function customLine(
  lineDomainId: string,
  sectionDomainId: string,
  displayName: string,
  quantityMilli: number,
): ReviseOfferVariantOperationV1 {
  return {
    operation: "add_custom_line",
    lineDomainId,
    sectionDomainId,
    position: 1,
    displayName,
    description: null,
    unit: "piece",
    quantityMilli,
    salesUnitNetCents: 5_000,
    purchaseUnitNetCents: 4_000,
    positionType: "required",
    isHidden: false,
    taxTreatment: "standard_19",
  };
}

async function addSourceAndDependent(offer: LinkedOffer): Promise<{
  sectionDomainId: string;
  sourceId: string;
  dependentId: string;
  revision: number;
}> {
  const sectionDomainId = randomUUID();
  const sourceId = randomUUID();
  const dependentId = randomUUID();
  const revision = await revise(offer, 1, [
    {
      operation: "add_custom_section",
      sectionDomainId,
      position: 1,
      title: "Freie Verknüpfungssektion",
      category: "other",
    },
    customLine(sourceId, sectionDomainId, "F1612 Quellmodule", 10_000),
    customLine(dependentId, sectionDomainId, "F1612 Kabelsatz", 1_000),
  ]);
  return { sectionDomainId, sourceId, dependentId, revision };
}

describe("F16-12 Mengenverknüpfung (PostgreSQL)", () => {
  it("F1612-DB-01: Link setzen leitet Menge ab (Quelle × Faktor)", async () => {
    const offer = await createLinkedOffer();
    const { sourceId, dependentId, revision } = await addSourceAndDependent(offer);

    const linked = await revise(offer, revision, [{
      operation: "set_line_quantity_link",
      lineDomainId: dependentId,
      sourceLineDomainId: sourceId,
      factorMilli: 2_500,
    }]);
    expect(linked).toBe(revision + 1);

    const sections = await readSections(offer.members.workspaceId, offer.offerId, offer.variantId, linked);
    const dependent = findLine(sections, dependentId);
    expect(dependent.quantityMilli).toBe(25_000);
    expect(dependent.quantityLink).toEqual({ sourceLineDomainId: sourceId, factorMilli: 2_500 });
  });

  it("F1612-DB-02: Quelländerung kaskadiert in derselben Revision", async () => {
    const offer = await createLinkedOffer();
    const { sourceId, dependentId, revision } = await addSourceAndDependent(offer);
    const linked = await revise(offer, revision, [{
      operation: "set_line_quantity_link",
      lineDomainId: dependentId,
      sourceLineDomainId: sourceId,
      factorMilli: 2_500,
    }]);

    const cascaded = await revise(offer, linked, [{
      operation: "set_line_quantity",
      lineDomainId: sourceId,
      quantityMilli: 12_000,
    }]);
    expect(cascaded).toBe(linked + 1);
    const sections = await readSections(offer.members.workspaceId, offer.offerId, offer.variantId, cascaded);
    expect(findLine(sections, sourceId).quantityMilli).toBe(12_000);
    expect(findLine(sections, dependentId).quantityMilli).toBe(30_000);
  });

  it("F1612-DB-03: transitive Kette folgt der Wurzel", async () => {
    const offer = await createLinkedOffer();
    const sectionDomainId = randomUUID();
    const rootId = randomUUID();
    const midId = randomUUID();
    const leafId = randomUUID();
    let revision = await revise(offer, 1, [
      {
        operation: "add_custom_section",
        sectionDomainId,
        position: 1,
        title: "F1612 Kette",
        category: "other",
      },
      customLine(rootId, sectionDomainId, "F1612 Wurzel", 4_000),
      customLine(midId, sectionDomainId, "F1612 Mitte", 1_000),
      customLine(leafId, sectionDomainId, "F1612 Blatt", 1_000),
    ]);
    revision = await revise(offer, revision, [{
      operation: "set_line_quantity_link",
      lineDomainId: midId,
      sourceLineDomainId: rootId,
      factorMilli: 3_000,
    }]);
    revision = await revise(offer, revision, [{
      operation: "set_line_quantity_link",
      lineDomainId: leafId,
      sourceLineDomainId: midId,
      factorMilli: 2_000,
    }]);
    const sections = await readSections(offer.members.workspaceId, offer.offerId, offer.variantId, revision);
    expect(findLine(sections, midId).quantityMilli).toBe(12_000);
    expect(findLine(sections, leafId).quantityMilli).toBe(24_000);

    const cascaded = await revise(offer, revision, [{
      operation: "set_line_quantity",
      lineDomainId: rootId,
      quantityMilli: 5_000,
    }]);
    const after = await readSections(offer.members.workspaceId, offer.offerId, offer.variantId, cascaded);
    expect(findLine(after, midId).quantityMilli).toBe(15_000);
    expect(findLine(after, leafId).quantityMilli).toBe(30_000);
  });

  it("F1612-DB-04: verknüpfte Menge, Self-Link, Zyklus und Katalogziel sind fail-closed", async () => {
    const offer = await createLinkedOffer();
    const { sourceId, dependentId, revision } = await addSourceAndDependent(offer);
    const linked = await revise(offer, revision, [{
      operation: "set_line_quantity_link",
      lineDomainId: dependentId,
      sourceLineDomainId: sourceId,
      factorMilli: 2_500,
    }]);

    // Manuelle Menge auf verknüpfter Zeile.
    await expect(revise(offer, linked, [{
      operation: "set_line_quantity",
      lineDomainId: dependentId,
      quantityMilli: 99_000,
    }])).rejects.toBeInstanceOf(OfferValidationError);

    // Self-Link.
    await expect(revise(offer, linked, [{
      operation: "set_line_quantity_link",
      lineDomainId: dependentId,
      sourceLineDomainId: dependentId,
      factorMilli: 1_000,
    }])).rejects.toBeInstanceOf(OfferValidationError);

    // Zyklus: Quelle folgt ihrer abhängigen Zeile.
    await expect(revise(offer, linked, [{
      operation: "set_line_quantity_link",
      lineDomainId: sourceId,
      sourceLineDomainId: dependentId,
      factorMilli: 1_000,
    }])).rejects.toBeInstanceOf(OfferValidationError);

    // Katalogzeile als Linkziel.
    await expect(revise(offer, linked, [{
      operation: "set_line_quantity_link",
      lineDomainId: offer.catalogLineId,
      sourceLineDomainId: sourceId,
      factorMilli: 1_000,
    }])).rejects.toBeInstanceOf(OfferValidationError);

    // Lösen ohne Verknüpfung.
    await expect(revise(offer, linked, [{
      operation: "clear_line_quantity_link",
      lineDomainId: sourceId,
    }])).rejects.toBeInstanceOf(OfferValidationError);

    // Quelle mit abhängiger Zeile löschen.
    await expect(revise(offer, linked, [{
      operation: "remove_custom_line",
      lineDomainId: sourceId,
    }])).rejects.toBeInstanceOf(OfferValidationError);

    // Fehlgeschlagene Befehle hinterlassen keine Revision.
    const sections = await readSections(offer.members.workspaceId, offer.offerId, offer.variantId, linked);
    expect(findLine(sections, dependentId).quantityMilli).toBe(25_000);
  });

  it("F1612-DB-05: Lösen erhält die Menge manuell; Quelle danach löschbar", async () => {
    const offer = await createLinkedOffer();
    const { sourceId, dependentId, revision } = await addSourceAndDependent(offer);
    const linked = await revise(offer, revision, [{
      operation: "set_line_quantity_link",
      lineDomainId: dependentId,
      sourceLineDomainId: sourceId,
      factorMilli: 2_500,
    }]);

    const cleared = await revise(offer, linked, [
      { operation: "clear_line_quantity_link", lineDomainId: dependentId },
      { operation: "set_line_quantity", lineDomainId: dependentId, quantityMilli: 7_000 },
    ]);
    const sections = await readSections(offer.members.workspaceId, offer.offerId, offer.variantId, cleared);
    const dependent = findLine(sections, dependentId);
    expect(dependent.quantityMilli).toBe(7_000);
    expect(dependent.quantityLink).toBeUndefined();

    const removed = await revise(offer, cleared, [{
      operation: "remove_custom_line",
      lineDomainId: sourceId,
    }]);
    const after = await readSections(offer.members.workspaceId, offer.offerId, offer.variantId, removed);
    expect(after.flatMap((section) => section.lines).some((line) => line.lineDomainId === sourceId)).toBe(false);
  });

  it("F1612-DB-06: linklose Snapshots schreiben keinen quantityLink-Key", async () => {
    const offer = await createLinkedOffer();
    const { dependentId, revision } = await addSourceAndDependent(offer);
    const raw = await readRawSnapshot(offer.members.workspaceId, offer.offerId, offer.variantId, revision);
    expect(raw).not.toContain("quantityLink");
    expect(raw).not.toContain("factorMilli");
    const sections = await readSections(offer.members.workspaceId, offer.offerId, offer.variantId, revision);
    expect(findLine(sections, dependentId).quantityLink).toBeUndefined();
  });
});
