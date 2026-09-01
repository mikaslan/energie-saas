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
      "PROJECT_ASSIGNMENT_COMMAND_VERSION",
      "PROJECT_ASSIGNMENT_MAX_USERS",
      "PROJECT_CLOSED_REQUEST_CURSOR_MAX_LENGTH",
      "PROJECT_CLOSED_REQUEST_PAGE_LIMIT",
      "PROJECT_LOSS_REASON_COMMAND_VERSION",
      "PROJECT_LOSS_REASON_LABEL_MAX_LENGTH",
      "PROJECT_OUTCOME_COMMAND_VERSION",
      "PROJECT_OUTCOME_MAX_REVISION",
      "PROJECT_OUTCOME_TEXT_MAX_LENGTH",
      "ProjectAssignmentConflictError",
      "ProjectAssignmentLimitError",
      "ProjectAssignmentNotFoundError",
      "ProjectAssignmentRoleError",
      "ProjectAssignmentTargetError",
      "ProjectAssignmentValidationError",
      "ProjectLossReasonConflictError",
      "ProjectLossReasonNotFoundError",
      "ProjectLossReasonUnavailableError",
      "ProjectLossReasonValidationError",
      "ProjectOutcomeConflictError",
      "ProjectOutcomeIllegalTransitionError",
      "ProjectOutcomeNotFoundError",
      "ProjectOutcomeValidationError",
      "SiteAddressCollisionError",
      "SiteAddressConflictError",
      "SiteAddressInvalidError",
      "SiteAddressNotEditableError",
      "SiteAddressSharedError",
      "SitePinNotConfirmableError",
      "SitePinOutOfRangeError",
      "changeProjectAssignment",
      "changeProjectLossReason",
      "changeProjectOutcome",
      "confirmProjectSitePin",
      "correctProjectSiteAddress",
      "getProjectAddressCorrectionContext",
      "getProjectAssignmentContext",
      "getProjectOutcomeContext",
      "getProjectPageDetail",
      "getProjectTriageDetail",
      "listClosedRequests",
      "listManagedProjectLossReasons",
      "listProjectLossReasons",
      "projectAssignmentCommandV1Schema",
      "projectAssignmentSearchV1Schema",
      "projectClosedRequestCursorSchema",
      "projectClosedRequestFilterSchema",
      "projectLossReasonCommandV1Schema",
      "projectOutcomeCommandV1Schema",
    ]);
  });
});
