import { z } from "zod";

export const PROJECT_TEAM_ASSIGNMENT_COMMAND_VERSION =
  "project-team-assignment-command.v1" as const;
export const PROJECT_TEAM_ASSIGNMENT_MAX_TEAMS = 50 as const;

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const base = {
  schemaVersion: z.literal(PROJECT_TEAM_ASSIGNMENT_COMMAND_VERSION),
  projectId: uuidSchema,
  expectedTeamAssignmentRevision: revisionSchema,
} as const;

const targetCommand = (kind: "assign_team" | "unassign_team") =>
  z.strictObject({
    ...base,
    kind: z.literal(kind),
    teamId: uuidSchema,
  });

export const projectTeamAssignmentCommandV1Schema = z.discriminatedUnion("kind", [
  targetCommand("assign_team"),
  targetCommand("unassign_team"),
]);

export type ProjectTeamAssignmentCommandV1 = z.infer<
  typeof projectTeamAssignmentCommandV1Schema
>;
