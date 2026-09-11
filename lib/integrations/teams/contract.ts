import { z } from "zod";

// F1-12 Teams (Slice 1) — client-sicherer Anteil (Konstanten + Zod;
// kein Server-Import). Verwaltung settings.manage (Admin), Lesen
// calendar.read, Termin-Schreiben appointment.write (keine neue
// Permission).
export const TEAM_SCHEMA_VERSION = 1;

export const TEAM_NAME_MAX = 120;
export const TEAM_LIST_MAX = 200;

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const teamNameSchema = z
  .string()
  .transform((value) => value.normalize("NFKC").trim())
  .refine((value) => value.length >= 1 && value.length <= TEAM_NAME_MAX, {
    message: "team-name-laenge",
  })
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
    message: "team-name-steuerzeichen",
  });

export const teamDtoSchema = z.strictObject({
  schemaVersion: z.literal(TEAM_SCHEMA_VERSION),
  id: z.uuid(),
  name: z.string().min(1).max(TEAM_NAME_MAX),
  active: z.boolean(),
  revision: z.number().int().min(1),
  members: z.array(z.strictObject({
    membershipId: z.uuid(),
    label: z.string().min(1),
  })),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type TeamDto = z.infer<typeof teamDtoSchema>;

export const teamOptionSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(TEAM_NAME_MAX),
});
export type TeamOption = z.infer<typeof teamOptionSchema>;

// F7-07: Team-Zugehörigkeit je Membership (nur aktive Teams; keine PII —
// Labels löst die Tafel aus dem eigenen Member-Lesepfad auf).
export const teamMembershipSchema = z.strictObject({
  teamId: z.uuid(),
  teamName: z.string().min(1).max(TEAM_NAME_MAX),
  membershipId: z.uuid(),
});
export type TeamMembership = z.infer<typeof teamMembershipSchema>;

export const createTeamCommandSchema = z.strictObject({
  schemaVersion: z.literal(TEAM_SCHEMA_VERSION),
  name: teamNameSchema,
});
export type CreateTeamCommand = z.infer<typeof createTeamCommandSchema>;

export const renameTeamCommandSchema = z.strictObject({
  schemaVersion: z.literal(TEAM_SCHEMA_VERSION),
  id: uuidSchema,
  name: teamNameSchema,
  expectedRevision: z.number().int().min(1),
});
export type RenameTeamCommand = z.infer<typeof renameTeamCommandSchema>;

export const setTeamActiveCommandSchema = z.strictObject({
  schemaVersion: z.literal(TEAM_SCHEMA_VERSION),
  id: uuidSchema,
  active: z.boolean(),
  expectedRevision: z.number().int().min(1),
});
export type SetTeamActiveCommand = z.infer<typeof setTeamActiveCommandSchema>;

export const setTeamMembersCommandSchema = z.strictObject({
  schemaVersion: z.literal(TEAM_SCHEMA_VERSION),
  id: uuidSchema,
  membershipIds: z.array(uuidSchema).max(TEAM_LIST_MAX),
});
export type SetTeamMembersCommand = z.infer<typeof setTeamMembersCommandSchema>;
