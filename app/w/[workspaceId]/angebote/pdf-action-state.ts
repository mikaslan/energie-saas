import type { OfferPdfDraftState } from "@/modules/offers";

export type GenerateOfferPdfDraftActionState =
  | { status: "idle" }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "conflict"; currentRevision?: number }
  | { status: "unavailable"; retryAfter?: string }
  | {
    status: "success";
    state: OfferPdfDraftState;
    replayed: boolean;
    variantRevision: number;
  };

export const GENERATE_OFFER_PDF_DRAFT_INITIAL_STATE = {
  status: "idle",
} as const satisfies GenerateOfferPdfDraftActionState;
