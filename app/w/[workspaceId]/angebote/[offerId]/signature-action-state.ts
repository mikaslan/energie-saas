import type { SignatureWithdrawalReason } from "@/lib/integrations/offers/signature-contract";

export type SignatureActionState =
  | { status: "idle" }
  | { status: "invalid"; paths?: string[] }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "conflict"; code: string }
  | { status: "unavailable" }
  | { status: "created"; requestId: string; token: string; expiresAt: string; replayed: boolean }
  | { status: "withdrawn"; requestId: string; reasonCode: SignatureWithdrawalReason }
  | { status: "signed"; requestId: string; mode: "analog" };

export const SIGNATURE_ACTION_INITIAL_STATE: SignatureActionState = { status: "idle" };
