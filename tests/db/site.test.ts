import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testPool } from "../setup/test-db";
import { withTenantOn } from "@/lib/db/tenant";
import { writeAudit } from "@/lib/audit";
import { createSite, PermissionDeniedError } from "@/modules/sites";

const ws = randomUUID();
const editorCtx = { workspaceId: ws, actor: "test-user", role: "editor" as const, capabilities: {}, featureFlags: {} };
const viewerCtx = { ...editorCtx, role: "viewer" as const };

beforeAll(async () => {
  await withTenantOn(testPool, ws, (tx) => tx.execute(sql`insert into workspace (id, name) values (${ws}::uuid, 'site')`));
});

describe("sites-Service (Referenzmuster)", () => {
  it("legt Site an und emittiert site.created", async () => {
    const { id } = await withTenantOn(testPool, ws, (tx) =>
      createSite(tx, editorCtx, { city: "Heidelberg", lat: 49.4, lng: 8.7, pinConfirmed: true }));
    const ev = await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`select 1 from domain_events where aggregate_id = ${id}::uuid and event_type = 'site.created'`));
    expect(ev.rows).toHaveLength(1);
  });

  // Boundary-Pattern (Controller-Ruling 1, siehe modules/sites/service.ts und
  // lib/audit.ts für den Transaktionsgrenzen-Vertrag): der Service selbst
  // schreibt bei Ablehnung KEINEN Denial-Audit — er würde mit der
  // abgebrochenen Transaktion zurückgerollt und wäre spurlos verschwunden.
  // Stattdessen wirft der Service PermissionDeniedError, und die AUFRUFGRENZE
  // (hier im Test simuliert; ab M1 der Server-Action-Wrapper) schreibt den
  // Denial-Audit in einer NEUEN, eigenen Transaktion nach dem Abort.
  it("viewer wird abgelehnt — Denial-Audit kommt von der Aufrufgrenze, nicht vom Service", async () => {
    // (a) createSite wirft PermissionDeniedError mit action/resource-Feldern.
    let caught: unknown;
    try {
      await withTenantOn(testPool, ws, (tx) => createSite(tx, viewerCtx, { city: "X" }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PermissionDeniedError);
    const err = caught as PermissionDeniedError;
    expect(err.action).toBe("project.write");
    expect(err.resource).toBe("site");

    // (b) Die abgebrochene Transaktion hat KEINEN Audit-Eintrag hinterlassen.
    const noAudit = await withTenantOn(testPool, ws, (tx) =>
      tx.execute(
        sql`select 1 from audit_log where workspace_id = ${ws}::uuid and action = 'project.write' and allowed = false`,
      ));
    expect(noAudit.rows).toHaveLength(0);

    // (c) Die Aufrufgrenze schreibt den Denial-Audit in einer NEUEN Transaktion.
    await withTenantOn(testPool, ws, (tx) =>
      writeAudit(tx, {
        workspaceId: ws,
        actor: viewerCtx.actor,
        action: err.action,
        resource: err.resource,
        allowed: false,
      }));
    const audit = await withTenantOn(testPool, ws, (tx) =>
      tx.execute(
        sql`select 1 from audit_log where workspace_id = ${ws}::uuid and action = 'project.write' and allowed = false`,
      ));
    expect(audit.rows.length).toBeGreaterThan(0);
  });
});
