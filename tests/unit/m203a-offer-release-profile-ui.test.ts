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
  class OfferReleaseProfileValidationError extends Error {
    constructor(public readonly paths: string[] = []) { super("private validation"); }
  }
  class OfferReleaseProfileConflictError extends Error {
    constructor(public readonly currentRevision?: number) { super("private conflict"); }
  }
  class OfferReleaseProfileNotFoundError extends Error {
    constructor() { super("private not-found sentinel"); }
  }
  class OfferReleaseProfileIntegrityError extends Error {
    constructor() { super("private integrity sentinel"); }
  }
  class OfferReleaseProfilePersistenceError extends Error {
    constructor() { super("private persistence sentinel"); }
  }
  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    OfferReleaseProfileValidationError,
    OfferReleaseProfileConflictError,
    OfferReleaseProfileNotFoundError,
    OfferReleaseProfileIntegrityError,
    OfferReleaseProfilePersistenceError,
    authorizedAction: vi.fn(),
    reviseOfferReleaseProfile: vi.fn(),
    activateOfferReleaseProfile: vi.fn(),
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
vi.mock("@/modules/offers", () => ({
  reviseOfferReleaseProfile: deps.reviseOfferReleaseProfile,
  activateOfferReleaseProfile: deps.activateOfferReleaseProfile,
  OfferReleaseProfileValidationError: deps.OfferReleaseProfileValidationError,
  OfferReleaseProfileConflictError: deps.OfferReleaseProfileConflictError,
  OfferReleaseProfileNotFoundError: deps.OfferReleaseProfileNotFoundError,
  OfferReleaseProfileIntegrityError: deps.OfferReleaseProfileIntegrityError,
  OfferReleaseProfilePersistenceError: deps.OfferReleaseProfilePersistenceError,
}));

import {
  activateOfferReleaseProfileAction,
  reviseOfferReleaseProfileAction,
} from "@/app/w/[workspaceId]/einstellungen/angebotsprofile/actions";
import { OFFER_RELEASE_PROFILE_INITIAL_STATE } from "@/app/w/[workspaceId]/einstellungen/angebotsprofile/action-state";
import {
  OfferReleaseProfileForm,
  type OfferReleaseProfileSurface,
} from "@/app/w/[workspaceId]/einstellungen/angebotsprofile/offer-release-profile-form";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const PROFILE_ID = "20000000-0000-4000-8000-000000000002";
const PROFILE_REVISION_ID = "30000000-0000-4000-8000-000000000003";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "40000000-0000-4000-8000-000000000004" };

function profileForm(): FormData {
  const form = new FormData();
  const values: Record<string, string> = {
    schemaVersion: "offer-release-profile-revise-command.v1",
    workspaceId: WORKSPACE_ID,
    expectedCurrentRevision: "0",
    profileName: "Synthetisches Angebotsprofil",
    legalName: "Beispiel Energie GmbH",
    tradingName: "",
    representedBy: "Beispiel Vertretung",
    street: "Testweg",
    houseNumber: "7",
    postalCode: "69168",
    city: "Dielheim",
    country: "DE",
    email: "angebot@example.test",
    phoneE164: "",
    websiteHttpsUrl: "",
    registerCourt: "",
    registerNumber: "",
    vatId: "",
    termsTitle: "Synthetische Angebotsbedingungen",
    termsPlainText: "Ausschließlich synthetischer Testtext.",
    withdrawalInformationTitle: "Synthetische Widerrufsinformation",
    withdrawalInformationPlainText: "Ausschließlich synthetischer Testtext.",
    privacyNoticeTitle: "Synthetischer Datenschutzhinweis",
    privacyNoticePlainText: "Ausschließlich synthetischer Testtext.",
  };
  for (const [name, value] of Object.entries(values)) form.set(name, value);
  return form;
}

function activationForm(): FormData {
  const form = new FormData();
  form.set("schemaVersion", "offer-release-profile-activate-command.v1");
  form.set("workspaceId", WORKSPACE_ID);
  form.set("profileId", PROFILE_ID);
  form.set("profileRevisionId", PROFILE_REVISION_ID);
  form.set("expectedProfileRevision", "1");
  form.set("operatorReviewed", "true");
  return form;
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.authorizedAction.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    operation: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
  ) => operation(TX, CTX));
  deps.reviseOfferReleaseProfile.mockResolvedValue({
    profileId: PROFILE_ID,
    profileRevisionId: PROFILE_REVISION_ID,
    revision: 1,
  });
  deps.activateOfferReleaseProfile.mockResolvedValue({
    profileId: PROFILE_ID,
    profileRevisionId: PROFILE_REVISION_ID,
    profileRevision: 1,
  });
});

describe("M2-03a Angebotsprofil-Actions", () => {
  it("reauthorisiert die Revision und übergibt nur den strict Command mit echten Nullwerten", async () => {
    const result = await reviseOfferReleaseProfileAction(
      OFFER_RELEASE_PROFILE_INITIAL_STATE,
      profileForm(),
    );

    expect(deps.authorizedAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "settings.manage",
      "offer_release_profile",
      expect.any(Function),
    );
    expect(deps.reviseOfferReleaseProfile).toHaveBeenCalledWith(TX, CTX, {
      schemaVersion: "offer-release-profile-revise-command.v1",
      workspaceId: WORKSPACE_ID,
      expectedCurrentRevision: 0,
      profileName: "Synthetisches Angebotsprofil",
      sender: {
        legalName: "Beispiel Energie GmbH",
        tradingName: null,
        representedBy: "Beispiel Vertretung",
        address: {
          street: "Testweg",
          houseNumber: "7",
          postalCode: "69168",
          city: "Dielheim",
          country: "DE",
        },
        email: "angebot@example.test",
        phoneE164: null,
        websiteHttpsUrl: null,
        registerCourt: null,
        registerNumber: null,
        vatId: null,
      },
      legalDocuments: {
        terms: {
          title: "Synthetische Angebotsbedingungen",
          plainText: "Ausschließlich synthetischer Testtext.",
        },
        withdrawalInformation: {
          title: "Synthetische Widerrufsinformation",
          plainText: "Ausschließlich synthetischer Testtext.",
        },
        privacyNotice: {
          title: "Synthetischer Datenschutzhinweis",
          plainText: "Ausschließlich synthetischer Testtext.",
        },
      },
    });
    expect(result).toEqual({
      status: "revised",
      profileId: PROFILE_ID,
      profileRevisionId: PROFILE_REVISION_ID,
      revision: 1,
    });
    expect(deps.revalidatePath).toHaveBeenCalledWith(
      `/w/${WORKSPACE_ID}/einstellungen/angebotsprofile`,
    );
  });

  it("weist unbekannte und doppelte Felder vor der Autorisierung ab", async () => {
    const unknown = profileForm();
    unknown.set("snapshotSha256", "attacker-choice");
    await expect(reviseOfferReleaseProfileAction(
      OFFER_RELEASE_PROFILE_INITIAL_STATE,
      unknown,
    )).resolves.toEqual({ status: "invalid" });

    const duplicate = profileForm();
    duplicate.append("workspaceId", WORKSPACE_ID);
    await expect(reviseOfferReleaseProfileAction(
      OFFER_RELEASE_PROFILE_INITIAL_STATE,
      duplicate,
    )).resolves.toEqual({ status: "invalid" });
    expect(deps.authorizedAction).not.toHaveBeenCalled();
  });

  it("aktiviert ausschließlich den exakt sichtbaren Profilstand", async () => {
    await expect(activateOfferReleaseProfileAction(
      OFFER_RELEASE_PROFILE_INITIAL_STATE,
      activationForm(),
    )).resolves.toEqual({
      status: "activated",
      profileId: PROFILE_ID,
      profileRevisionId: PROFILE_REVISION_ID,
      revision: 1,
    });
    expect(deps.activateOfferReleaseProfile).toHaveBeenCalledWith(TX, CTX, {
      schemaVersion: "offer-release-profile-activate-command.v1",
      workspaceId: WORKSPACE_ID,
      profileId: PROFILE_ID,
      profileRevisionId: PROFILE_REVISION_ID,
      expectedProfileRevision: 1,
    });
  });

  it("verweigert die Aktivierung ohne ausdrückliche Betreiberprüfung", async () => {
    const form = activationForm();
    form.delete("operatorReviewed");
    await expect(activateOfferReleaseProfileAction(
      OFFER_RELEASE_PROFILE_INITIAL_STATE,
      form,
    )).resolves.toEqual({ status: "invalid", paths: ["/operatorReviewed"] });
    expect(deps.activateOfferReleaseProfile).not.toHaveBeenCalled();
  });

  it.each([
    [new deps.NotAuthenticatedError(), { status: "unauthenticated" }],
    [new deps.PermissionDeniedError(), { status: "denied" }],
    [new deps.OfferReleaseProfileValidationError(["/sender/email"]), {
      status: "invalid",
      paths: ["/sender/email"],
    }],
    [new deps.OfferReleaseProfileConflictError(4), {
      status: "conflict",
      currentRevision: 4,
    }],
    [new deps.OfferReleaseProfileNotFoundError(), { status: "not_found" }],
    [new deps.OfferReleaseProfileIntegrityError(), { status: "unavailable" }],
    [new deps.OfferReleaseProfilePersistenceError(), { status: "unavailable" }],
  ])("redigiert %s in einen geschlossenen Oberflächenstatus", async (error, expected) => {
    deps.reviseOfferReleaseProfile.mockRejectedValueOnce(error);
    const result = await reviseOfferReleaseProfileAction(
      OFFER_RELEASE_PROFILE_INITIAL_STATE,
      profileForm(),
    );
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(error.message);
  });
});

describe("M2-03a Angebotsprofil-Oberfläche", () => {
  const profile: OfferReleaseProfileSurface = {
    profileId: PROFILE_ID,
    currentRevision: 1,
    current: {
      profileRevisionId: PROFILE_REVISION_ID,
      profileName: "Synthetisches Angebotsprofil",
      sender: {
        legalName: "Beispiel Energie GmbH",
        tradingName: null,
        representedBy: "Beispiel Vertretung",
        address: {
          street: "Testweg",
          houseNumber: "7",
          postalCode: "69168",
          city: "Dielheim",
          country: "DE",
        },
        email: "angebot@example.test",
        phoneE164: null,
        websiteHttpsUrl: null,
        registerCourt: null,
        registerNumber: null,
        vatId: null,
      },
      legalDocuments: {
        terms: { title: "Testbedingungen", plainText: "Synthetischer Testtext" },
        withdrawalInformation: { title: "Testwiderruf", plainText: "Synthetischer Testtext" },
        privacyNotice: { title: "Testdatenschutz", plainText: "Synthetischer Testtext" },
      },
    },
    active: null,
  };

  it("nutzt semantische Gruppen, vollständige Labels und eine getrennte Aktivierung", () => {
    const html = renderToStaticMarkup(createElement(OfferReleaseProfileForm, {
      workspaceId: WORKSPACE_ID,
      profile,
      canManage: true,
    }));

    expect(html).toContain("<fieldset");
    expect(html).toContain("Angebotsprofil erfassen");
    expect(html).toContain("Es gibt keine Standardtexte");
    expect(html).toContain('name="expectedCurrentRevision" value="1"');
    expect(html).toContain("Neue Profilrevision speichern");
    expect(html).toContain("Revision 1 als geprüft aktivieren");
    expect(html).toContain('name="operatorReviewed"');
    expect(html).toContain("übernehme die Betreiberverantwortung");
    expect(html).toContain("required");
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("WMEE Solar &amp; Energie GmbH");
  });

  it("entfernt für Nicht-Admins sämtliche Mutationsformulare", () => {
    const html = renderToStaticMarkup(createElement(OfferReleaseProfileForm, {
      workspaceId: WORKSPACE_ID,
      profile,
      canManage: false,
    }));
    expect(html).toContain("Nur Lesezugriff");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Neue Profilrevision speichern");
    expect(html).not.toContain("als geprüft aktivieren");
  });
});
