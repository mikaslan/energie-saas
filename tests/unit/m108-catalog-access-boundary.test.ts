import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import {
  activateCatalogComponent,
  archiveCatalogComponent,
  createCatalogComponent,
  getCatalogComponent,
  getProjectCatalogResolutionContext,
  listCatalogComponents,
  resolveProjectCatalog,
  returnCatalogComponentToDraft,
  reviseCatalogComponentDetails,
  reviseCatalogComponentPricing,
  searchActiveProjectCatalogComponents,
} from "@/modules/catalog";

describe("M1-08 external-only Kataloggrenze", () => {
  it("weist jeden öffentlichen Pfad vor Parsing und SQL fail-closed ab", async () => {
    let sqlCalls = 0;
    const tx = {
      execute: async () => {
        sqlCalls += 1;
        throw new Error("Poison-Tx darf nie erreicht werden");
      },
      insert: () => {
        sqlCalls += 1;
        throw new Error("Poison-Tx darf nie erreicht werden");
      },
    } as unknown as TenantTx;
    const context: ServiceCtx = {
      workspaceId: randomUUID(),
      actor: randomUUID(),
      role: "admin",
      capabilities: { external_only: true },
      featureFlags: {},
    };
    const invalid = "bewusst-ungueltig";
    const calls: Array<() => Promise<unknown>> = [
      () => listCatalogComponents(tx, context),
      () => getCatalogComponent(tx, context, invalid),
      () => createCatalogComponent(tx, context, invalid),
      () => reviseCatalogComponentDetails(tx, context, invalid),
      () => reviseCatalogComponentPricing(tx, context, invalid),
      () => activateCatalogComponent(tx, context, invalid),
      () => archiveCatalogComponent(tx, context, invalid),
      () => returnCatalogComponentToDraft(tx, context, invalid),
      () => getProjectCatalogResolutionContext(tx, context, invalid),
      () => resolveProjectCatalog(tx, context, invalid),
      () => searchActiveProjectCatalogComponents(tx, context, invalid),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        name: "PermissionDeniedError",
        reason: "external_only_without_assignment",
      });
    }
    expect(sqlCalls).toBe(0);
  });
});
