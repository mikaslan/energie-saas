export type OfferReleaseProfileActionState =
  | { status: "idle" }
  | { status: "invalid"; paths?: readonly string[] }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "conflict"; currentRevision?: number }
  | { status: "unavailable" }
  | {
    status: "revised";
    profileId: string;
    profileRevisionId: string;
    revision: number;
  }
  | {
    status: "activated";
    profileId: string;
    profileRevisionId: string;
    revision: number;
  };

export const OFFER_RELEASE_PROFILE_INITIAL_STATE = {
  status: "idle",
} as const satisfies OfferReleaseProfileActionState;
