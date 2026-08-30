import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import {
  CatalogOfferBridgeIntegrityError,
  readCurrentProjectCatalogBasisReference,
  readCurrentProjectCatalogForOfferCopy,
  readOfferCatalogFreshness,
} from "@/modules/catalog";

function poisonTx() {
  const execute = vi.fn(async () => {
    throw new Error("Poison-Tx darf vor Autorisierung/Validierung nie laufen");
  });
  return { tx: { execute } as unknown as TenantTx, execute };
}

function context(input: Partial<ServiceCtx> = {}): ServiceCtx {
  return {
    workspaceId: randomUUID(),
    actor: randomUUID(),
    role: "admin",
    capabilities: {},
    featureFlags: {},
    ...input,
  };
}

describe("M2-01 enger Katalogexport fuer Angebote", () => {
  it("weist External bei Freshness und Copy fail-closed vor Parsing und SQL ab", async () => {
    const { tx, execute } = poisonTx();
    const external = context({
      capabilities: { external_only: true },
    });

    await expect(readOfferCatalogFreshness(tx, external, "ungueltig"))
      .rejects.toMatchObject({
        name: "PermissionDeniedError",
        action: "project.read",
        reason: "external_only_without_assignment",
      });
    await expect(readCurrentProjectCatalogForOfferCopy(tx, external, "ungueltig"))
      .rejects.toMatchObject({
        name: "PermissionDeniedError",
        action: "project.write",
        reason: "external_only_without_assignment",
      });
    await expect(readCurrentProjectCatalogBasisReference(tx, external, "ungueltig"))
      .rejects.toMatchObject({
        name: "PermissionDeniedError",
        action: "project.write",
        reason: "external_only_without_assignment",
      });
    expect(execute).not.toHaveBeenCalled();
  });

  it("erzwingt price.edit fuer Copy und mappt ungueltige interne Daten als Integrity", async () => {
    const { tx, execute } = poisonTx();
    const editorWithoutPrice = context({
      role: "editor",
      capabilities: {},
    });
    await expect(readCurrentProjectCatalogForOfferCopy(
      tx,
      editorWithoutPrice,
      "ungueltig",
    )).rejects.toMatchObject({
      name: "PermissionDeniedError",
      action: "price.edit",
    });
    await expect(readCurrentProjectCatalogBasisReference(
      tx,
      editorWithoutPrice,
      randomUUID(),
    )).rejects.toMatchObject({
      name: "PermissionDeniedError",
      action: "price.edit",
    });
    await expect(readCurrentProjectCatalogForOfferCopy(
      tx,
      context(),
      "ungueltig",
    )).rejects.toBeInstanceOf(CatalogOfferBridgeIntegrityError);
    await expect(readCurrentProjectCatalogBasisReference(tx, context(), "ungueltig"))
      .rejects.toBeInstanceOf(CatalogOfferBridgeIntegrityError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("haelt Katalogtabellen und die Project-zu-Component-Lockkante aus dem Offer-Modul", async () => {
    const [offerSource, bridgeSource] = await Promise.all([
      readFile("modules/offers/service.ts", "utf8"),
      readFile("modules/catalog/offer-copy.ts", "utf8"),
    ]);
    expect(offerSource).not.toMatch(/from\s+project_catalog_resolution\b/iu);
    expect(offerSource).not.toMatch(/from\s+project_catalog_resolution_line\b/iu);
    expect(offerSource).not.toMatch(/join\s+catalog_component\b/iu);
    expect(offerSource).not.toContain("@/lib/integrations/catalog/contract");
    expect(offerSource).toContain("readCurrentProjectCatalogForOfferCopy");
    expect(offerSource).toContain("readCurrentProjectCatalogBasisReference");
    expect(offerSource).toContain("readOfferCatalogFreshness");

    expect(bridgeSource).toMatch(/^import "server-only";/u);
    const componentRead = bridgeSource.slice(
      bridgeSource.indexOf("const states = await tx.execute"),
      bridgeSource.indexOf("export async function readOfferCatalogFreshness"),
    );
    expect(componentRead).toContain("left join catalog_component component");
    expect(componentRead).not.toMatch(/for\s+(?:update|share)/iu);
  });
});
