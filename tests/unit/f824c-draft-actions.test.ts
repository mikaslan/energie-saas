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
    requestDraftPdfInput: vi.fn(),
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
  COMMERCIAL_DOCUMENT_DRAFT_RENDER_COMMAND_VERSION: "commercial-document-draft-render-command.v1",
  requestDraftPdfInput: deps.requestDraftPdfInput,
  InvoicingValidationError: deps.InvoicingValidationError,
  InvoicingNotFoundError: deps.InvoicingNotFoundError,
  InvoicingIntegrityError: deps.InvoicingIntegrityError,
}));

import { requestDraftPdfAction } from "@/app/w/[workspaceId]/rechnungen/draft-actions";
import { REQUEST_DRAFT_PDF_INITIAL_STATE } from "@/app/w/[workspaceId]/rechnungen/pdf-action-state";
import {
  DraftPdfPanel,
  type DraftPdfSurfaceView,
} from "@/app/w/[workspaceId]/rechnungen/[type]/[documentId]/draft-pdf-panel";

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
  deps.requestDraftPdfInput.mockResolvedValue({
    jobId: JOB_ID,
    inputSha256Hex: "ab".repeat(32),
    status: "requested",
  });
});

describe("F8-24c Draft-Action (F824C-CT-02)", () => {
  it("F824C-UT-A01: gueltiges Formular fordert Draft-Job an + revalidiert Detailseite", async () => {
    const result = await requestDraftPdfAction(REQUEST_DRAFT_PDF_INITIAL_STATE, validForm());
    expect(result).toEqual({ status: "success", state: "requested", jobId: JOB_ID });
    expect(deps.authorizedAction).toHaveBeenCalledTimes(1);
    expect(deps.authorizedAction.mock.calls[0]?.[1]).toBe("invoicing.write");
    expect(deps.requestDraftPdfInput).toHaveBeenCalledTimes(1);
    expect(deps.revalidatePath).toHaveBeenCalledWith(
      `/w/${WORKSPACE_ID.toLowerCase()}/rechnungen/invoice/${DOCUMENT_ID.toLowerCase()}`,
    );
  });

  it("F824C-UT-A02: letter-Typ fail-closed bereits beim Parsen (kein Service-Call)", async () => {
    const formData = validForm();
    formData.set("type", "letter");
    const result = await requestDraftPdfAction(REQUEST_DRAFT_PDF_INITIAL_STATE, formData);
    expect(result).toEqual({ status: "invalid" });
    expect(deps.requestDraftPdfInput).not.toHaveBeenCalled();
  });

  it("F824C-UT-A03: Fremdfelder, Dubletten und fehlende Felder sind invalid", async () => {
    const extra = validForm();
    extra.set("injected", "1");
    expect(await requestDraftPdfAction(REQUEST_DRAFT_PDF_INITIAL_STATE, extra))
      .toEqual({ status: "invalid" });
    const missing = validForm();
    missing.delete("documentId");
    expect(await requestDraftPdfAction(REQUEST_DRAFT_PDF_INITIAL_STATE, missing))
      .toEqual({ status: "invalid" });
    const broken = validForm();
    broken.set("documentId", "keine-uuid");
    expect(await requestDraftPdfAction(REQUEST_DRAFT_PDF_INITIAL_STATE, broken))
      .toEqual({ status: "invalid" });
    expect(deps.requestDraftPdfInput).not.toHaveBeenCalled();
  });

  it("F824C-UT-A04: Fehler-Mapping unauthenticated/denied/not_found/unavailable", async () => {
    deps.authorizedAction.mockRejectedValueOnce(new deps.NotAuthenticatedError());
    expect(await requestDraftPdfAction(REQUEST_DRAFT_PDF_INITIAL_STATE, validForm()))
      .toEqual({ status: "unauthenticated" });
    deps.authorizedAction.mockRejectedValueOnce(new deps.PermissionDeniedError());
    expect(await requestDraftPdfAction(REQUEST_DRAFT_PDF_INITIAL_STATE, validForm()))
      .toEqual({ status: "denied" });
    deps.requestDraftPdfInput.mockRejectedValueOnce(new deps.InvoicingNotFoundError());
    expect(await requestDraftPdfAction(REQUEST_DRAFT_PDF_INITIAL_STATE, validForm()))
      .toEqual({ status: "not_found" });
    deps.requestDraftPdfInput.mockRejectedValueOnce(new deps.InvoicingIntegrityError());
    expect(await requestDraftPdfAction(REQUEST_DRAFT_PDF_INITIAL_STATE, validForm()))
      .toEqual({ status: "unavailable" });
    deps.requestDraftPdfInput.mockRejectedValueOnce(new deps.InvoicingValidationError());
    expect(await requestDraftPdfAction(REQUEST_DRAFT_PDF_INITIAL_STATE, validForm()))
      .toEqual({ status: "invalid" });
  });

  it("F824C-UT-A05: Initial-State ist idle (konsolidiert in pdf-action-state.ts)", () => {
    expect(REQUEST_DRAFT_PDF_INITIAL_STATE).toEqual({ status: "idle" });
  });
});

describe("F8-24c draft panel (F824C-CT-02)", () => {
  function renderPanel(options: { canGenerate: boolean; jobs?: readonly DraftPdfSurfaceView[] }): string {
    return renderToStaticMarkup(createElement(DraftPdfPanel, {
      workspaceId: WORKSPACE_ID,
      type: "invoice",
      documentId: DOCUMENT_ID,
      canGenerate: options.canGenerate,
      jobs: options.jobs ?? [],
    }));
  }

  it("F824C-UT-P01: gibt Editoren ein semantisches Formular mit drei Feldern", () => {
    const html = renderPanel({ canGenerate: true });

    expect(html).toContain('data-testid="draft-pdf-panel"');
    expect(html).toContain("<form");
    expect(html).toContain('name="workspaceId"');
    expect(html).toContain('name="type"');
    expect(html).toContain('name="documentId"');
    expect(html).toContain("ENTWURF-Vorschau");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("F824C-UT-P02: zeigt Lesern ohne Erzeugungsrecht kein Formular", () => {
    const html = renderPanel({ canGenerate: false });

    expect(html).toContain("Nur Lesezugriff");
    expect(html).not.toContain("<form");
  });

  it("F824C-UT-P03: listet Auftraege mit Status (kein stiller Anspruch)", () => {
    const html = renderPanel({
      canGenerate: true,
      jobs: [{
        jobId: JOB_ID,
        state: "succeeded",
        attemptCount: 1,
        nextAttemptAt: "2026-09-19T10:00:00.000Z",
        createdAt: "2026-09-19T09:00:00.000Z",
        startedAt: "2026-09-19T09:01:00.000Z",
        finishedAt: "2026-09-19T09:02:00.000Z",
        errorCode: null,
        canDownload: true,
      }],
    });

    expect(html).toContain("Bisherige Erstellungsaufträge");
    expect(html).toContain(JOB_ID);
  });
});
