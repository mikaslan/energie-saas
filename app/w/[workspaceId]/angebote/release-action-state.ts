import type { OfferReleaseRenderState } from "@/modules/offers";

export type OfferReleaseActionState = (
  | { status: "idle" }
  | { status: "invalid"; paths?: readonly string[] }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "conflict"; code?: string; currentRevision?: number }
  | { status: "unavailable"; retryAfter?: string }
  | {
    status: "recipient_saved";
    recipientRevisionId: string;
    recipientRevision: number;
  }
  | {
    status: "candidate_requested";
    candidateId: string;
    state: OfferReleaseRenderState;
    variantRevision: number;
    replayed: boolean;
  }
  | {
    status: "candidate_approved";
    candidateId: string;
    approvedAt: string;
    replayed: boolean;
  }
) & {
  submittedRecipientRevision?: number | null;
};

export const OFFER_RELEASE_ACTION_INITIAL_STATE = {
  status: "idle",
} as const satisfies OfferReleaseActionState;
