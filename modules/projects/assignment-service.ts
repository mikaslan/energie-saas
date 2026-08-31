import { sql } from "drizzle-orm";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { writeAudit } from "@/lib/audit";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type ServiceCtx,
} from "@/lib/permissions";
import {
  PROJECT_ASSIGNMENT_MAX_USERS,
  projectAssignmentCommandV1Schema,
  projectAssignmentSearchV1Schema,
  type ProjectAssignmentCommandV1,
  type ProjectAssignmentSearchV1,
} from "./assignment-contract";
import { getProjectTriageDetail, type ProjectTriageDetail } from "./service";

export type ProjectAssignmentRole = "key_account" | "user";

export type ProjectAssignmentMember = {
  membershipId: string;
  label: string;
};

export type ProjectAssignmentSearchResult = ProjectAssignmentMember & {
  alreadyAssigned: boolean;
  assignmentRole: ProjectAssignmentRole | null;
};

export type ProjectAssignmentContext = {
  projectId: string;
  assignmentRevision: number;
  keyAccount: ProjectAssignmentMember | null;
  users: ProjectAssignmentMember[];
  canAssign: boolean;
  searchResults: ProjectAssignmentSearchResult[];
};

export type AssignedExternalRequestDetail = {
  project: {
    id: string;
    name: string;
    phase: "request";
    outcome: "open";
    createdAt: string;
    columnName: string;
  };
  contact: {
    displayName: string;
    email: string | null;
    phone: string | null;
  };
  site: {
    formattedAddress: string | null;
  };
  requirements: {
    productGroupLabel: string;
    branch: string | null;
    targetStorageKwh: number | null;
    wallbox: boolean;
    bidirectionalCharging: boolean;
    backupPower: boolean;
  };
  blockers: {
    dedupeReviewRequired: boolean;
    addressFollowUpRequired: boolean;
    pinConfirmationRequired: boolean;
    catalogResolutionPending: boolean;
  };
};

export type ProjectPageDetail =
  | { audience: "internal"; record: ProjectTriageDetail }
  | { audience: "assigned_external"; record: AssignedExternalRequestDetail };

type AssignmentRow = {
  membership_id: string;
  assignment_role: ProjectAssignmentRole;
  label: string;
  [key: string]: unknown;
};

type SearchRow = {
  membership_id: string;
  label: string;
  assignment_role: ProjectAssignmentRole | null;
  [key: string]: unknown;
};

type LockedProjectRow = {
  project_id: string;
  assignment_revision: number;
  [key: string]: unknown;
};

type ExternalDetailRow = {
  project_id: string;
  project_name: string;
  created_at: Date | string;
  column_name: string;
  contact_name: string;
  email: string | null;
  phone: string | null;
  formatted_address: string | null;
  requirements_branch: string | null;
  product_group_label: string;
  target_storage_kwh: number | string | null;
  wallbox: boolean | null;
  bidirectional_charging: boolean | null;
  backup_power: boolean | null;
  dedupe_review_required: boolean;
  address_follow_up_required: boolean;
  pin_confirmed: boolean;
  catalog_resolution_status: string;
  [key: string]: unknown;
};

export class ProjectAssignmentValidationError extends Error {
  readonly code = "invalid_assignment_command";

  constructor() {
    super("project assignment command is invalid");
    this.name = "ProjectAssignmentValidationError";
  }
}

export class ProjectAssignmentNotFoundError extends Error {
  readonly code = "project_not_found";

  constructor() {
    super("project assignment target was not found");
    this.name = "ProjectAssignmentNotFoundError";
  }
}

export class ProjectAssignmentTargetError extends Error {
  readonly code = "membership_target_not_found";

  constructor() {
    super("project assignment membership target was not found");
    this.name = "ProjectAssignmentTargetError";
  }
}

export class ProjectAssignmentConflictError extends Error {
  readonly code = "assignment_revision_conflict";

  constructor(public readonly currentRevision?: number) {
    super("project assignment revision is stale");
    this.name = "ProjectAssignmentConflictError";
  }
}

export class ProjectAssignmentLimitError extends Error {
  readonly code = "assignment_limit_reached";

  constructor() {
    super("project assignment limit was reached");
    this.name = "ProjectAssignmentLimitError";
  }
}

export class ProjectAssignmentRoleError extends Error {
  readonly code = "key_account_requires_explicit_clear";

  constructor() {
    super("key account must be cleared before it can be removed");
    this.name = "ProjectAssignmentRoleError";
  }
}

function requireProjectRead(ctx: ServiceCtx, resource: string): void {
  if (!can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", resource, undefined, ctx.actor);
  }
}

function requireInternalProjectRead(ctx: ServiceCtx, resource: string): void {
  requireProjectRead(ctx, resource);
  if (isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      "project.read",
      resource,
      "external_only_without_internal_detail",
      ctx.actor,
    );
  }
}

function requireAssignmentMutation(ctx: ServiceCtx): void {
  if (!can(ctx, "project.assign")) {
    throw new PermissionDeniedError(
      "project.assign",
      "project_assignment",
      undefined,
      ctx.actor,
    );
  }
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ProjectAssignmentNotFoundError();
  return parsed.toISOString();
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getProjectPageDetail(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ProjectPageDetail | null> {
  requireProjectRead(ctx, "project");
  if (!isExternalOnly(ctx)) {
    const record = await getProjectTriageDetail(tx, ctx, projectId);
    return record === null ? null : { audience: "internal", record };
  }

  const result = await tx.execute<ExternalDetailRow>(sql`
    select p.id as project_id, p.name as project_name, p.created_at,
           column_record.name as column_name,
           contact_record.display_name as contact_name,
           contact_record.email_primary as email,
           contact_record.phone_raw as phone,
           site_record.formatted_address,
           requirement_record.requirements->>'branch' as requirements_branch,
           'Photovoltaik'::text as product_group_label,
           nullif(
             requirement_record.requirements #>> '{requestedProducts,targetStorageKwh}',
             ''
           )::numeric as target_storage_kwh,
           (requirement_record.requirements #>> '{requestedProducts,wallbox}')::boolean
             as wallbox,
           (requirement_record.requirements #>> '{requestedProducts,bidirectionalCharging}')::boolean
             as bidirectional_charging,
           (requirement_record.requirements #>> '{requestedProducts,backupPower}')::boolean
             as backup_power,
           coalesce(p.dedupe_review_required, false)
             or coalesce(contact_record.dedupe_review_required, false)
             as dedupe_review_required,
           site_record.address_follow_up_required,
           site_record.pin_confirmed,
           p.catalog_resolution_status
      from project p
      join membership actor_membership
        on actor_membership.workspace_id = p.workspace_id
       and actor_membership.user_id = ${ctx.actor}::uuid
      join project_assignment direct_assignment
        on direct_assignment.workspace_id = p.workspace_id
       and direct_assignment.project_id = p.id
       and direct_assignment.membership_id = actor_membership.id
       and direct_assignment.assignment_role in ('key_account', 'user')
      join contact contact_record
        on contact_record.workspace_id = p.workspace_id
       and contact_record.id = p.contact_id
      join site site_record
        on site_record.workspace_id = p.workspace_id
       and site_record.id = p.site_id
      join kanban_column column_record
        on column_record.workspace_id = p.workspace_id
       and column_record.board_id = p.kanban_board_id
       and column_record.id = p.kanban_column_id
      left join lateral (
        select requirement.requirements
          from project_requirement requirement
         where requirement.workspace_id = p.workspace_id
           and requirement.project_id = p.id
         order by requirement.revision desc
         limit 1
      ) requirement_record on true
     where p.workspace_id = ${ctx.workspaceId}::uuid
       and p.id = ${projectId}::uuid
       and p.phase = 'request'
       and p.outcome = 'open'
     limit 1
  `);
  const row = result.rows[0];
  if (!row) return null;

  return {
    audience: "assigned_external",
    record: {
      project: {
        id: row.project_id,
        name: row.project_name,
        phase: "request",
        outcome: "open",
        createdAt: iso(row.created_at),
        columnName: row.column_name,
      },
      contact: {
        displayName: row.contact_name,
        email: row.email,
        phone: row.phone,
      },
      site: { formattedAddress: row.formatted_address },
      requirements: {
        productGroupLabel: row.product_group_label,
        branch: row.requirements_branch,
        targetStorageKwh: numberOrNull(row.target_storage_kwh),
        wallbox: row.wallbox === true,
        bidirectionalCharging: row.bidirectional_charging === true,
        backupPower: row.backup_power === true,
      },
      blockers: {
        dedupeReviewRequired: row.dedupe_review_required,
        addressFollowUpRequired: row.address_follow_up_required,
        pinConfirmationRequired: !row.pin_confirmed,
        catalogResolutionPending: row.catalog_resolution_status !== "resolved",
      },
    },
  };
}

export async function getProjectAssignmentContext(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  search?: ProjectAssignmentSearchV1,
): Promise<ProjectAssignmentContext | null> {
  requireInternalProjectRead(ctx, "project_assignment");
  if (search !== undefined) requireAssignmentMutation(ctx);
  const projectResult = await tx.execute<LockedProjectRow>(sql`
    select id as project_id, assignment_revision
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${projectId}::uuid
     limit 1
     for share
  `);
  const project = projectResult.rows[0];
  if (!project) return null;

  const assignmentResult = await tx.execute<AssignmentRow>(sql`
    select assignment_record.membership_id,
           assignment_record.assignment_role,
           identity_record.email as label
      from project_assignment assignment_record
      join membership membership_record
        on membership_record.workspace_id = assignment_record.workspace_id
       and membership_record.id = assignment_record.membership_id
      join user_identity identity_record
        on identity_record.id = membership_record.user_id
     where assignment_record.workspace_id = ${ctx.workspaceId}::uuid
       and assignment_record.project_id = ${projectId}::uuid
     order by
       case when assignment_record.assignment_role = 'key_account' then 0 else 1 end,
       lower(identity_record.email), assignment_record.membership_id
  `);
  const canAssign = can(ctx, "project.assign");
  let searchResults: ProjectAssignmentSearchResult[] = [];
  if (search !== undefined && canAssign) {
    const parsedSearch = projectAssignmentSearchV1Schema.safeParse(search);
    if (!parsedSearch.success) throw new ProjectAssignmentValidationError();
    const candidates = await tx.execute<SearchRow>(sql`
      select membership_record.id as membership_id,
             identity_record.email as label,
             assignment_record.assignment_role
        from membership membership_record
        join user_identity identity_record
          on identity_record.id = membership_record.user_id
        left join project_assignment assignment_record
          on assignment_record.workspace_id = membership_record.workspace_id
         and assignment_record.membership_id = membership_record.id
         and assignment_record.project_id = ${projectId}::uuid
       where membership_record.workspace_id = ${ctx.workspaceId}::uuid
         and position(lower(${parsedSearch.data.query}) in lower(identity_record.email)) > 0
       order by lower(identity_record.email), membership_record.id
       limit 20
    `);
    searchResults = candidates.rows.map((row) => ({
      membershipId: row.membership_id,
      label: row.label,
      alreadyAssigned: row.assignment_role !== null,
      assignmentRole: row.assignment_role,
    }));
  }

  const keyAccountRow = assignmentResult.rows.find(
    ({ assignment_role: role }) => role === "key_account",
  );
  return {
    projectId: project.project_id,
    assignmentRevision: project.assignment_revision,
    keyAccount: keyAccountRow
      ? { membershipId: keyAccountRow.membership_id, label: keyAccountRow.label }
      : null,
    users: assignmentResult.rows
      .filter(({ assignment_role: role }) => role === "user")
      .map((row) => ({ membershipId: row.membership_id, label: row.label })),
    canAssign,
    searchResults,
  };
}

function targetMembershipId(command: ProjectAssignmentCommandV1): string | null {
  return command.kind === "clear_key_account" ? null : command.membershipId;
}

export async function changeProjectAssignment(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ProjectAssignmentCommandV1,
): Promise<{ projectId: string; assignmentRevision: number; changed: boolean }> {
  requireAssignmentMutation(ctx);
  const parsed = projectAssignmentCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new ProjectAssignmentValidationError();
  const command = parsed.data;

  const locked = await tx.execute<LockedProjectRow>(sql`
    select id as project_id, assignment_revision
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.projectId}::uuid
     for update
  `);
  const project = locked.rows[0];
  if (!project) throw new ProjectAssignmentNotFoundError();
  if (project.assignment_revision !== command.expectedAssignmentRevision) {
    throw new ProjectAssignmentConflictError(project.assignment_revision);
  }

  // Membership-DML nimmt dieselbe Workspace-Zeile bereits im BEFORE-
  // STATEMENT-Trigger FOR UPDATE. Wir nehmen den Gegenlock fuer JEDEN Command,
  // bevor irgendeine Assignment-Zeile gesperrt wird. Das gilt insbesondere
  // fuer clear_key_account: sonst koennte Clear eine Assignment-Zeile halten,
  // waehrend Offboarding den Workspace-Lock haelt und beim RESTRICT-FK auf
  // genau diese Zeile wartet. Die feste Reihenfolge verhindert diesen Zyklus.
  await tx.execute(sql`
    select id
      from workspace
     where id = ${ctx.workspaceId}::uuid
     for share
  `);

  const membershipId = targetMembershipId(command);
  if (membershipId !== null) {
    // Gewinnt das Offboarding den Workspace-Lock zuerst, lesen wir nach dem
    // Warten unter READ COMMITTED den entfernten Stand und liefern den
    // generischen Target-Fehler. Gewinnt die Zuweisung, wartet Offboarding bis
    // zum Commit und trifft danach deterministisch den benannten RESTRICT-FK.
    const target = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      select id
        from membership
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${membershipId}::uuid
       limit 1
    `);
    if (!target.rows[0]) throw new ProjectAssignmentTargetError();
  }

  const currentResult = await tx.execute<{
    membership_id: string;
    assignment_role: ProjectAssignmentRole;
    [key: string]: unknown;
  }>(sql`
    select membership_id, assignment_role
      from project_assignment
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${command.projectId}::uuid
     order by membership_id
     for update
  `);
  const current = currentResult.rows;
  const existingTarget = membershipId === null
    ? undefined
    : current.find((row) => row.membership_id === membershipId);
  const currentKeyAccount = current.find(
    ({ assignment_role: role }) => role === "key_account",
  );

  let changed = false;
  let eventType = "";
  let previousMembershipId: string | null = null;

  if (command.kind === "set_key_account") {
    if (existingTarget?.assignment_role === "key_account") {
      return {
        projectId: project.project_id,
        assignmentRevision: project.assignment_revision,
        changed: false,
      };
    }
    if (!existingTarget && current.length >= PROJECT_ASSIGNMENT_MAX_USERS) {
      throw new ProjectAssignmentLimitError();
    }
    previousMembershipId = currentKeyAccount?.membership_id ?? null;
    if (currentKeyAccount) {
      await tx.execute(sql`
        update project_assignment
           set assignment_role = 'user', updated_at = now()
         where workspace_id = ${ctx.workspaceId}::uuid
           and project_id = ${command.projectId}::uuid
           and membership_id = ${currentKeyAccount.membership_id}::uuid
      `);
    }
    if (existingTarget) {
      await tx.execute(sql`
        update project_assignment
           set assignment_role = 'key_account', updated_at = now()
         where workspace_id = ${ctx.workspaceId}::uuid
           and project_id = ${command.projectId}::uuid
           and membership_id = ${command.membershipId}::uuid
      `);
    } else {
      await tx.execute(sql`
        insert into project_assignment (
          workspace_id, project_id, membership_id, assignment_role
        ) values (
          ${ctx.workspaceId}::uuid, ${command.projectId}::uuid,
          ${command.membershipId}::uuid, 'key_account'
        )
      `);
    }
    changed = true;
    eventType = "project.assignment_key_account_changed";
  } else if (command.kind === "clear_key_account") {
    if (!currentKeyAccount) {
      return {
        projectId: project.project_id,
        assignmentRevision: project.assignment_revision,
        changed: false,
      };
    }
    previousMembershipId = currentKeyAccount.membership_id;
    await tx.execute(sql`
      update project_assignment
         set assignment_role = 'user', updated_at = now()
       where workspace_id = ${ctx.workspaceId}::uuid
         and project_id = ${command.projectId}::uuid
         and membership_id = ${currentKeyAccount.membership_id}::uuid
    `);
    changed = true;
    eventType = "project.assignment_key_account_changed";
  } else if (command.kind === "add_user") {
    if (existingTarget) {
      return {
        projectId: project.project_id,
        assignmentRevision: project.assignment_revision,
        changed: false,
      };
    }
    if (current.length >= PROJECT_ASSIGNMENT_MAX_USERS) {
      throw new ProjectAssignmentLimitError();
    }
    await tx.execute(sql`
      insert into project_assignment (
        workspace_id, project_id, membership_id, assignment_role
      ) values (
        ${ctx.workspaceId}::uuid, ${command.projectId}::uuid,
        ${command.membershipId}::uuid, 'user'
      )
    `);
    changed = true;
    eventType = "project.assignment_user_added";
  } else {
    if (!existingTarget) {
      return {
        projectId: project.project_id,
        assignmentRevision: project.assignment_revision,
        changed: false,
      };
    }
    if (existingTarget.assignment_role === "key_account") {
      throw new ProjectAssignmentRoleError();
    }
    await tx.execute(sql`
      delete from project_assignment
       where workspace_id = ${ctx.workspaceId}::uuid
         and project_id = ${command.projectId}::uuid
         and membership_id = ${command.membershipId}::uuid
    `);
    changed = true;
    eventType = "project.assignment_user_removed";
  }

  if (!changed) {
    return {
      projectId: project.project_id,
      assignmentRevision: project.assignment_revision,
      changed: false,
    };
  }
  if (project.assignment_revision >= 2_147_483_647) {
    throw new ProjectAssignmentConflictError(project.assignment_revision);
  }
  const assignmentRevision = project.assignment_revision + 1;
  const updated = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    update project
       set assignment_revision = ${assignmentRevision}, updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.projectId}::uuid
       and assignment_revision = ${project.assignment_revision}
     returning id
  `);
  if (!updated.rows[0]) throw new ProjectAssignmentConflictError();

  const evidence = {
    projectId: command.projectId,
    assignmentRevision,
    commandKind: command.kind,
    membershipId,
    ...(previousMembershipId === null ? {} : { previousMembershipId }),
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: command.projectId,
    eventType,
    actor: ctx.actor,
    payload: evidence,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project.assign",
    resource: "project_assignment",
    allowed: true,
    details: evidence,
  });
  return { projectId: command.projectId, assignmentRevision, changed: true };
}
