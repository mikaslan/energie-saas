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
  class OfferPdfDraftValidationError extends Error {
    constructor() { super("private validation sentinel"); }
  }
  class OfferPdfDraftConflictError extends Error {
    constructor(public readonly currentRevision?: number) {
      super("source changed");
    }
  }
  class OfferPdfDraftNotFoundError extends Error {
    constructor() { super("private not-found sentinel"); }
  }
  class OfferPdfDraftIntegrityError extends Error {
    constructor() { super("private integrity sentinel"); }
  }
  class OfferPdfDraftPersistenceError extends Error {
    constructor() { super("private persistence sentinel"); }
  }
  class OfferPdfDraftDispatchError extends Error {
    constructor() { super("private dispatch sentinel"); }
  }
  class OfferRateLimitError extends Error {
    constructor(public readonly retryAfter: string) {
      super("rate limited");
    }
  }

  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    OfferPdfDraftValidationError,
    OfferPdfDraftConflictError,
    OfferPdfDraftNotFoundError,
    OfferPdfDraftIntegrityError,
    OfferPdfDraftPersistenceError,
    OfferPdfDraftDispatchError,
    OfferRateLimitError,
    authorizedOfferMutationAction: vi.fn(),
    requestOfferPdfDraft: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: deps.revalidatePath }));
vi.mock("@/lib/action", () => ({
  authorizedOfferMutationAction: deps.authorizedOfferMutationAction,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/lib/integrations/offers/admission", () => ({
  OfferRateLimitError: deps.OfferRateLimitError,
}));
vi.mock("@/modules/offers", () => ({
  requestOfferPdfDraft: deps.requestOfferPdfDraft,
  OfferPdfDraftValidationError: deps.OfferPdfDraftValidationError,
  OfferPdfDraftConflictError: deps.OfferPdfDraftConflictError,
  OfferPdfDraftNotFoundError: deps.OfferPdfDraftNotFoundError,
  OfferPdfDraftIntegrityError: deps.OfferPdfDraftIntegrityError,
  OfferPdfDraftPersistenceError: deps.OfferPdfDraftPersistenceError,
  OfferPdfDraftDispatchError: deps.OfferPdfDraftDispatchError,
}));

import {
  generateOfferPdfDraftAction,
} from "@/app/w/[workspaceId]/angebote/pdf-actions";
import {
  GENERATE_OFFER_PDF_DRAFT_INITIAL_STATE,
} from "@/app/w/[workspaceId]/angebote/pdf-action-state";
import { OfferPdfDraftPanel } from "@/app/w/[workspaceId]/angebote/[offerId]/offer-pdf-draft-panel";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const OFFER_ID = "20000000-0000-4000-8000-000000000002";
const VARIANT_ID = "30000000-0000-4000-8000-000000000003";
const JOB_ID = "40000000-0000-4000-8000-000000000004";
const RETRY_AFTER = "2026-08-30T12:15:00.000Z";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "member-1" };

function validForm(): FormData {
  const formData = new FormData();
  formData.set("workspaceId", WORKSPACE_ID);
  formData.set("offerId", OFFER_ID);
  formData.set("variantId", VARIANT_ID);
  formData.set("expectedVariantRevision", "7");
  return formData;
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.authorizedOfferMutationAction.mockImplementation(async (
    _workspaceId: string,
    _actions: readonly string[],
    _resource: string,
    operation: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
  ) => operation(TX, CTX));
  deps.requestOfferPdfDraft.mockResolvedValue({
    jobId: JOB_ID,
    offerId: OFFER_ID,
    variantId: VARIANT_ID,
    variantRevision: 7,
    state: "queued",
    replayed: false,
  });
});

describe("M2-02 offer PDF draft action", () => {
  it("autorisiert project.write, übergibt nur die vier kanonischen Felder und revalidiert danach", async () => {
    const result = await generateOfferPdfDraftAction(
      GENERATE_OFFER_PDF_DRAFT_INITIAL_STATE,
      validForm(),
    );

    expect(deps.authorizedOfferMutationAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      ["project.write"],
      "offer_pdf_draft",
      expect.any(Function),
    );
    expect(deps.requestOfferPdfDraft).toHaveBeenCalledWith(TX, CTX, {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      expectedVariantRevision: 7,
    });
    expect(result).toEqual({
      status: "success",
      state: "queued",
      replayed: false,
      variantRevision: 7,
    });
    expect(deps.revalidatePath).toHaveBeenCalledWith(
      `/w/${WORKSPACE_ID}/angebote/${OFFER_ID}`,
    );
  });

  it("akzeptiert ausschließlich framework-interne $ACTION-Felder zusätzlich", async () => {
    const accepted = validForm();
    accepted.set("$ACTION_ID_safe", "framework-value");
    await expect(generateOfferPdfDraftAction(
      GENERATE_OFFER_PDF_DRAFT_INITIAL_STATE,
      accepted,
    )).resolves.toMatchObject({ status: "success" });

    const rejected = validForm();
    rejected.set("templateVersion", "attacker-choice");
    await expect(generateOfferPdfDraftAction(
      GENERATE_OFFER_PDF_DRAFT_INITIAL_STATE,
      rejected,
    )).resolves.toEqual({ status: "invalid" });
    expect(deps.requestOfferPdfDraft).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ungültige Workspace-ID", { workspaceId: "kein-uuid" }],
    ["doppelte Workspace-ID", { duplicateWorkspace: true }],
    ["Revision null", { expectedVariantRevision: "0" }],
    ["Revision mit Vorzeichen", { expectedVariantRevision: "+7" }],
    ["Revision mit Dezimalstelle", { expectedVariantRevision: "7.0" }],
  ])("weist %s ohne Fachserviceaufruf ab", async (_label, mutation) => {
    const formData = validForm();
    if ("workspaceId" in mutation) formData.set("workspaceId", mutation.workspaceId);
    if ("duplicateWorkspace" in mutation) formData.append("workspaceId", WORKSPACE_ID);
    if ("expectedVariantRevision" in mutation) {
      formData.set("expectedVariantRevision", mutation.expectedVariantRevision);
    }

    await expect(generateOfferPdfDraftAction(
      GENERATE_OFFER_PDF_DRAFT_INITIAL_STATE,
      formData,
    )).resolves.toEqual({ status: "invalid" });
    expect(deps.requestOfferPdfDraft).not.toHaveBeenCalled();
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [new deps.NotAuthenticatedError(), { status: "unauthenticated" }],
    [new deps.PermissionDeniedError(), { status: "denied" }],
    [new deps.OfferPdfDraftValidationError(), { status: "invalid" }],
    [new deps.OfferPdfDraftNotFoundError(), { status: "not_found" }],
    [new deps.OfferPdfDraftConflictError(9), { status: "conflict", currentRevision: 9 }],
    [new deps.OfferPdfDraftIntegrityError(), { status: "unavailable" }],
    [new deps.OfferPdfDraftPersistenceError(), { status: "unavailable" }],
    [new deps.OfferPdfDraftDispatchError(), { status: "unavailable" }],
    [new deps.OfferRateLimitError(RETRY_AFTER), {
      status: "unavailable",
      retryAfter: RETRY_AFTER,
    }],
  ] as const)("redigiert %s und revalidiert nie", async (error, expected) => {
    deps.requestOfferPdfDraft.mockRejectedValueOnce(error);

    await expect(generateOfferPdfDraftAction(
      GENERATE_OFFER_PDF_DRAFT_INITIAL_STATE,
      validForm(),
    )).resolves.toEqual(expected);
    expect(deps.revalidatePath).not.toHaveBeenCalled();
    expect(JSON.stringify(expected)).not.toContain(error.message);
  });
});

describe("M2-02 offer PDF draft panel", () => {
  const drafts = [{
    jobId: JOB_ID,
    variantId: VARIANT_ID,
    variantRevision: 7,
    state: "succeeded" as const,
    attemptCount: 1,
    nextAttemptAt: "2026-08-30T12:00:00.000Z",
    createdAt: "2026-08-30T11:59:00.000Z",
    startedAt: "2026-08-30T11:59:01.000Z",
    finishedAt: "2026-08-30T11:59:02.000Z",
    errorCode: null,
    canDownload: true,
  }, {
    jobId: "50000000-0000-4000-8000-000000000005",
    variantId: VARIANT_ID,
    variantRevision: 6,
    state: "failed_final" as const,
    attemptCount: 3,
    nextAttemptAt: "2026-08-30T11:00:00.000Z",
    createdAt: "2026-08-30T10:59:00.000Z",
    startedAt: "2026-08-30T10:59:01.000Z",
    finishedAt: "2026-08-30T10:59:02.000Z",
    errorCode: "PRIVATE_WORKER_SENTINEL",
    canDownload: false,
  }];

  function renderPanel(canGenerate: boolean): string {
    return renderToStaticMarkup(createElement(OfferPdfDraftPanel, {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      variantRevision: 7,
      canGenerate,
      drafts,
    }));
  }

  it("lässt Viewer nur echte fertige Artefakte laden und redigiert Workerfehler", () => {
    const html = renderPanel(false);

    expect(html).toContain("Nur Lesezugriff");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Internen PDF-Entwurf erzeugen</button>");
    expect(html).toContain(`/angebote/${OFFER_ID}/pdf/${JOB_ID}`);
    expect(html).toContain("PDF-Erstellung endgültig fehlgeschlagen");
    expect(html).toContain("Versuche:");
    expect(html).not.toContain("PRIVATE_WORKER_SENTINEL");
    expect(html).not.toContain("/pdf/50000000-0000-4000-8000-000000000005");
  });

  it("gibt Editoren ein semantisches Formular ausschließlich für die gespeicherte Revision", () => {
    const html = renderPanel(true);

    expect(html).toContain("<form");
    expect(html).toContain('name="workspaceId"');
    expect(html).toContain('name="offerId"');
    expect(html).toContain('name="variantId"');
    expect(html).toContain('name="expectedVariantRevision"');
    expect(html).toContain('value="7"');
    expect(html).toContain("Internen PDF-Entwurf erzeugen");
    expect(html).toContain("Ungespeicherte Änderungen");
    expect(html).toContain('aria-describedby="offer-pdf-source-warning"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});
