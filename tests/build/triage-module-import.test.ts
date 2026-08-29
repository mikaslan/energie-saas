import { describe, expect, it } from "vitest";

describe("M1-05 Modulgrenzen", () => {
  it("exportiert nur die öffentlichen Board- und Project-APIs", async () => {
    const boards = await import("@/modules/boards");
    const projects = await import("@/modules/projects");

    expect(Object.keys(boards).sort()).toEqual([
      "ProjectMoveConflictError",
      "getDefaultRequestBoard",
      "moveProjectCard",
    ]);
    expect(Object.keys(projects).sort()).toEqual([
      "SiteAddressCollisionError",
      "SiteAddressConflictError",
      "SiteAddressInvalidError",
      "SiteAddressNotEditableError",
      "SiteAddressSharedError",
      "SitePinNotConfirmableError",
      "SitePinOutOfRangeError",
      "confirmProjectSitePin",
      "correctProjectSiteAddress",
      "getProjectAddressCorrectionContext",
      "getProjectTriageDetail",
    ]);
  });
});
