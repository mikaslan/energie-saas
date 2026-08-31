import { z } from "zod";

export const PROJECT_ASSIGNMENT_COMMAND_VERSION = "project-assignment-command.v1" as const;
export const PROJECT_ASSIGNMENT_MAX_USERS = 50 as const;

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const base = {
  schemaVersion: z.literal(PROJECT_ASSIGNMENT_COMMAND_VERSION),
  projectId: uuidSchema,
  expectedAssignmentRevision: revisionSchema,
} as const;

const targetCommand = (kind: "set_key_account" | "add_user" | "remove_user") =>
  z.strictObject({
    ...base,
    kind: z.literal(kind),
    membershipId: uuidSchema,
  });

export const projectAssignmentCommandV1Schema = z.discriminatedUnion("kind", [
  targetCommand("set_key_account"),
  z.strictObject({
    ...base,
    kind: z.literal("clear_key_account"),
  }),
  targetCommand("add_user"),
  targetCommand("remove_user"),
]);

export type ProjectAssignmentCommandV1 = z.infer<typeof projectAssignmentCommandV1Schema>;

export const projectAssignmentSearchV1Schema = z.strictObject({
  query: z.string().trim().min(2).max(100),
});

export type ProjectAssignmentSearchV1 = z.infer<typeof projectAssignmentSearchV1Schema>;
