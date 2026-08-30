import type { OfferIssuanceStatusState } from "@/modules/offers";

export type OfferIssuanceActionState =
  | { status: "idle" }
  | { status: "invalid"; paths?: readonly string[] }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "conflict"; code?: string }
  | { status: "unavailable"; retryAfter?: string }
  | {
    status: "issuance_requested";
    issuanceId: string;
    state: OfferIssuanceStatusState;
    approvalCount: number;
    replayed: boolean;
  }
  | {
    status: "issuance_approved";
    issuanceId: string;
    approvalCount: 1 | 2;
    derivedState: "approval_pending" | "approved_for_archive_not_issued";
    replayed: boolean;
  }
  | {
    status: "issuance_withdrawn";
    issuanceId: string;
    state: "withdrawn_before_archive";
    approvalCount: number;
    withdrawnAt: string;
    replayed: boolean;
  };

export const OFFER_ISSUANCE_ACTION_INITIAL_STATE = {
  status: "idle",
} as const satisfies OfferIssuanceActionState;
