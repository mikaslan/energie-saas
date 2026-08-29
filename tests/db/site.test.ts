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
const externalCtx = {
  ...editorCtx,
  capabilities: { external_only: true },
};

beforeAll(async () => {
  await withTenantOn(testPool, ws, (tx) => tx.execute(sql`insert into workspace (id, name) values (${ws}::uuid, 'site')`));
});

describe("sites-Service (Referenzmuster)", () => {
  it("legt Site an und emittiert site.created", async () => {
    const { id } = await withTenantOn(testPool, ws, (tx) =>
      createSite(tx, editorCtx, { city: "Heidelberg", lat: 49.4, lng: 8.7 }));
    const ev = await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`select 1 from domain_events where aggregate_id = ${id}::uuid and event_type = 'site.created'`));
    expect(ev.rows).toHaveLength(1);
  });

  it("ignoriert einen eingeschleusten pinConfirmed-Wert und legt Legacy-Sites immer unbestätigt an", async () => {
    const crafted = {
      city: "Heidelberg",
      lat: 49.4,
      lng: 8.7,
      pinConfirmed: true,
    } as Parameters<typeof createSite>[2] & { pinConfirmed: boolean };

    const { id } = await withTenantOn(testPool, ws, (tx) =>
      createSite(tx, editorCtx, crafted));
    const row = await withTenantOn(testPool, ws, (tx) =>
      tx.execute<{ pin_confirmed: boolean; [k: string]: unknown }>(sql`
        select pin_confirmed from site where id = ${id}::uuid
      `));

    expect(row.rows).toEqual([{ pin_confirmed: false }]);
  });

  it("external_only bleibt bis zu einer verifizierten Zuweisung fail-closed", async () => {
    const before = await withTenantOn(testPool, ws, (tx) => tx.execute<{
      sites: number;
      events: number;
      audits: number;
      [key: string]: unknown;
    }>(sql`
      select
        (select count(*)::int from site) as sites,
        (select count(*)::int from domain_events
          where event_type = 'site.created'
            and payload->>'siteId' is not null) as events,
        (select count(*)::int from audit_log
          where action = 'project.write'
            and resource = 'site'
            and allowed = true) as audits
    `));

    await expect(withTenantOn(testPool, ws, (tx) =>
      createSite(tx, externalCtx, { city: "Nicht zugewiesen" })))
      .rejects.toMatchObject({
        name: "PermissionDeniedError",
        reason: "external_only_without_assignment",
      });

    const after = await withTenantOn(testPool, ws, (tx) => tx.execute<{
      sites: number;
      events: number;
      audits: number;
      [key: string]: unknown;
    }>(sql`
      select
        (select count(*)::int from site) as sites,
        (select count(*)::int from domain_events
          where event_type = 'site.created'
            and payload->>'siteId' is not null) as events,
        (select count(*)::int from audit_log
          where action = 'project.write'
            and resource = 'site'
            and allowed = true) as audits
    `));
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Codex-Review #12 (DSGVO): der Event-Payload trug vorher `input` — Straße,
  // Hausnummer, PLZ, Ort, Koordinaten. domain_events ist append-only, dieser
  // Klartext wäre nie wieder löschbar gewesen (docs/konzepte/
  // dsgvo-loeschkonzept.md, Regel 1: nur IDs, nie Klartext).
  // ═══════════════════════════════════════════════════════════════════════
  it("Event-Payload enthält NUR die siteId, keinen Adress-Klartext", async () => {
    const adresse = {
      label: "Zentrale",
      street: "Hauptstraße",
      houseNumber: "42a",
      postalCode: "69117",
      city: "Heidelberg",
      lat: 49.4093,
      lng: 8.6939,
    };
    const { id } = await withTenantOn(testPool, ws, (tx) => createSite(tx, editorCtx, adresse));

    const ev = await withTenantOn(testPool, ws, (tx) =>
      tx.execute<{ payload: unknown; [k: string]: unknown }>(
        sql`select payload from domain_events where aggregate_id = ${id}::uuid and event_type = 'site.created'`,
      ));
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].payload).toEqual({ siteId: id });

    // Gegenprobe über den rohen JSON-Text: KEIN Adressbestandteil darf
    // irgendwo im Payload auftauchen.
    const roh = JSON.stringify(ev.rows[0].payload);
    for (const wert of ["Hauptstraße", "42a", "69117", "Heidelberg", "Zentrale", "49.4093", "8.6939"]) {
      expect(roh, `Adress-Klartext "${wert}" im append-only Event-Payload`).not.toContain(wert);
    }

    // Die Adresse selbst liegt weiterhin in der (löschbaren) site-Zeile.
    const row = await withTenantOn(testPool, ws, (tx) =>
      tx.execute<{ street: string; [k: string]: unknown }>(
        sql`select street from site where id = ${id}::uuid`,
      ));
    expect(row.rows[0].street).toBe("Hauptstraße");
  });

  // Codex-Review #13a: der Erfolgspfad schrieb bisher gar keinen Audit.
  it("schreibt einen Erfolgs-Audit ATOMAR in derselben Transaktion", async () => {
    const { id } = await withTenantOn(testPool, ws, (tx) =>
      createSite(tx, editorCtx, { city: "Mannheim" }));
    const audit = await withTenantOn(testPool, ws, (tx) =>
      tx.execute<{ actor: string; details: unknown; [k: string]: unknown }>(
        sql`select actor, details from audit_log
             where workspace_id = ${ws}::uuid and action = 'project.write'
               and resource = 'site' and allowed = true
               and details->>'siteId' = ${id}`,
      ));
    expect(audit.rows, "kein Erfolgs-Audit geschrieben").toHaveLength(1);
    expect(audit.rows[0].actor).toBe(editorCtx.actor);
  });

  it("Rollback nimmt Site, Event UND Erfolgs-Audit gemeinsam mit", async () => {
    let siteId: string | undefined;
    await expect(
      withTenantOn(testPool, ws, async (tx) => {
        const created = await createSite(tx, editorCtx, { city: "Rollback" });
        siteId = created.id;
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(siteId).toBeDefined();

    const reste = await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`select 1 from site where id = ${siteId!}::uuid
                     union all select 1 from domain_events where aggregate_id = ${siteId!}::uuid
                     union all select 1 from audit_log where details->>'siteId' = ${siteId!}`));
    expect(reste.rows, "Rollback hat nicht alles mitgenommen").toHaveLength(0);
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
