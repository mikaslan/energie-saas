import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import type {
  OfferCatalogBasisReference,
  OfferCatalogCopyResult,
} from "./offer-copy";

export {
  activateCatalogComponent,
  archiveCatalogComponent,
  CatalogConflictError,
  CatalogInputError,
  CatalogIntegrityError,
  CatalogNotFoundError,
  CatalogPersistenceError,
  CatalogStateError,
  createCatalogComponent,
  getCatalogComponent,
  listCatalogComponents,
  getProjectCatalogResolutionContext,
  ProjectCatalogBlockedError,
  ProjectCatalogConflictError,
  resolveProjectCatalog,
  returnCatalogComponentToDraft,
  reviseCatalogComponentDetails,
  reviseCatalogComponentPricing,
} from "./service";
export type {
  CatalogComponentReadModel,
  CatalogListFilters,
  CatalogLifecycleCommand,
  CatalogMutationResult,
  ProjectCatalogResolutionContext,
  ProjectCatalogResolutionMutationResult,
  ProjectCatalogResolutionStaleReason,
} from "./service";
export type {
  OfferCatalogBasisReference,
  OfferCatalogCopy,
  OfferCatalogCopyResult,
  OfferCatalogResolutionSnapshot,
} from "./offer-copy";

export class CatalogOfferBridgeIntegrityError extends Error {
  constructor() {
    super("catalog data for the offer boundary failed integrity validation");
    this.name = "CatalogOfferBridgeIntegrityError";
  }
}

async function mapOfferBridgeIntegrity<T>(
  operation: (
    bridge: typeof import("./offer-copy"),
  ) => Promise<T>,
): Promise<T> {
  const bridge = await import("./offer-copy");
  try {
    return await operation(bridge);
  } catch (error) {
    if (error instanceof bridge.CatalogOfferBridgeIntegrityError) {
      throw new CatalogOfferBridgeIntegrityError();
    }
    throw error;
  }
}

export async function readCurrentProjectCatalogForOfferCopy(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferCatalogCopyResult> {
  return mapOfferBridgeIntegrity((bridge) =>
    bridge.readCurrentProjectCatalogForOfferCopy(tx, ctx, value));
}

export async function readCurrentProjectCatalogBasisReference(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferCatalogBasisReference | null> {
  return mapOfferBridgeIntegrity((bridge) =>
    bridge.readCurrentProjectCatalogBasisReference(tx, ctx, value));
}

export async function readOfferCatalogFreshness(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<ReadonlyMap<string, boolean>> {
  return mapOfferBridgeIntegrity((bridge) =>
    bridge.readOfferCatalogFreshness(tx, ctx, value));
}
