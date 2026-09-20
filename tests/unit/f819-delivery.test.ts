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
  class InvoicingConflictError extends Error {
    constructor() { super("private conflict sentinel"); }
  }
  class InvoicingIntegrityError extends Error {
    constructor() { super("private integrity sentinel"); }
  }

  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    InvoicingValidationError,
    InvoicingNotFoundError,
    InvoicingConflictError,
    InvoicingIntegrityError,
    authorizedAction: vi.fn(),
    markSentWithDelivery: vi.fn(),
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
  COMMERCIAL_DOCUMENT_DELIVERY_COMMAND_VERSION: "commercial-document-delivery-command.v1",
  markSentWithDelivery: deps.markSentWithDelivery,
  InvoicingValidationError: deps.InvoicingValidationError,
  InvoicingNotFoundError: deps.InvoicingNotFoundError,
  InvoicingConflictError: deps.InvoicingConflictError,
  InvoicingIntegrityError: deps.InvoicingIntegrityError,
}));

import { markSentWithDeliveryAction } from "@/app/w/[workspaceId]/rechnungen/delivery-actions";
import { MARK_SENT_WITH_DELIVERY_INITIAL_STATE } from "@/app/w/[workspaceId]/rechnungen/pdf-action-state";
import {
  VersandPanel,
  type DeliverySurfaceView,
} from "@/app/w/[workspaceId]/rechnungen/[type]/[documentId]/versand-panel";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "20000000-0000-4000-8000-000000000002";
const INVOICE_JOB_ID = "30000000-0000-4000-8000-000000000003";
const PAYMENT_JOB_ID = "40000000-0000-4000-8000-000000000004";
const INVOICE_SHA = "ab".repeat(32);
const PAYMENT_SHA = "cd".repeat(32);
const SENT_AT = "2026-09-19T10:00:00.000Z";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "member-1" };

function validForm(): FormData {
  const formData = new FormData();
  formData.set("workspaceId", WORKSPACE_ID);
  formData.set("documentId", DOCUMENT_ID);
  formData.set("channel", "manual");
  return formData;
}

function delivered(): DeliverySurfaceView {
  return {
    sentAt: SENT_AT,
    channel: "manual",
    invoiceJobId: INVOICE_JOB_ID,
    invoiceArtifactSha256: INVOICE_SHA,
    paymentJobId: PAYMENT_JOB_ID,
    paymentArtifactSha256: PAYMENT_SHA,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.authorizedAction.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    operation: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
  ) => operation(TX, CTX));
  deps.markSentWithDelivery.mockResolvedValue({
    documentId: DOCUMENT_ID,
    type: "invoice",
    channel: "manual",
    sentAt: SENT_AT,
    invoiceJobId: INVOICE_JOB_ID,
    invoiceArtifactSha256: INVOICE_SHA,
    paymentJobId: PAYMENT_JOB_ID,
    paymentArtifactSha256: PAYMENT_SHA,
  });
});

describe("F8-19 delivery action", () => {
  it("F819-CT-04: autorisiert invoicing.write, uebergibt nur die drei kanonischen Felder und revalidiert die Detailseite", async () => {
    const result = await markSentWithDeliveryAction(
      MARK_SENT_WITH_DELIVERY_INITIAL_STATE,
      validForm(),
    );

    expect(deps.authorizedAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "invoicing.write",
      "commercial_document_delivery",
      expect.any(Function),
    );
    expect(deps.markSentWithDelivery).toHaveBeenCalledWith(TX, CTX, {
      schemaVersion: "commercial-document-delivery-command.v1",
      documentId: DOCUMENT_ID,
      channel: "manual",
    });
    expect(result).toEqual({
      status: "success",
      sentAt: SENT_AT,
      invoiceJobId: INVOICE_JOB_ID,
      paymentJobId: PAYMENT_JOB_ID,
    });
    expect(deps.revalidatePath).toHaveBeenCalledWith(
      `/w/${WORKSPACE_ID}/rechnungen/invoice/${DOCUMENT_ID}`,
    );
  });

  it("F819-CT-04: akzeptiert ausschliesslich framework-interne $ACTION-Felder zusaetzlich", async () => {
    const accepted = validForm();
    accepted.set("$ACTION_ID_safe", "framework-value");
    await expect(markSentWithDeliveryAction(
      MARK_SENT_WITH_DELIVERY_INITIAL_STATE,
      accepted,
    )).resolves.toMatchObject({ status: "success" });

    const rejected = validForm();
    rejected.set("type", "invoice");
    await expect(markSentWithDeliveryAction(
      MARK_SENT_WITH_DELIVERY_INITIAL_STATE,
      rejected,
    )).resolves.toEqual({ status: "invalid" });
    expect(deps.markSentWithDelivery).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ungueltige Workspace-ID", { workspaceId: "kein-uuid" }],
    ["doppelte Workspace-ID", { duplicateWorkspace: true }],
    ["ungueltige Document-ID", { documentId: "kein-uuid" }],
    ["fehlender Kanal", { dropChannel: true }],
    ["reservierter Kanal email", { channel: "email" }],
    ["reservierter Kanal post", { channel: "post" }],
  ])("F819-CT-04: weist %s ohne Fachserviceaufruf ab", async (_label, mutation) => {
    const formData = validForm();
    if ("workspaceId" in mutation) formData.set("workspaceId", mutation.workspaceId);
    if ("duplicateWorkspace" in mutation) formData.append("workspaceId", WORKSPACE_ID);
    if ("documentId" in mutation) formData.set("documentId", mutation.documentId);
    if ("dropChannel" in mutation) formData.delete("channel");
    if ("channel" in mutation) formData.set("channel", mutation.channel);

    await expect(markSentWithDeliveryAction(
      MARK_SENT_WITH_DELIVERY_INITIAL_STATE,
      formData,
    )).resolves.toEqual({ status: "invalid" });
    expect(deps.markSentWithDelivery).not.toHaveBeenCalled();
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });

  it("F819-CT-04: normalisiert UUIDs kleingeschrieben", async () => {
    const formData = validForm();
    formData.set("workspaceId", WORKSPACE_ID.toUpperCase());
    formData.set("documentId", DOCUMENT_ID.toUpperCase());

    await expect(markSentWithDeliveryAction(
      MARK_SENT_WITH_DELIVERY_INITIAL_STATE,
      formData,
    )).resolves.toMatchObject({ status: "success" });
    expect(deps.markSentWithDelivery).toHaveBeenCalledWith(TX, CTX, {
      schemaVersion: "commercial-document-delivery-command.v1",
      documentId: DOCUMENT_ID,
      channel: "manual",
    });
  });

  it.each([
    [new deps.NotAuthenticatedError(), { status: "unauthenticated" }],
    [new deps.PermissionDeniedError(), { status: "denied" }],
    [new deps.InvoicingValidationError(), { status: "invalid" }],
    [new deps.InvoicingNotFoundError(), { status: "not_found" }],
    [new deps.InvoicingConflictError(), { status: "conflict" }],
    [new deps.InvoicingIntegrityError(), { status: "unavailable" }],
  ] as const)("F819-CT-04: redigiert Fehler und revalidiert nie", async (error, expected) => {
    deps.markSentWithDelivery.mockRejectedValueOnce(error);

    await expect(markSentWithDeliveryAction(
      MARK_SENT_WITH_DELIVERY_INITIAL_STATE,
      validForm(),
    )).resolves.toEqual(expected);
    expect(deps.revalidatePath).not.toHaveBeenCalled();
    expect(JSON.stringify(expected)).not.toContain(error.message);
  });

  it("F819-CT-04: unbekannte Fehler werden nicht verschluckt", async () => {
    const boom = new Error("private boom sentinel");
    deps.markSentWithDelivery.mockRejectedValueOnce(boom);

    await expect(markSentWithDeliveryAction(
      MARK_SENT_WITH_DELIVERY_INITIAL_STATE,
      validForm(),
    )).rejects.toBe(boom);
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("F8-19 versand panel", () => {
  function renderPanel(options: {
    canSend: boolean;
    delivery: DeliverySurfaceView | null;
    downloads?: Array<{ jobId: string; kind: "invoice" | "payment"; href: string }>;
  }): string {
    return renderToStaticMarkup(createElement(VersandPanel, {
      workspaceId: WORKSPACE_ID,
      type: "invoice",
      documentId: DOCUMENT_ID,
      canSend: options.canSend,
      delivery: options.delivery,
      downloads: options.downloads ?? [],
    }));
  }

  it("F819-CT-05: gibt Editoren ein semantisches Formular mit drei kanonischen Feldern", () => {
    const html = renderPanel({ canSend: true, delivery: null });

    expect(html).toContain("<form");
    expect(html).toContain('name="workspaceId"');
    expect(html).toContain('name="documentId"');
    expect(html).toContain('name="channel"');
    expect(html).toContain('value="manual"');
    expect(html).not.toContain('name="type"');
    expect(html).toContain("Als versendet markieren");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("delivery-sent-badge");
  });

  it("F819-CT-05: zeigt Lesern ohne Senderecht kein Formular", () => {
    const html = renderPanel({ canSend: false, delivery: null });

    expect(html).toContain("Nur Lesezugriff");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Als versendet markieren</button>");
  });

  it("F819-CT-05: zeigt nach Versand Badge, Nachweis mit SHA-Kurzformen und deaktivierten Button", () => {
    const html = renderPanel({
      canSend: true,
      delivery: delivered(),
      downloads: [
        { jobId: INVOICE_JOB_ID, kind: "invoice", href: `/w/${WORKSPACE_ID}/rechnungen/invoice/${DOCUMENT_ID}/pdf/${INVOICE_JOB_ID}` },
        { jobId: PAYMENT_JOB_ID, kind: "payment", href: `/w/${WORKSPACE_ID}/rechnungen/invoice/${DOCUMENT_ID}/pdf/${PAYMENT_JOB_ID}` },
      ],
    });

    expect(html).toContain('data-testid="delivery-sent-badge"');
    expect(html).toContain("Versendet");
    expect(html).toContain("Manuell (externer Versand)");
    expect(html).toContain(`dateTime="${SENT_AT}"`);
    // Kurzformen sichtbar, volle Hashes nur als Titel-Hinweis.
    expect(html).toContain(`${INVOICE_SHA.slice(0, 12)}…`);
    expect(html).toContain(`${PAYMENT_SHA.slice(0, 12)}…`);
    expect(html).toContain(`title="${INVOICE_SHA}"`);
    expect(html).toContain(`title="${PAYMENT_SHA}"`);
    expect(html).toContain(`/pdf/${INVOICE_JOB_ID}`);
    expect(html).toContain(`/pdf/${PAYMENT_JOB_ID}`);
    expect(html).toContain("Rechnungs-PDF laden");
    expect(html).toContain("Zahlungsbeleg laden");
    // Nach Versand deaktiviert: kein Re-Send-Formular, Button trägt disabled.
    expect(html).not.toContain("<form");
    expect(html).toContain("Bereits versendet");
    expect(html).toContain("disabled");
  });

  it("F819-CT-05: Rechnung-ohne-Beleg zeigt explizit keinen Zahlungsbeleg", () => {
    const html = renderPanel({
      canSend: false,
      delivery: { ...delivered(), paymentJobId: null, paymentArtifactSha256: null },
      downloads: [
        { jobId: INVOICE_JOB_ID, kind: "invoice", href: `/w/${WORKSPACE_ID}/rechnungen/invoice/${DOCUMENT_ID}/pdf/${INVOICE_JOB_ID}` },
      ],
    });

    expect(html).toContain("Kein Zahlungsbeleg beigefügt.");
    expect(html).not.toContain("Zahlungsbeleg laden");
    expect(html).toContain(`/pdf/${INVOICE_JOB_ID}`);
  });
});
