import { describe, expect, it } from "vitest";
import {
  PROJECT_LOSS_REASON_COMMAND_VERSION,
  PROJECT_LOSS_REASON_LABEL_MAX_LENGTH,
  PROJECT_OUTCOME_COMMAND_VERSION,
  PROJECT_OUTCOME_MAX_REVISION,
  PROJECT_OUTCOME_TEXT_MAX_LENGTH,
  projectClosedRequestCursorSchema,
  projectClosedRequestFilterSchema,
  projectLossReasonCommandV1Schema,
  projectOutcomeCommandV1Schema,
} from "@/modules/projects";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const REASON_ID = "20000000-0000-4000-8000-000000000002";

describe("M1-11a Project-Outcome-Vertrag", () => {
  it("akzeptiert exakt Won, Lost und Reopen und kanonisiert IDs sowie Text", () => {
    expect(projectOutcomeCommandV1Schema.parse({
      schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
      kind: "mark_lost",
      projectId: PROJECT_ID.toUpperCase(),
      expectedOutcomeRevision: 0,
      lossReasonId: REASON_ID.toUpperCase(),
      lossReasonText: "  Ｋｕｎｄｅ hat verschoben  ",
      confirmation: "mark_lost",
    })).toEqual({
      schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
      kind: "mark_lost",
      projectId: PROJECT_ID,
      expectedOutcomeRevision: 0,
      lossReasonId: REASON_ID,
      lossReasonText: "Kunde hat verschoben",
      confirmation: "mark_lost",
    });

    expect(projectOutcomeCommandV1Schema.safeParse({
      schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
      kind: "mark_won",
      projectId: PROJECT_ID,
      expectedOutcomeRevision: PROJECT_OUTCOME_MAX_REVISION - 1,
      confirmation: "mark_won",
    }).success).toBe(true);
    expect(projectOutcomeCommandV1Schema.safeParse({
      schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
      kind: "reopen",
      projectId: PROJECT_ID,
      expectedOutcomeRevision: 7,
      confirmation: "reopen",
    }).success).toBe(true);
  });

  it("weist Unknowns, Fremdfelder, Cannot-fulfill und falsche Bestätigungen ab", () => {
    const valid = {
      schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
      kind: "mark_won",
      projectId: PROJECT_ID,
      expectedOutcomeRevision: 0,
      confirmation: "mark_won",
    } as const;
    for (const candidate of [
      { ...valid, workspaceId: PROJECT_ID },
      { ...valid, actorId: REASON_ID },
      { ...valid, lossReasonId: REASON_ID },
      { ...valid, expectedOutcomeRevision: -1 },
      { ...valid, expectedOutcomeRevision: 1.5 },
      { ...valid, expectedOutcomeRevision: PROJECT_OUTCOME_MAX_REVISION + 1 },
      { ...valid, projectId: "not-a-uuid" },
      { ...valid, confirmation: "yes" },
      { ...valid, kind: "cannot_fulfill", confirmation: "cannot_fulfill" },
      { ...valid, schemaVersion: "project-outcome-command.v2" },
    ]) {
      expect(projectOutcomeCommandV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("begrenzt Lost-Kommentar und verbietet Steuerzeichen oder leere Strings", () => {
    const valid = {
      schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
      kind: "mark_lost",
      projectId: PROJECT_ID,
      expectedOutcomeRevision: 1,
      lossReasonId: REASON_ID,
      lossReasonText: null,
      confirmation: "mark_lost",
    } as const;
    expect(projectOutcomeCommandV1Schema.safeParse(valid).success).toBe(true);
    for (const lossReasonText of [
      "",
      "   ",
      "Zeile\nZwei",
      "nul\u0000byte",
      "x".repeat(PROJECT_OUTCOME_TEXT_MAX_LENGTH + 1),
    ]) {
      expect(projectOutcomeCommandV1Schema.safeParse({
        ...valid,
        lossReasonText,
      }).success).toBe(false);
    }
  });
});

describe("M1-11a Verlustgrund-Vertrag", () => {
  it("normalisiert Create und akzeptiert revisionsgebundenes Archive/Reactivate", () => {
    expect(projectLossReasonCommandV1Schema.parse({
      schemaVersion: PROJECT_LOSS_REASON_COMMAND_VERSION,
      kind: "create",
      label: "  Ｐｒｅｉｓ／Budget  ",
    })).toEqual({
      schemaVersion: PROJECT_LOSS_REASON_COMMAND_VERSION,
      kind: "create",
      label: "Preis/Budget",
    });
    expect(projectLossReasonCommandV1Schema.safeParse({
      schemaVersion: PROJECT_LOSS_REASON_COMMAND_VERSION,
      kind: "archive",
      reasonId: REASON_ID.toUpperCase(),
      expectedRevision: 2,
      archiveConfirmation: "archive",
    }).success).toBe(true);
    expect(projectLossReasonCommandV1Schema.safeParse({
      schemaVersion: PROJECT_LOSS_REASON_COMMAND_VERSION,
      kind: "reactivate",
      reasonId: REASON_ID,
      expectedRevision: 3,
    }).success).toBe(true);
  });

  it("lehnt Fremdfelder, leere/mehrzeilige/überlange Labels und falsche Revisionen ab", () => {
    const valid = {
      schemaVersion: PROJECT_LOSS_REASON_COMMAND_VERSION,
      kind: "create",
      label: "Kein Budget",
    } as const;
    for (const candidate of [
      { ...valid, workspaceId: PROJECT_ID },
      { ...valid, label: "" },
      { ...valid, label: "  " },
      { ...valid, label: "Mehr\nZeilen" },
      { ...valid, label: "x".repeat(PROJECT_LOSS_REASON_LABEL_MAX_LENGTH + 1) },
      {
        schemaVersion: PROJECT_LOSS_REASON_COMMAND_VERSION,
        kind: "archive",
        reasonId: REASON_ID,
        expectedRevision: 0,
        archiveConfirmation: "archive",
      },
      {
        schemaVersion: PROJECT_LOSS_REASON_COMMAND_VERSION,
        kind: "archive",
        reasonId: REASON_ID,
        expectedRevision: 1,
        archiveConfirmation: "delete",
      },
    ]) {
      expect(projectLossReasonCommandV1Schema.safeParse(candidate).success).toBe(false);
    }
  });
});

describe("M1-11a Closed-List-Vertrag", () => {
  it("begrenzt Filter und opaque Cursor", () => {
    for (const filter of ["all", "won", "lost", "cannot_fulfill"]) {
      expect(projectClosedRequestFilterSchema.parse(filter)).toBe(filter);
    }
    for (const filter of ["open", "archived", ""]) {
      expect(projectClosedRequestFilterSchema.safeParse(filter).success).toBe(false);
    }
    expect(projectClosedRequestCursorSchema.safeParse("eyJ2IjoxfQ").success).toBe(true);
    expect(projectClosedRequestCursorSchema.safeParse("../cursor").success).toBe(false);
    expect(projectClosedRequestCursorSchema.safeParse("x".repeat(513)).success).toBe(false);
  });

  it("pinnt die Grenzen", () => {
    expect(PROJECT_OUTCOME_MAX_REVISION).toBe(2_147_483_647);
    expect(PROJECT_OUTCOME_TEXT_MAX_LENGTH).toBe(500);
    expect(PROJECT_LOSS_REASON_LABEL_MAX_LENGTH).toBe(80);
  });
});
