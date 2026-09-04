"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PORTAL_INVITE_CREATE_VERSION,
  PORTAL_INVITE_WITHDRAW_VERSION,
  PORTAL_TTL_DAYS_DEFAULT,
  PORTAL_WITHDRAW_REASON,
  createPortalInvite,
  withdrawPortalInvite,
  PortalConflictError,
  PortalNotFoundError,
  PortalValidationError,
} from "@/modules/portal";

const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());

export type PortalActionState =
  | { status: "idle" }
  | {
      status: "success";
      operation: "create_invite" | "withdraw_invite";
      inviteId: string;
      token: string | null;
      expiresAt: string;
    }
  | { status: "invalid" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function routePath(workspaceId: string, projectId: string): string {
  return `/w/${workspaceId}/anfragen/${projectId}`;
}

function mapError(error: unknown): PortalActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof PortalValidationError) return { status: "invalid" };
  if (error instanceof PortalNotFoundError) return { status: "not_found" };
  if (error instanceof PortalConflictError) return { status: "conflict" };
  return null;
}

const CREATE_TTL_VALUES = new Set(["7", "14", "30", "60"]);

export async function createPortalInviteAction(
  rawWorkspaceId: string,
  rawProjectId: string,
  _previousState: PortalActionState,
  formData: FormData,
): Promise<PortalActionState> {
  const route = z.strictObject({
    workspaceId: UUID_SCHEMA,
    projectId: UUID_SCHEMA,
  }).safeParse({ workspaceId: rawWorkspaceId, projectId: rawProjectId });
  const ttlValues = formData.getAll("ttlDays");
  if (!route.success || ttlValues.length !== 1 || typeof ttlValues[0] !== "string") {
    return { status: "invalid" };
  }
  const ttlDays = CREATE_TTL_VALUES.has(ttlValues[0])
    ? Number(ttlValues[0])
    : PORTAL_TTL_DAYS_DEFAULT;
  try {
    const result = await authorizedAction(
      route.data.workspaceId,
      "project.write",
      "portal_invite",
      (tx, ctx) => createPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId: route.data.workspaceId,
        projectId: route.data.projectId,
        ttlDays,
      }),
    );
    revalidatePath(routePath(route.data.workspaceId, route.data.projectId));
    return {
      status: "success",
      operation: "create_invite",
      inviteId: result.inviteId,
      token: result.token,
      expiresAt: result.expiresAt,
    };
  } catch (error) {
    const mapped = mapError(error);
    if (mapped) return mapped;
    return { status: "invalid" };
  }
}

const WITHDRAW_REASONS = new Set(PORTAL_WITHDRAW_REASON);

export async function withdrawPortalInviteAction(
  rawWorkspaceId: string,
  rawProjectId: string,
  _previousState: PortalActionState,
  formData: FormData,
): Promise<PortalActionState> {
  const route = z.strictObject({
    workspaceId: UUID_SCHEMA,
    projectId: UUID_SCHEMA,
  }).safeParse({ workspaceId: rawWorkspaceId, projectId: rawProjectId });
  const inviteValues = formData.getAll("inviteId");
  const reasonValues = formData.getAll("reason");
  if (
    !route.success
    || inviteValues.length !== 1 || typeof inviteValues[0] !== "string"
    || reasonValues.length !== 1 || typeof reasonValues[0] !== "string"
    || !WITHDRAW_REASONS.has(reasonValues[0] as (typeof PORTAL_WITHDRAW_REASON)[number])
  ) return { status: "invalid" };
  const invite = z.uuid().safeParse(inviteValues[0]);
  if (!invite.success) return { status: "invalid" };
  try {
    const result = await authorizedAction(
      route.data.workspaceId,
      "project.write",
      "portal_invite",
      (tx, ctx) => withdrawPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_WITHDRAW_VERSION,
        workspaceId: route.data.workspaceId,
        inviteId: invite.data.toLowerCase(),
        reason: reasonValues[0] as (typeof PORTAL_WITHDRAW_REASON)[number],
      }),
    );
    revalidatePath(routePath(route.data.workspaceId, route.data.projectId));
    return {
      status: "success",
      operation: "withdraw_invite",
      inviteId: result.inviteId,
      token: null,
      expiresAt: "",
    };
  } catch (error) {
    const mapped = mapError(error);
    if (mapped) return mapped;
    return { status: "invalid" };
  }
}

