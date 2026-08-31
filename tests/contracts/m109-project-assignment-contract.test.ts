import { describe, expect, it } from "vitest";
import {
  PROJECT_ASSIGNMENT_COMMAND_VERSION,
  PROJECT_ASSIGNMENT_MAX_USERS,
  projectAssignmentCommandV1Schema,
  projectAssignmentSearchV1Schema,
} from "@/modules/projects";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const MEMBERSHIP_ID = "20000000-0000-4000-8000-000000000002";

describe("M1-09 Assignment-Vertrag", () => {
  it("akzeptiert exakt die vier Commands und kanonisiert UUIDs", () => {
    expect(projectAssignmentCommandV1Schema.parse({
      schemaVersion: PROJECT_ASSIGNMENT_COMMAND_VERSION,
      kind: "set_key_account",
      projectId: PROJECT_ID.toUpperCase(),
      membershipId: MEMBERSHIP_ID.toUpperCase(),
      expectedAssignmentRevision: 0,
    })).toEqual({
      schemaVersion: PROJECT_ASSIGNMENT_COMMAND_VERSION,
      kind: "set_key_account",
      projectId: PROJECT_ID,
      membershipId: MEMBERSHIP_ID,
      expectedAssignmentRevision: 0,
    });

    for (const kind of ["add_user", "remove_user"] as const) {
      expect(projectAssignmentCommandV1Schema.safeParse({
        schemaVersion: PROJECT_ASSIGNMENT_COMMAND_VERSION,
        kind,
        projectId: PROJECT_ID,
        membershipId: MEMBERSHIP_ID,
        expectedAssignmentRevision: 7,
      }).success).toBe(true);
    }
    expect(projectAssignmentCommandV1Schema.safeParse({
      schemaVersion: PROJECT_ASSIGNMENT_COMMAND_VERSION,
      kind: "clear_key_account",
      projectId: PROJECT_ID,
      expectedAssignmentRevision: 3,
    }).success).toBe(true);
  });

  it("weist Unknowns, Fremdfelder und unzulässige Revisionen ab", () => {
    const valid = {
      schemaVersion: PROJECT_ASSIGNMENT_COMMAND_VERSION,
      kind: "add_user",
      projectId: PROJECT_ID,
      membershipId: MEMBERSHIP_ID,
      expectedAssignmentRevision: 0,
    } as const;
    for (const candidate of [
      { ...valid, workspaceId: PROJECT_ID },
      { ...valid, actorId: MEMBERSHIP_ID },
      { ...valid, email: "private@example.test" },
      { ...valid, expectedAssignmentRevision: -1 },
      { ...valid, expectedAssignmentRevision: 1.5 },
      { ...valid, expectedAssignmentRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, membershipId: "not-a-uuid" },
      { ...valid, kind: "assign_team" },
    ]) {
      expect(projectAssignmentCommandV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("erzwingt die getrennte clear-Form ohne versteckte Membership-ID", () => {
    expect(projectAssignmentCommandV1Schema.safeParse({
      schemaVersion: PROJECT_ASSIGNMENT_COMMAND_VERSION,
      kind: "clear_key_account",
      projectId: PROJECT_ID,
      membershipId: MEMBERSHIP_ID,
      expectedAssignmentRevision: 2,
    }).success).toBe(false);
  });

  it("begrenzt und normalisiert die serverseitige Membership-Suche", () => {
    expect(projectAssignmentSearchV1Schema.parse({ query: "  MIA@Example.test  " }))
      .toEqual({ query: "MIA@Example.test" });
    expect(projectAssignmentSearchV1Schema.safeParse({ query: "a" }).success).toBe(false);
    expect(projectAssignmentSearchV1Schema.safeParse({ query: "x".repeat(101) }).success).toBe(false);
    expect(projectAssignmentSearchV1Schema.safeParse({ query: "ok", workspaceId: PROJECT_ID }).success)
      .toBe(false);
  });

  it("pinnt das direkte Nutzerlimit", () => {
    expect(PROJECT_ASSIGNMENT_MAX_USERS).toBe(50);
  });
});
