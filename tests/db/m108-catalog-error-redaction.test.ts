import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TenantTx } from "@/lib/db/types";
import {
  CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
  type CatalogComponentCreateCommandV1,
} from "@/lib/integrations/catalog/contract";
import type { ServiceCtx } from "@/lib/permissions";
import {
  CatalogPersistenceError,
  createCatalogComponent,
} from "@/modules/catalog";

const PURCHASE_PRICE_SENTINEL = 876_543_210;
const SALES_PRICE_SENTINEL = 987_654_321;
const PURCHASE_REFERENCE_SENTINEL = "PRIVATE-EK-REFERENCE-M108-DO-NOT-EXPOSE";
const SALES_REFERENCE_SENTINEL = "PRIVATE-VK-REFERENCE-M108-DO-NOT-EXPOSE";

function catalogEditorContext(): ServiceCtx {
  return {
    workspaceId: randomUUID(),
    actor: randomUUID(),
    role: "editor",
    capabilities: { manage_catalog: true, edit_prices: true },
    featureFlags: {},
  };
}

function privatePricedComponent(): CatalogComponentCreateCommandV1 {
  return {
    schemaVersion: CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
    internalSku: "M108-ERROR-REDACTION",
    componentType: "other",
    presentation: {
      displayName: "Synthetische Testkomponente",
      manufacturer: "Testwerk",
      model: "Redaction Fixture",
      unit: "piece",
      keyPoints: [],
      image: null,
      datasheet: null,
    },
    technicalData: {
      schemaVersion: "other.v1",
      attributes: [],
    },
    commercial: {
      currency: "EUR",
      basis: "net",
      purchasePriceNetCents: PURCHASE_PRICE_SENTINEL,
      salesPriceNetCents: SALES_PRICE_SENTINEL,
      purchaseProvenance: {
        sourceKind: "supplier_quote",
        reference: PURCHASE_REFERENCE_SENTINEL,
        observedOn: "2026-08-29",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: SALES_REFERENCE_SENTINEL,
        observedOn: "2026-08-29",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance: {
      sourceKind: "workspace_manual",
      reference: "SYNTHETIC-TECHNICAL-REFERENCE",
      observedOn: "2026-08-29",
      rightsBasis: "workspace_owned",
      sourceDocumentSha256: null,
    },
  };
}

function exposedErrorSurface(error: Error): string {
  const ownProperties = Object.fromEntries(
    Object.getOwnPropertyNames(error).map((property) => [
      property,
      String(Reflect.get(error, property)),
    ]),
  );
  return JSON.stringify({
    stringValue: String(error),
    jsonValue: error,
    ownProperties,
  });
}

describe("M1-08 Katalog-Fehlerredaktion", () => {
  it("ersetzt sensible Treiberfehler des Revisions-Inserts durch einen ursachenlosen Fehler", async () => {
    const command = privatePricedComponent();
    const driverCause = Object.assign(
      new Error(
        `revision params: ${PURCHASE_PRICE_SENTINEL}, ${SALES_PRICE_SENTINEL}, `
        + `${PURCHASE_REFERENCE_SENTINEL}, ${SALES_REFERENCE_SENTINEL}`,
      ),
      {
        constraint: "catalog_component_revision_private_fixture_check",
        detail: PURCHASE_REFERENCE_SENTINEL,
      },
    );
    const driverError = Object.assign(
      new Error(`failed query containing ${SALES_REFERENCE_SENTINEL}`, {
        cause: driverCause,
      }),
      {
        params: [
          PURCHASE_PRICE_SENTINEL,
          SALES_PRICE_SENTINEL,
          PURCHASE_REFERENCE_SENTINEL,
          SALES_REFERENCE_SENTINEL,
        ],
      },
    );
    let executeCalls = 0;
    const tx = {
      execute: async () => {
        executeCalls += 1;
        if (executeCalls === 2) throw driverError;
        return { rows: [] };
      },
    } as unknown as TenantTx;

    let caught: unknown;
    try {
      await createCatalogComponent(tx, catalogEditorContext(), command);
    } catch (error) {
      caught = error;
    }

    expect(executeCalls).toBe(2);
    expect(caught).toBeInstanceOf(CatalogPersistenceError);
    expect(caught).not.toBe(driverError);
    expect(caught).toMatchObject({
      name: "CatalogPersistenceError",
      message: "catalog write failed",
    });
    expect(Object.prototype.hasOwnProperty.call(caught, "cause")).toBe(false);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();

    const publicSurface = exposedErrorSurface(caught as Error);
    for (const secret of [
      String(PURCHASE_PRICE_SENTINEL),
      String(SALES_PRICE_SENTINEL),
      PURCHASE_REFERENCE_SENTINEL,
      SALES_REFERENCE_SENTINEL,
    ]) {
      expect(publicSurface).not.toContain(secret);
    }
  });
});
