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

// F8-24c: ENTWURF-Vorschau anfordern (Spiegel des Rechnungs-PDF-States).
export type RequestDraftPdfActionState =
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

export const REQUEST_DRAFT_PDF_INITIAL_STATE = {
  status: "idle",
} as const satisfies RequestDraftPdfActionState;

// F8-19: Versand-Nachweis anlegen (eigener State: Erfolg traegt den
// Nachweis statt einer Job-ID). Liegt hier statt in delivery-actions.ts,
// weil "use server"-Dateien nur async Functions exportieren duerfen.
export type MarkSentWithDeliveryActionState =
  | { status: "idle" }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "conflict" }
  | { status: "unavailable" }
  | {
    status: "success";
    sentAt: string;
    invoiceJobId: string;
    paymentJobId: string | null;
  };

export const MARK_SENT_WITH_DELIVERY_INITIAL_STATE = {
  status: "idle",
} as const satisfies MarkSentWithDeliveryActionState;
