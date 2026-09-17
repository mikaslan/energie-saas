import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
    requestInvoicePdfInput: vi.fn(),
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
  requestInvoicePdfInput: deps.requestInvoicePdfInput,
  InvoicingValidationError: deps.InvoicingValidationError,
  InvoicingNotFoundError: deps.InvoicingNotFoundError,
  InvoicingIntegrityError: deps.InvoicingIntegrityError,
}));

import {
  requestInvoicePdfAction,
} from "@/app/w/[workspaceId]/rechnungen/pdf-actions";
import {
  REQUEST_INVOICE_PDF_INITIAL_STATE,
} from "@/app/w/[workspaceId]/rechnungen/pdf-action-state";
import { InvoicePdfPanel } from "@/app/w/[workspaceId]/rechnungen/[type]/[documentId]/invoice-pdf-panel";

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
  deps.requestInvoicePdfInput.mockResolvedValue({
    jobId: JOB_ID,
    inputSha256Hex: "c".repeat(64),
    status: "requested",
  });
});

describe("M3-02d invoice PDF action", () => {
  it("M302D-CT-04: autorisiert invoicing.write, uebergibt nur die drei kanonischen Felder und revalidiert danach", async () => {
    const result = await requestInvoicePdfAction(
      REQUEST_INVOICE_PDF_INITIAL_STATE,
      validForm(),
    );

    expect(deps.authorizedAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "invoicing.write",
      "invoice_pdf",
      expect.any(Function),
    );
    expect(deps.requestInvoicePdfInput).toHaveBeenCalledWith(TX, CTX, {
      schemaVersion: "commercial-document-render-command.v1",
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

  it("M302D-CT-04: akzeptiert ausschliesslich framework-interne $ACTION-Felder zusaetzlich", async () => {
    const accepted = validForm();
    accepted.set("$ACTION_ID_safe", "framework-value");
    await expect(requestInvoicePdfAction(
      REQUEST_INVOICE_PDF_INITIAL_STATE,
      accepted,
    )).resolves.toMatchObject({ status: "success" });

    const rejected = validForm();
    rejected.set("templateVersion", "attacker-choice");
    await expect(requestInvoicePdfAction(
      REQUEST_INVOICE_PDF_INITIAL_STATE,
      rejected,
    )).resolves.toEqual({ status: "invalid" });
    expect(deps.requestInvoicePdfInput).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ungueltige Workspace-ID", { workspaceId: "kein-uuid" }],
    ["doppelte Workspace-ID", { duplicateWorkspace: true }],
    ["ungueltiger Typ", { type: "kein-typ" }],
    ["ungueltige Document-ID", { documentId: "kein-uuid" }],
  ])("M302D-CT-04: weist %s ohne Fachserviceaufruf ab", async (_label, mutation) => {
    const formData = validForm();
    if ("workspaceId" in mutation) formData.set("workspaceId", mutation.workspaceId);
    if ("duplicateWorkspace" in mutation) formData.append("workspaceId", WORKSPACE_ID);
    if ("type" in mutation) formData.set("type", mutation.type);
    if ("documentId" in mutation) formData.set("documentId", mutation.documentId);

    await expect(requestInvoicePdfAction(
      REQUEST_INVOICE_PDF_INITIAL_STATE,
      formData,
    )).resolves.toEqual({ status: "invalid" });
    expect(deps.requestInvoicePdfInput).not.toHaveBeenCalled();
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [new deps.NotAuthenticatedError(), { status: "unauthenticated" }],
    [new deps.PermissionDeniedError(), { status: "denied" }],
    [new deps.InvoicingValidationError(), { status: "invalid" }],
    [new deps.InvoicingNotFoundError(), { status: "not_found" }],
    [new deps.InvoicingIntegrityError(), { status: "unavailable" }],
  ] as const)("M302D-CT-04: redigiert Fehler und revalidiert nie", async (error, expected) => {
    deps.requestInvoicePdfInput.mockRejectedValueOnce(error);

    await expect(requestInvoicePdfAction(
      REQUEST_INVOICE_PDF_INITIAL_STATE,
      validForm(),
    )).resolves.toEqual(expected);
    expect(deps.revalidatePath).not.toHaveBeenCalled();
    expect(JSON.stringify(expected)).not.toContain(error.message);
  });
});

describe("M3-02d invoice PDF panel", () => {
  const jobs = [{
    jobId: JOB_ID,
    state: "succeeded" as const,
    attemptCount: 1,
    nextAttemptAt: "2026-09-17T12:00:00.000Z",
    createdAt: "2026-09-17T11:59:00.000Z",
    startedAt: "2026-09-17T11:59:01.000Z",
    finishedAt: "2026-09-17T11:59:02.000Z",
    errorCode: null,
    canDownload: true,
  }, {
    jobId: "40000000-0000-4000-8000-000000000004",
    state: "failed_final" as const,
    attemptCount: 3,
    nextAttemptAt: "2026-09-17T11:00:00.000Z",
    createdAt: "2026-09-17T10:59:00.000Z",
    startedAt: "2026-09-17T10:59:01.000Z",
    finishedAt: "2026-09-17T10:59:02.000Z",
    errorCode: "PRIVATE_WORKER_SENTINEL",
    canDownload: false,
  }];

  function renderPanel(canGenerate: boolean): string {
    return renderToStaticMarkup(createElement(InvoicePdfPanel, {
      workspaceId: WORKSPACE_ID,
      type: "invoice",
      documentId: DOCUMENT_ID,
      canGenerate,
      jobs,
    }));
  }

  it("M302D-CT-05: laesst Leser nur echte fertige Artefakte laden und redigiert Workerfehler", () => {
    const html = renderPanel(false);

    expect(html).toContain("Nur Lesezugriff");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Rechnungs-PDF erzeugen</button>");
    expect(html).toContain(`/rechnungen/invoice/${DOCUMENT_ID}/pdf/${JOB_ID}`);
    expect(html).toContain("PDF-Erstellung endgültig fehlgeschlagen");
    expect(html).toContain("Versuche:");
    expect(html).not.toContain("PRIVATE_WORKER_SENTINEL");
    expect(html).not.toContain("/pdf/40000000-0000-4000-8000-000000000004");
  });

  it("M302D-CT-05: gibt Editoren ein semantisches Formular mit drei kanonischen Feldern", () => {
    const html = renderPanel(true);

    expect(html).toContain("<form");
    expect(html).toContain('name="workspaceId"');
    expect(html).toContain('name="type"');
    expect(html).toContain('name="documentId"');
    expect(html).toContain("Rechnungs-PDF erzeugen");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});
