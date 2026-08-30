import {
  OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
  validateOfferReleaseCandidateInput,
  type OfferReleaseCandidateInputV1,
} from "../lib/integrations/offers/release-contract";
import {
  renderOfferReleaseCandidateHtml,
} from "../lib/integrations/offers/release-template";
import {
  createSealedPlaywrightOfferPdfRenderer,
  type SealedOfferPdfRenderer,
} from "./offer-pdf-renderer";

export type OfferReleaseCandidateRenderer = SealedOfferPdfRenderer<
  OfferReleaseCandidateInputV1
>;

export type OfferReleaseCandidateRendererOptions = Readonly<{
  /** Verification-only seam. Production callers use the sealed template. */
  htmlRenderer?: (input: OfferReleaseCandidateInputV1) => string;
  /** Host-only diagnostics. Production callers must leave this false. */
  allowUnpinnedRuntimeForVerification?: boolean;
}>;

export function createPlaywrightOfferReleaseCandidateRenderer(
  options: OfferReleaseCandidateRendererOptions = {},
): OfferReleaseCandidateRenderer {
  return createSealedPlaywrightOfferPdfRenderer({
    expectedRendererRecipeVersion:
      OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
    validateInput: validateOfferReleaseCandidateInput,
    htmlRenderer: options.htmlRenderer ?? renderOfferReleaseCandidateHtml,
    allowUnpinnedRuntimeForVerification:
      options.allowUnpinnedRuntimeForVerification,
  });
}
