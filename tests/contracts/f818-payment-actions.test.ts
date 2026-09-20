import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {
    constructor() { super("private authentication sentinel"); }
  }
  class PermissionDeniedError extends Error {
    constructor() { super("private permission sentinel"); }
  }
  class InvoicingValidationError extends Error {
    constructor() { super("private validation sentinel"); }
  }
  class InvoicingNotFoundError extends Error {
    constructor() { super("private not-found sentinel"); }
  }
  class InvoicingIntegrityError extends Error {
    constructor() { super("private integrity sentinel"); }
  }

  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    InvoicingValidationError,
    InvoicingNotFoundError,
    InvoicingIntegrityError,
    authorizedAction: vi.fn(),
    requestInvoicePaymentInput: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: deps.revalidatePath }));
vi.mock("@/lib/action", () => ({
  authorizedAction: deps.authorizedAction,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/modules/invoicing", () => ({
  requestInvoicePaymentInput: deps.requestInvoicePaymentInput,
  InvoicingValidationError: deps.InvoicingValidationError,
  InvoicingNotFoundError: deps.InvoicingNotFoundError,
  InvoicingIntegrityError: deps.InvoicingIntegrityError,
}));

import {
  requestInvoicePaymentAction,
} from "@/app/w/[workspaceId]/rechnungen/pdf-actions";
import {
  REQUEST_INVOICE_PAYMENT_INITIAL_STATE,
} from "@/app/w/[workspaceId]/rechnungen/pdf-action-state";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "20000000-0000-4000-8000-000000000002";
const JOB_ID = "30000000-0000-4000-8000-000000000003";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "member-1" };

function validForm(): FormData {
  const formData = new FormData();
  formData.set("workspaceId", WORKSPACE_ID);
  formData.set("type", "invoice");
  formData.set("documentId", DOCUMENT_ID);
  return formData;
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.authorizedAction.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    operation: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
  ) => operation(TX, CTX));
  deps.requestInvoicePaymentInput.mockResolvedValue({
    jobId: JOB_ID,
    inputSha256Hex: "c".repeat(64),
    status: "requested",
    amountCents: 119000,
  });
});

describe("F8-18 invoice payment action", () => {
  it("F818-CT-03: autorisiert invoicing.write, ruft den Payment-Input mit Command-Version und revalidiert danach", async () => {
    const result = await requestInvoicePaymentAction(
      REQUEST_INVOICE_PAYMENT_INITIAL_STATE,
      validForm(),
    );

    expect(deps.authorizedAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "invoicing.write",
      "invoice_payment",
      expect.any(Function),
    );
    expect(deps.requestInvoicePaymentInput).toHaveBeenCalledWith(TX, CTX, {
      schemaVersion: "commercial-document-payment-render-command.v1",
      documentId: DOCUMENT_ID,
    });
    expect(result).toEqual({
      status: "success",
      state: "requested",
      jobId: JOB_ID,
    });
    expect(deps.revalidatePath).toHaveBeenCalledWith(
      `/w/${WORKSPACE_ID}/rechnungen/invoice/${DOCUMENT_ID}`,
    );
  });

  it("F818-CT-03: akzeptiert ausschliesslich framework-interne $ACTION-Felder zusaetzlich", async () => {
    const accepted = validForm();
    accepted.set("$ACTION_ID_safe", "framework-value");
    await expect(requestInvoicePaymentAction(
      REQUEST_INVOICE_PAYMENT_INITIAL_STATE,
      accepted,
    )).resolves.toMatchObject({ status: "success" });

    const rejected = validForm();
    rejected.set("templateVersion", "attacker-choice");
    await expect(requestInvoicePaymentAction(
      REQUEST_INVOICE_PAYMENT_INITIAL_STATE,
      rejected,
    )).resolves.toEqual({ status: "invalid" });
    expect(deps.requestInvoicePaymentInput).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ungueltige Workspace-ID", { workspaceId: "kein-uuid" }],
    ["doppelte Workspace-ID", { duplicateWorkspace: true }],
    ["ungueltiger Typ", { type: "kein-typ" }],
    ["Gutschrift-Typ", { type: "credit_note" }],
    ["ungueltige Document-ID", { documentId: "kein-uuid" }],
  ])("F818-CT-03: weist %s ohne Fachserviceaufruf ab (type strikt invoice)", async (_label, mutation) => {
    const formData = validForm();
    if ("workspaceId" in mutation) formData.set("workspaceId", mutation.workspaceId);
    if ("duplicateWorkspace" in mutation) formData.append("workspaceId", WORKSPACE_ID);
    if ("type" in mutation) formData.set("type", mutation.type);
    if ("documentId" in mutation) formData.set("documentId", mutation.documentId);

    await expect(requestInvoicePaymentAction(
      REQUEST_INVOICE_PAYMENT_INITIAL_STATE,
      formData,
    )).resolves.toEqual({ status: "invalid" });
    expect(deps.requestInvoicePaymentInput).not.toHaveBeenCalled();
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [new deps.NotAuthenticatedError(), { status: "unauthenticated" }],
    [new deps.PermissionDeniedError(), { status: "denied" }],
    [new deps.InvoicingValidationError(), { status: "invalid" }],
    [new deps.InvoicingNotFoundError(), { status: "not_found" }],
    [new deps.InvoicingIntegrityError(), { status: "unavailable" }],
  ] as const)("F818-CT-03: redigiert Fehler und revalidiert nie", async (error, expected) => {
    deps.requestInvoicePaymentInput.mockRejectedValueOnce(error);

    await expect(requestInvoicePaymentAction(
      REQUEST_INVOICE_PAYMENT_INITIAL_STATE,
      validForm(),
    )).resolves.toEqual(expected);
    expect(deps.revalidatePath).not.toHaveBeenCalled();
    expect(JSON.stringify(expected)).not.toContain(error.message);
  });
});
