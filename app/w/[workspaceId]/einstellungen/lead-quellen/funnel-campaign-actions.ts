"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  FUNNEL_CAMPAIGN_NAME_MAX,
  FUNNEL_CAMPAIGN_SCHEMA_VERSION,
  FUNNEL_CAMPAIGN_SLUG_MAX,
  FUNNEL_CAMPAIGN_SLUG_PATTERN,
  type CreateFunnelCampaignCommand,
} from "@/lib/integrations/funnel-campaigns/contract";
import { LeadSourceNotFoundError } from "@/modules/lead-sources";
import {
  archiveFunnelCampaign,
  createFunnelCampaign,
  FunnelCampaignAssigneeNotFoundError,
  FunnelCampaignConflictError,
  FunnelCampaignNotFoundError,
  FunnelCampaignValidationError,
} from "@/modules/funnel-campaigns";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type FunnelCampaignActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid"; message?: string }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function mapError(error: unknown): FunnelCampaignActionState {
  if (error instanceof FunnelCampaignValidationError) return { status: "invalid" };
  if (error instanceof FunnelCampaignConflictError) return { status: "conflict" };
  if (
    error instanceof FunnelCampaignNotFoundError
    || error instanceof LeadSourceNotFoundError
    || error instanceof FunnelCampaignAssigneeNotFoundError
  ) {
    return { status: "not_found" };
  }
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

function parseWorkspace(formData: FormData): string | null {
  const workspaceValue = formData.get("workspaceId");
  if (typeof workspaceValue !== "string") return null;
  const workspace = workspaceIdSchema.safeParse(workspaceValue);
  return workspace.success ? workspace.data : null;
}

function parseName(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.normalize("NFKC").trim();
  if (trimmed.length < 1 || trimmed.length > FUNNEL_CAMPAIGN_NAME_MAX) return null;
  return trimmed;
}

function parseSlug(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.normalize("NFKC").trim();
  if (trimmed.length < 1 || trimmed.length > FUNNEL_CAMPAIGN_SLUG_MAX) return null;
  return FUNNEL_CAMPAIGN_SLUG_PATTERN.test(trimmed) ? trimmed : null;
}

export async function createFunnelCampaignAction(
  _previous: FunnelCampaignActionState,
  formData: FormData,
): Promise<FunnelCampaignActionState> {
  const workspace = parseWorkspace(formData);
  const name = parseName(formData.get("name"));
  const slug = parseSlug(formData.get("slug"));
  const sourceValue = formData.get("leadSourceId");
  const leadSourceId = typeof sourceValue === "string" ? idSchema.safeParse(sourceValue) : null;
  // F12-02: Beauftragter optional (leerer String = keine Auto-Zuweisung).
  const assigneeValue = formData.get("assigneeMembershipId");
  const assignee = typeof assigneeValue === "string" && assigneeValue !== ""
    ? idSchema.safeParse(assigneeValue)
    : null;
  if (!workspace || name === null || slug === null || !leadSourceId?.success) {
    return { status: "invalid" };
  }
  if (assignee !== null && !assignee.success) return { status: "invalid" };
  const command: CreateFunnelCampaignCommand = {
    schemaVersion: FUNNEL_CAMPAIGN_SCHEMA_VERSION,
    name,
    slug,
    leadSourceId: leadSourceId.data,
    assigneeMembershipId: assignee?.success === true ? assignee.data : null,
  };
  try {
    await authorizedAction(workspace, "lead_source.write", "funnel_campaign", (tx, ctx) =>
      createFunnelCampaign(tx, ctx, command),
    );
    revalidatePath(`/w/${workspace}/einstellungen/lead-quellen`);
    return { status: "success", message: "Funnel-Kampagne angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function archiveFunnelCampaignAction(
  _previous: FunnelCampaignActionState,
  formData: FormData,
): Promise<FunnelCampaignActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "lead_source.write", "funnel_campaign", (tx, ctx) =>
      archiveFunnelCampaign(tx, ctx, id.data),
    );
    revalidatePath(`/w/${workspace}/einstellungen/lead-quellen`);
    return { status: "success", message: "Funnel-Kampagne archiviert." };
  } catch (error) {
    return mapError(error);
  }
}
