"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { TEAM_LIST_MAX } from "@/lib/integrations/teams/contract";
import {
  createTeam,
  renameTeam,
  setTeamActive,
  setTeamMembers,
  TeamConflictError,
  TeamNotFoundError,
  TeamValidationError,
} from "@/modules/teams";

export type TeamActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid"; message?: string }
  | { status: "conflict"; message?: string }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const SETTINGS_PATH = (workspace: string): string => `/w/${workspace}/einstellungen/teams`;

function parseWorkspace(formData: FormData): string | null {
  const value = formData.get("workspaceId");
  if (typeof value !== "string") return null;
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseTeamId(formData: FormData): string | null {
  const value = formData.get("teamId");
  if (typeof value !== "string") return null;
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseRevision(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}

function parseMemberIds(formData: FormData): string[] | null {
  const raw = formData.get("membershipIds");
  if (raw === null) return [];
  if (typeof raw !== "string") return null;
  if (raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > TEAM_LIST_MAX) return null;
    if (!parsed.every((item) => typeof item === "string")) return null;
    const ids = (parsed as string[]).map((item) => item.toLowerCase());
    if (!ids.every((id) => uuidSchema.safeParse(id).success)) return null;
    return [...new Set(ids)];
  } catch {
    return null;
  }
}

function mapError(error: unknown): TeamActionState {
  if (error instanceof TeamValidationError) {
    return { status: "invalid", message: "Eingaben prüfen (Name 1–120 Zeichen, gültige Mitglieder)." };
  }
  if (error instanceof TeamConflictError) {
    return { status: "conflict", message: "Name bereits vergeben oder Stand veraltet — Seite neu laden." };
  }
  if (error instanceof TeamNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

async function run(
  workspace: string,
  work: (tx: never, ctx: never) => Promise<unknown>,
  message: string,
): Promise<TeamActionState> {
  try {
    await authorizedAction(workspace, "settings.manage", "team", work as never);
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message };
  } catch (error) {
    return mapError(error);
  }
}

export async function createTeamAction(
  _previous: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const workspace = parseWorkspace(formData);
  const name = formData.get("name");
  if (!workspace || typeof name !== "string") return { status: "invalid" };
  return run(workspace, (tx, ctx) => createTeam(tx, ctx, { name }), "Team angelegt.");
}

export async function renameTeamAction(
  _previous: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const workspace = parseWorkspace(formData);
  const teamId = parseTeamId(formData);
  const name = formData.get("name");
  const expectedRevision = parseRevision(formData.get("expectedRevision"));
  if (!workspace || !teamId || typeof name !== "string" || expectedRevision === null) {
    return { status: "invalid" };
  }
  return run(
    workspace,
    (tx, ctx) => renameTeam(tx, ctx, { id: teamId, name, expectedRevision }),
    "Team umbenannt.",
  );
}

export async function setTeamActiveAction(
  _previous: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const workspace = parseWorkspace(formData);
  const teamId = parseTeamId(formData);
  const activeValue = formData.get("active");
  const expectedRevision = parseRevision(formData.get("expectedRevision"));
  if (!workspace || !teamId || (activeValue !== "true" && activeValue !== "false") || expectedRevision === null) {
    return { status: "invalid" };
  }
  const active = activeValue === "true";
  return run(
    workspace,
    (tx, ctx) => setTeamActive(tx, ctx, { id: teamId, active, expectedRevision }),
    active ? "Team wiederhergestellt." : "Team archiviert.",
  );
}

export async function setTeamMembersAction(
  _previous: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const workspace = parseWorkspace(formData);
  const teamId = parseTeamId(formData);
  const membershipIds = parseMemberIds(formData);
  if (!workspace || !teamId || membershipIds === null) return { status: "invalid" };
  return run(
    workspace,
    (tx, ctx) => setTeamMembers(tx, ctx, { id: teamId, membershipIds }),
    "Mitglieder gespeichert.",
  );
}
