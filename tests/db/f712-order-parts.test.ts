import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  createInstallation,
  InstallationNotFoundError,
  setInstallationVariant,
} from "@/modules/installations";
import {
  listOrderParts,
  OrderPartNotFoundError,
  OrderPartValidationError,
  postOrderPartMessage,
  requestOrderPart,
  setOrderPartStatus,
} from "@/modules/order-parts";
import { testPool } from "../setup/test-db";
import { seedSignedGraphDirect } from "../setup/f806-offer-import-seed";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  adminId: string;
  projectId: string;
  offerId: string;
  variantId: string;
  installationId: string;
  lineDomainId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F7-12 Order')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@f712.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@f712.test`}),
        (${adminId}::uuid, ${`admin-${adminId}@f712.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid, 'admin', '{}'::jsonb)
    `);
  });
  const { graph } = await seedSignedGraphDirect(testPool, { workspaceId, adminId });
  const asEditor = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, editorId, workspaceId, fn as never) as Promise<T>;
  const installation = await asEditor((tx, ctx) => createInstallation(tx, ctx, {
    projectId: graph.projectId,
  }));
  await asEditor((tx, ctx) => setInstallationVariant(tx, ctx, {
    projectId: graph.projectId,
    variantId: graph.variantId,
  }));
  const line = await withTenantOn(testPool, workspaceId, async (tx) => {
    const found = await tx.execute<{ line_domain_id: string }>(sql`
      select line.value ->> 'lineDomainId' as line_domain_id
        from offer_variant_revision as revision,
             lateral jsonb_array_elements(revision.revision_snapshot -> 'sections') as section(value),
             lateral jsonb_array_elements(section.value -> 'lines') as line(value)
       where revision.workspace_id = ${workspaceId}::uuid
         and revision.offer_id = ${graph.offerId}::uuid
         and revision.variant_id = ${graph.variantId}::uuid
         and (line.value ->> 'isHidden')::boolean is distinct from true
       limit 1
    `);
    return found.rows[0]?.line_domain_id ?? "";
  });
  if (!line) throw new Error("F7-12: Fixture-Zeile fehlt.");
  return {
    workspaceId, editorId, viewerId, adminId,
    projectId: graph.projectId, offerId: graph.offerId, variantId: graph.variantId,
    installationId: installation.id, lineDomainId: line,
  };
}

describe("F7-12 Order Parts (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  it("F712-DB-01: Anfrage + Thread + Kanten bis delivered", async () => {
    const created = await asEditor(fixture, (tx, ctx) => requestOrderPart(tx, ctx, {
      installationId: fixture.installationId,
      lineDomainId: fixture.lineDomainId,
      quantityUnits: 2,
      note: "2 Module mehr",
    }));
    expect(created.status).toBe("open");
    expect(created.quantityUnits).toBe(2);
    expect(created.lineLabel).toContain("Tenant-Fixture");
    expect(created.messages).toEqual([]);

    const message = await asEditor(fixture, (tx, ctx) => postOrderPartMessage(tx, ctx, {
      id: created.id, body: "Lieferung KW 38?",
    }));
    expect(message.body).toBe("Lieferung KW 38?");

    const ordered = await asEditor(fixture, (tx, ctx) => setOrderPartStatus(tx, ctx, {
      id: created.id, status: "ordered",
    }));
    expect(ordered.status).toBe("ordered");
    const delivered = await asEditor(fixture, (tx, ctx) => setOrderPartStatus(tx, ctx, {
      id: created.id, status: "delivered",
    }));
    expect(delivered.status).toBe("delivered");
    expect(delivered.messages.map((entry) => entry.body)).toEqual(["Lieferung KW 38?"]);

    const listed = await asEditor(fixture, (tx, ctx) => listOrderParts(tx, ctx, {
      installationId: fixture.installationId,
    }));
    expect(listed.map((entry) => entry.id)).toEqual([created.id]);
    expect(listed[0]!.permissions.canWrite).toBe(true);
  });

  it("F712-DB-02: Fantasie-Zeile, Kanten, Mengen fail-closed", async () => {
    // Unbekannte Zeile → NotFound (kein Raten).
    await expect(asEditor(fixture, (tx, ctx) => requestOrderPart(tx, ctx, {
      installationId: fixture.installationId,
      lineDomainId: randomUUID(),
      quantityUnits: 1,
    }))).rejects.toBeInstanceOf(OrderPartNotFoundError);

    // Menge 0 → Validation.
    await expect(asEditor(fixture, (tx, ctx) => requestOrderPart(tx, ctx, {
      installationId: fixture.installationId,
      lineDomainId: fixture.lineDomainId,
      quantityUnits: 0,
    }))).rejects.toBeInstanceOf(OrderPartValidationError);

    const created = await asEditor(fixture, (tx, ctx) => requestOrderPart(tx, ctx, {
      installationId: fixture.installationId,
      lineDomainId: fixture.lineDomainId,
      quantityUnits: 1,
    }));

    // Kantensprung open → delivered → Validation.
    await expect(asEditor(fixture, (tx, ctx) => setOrderPartStatus(tx, ctx, {
      id: created.id, status: "delivered",
    }))).rejects.toBeInstanceOf(OrderPartValidationError);

    // Nachricht an Unbekannt → NotFound; leere Nachricht → Validation.
    await expect(asEditor(fixture, (tx, ctx) => postOrderPartMessage(tx, ctx, {
      id: randomUUID(), body: "Hallo?",
    }))).rejects.toBeInstanceOf(OrderPartNotFoundError);
    await expect(asEditor(fixture, (tx, ctx) => postOrderPartMessage(tx, ctx, {
      id: created.id, body: "   ",
    }))).rejects.toBeInstanceOf(OrderPartValidationError);
  });

  it("F712-RBAC-01: Viewer liest, schreibt nicht; Fremdtenant leer", async () => {
    const created = await asEditor(fixture, (tx, ctx) => requestOrderPart(tx, ctx, {
      installationId: fixture.installationId,
      lineDomainId: fixture.lineDomainId,
      quantityUnits: 1,
    }));

    const listed = await asViewer(fixture, (tx, ctx) => listOrderParts(tx, ctx, {
      installationId: fixture.installationId,
    }));
    expect(listed).toHaveLength(1);
    expect(listed[0]!.permissions.canWrite).toBe(false);
    await expect(asViewer(fixture, (tx, ctx) => postOrderPartMessage(tx, ctx, {
      id: created.id, body: "Viewer?",
    }))).rejects.toBeInstanceOf(PermissionDeniedError);

    // Fremdinstallation (eigener Workspace): NotFound statt Leak.
    const foreignWorkspaceId = randomUUID();
    await withTenantOn(testPool, foreignWorkspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${foreignWorkspaceId}::uuid, 'F7-12 Fremd')`);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values (${randomUUID()}::uuid, ${foreignWorkspaceId}::uuid, ${fixture.editorId}::uuid, 'editor', '{}'::jsonb)
      `);
    });
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, foreignWorkspaceId,
      (tx, ctx) => requestOrderPart(tx, ctx, {
        installationId: fixture.installationId,
        lineDomainId: fixture.lineDomainId,
        quantityUnits: 1,
      }),
    )).rejects.toBeInstanceOf(InstallationNotFoundError);
  });
});
