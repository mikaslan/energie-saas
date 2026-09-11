import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import {
  PORTAL_INVITE_CREATE_VERSION,
} from "@/lib/integrations/portal/portal-contract";
import {
  createPortalInvite,
  resolvePortalByToken,
} from "@/modules/portal";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  residentialProjectId: string;
  commercialProjectId: string;
};

async function seedProject(
  tx: TenantTx,
  args: {
    workspaceId: string;
    projectId: string;
    label: string;
    scope: "residential" | "commercial";
  },
): Promise<void> {
  const contactId = randomUUID();
  const siteId = randomUUID();
  await tx.execute(sql`
    insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
    values (${contactId}::uuid, ${args.workspaceId}::uuid, ${args.label}, 'F10', 'Fixture',
      ${`${contactId}@f1003c.test`}, ${`${contactId}@f1003c.test`})
  `);
  await tx.execute(sql`
    insert into site (id, workspace_id, contact_id, label)
    values (${siteId}::uuid, ${args.workspaceId}::uuid, ${contactId}::uuid, ${`${args.label} Site`})
  `);
  await tx.execute(sql`
    insert into project (
      id, workspace_id, contact_id, site_id, kanban_board_id,
      kanban_column_id, name, source_key
    )
    select ${args.projectId}::uuid, ${args.workspaceId}::uuid, ${contactId}::uuid,
           ${siteId}::uuid, board.id, intake_column.id,
           ${args.label}, 'fixture'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
       and intake_column.board_id = board.id
       and intake_column.is_intake = true
       and intake_column.archived_at is null
     where board.workspace_id = ${args.workspaceId}::uuid
       and board.scope = ${args.scope}
       and board.is_default = true
       and board.archived_at is null
  `);
}

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const residentialProjectId = randomUUID();
  const commercialProjectId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F10-03c Fixture')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1003c.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb)
    `);
    await seedProject(tx, {
      workspaceId, projectId: residentialProjectId, label: "F10-03c Wohnbau", scope: "residential",
    });
    await seedProject(tx, {
      workspaceId, projectId: commercialProjectId, label: "F10-03c Gewerbe", scope: "commercial",
    });
  });
  return { workspaceId, editorId, residentialProjectId, commercialProjectId };
}

describe("F10-03c Commercial-Portal ohne Angebot/Signatur (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  async function resolveFor(projectId: string) {
    const invite = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId: fixture.workspaceId,
        projectId,
        ttlDays: 14,
      }),
    );
    return resolvePortalByToken(testPool, { token: invite.token });
  }

  it("F1003C-DB-01: scope je Bereich, commercial documents leer", async () => {
    const residential = await resolveFor(fixture.residentialProjectId);
    expect(residential.project.scope).toBe("residential");

    const commercial = await resolveFor(fixture.commercialProjectId);
    expect(commercial.project.scope).toBe("commercial");
    // Ohne Ausstellung leer; der Strip ist im Contract-Unit-Test mit
    // belegtem Dokument bewiesen (keine erfundene Issuance-Seed).
    expect(commercial.documents).toEqual([]);
  });
});
