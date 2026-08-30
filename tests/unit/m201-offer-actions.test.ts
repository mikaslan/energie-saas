import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class OfferConflictError extends Error {
    constructor(public readonly currentRevision?: number) {
      super("offer changed since it was loaded");
    }
  }
  class OfferValidationError extends Error {}
  class OfferBlockedError extends OfferValidationError {
    constructor(public readonly code: string) {
      super("offer is blocked");
    }
  }
  class OfferRateLimitError extends Error {
    constructor(public readonly retryAfter: string) {
      super("offer mutation rate limited");
    }
  }

  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    OfferConflictError,
    OfferBlockedError,
    OfferValidationError,
    OfferRateLimitError,
    authorizedOfferMutationAction: vi.fn(),
    createOfferFromRequest: vi.fn(),
    createVariantFromCurrentResolution: vi.fn(),
    duplicateOfferVariant: vi.fn(),
    redirect: vi.fn(),
    revalidatePath: vi.fn(),
    reviseOfferVariant: vi.fn(),
    callOrder: [] as string[],
  };
});

vi.mock("next/cache", () => ({ revalidatePath: deps.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: deps.redirect }));
vi.mock("@/lib/action", () => ({
  authorizedOfferMutationAction: deps.authorizedOfferMutationAction,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/modules/offers", () => ({
  createOfferFromRequest: deps.createOfferFromRequest,
  createVariantFromCurrentResolution: deps.createVariantFromCurrentResolution,
  duplicateOfferVariant: deps.duplicateOfferVariant,
  OfferConflictError: deps.OfferConflictError,
  OfferBlockedError: deps.OfferBlockedError,
  OfferRateLimitError: deps.OfferRateLimitError,
  OfferValidationError: deps.OfferValidationError,
  reviseOfferVariant: deps.reviseOfferVariant,
}));

import {
  createOfferFromRequestAction,
  createVariantFromCurrentResolutionEditorAction,
  createVariantFromCurrentResolutionAction,
  duplicateOfferVariantEditorAction,
  duplicateOfferVariantAction,
  saveOfferVariantDraftAction,
  reviseOfferVariantAction,
} from "@/app/w/[workspaceId]/angebote/actions";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";
const OFFER_ID = "30000000-0000-4000-8000-000000000003";
const SOURCE_VARIANT_ID = "40000000-0000-4000-8000-000000000004";
const VARIANT_ID = "50000000-0000-4000-8000-000000000005";
const DUPLICATE_VARIANT_ID = "60000000-0000-4000-8000-000000000006";
const BASIS_VARIANT_ID = "70000000-0000-4000-8000-000000000007";
const RETRY_AFTER = "2026-08-30T12:15:00.000Z";
const REDIRECT_ERROR = new Error("NEXT_REDIRECT");
const IDLE = { status: "idle" as const };

function form(values: Record<string, string>): FormData {
  const result = new FormData();
  for (const [name, value] of Object.entries(values)) result.set(name, value);
  return result;
}

function validCreateForm(): FormData {
  return form({
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    expectedRequirementRevision: "3",
    expectedCalculationRevision: "4",
    expectedResolutionRevision: "5",
    forecastValueNetCents: "1250000",
    priceAudience: "b2c",
    "priceAudienceConfirmation.code": "b2c_operator_confirmed",
    "priceAudienceConfirmation.confirmed": "true",
    taxTreatment: "standard_19",
  });
}

function validDuplicateForm(): FormData {
  return form({
    workspaceId: WORKSPACE_ID,
    offerId: OFFER_ID,
    sourceVariantId: SOURCE_VARIANT_ID,
    expectedSourceRevision: "7",
    name: "Empfohlen",
  });
}

function validReviseForm(): FormData {
  return form({
    workspaceId: WORKSPACE_ID,
    offerId: OFFER_ID,
    variantId: VARIANT_ID,
    expectedRevision: "7",
    operations: JSON.stringify([
      { operation: "set_variant_name", name: "Empfohlen Plus" },
    ]),
  });
}

function validNewBasisForm(): FormData {
  return form({
    workspaceId: WORKSPACE_ID,
    offerId: OFFER_ID,
    expectedRequirementRevision: "8",
    expectedCalculationRevision: "9",
    expectedResolutionRevision: "10",
    name: "Aktuelle Basis",
    taxTreatment: "standard_19",
  });
}

type OfferAction = (
  previous: typeof IDLE,
  formData: FormData,
) => Promise<unknown>;

interface ActionCase {
  name: string;
  action: OfferAction;
  validForm: () => FormData;
  service: ReturnType<typeof vi.fn>;
}

const actionCases: readonly ActionCase[] = [
  {
    name: "Create",
    action: createOfferFromRequestAction,
    validForm: validCreateForm,
    service: deps.createOfferFromRequest,
  },
  {
    name: "Duplicate",
    action: duplicateOfferVariantAction,
    validForm: validDuplicateForm,
    service: deps.duplicateOfferVariant,
  },
  {
    name: "Revision",
    action: reviseOfferVariantAction,
    validForm: validReviseForm,
    service: deps.reviseOfferVariant,
  },
  {
    name: "neue Basis",
    action: createVariantFromCurrentResolutionAction,
    validForm: validNewBasisForm,
    service: deps.createVariantFromCurrentResolution,
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  deps.callOrder.length = 0;
  deps.authorizedOfferMutationAction.mockImplementation(async (
    _workspaceId: string,
    _capability: string,
    _resource: string,
    callback: (tx: object, ctx: object) => Promise<unknown>,
  ) => callback({}, { workspaceId: WORKSPACE_ID, actor: "member-1" }));
  deps.createOfferFromRequest.mockImplementation(async () => {
    deps.callOrder.push("service:create");
    return { offerId: OFFER_ID, variantId: VARIANT_ID, revision: 1 };
  });
  deps.duplicateOfferVariant.mockImplementation(async () => {
    deps.callOrder.push("service:duplicate");
    return { offerId: OFFER_ID, variantId: DUPLICATE_VARIANT_ID, revision: 1 };
  });
  deps.reviseOfferVariant.mockImplementation(async () => {
    deps.callOrder.push("service:revise");
    return { offerId: OFFER_ID, variantId: VARIANT_ID, revision: 8 };
  });
  deps.createVariantFromCurrentResolution.mockImplementation(async () => {
    deps.callOrder.push("service:new-basis");
    return { offerId: OFFER_ID, variantId: BASIS_VARIANT_ID, revision: 1 };
  });
  deps.revalidatePath.mockImplementation((path: string) => {
    deps.callOrder.push(`revalidate:${path}`);
  });
  deps.redirect.mockImplementation((path: string) => {
    deps.callOrder.push(`redirect:${path}`);
    throw REDIRECT_ERROR;
  });
});

describe("M2-01 Offer-Actions", () => {
  it("speichert den gebündelten Editor-Patch typisiert ohne Redirect und meldet die Serverrevision", async () => {
    const result = await saveOfferVariantDraftAction(validReviseForm());

    expect(result).toEqual({
      status: "success",
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      revision: 8,
    });
    expect(deps.reviseOfferVariant).toHaveBeenCalledTimes(1);
    expect(deps.callOrder).toEqual([
      "service:revise",
      `revalidate:/w/${WORKSPACE_ID}/angebote/${OFFER_ID}`,
      `revalidate:/w/${WORKSPACE_ID}/angebote`,
    ]);
    expect(deps.redirect).not.toHaveBeenCalled();
  });

  it("liefert Duplicate und neue Basis als echte typisierte Editor-Actions ohne Zwischenredirect", async () => {
    const duplicate = await duplicateOfferVariantEditorAction(validDuplicateForm());
    expect(duplicate).toEqual({
      status: "success",
      offerId: OFFER_ID,
      variantId: DUPLICATE_VARIANT_ID,
      revision: 1,
    });

    vi.clearAllMocks();
    const basis = await createVariantFromCurrentResolutionEditorAction(validNewBasisForm());
    expect(basis).toEqual({
      status: "success",
      offerId: OFFER_ID,
      variantId: BASIS_VARIANT_ID,
      revision: 1,
    });
    expect(deps.redirect).not.toHaveBeenCalled();
    expect(deps.revalidatePath).toHaveBeenNthCalledWith(
      1,
      `/w/${WORKSPACE_ID}/angebote/${OFFER_ID}`,
    );
    expect(deps.revalidatePath).toHaveBeenNthCalledWith(
      2,
      `/w/${WORKSPACE_ID}/angebote`,
    );
  });

  it("liefert dem Editor die aktuelle Conflict-Revision ohne Revalidation oder Redirect", async () => {
    deps.reviseOfferVariant.mockRejectedValueOnce(new deps.OfferConflictError(11));

    await expect(saveOfferVariantDraftAction(validReviseForm())).resolves.toEqual({
      status: "conflict",
      currentRevision: 11,
    });
    expect(deps.revalidatePath).not.toHaveBeenCalled();
    expect(deps.redirect).not.toHaveBeenCalled();
  });

  it.each(actionCases)(
    "$name zählt autorisierte Invalid-Versuche und weist sie vor dem Fachservice ab",
    async ({ action, validForm }) => {
      const additional = validForm();
      additional.set("unexpected", "browser-trust");
      const missing = validForm();
      const fieldName = [...missing.keys()].find((name) => name !== "workspaceId");
      if (!fieldName) throw new Error("Fachfeld im Testformular fehlt");
      missing.delete(fieldName);
      const repeated = validForm();
      repeated.append(fieldName, String(repeated.get(fieldName)));
      const file = validForm();
      file.set(fieldName, new File(["browser-trust"], "field.txt"));

      for (const invalidForm of [additional, missing, repeated, file]) {
        await expect(action(IDLE, invalidForm)).resolves.toEqual({ status: "invalid" });
      }

      expect(deps.authorizedOfferMutationAction).toHaveBeenCalledTimes(4);
      expect(deps.createOfferFromRequest).not.toHaveBeenCalled();
      expect(deps.duplicateOfferVariant).not.toHaveBeenCalled();
      expect(deps.reviseOfferVariant).not.toHaveBeenCalled();
      expect(deps.createVariantFromCurrentResolution).not.toHaveBeenCalled();
      expect(deps.revalidatePath).not.toHaveBeenCalled();
      expect(deps.redirect).not.toHaveBeenCalled();
    },
  );

  it.each(actionCases)(
    "$name akzeptiert ausschließlich echte React-Action-Metafelder zusätzlich zur Fach-Allowlist",
    async ({ action, validForm, service }) => {
      const directAction = validForm();
      directAction.set("$ACTION_ID_offerAction", "");
      directAction.set("$ACTION_KEY", "offer-action-state");
      await expect(action(IDLE, directAction)).rejects.toBe(REDIRECT_ERROR);
      expect(service).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();
      const boundAction = validForm();
      boundAction.set("$ACTION_REF_offerAction", "");
      boundAction.set("$ACTION_offerAction:0", "bound-action-descriptor");
      await expect(action(IDLE, boundAction)).rejects.toBe(REDIRECT_ERROR);
      expect(service).toHaveBeenCalledTimes(1);

      for (const forgedName of [
        "$ACTION_EVIL",
        "$ACTION_ID_",
        "$ACTION_REF_",
        "$ACTION_offerAction:not-an-index",
      ]) {
        vi.clearAllMocks();
        const forged = validForm();
        forged.set(forgedName, "browser-trust");
        await expect(action(IDLE, forged)).resolves.toEqual({ status: "invalid" });
        expect(deps.authorizedOfferMutationAction).toHaveBeenCalledTimes(1);
        expect(service).not.toHaveBeenCalled();
        expect(deps.revalidatePath).not.toHaveBeenCalled();
        expect(deps.redirect).not.toHaveBeenCalled();
      }
    },
  );

  it.each(actionCases)(
    "$name übernimmt niemals Actor, DB-Zeit, Hash oder Total aus FormData",
    async ({ action, validForm }) => {
      for (const [name, value] of [
        ["actor", "forged-member"],
        ["createdAt", "2026-08-30T12:00:00.000Z"],
        ["snapshotHash", "a".repeat(64)],
        ["totalGrossCents", "1"],
      ] as const) {
        const forged = validForm();
        forged.set(name, value);
        await expect(action(IDLE, forged)).resolves.toEqual({ status: "invalid" });
      }

      expect(deps.authorizedOfferMutationAction).toHaveBeenCalledTimes(4);
      expect(deps.revalidatePath).not.toHaveBeenCalled();
      expect(deps.redirect).not.toHaveBeenCalled();
    },
  );

  it("baut ausschließlich den geschlossenen Create-Command und revalidiert vor dem exakten Redirect", async () => {
    await expect(createOfferFromRequestAction(IDLE, validCreateForm()))
      .rejects.toBe(REDIRECT_ERROR);

    expect(deps.createOfferFromRequest).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, actor: "member-1" },
      {
        schemaVersion: "offer-create-command.v1",
        projectId: PROJECT_ID,
        expectedRequirementRevision: 3,
        expectedCalculationRevision: 4,
        expectedResolutionRevision: 5,
        forecastValueNetCents: 1_250_000,
        priceAudience: "b2c",
        priceAudienceConfirmation: {
          code: "b2c_operator_confirmed",
          confirmed: true,
        },
        taxTreatment: "standard_19",
      },
    );
    expect(deps.callOrder).toEqual([
      "service:create",
      `revalidate:/w/${WORKSPACE_ID}/anfragen`,
      `revalidate:/w/${WORKSPACE_ID}/anfragen/${PROJECT_ID}`,
      `revalidate:/w/${WORKSPACE_ID}/angebote`,
      `redirect:/w/${WORKSPACE_ID}/angebote/${OFFER_ID}?variante=${VARIANT_ID}`,
    ]);
  });

  it("baut den geschlossenen Duplicate-Command und revalidiert Detail/Liste vor dem Redirect", async () => {
    await expect(duplicateOfferVariantAction(IDLE, validDuplicateForm()))
      .rejects.toBe(REDIRECT_ERROR);

    expect(deps.duplicateOfferVariant).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, actor: "member-1" },
      {
        schemaVersion: "offer-variant-duplicate-command.v1",
        offerId: OFFER_ID,
        sourceVariantId: SOURCE_VARIANT_ID,
        expectedSourceRevision: 7,
        name: "Empfohlen",
      },
    );
    expect(deps.callOrder).toEqual([
      "service:duplicate",
      `revalidate:/w/${WORKSPACE_ID}/angebote/${OFFER_ID}`,
      `revalidate:/w/${WORKSPACE_ID}/angebote`,
      `redirect:/w/${WORKSPACE_ID}/angebote/${OFFER_ID}?variante=${DUPLICATE_VARIANT_ID}`,
    ]);
  });

  it("baut nur den kompakten Revision-Patch und revalidiert Detail/Liste vor dem Redirect", async () => {
    await expect(reviseOfferVariantAction(IDLE, validReviseForm()))
      .rejects.toBe(REDIRECT_ERROR);

    expect(deps.reviseOfferVariant).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, actor: "member-1" },
      {
        schemaVersion: "offer-variant-revise-command.v1",
        offerId: OFFER_ID,
        variantId: VARIANT_ID,
        expectedRevision: 7,
        operations: [{ operation: "set_variant_name", name: "Empfohlen Plus" }],
      },
    );
    expect(deps.callOrder).toEqual([
      "service:revise",
      `revalidate:/w/${WORKSPACE_ID}/angebote/${OFFER_ID}`,
      `revalidate:/w/${WORKSPACE_ID}/angebote`,
      `redirect:/w/${WORKSPACE_ID}/angebote/${OFFER_ID}?variante=${VARIANT_ID}`,
    ]);
  });

  it("baut den geschlossenen Neue-Basis-Command und revalidiert vor dem Varianten-Redirect", async () => {
    await expect(createVariantFromCurrentResolutionAction(IDLE, validNewBasisForm()))
      .rejects.toBe(REDIRECT_ERROR);

    expect(deps.createVariantFromCurrentResolution).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, actor: "member-1" },
      {
        schemaVersion: "offer-variant-from-resolution-command.v1",
        offerId: OFFER_ID,
        expectedRequirementRevision: 8,
        expectedCalculationRevision: 9,
        expectedResolutionRevision: 10,
        name: "Aktuelle Basis",
        taxTreatment: "standard_19",
      },
    );
    expect(deps.callOrder).toEqual([
      "service:new-basis",
      `revalidate:/w/${WORKSPACE_ID}/angebote/${OFFER_ID}`,
      `revalidate:/w/${WORKSPACE_ID}/angebote`,
      `redirect:/w/${WORKSPACE_ID}/angebote/${OFFER_ID}?variante=${BASIS_VARIANT_ID}`,
    ]);
  });

  it.each([
    [() => new deps.NotAuthenticatedError(), { status: "unauthenticated" }],
    [() => new deps.PermissionDeniedError(), { status: "denied" }],
    [() => new deps.OfferBlockedError("variant_limit"), { status: "blocked", code: "variant_limit" }],
    [() => new deps.OfferValidationError(), { status: "invalid" }],
    [() => new deps.OfferConflictError(), { status: "conflict" }],
  ] as const)("bildet %s minimal ab und revalidiert bei Fehlern nie", async (
    createError,
    expected,
  ) => {
    deps.createOfferFromRequest.mockRejectedValueOnce(createError());

    await expect(createOfferFromRequestAction(IDLE, validCreateForm()))
      .resolves.toEqual(expected);
    expect(deps.revalidatePath).not.toHaveBeenCalled();
    expect(deps.redirect).not.toHaveBeenCalled();
  });

  it("liefert bei erschöpfter Quote ausschließlich das stabile UTC-Fensterende", async () => {
    deps.createOfferFromRequest.mockRejectedValueOnce(
      new deps.OfferRateLimitError(RETRY_AFTER),
    );

    const result = await createOfferFromRequestAction(IDLE, validCreateForm());

    expect(result).toEqual({ status: "unavailable", retryAfter: RETRY_AFTER });
    expect(JSON.stringify(result)).not.toContain("offer mutation rate limited");
    expect(deps.revalidatePath).not.toHaveBeenCalled();
    expect(deps.redirect).not.toHaveBeenCalled();
  });

  it.each(actionCases)(
    "$name revalidiert und redirectet bei einem Conflict niemals",
    async ({ action, validForm, service }) => {
      service.mockRejectedValueOnce(new deps.OfferConflictError());

      await expect(action(IDLE, validForm())).resolves.toEqual({ status: "conflict" });
      expect(deps.revalidatePath).not.toHaveBeenCalled();
      expect(deps.redirect).not.toHaveBeenCalled();
    },
  );

  it.each(actionCases)(
    "$name liefert serverseitige Blocker redigiert und mutiert danach nichts",
    async ({ action, validForm, service }) => {
      service.mockRejectedValueOnce(new deps.OfferBlockedError("catalog_pricing_missing"));

      await expect(action(IDLE, validForm())).resolves.toEqual({
        status: "blocked",
        code: "catalog_pricing_missing",
      });
      expect(deps.revalidatePath).not.toHaveBeenCalled();
      expect(deps.redirect).not.toHaveBeenCalled();
    },
  );
});
