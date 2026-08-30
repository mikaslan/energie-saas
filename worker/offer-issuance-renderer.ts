import {
  OFFER_ISSUANCE_RENDERER_RECIPE_VERSION,
  validateOfferIssuanceInput,
  type OfferIssuanceInputV1,
} from "../lib/integrations/offers/issuance-contract";
import {
  renderOfferIssuanceHtml,
} from "../lib/integrations/offers/issuance-template";
import {
  createSealedPlaywrightOfferPdfRenderer,
  type SealedOfferPdfRenderer,
} from "./offer-pdf-renderer";

export type OfferIssuanceRenderer = SealedOfferPdfRenderer<
  OfferIssuanceInputV1
>;

export type OfferIssuanceRendererOptions = Readonly<{
  /** Verification-only seam. Production callers use the sealed template. */
  htmlRenderer?: (input: OfferIssuanceInputV1) => string;
  /** Host-only diagnostics. Production callers must leave this false. */
  allowUnpinnedRuntimeForVerification?: boolean;
}>;

export function createPlaywrightOfferIssuanceRenderer(
  options: OfferIssuanceRendererOptions = {},
): OfferIssuanceRenderer {
  return createSealedPlaywrightOfferPdfRenderer({
    expectedRendererRecipeVersion: OFFER_ISSUANCE_RENDERER_RECIPE_VERSION,
    validateInput: validateOfferIssuanceInput,
    htmlRenderer: options.htmlRenderer ?? renderOfferIssuanceHtml,
    allowUnpinnedRuntimeForVerification:
      options.allowUnpinnedRuntimeForVerification,
  });
}
