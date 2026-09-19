export type RequestInvoicePdfActionState =
  | { status: "idle" }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "unavailable" }
  | {
    status: "success";
    state: "requested";
    jobId: string;
  };

export const REQUEST_INVOICE_PDF_INITIAL_STATE = {
  status: "idle",
} as const satisfies RequestInvoicePdfActionState;

// F8-18: Zahlungsbeleg anfordern (Spiegel des Rechnungs-PDF-States).
export type RequestInvoicePaymentActionState =
  | { status: "idle" }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "unavailable" }
  | {
    status: "success";
    state: "requested";
    jobId: string;
  };

export const REQUEST_INVOICE_PAYMENT_INITIAL_STATE = {
  status: "idle",
} as const satisfies RequestInvoicePaymentActionState;
