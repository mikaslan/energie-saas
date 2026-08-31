import type {
  CatalogComponentViewV1,
} from "@/lib/integrations/catalog/contract";
import type { CatalogComponentReadModel } from "@/modules/catalog";

export type ResolutionSelectableComponent = {
  id: string;
  revision: number;
  sku: string;
  name: string;
  manufacturer: string;
  model: string;
  componentType: CatalogComponentViewV1["identity"]["componentType"];
  technicalData: CatalogComponentViewV1["technicalData"];
  salesPriceNetCents: number;
  purchasePriceNetCents?: number;
};

export function toResolutionSelectableComponent(
  component: CatalogComponentReadModel,
): ResolutionSelectableComponent {
  if (component.status !== "active" || component.current.commercial === null) {
    throw new TypeError("project catalog selection requires an active priced component");
  }
  const commercial = component.current.commercial;
  const purchase = "purchasePriceNetCents" in commercial
    ? commercial.purchasePriceNetCents
    : undefined;
  return {
    id: component.id,
    revision: component.currentRevision,
    sku: component.current.identity.internalSku,
    name: component.current.presentation.displayName,
    manufacturer: component.current.presentation.manufacturer,
    model: component.current.presentation.model,
    componentType: component.current.identity.componentType,
    technicalData: component.current.technicalData,
    salesPriceNetCents: commercial.salesPriceNetCents,
    ...(purchase === undefined ? {} : { purchasePriceNetCents: purchase }),
  };
}
