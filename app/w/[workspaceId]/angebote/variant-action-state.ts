export type SetPrimaryVariantEditorState =
  | { status: "idle" }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "unavailable" }
  | { status: "success"; alreadyPrimary: boolean };

export const SET_PRIMARY_VARIANT_INITIAL_STATE = {
  status: "idle",
} as const satisfies SetPrimaryVariantEditorState;

export type SetTotalOverrideEditorState =
  | { status: "idle" }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "unavailable" }
  | { status: "success"; changed: boolean; cleared: boolean };

export const SET_TOTAL_OVERRIDE_INITIAL_STATE = {
  status: "idle",
} as const satisfies SetTotalOverrideEditorState;

export type SetVariantBundlesEditorState =
  | { status: "idle" }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "unavailable" }
  | { status: "success"; changed: boolean };

export const SET_VARIANT_BUNDLES_INITIAL_STATE = {
  status: "idle",
} as const satisfies SetVariantBundlesEditorState;

export type SetVariantPaymentOptionEditorState =
  | { status: "idle" }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "unavailable" }
  | { status: "success"; changed: boolean };

export const SET_VARIANT_PAYMENT_OPTION_INITIAL_STATE = {
  status: "idle",
} as const satisfies SetVariantPaymentOptionEditorState;
