import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { ServiceCtx } from "@/lib/permissions";
import type {
  RechnerIntakeMeta,
  RechnerIntakeV1,
} from "@/lib/integrations/rechner/types";
import {
  RECHNER_INTAKE_PATH,
  sha256Hex,
  signatureMessage,
  verifyRechnerSignature,
  type VerifiedRechnerIdentity,
} from "@/lib/integrations/rechner/signature";
import { withTenantOn } from "@/lib/db/tenant";
import {
  getDefaultRequestBoard,
  moveProjectCard,
  ProjectMoveConflictError,
} from "@/modules/boards";
import {
  confirmProjectSitePin,
  getProjectTriageDetail,
  SitePinNotConfirmableError,
} from "@/modules/projects";
import { processRechnerIntake } from "@/modules/intake";
import { PermissionDeniedError } from "@/lib/permissions";
import { testPool } from "../setup/test-db";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const GOLDEN = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/rechner-intake.v1.json"),
  "utf8",
)) as RechnerIntakeV1;

function editorCtx(workspaceId: string): ServiceCtx {
  return {
    workspaceId,
    actor: randomUUID(),
    role: "editor",
    capabilities: {},
    featureFlags: {},
  };
}

function viewerCtx(workspaceId: string): ServiceCtx {
  return { ...editorCtx(workspaceId), role: "viewer" };
}

function externalCtx(workspaceId: string): ServiceCtx {
  return {
    ...editorCtx(workspaceId),
    capabilities: { external_only: true },
  };
}

function verifiedIdentity(workspaceId: string): VerifiedRechnerIdentity {
  const keyId = `triage-${randomUUID()}`;
  const secret = Buffer.alloc(32, 11);
  const body = Buffer.from("{}", "utf8");
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const idempotencyKey = randomUUID();
  const contentSha256 = sha256Hex(body);
  const signature = createHmac("sha256", secret)
    .update(signatureMessage({
      method: "POST",
      path: RECHNER_INTAKE_PATH,
      keyId,
      timestamp,
      idempotencyKey,
      contentSha256,
    }))
    .digest("base64url");
  return verifyRechnerSignature({
    method: "POST",
    path: RECHNER_INTAKE_PATH,
    body,
    nowSeconds: Number(timestamp),
    credentialsJson: JSON.stringify([{
      keyId,
      workspaceId,
      scope: "rechner-intake.write",
      secretBase64: secret.toString("base64"),
    }]),
    headers: {
      keyId,
      timestamp,
      idempotencyKey,
      contentSha256,
      signature: `v1=${signature}`,
    },
  });
}

function payload(): RechnerIntakeV1 {
  const value = structuredClone(GOLDEN);
  value.submissionId = randomUUID();
  value.submittedAt = NOW.toISOString();
  value.calculation.calculatedAt = NOW.toISOString();
  return value;
}

function meta(value: RechnerIntakeV1): RechnerIntakeMeta {
  return {
    payloadSha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    signedAt: NOW,
    receivedAt: NOW,
  };
}

async function createWorkspace(name = "Triage Test"): Promise<string> {
  const workspaceId = randomUUID();
  await withTenantOn(testPool, workspaceId, (tx) =>
    tx.execute(sql`
      insert into workspace (id, name)
      values (${workspaceId}::uuid, ${name})
    `));
  return workspaceId;
}

async function submit(workspaceId: string, value = payload()): Promise<{
  payload: RechnerIntakeV1;
  projectId: string;
}> {
  const identity = verifiedIdentity(workspaceId);
  const receipt = await withTenantOn(testPool, workspaceId, (tx) =>
    processRechnerIntake(tx, identity, value, meta(value)));
  const result = await withTenantOn(testPool, workspaceId, (tx) =>
    tx.execute<{ project_id: string; [key: string]: unknown }>(sql`
      select project_id
      from inbound_receipt
      where id = ${receipt.receiptId}::uuid
    `));
  return { payload: value, projectId: result.rows[0].project_id };
}

describe("M1-05 Default-Request-Kanban", () => {
  it("provisioniert je neuem Workspace genau ein physisches Default-Board", async () => {
    const workspaceId = await createWorkspace();
    const result = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      board_name: string;
      scope: string;
      is_default: boolean;
      column_name: string;
      column_type: string;
      position: number;
      is_intake: boolean;
      [key: string]: unknown;
    }>(sql`
      select b.name as board_name, b.scope, b.is_default,
             c.name as column_name, c.column_type, c.position, c.is_intake
      from kanban_board b
      join kanban_column c
        on c.workspace_id = b.workspace_id and c.board_id = b.id
      order by c.position
    `));

    expect(result.rows).toEqual([
      {
        board_name: "Anfragen",
        scope: "residential",
        is_default: true,
        column_name: "Eingang",
        column_type: "lead",
        position: 1,
        is_intake: true,
      },
      {
        board_name: "Anfragen",
        scope: "residential",
        is_default: true,
        column_name: "In Prüfung",
        column_type: "lead",
        position: 2,
        is_intake: false,
      },
      {
        board_name: "Anfragen",
        scope: "residential",
        is_default: true,
        column_name: "Qualifiziert",
        column_type: "lead",
        position: 3,
        is_intake: false,
      },
      {
        board_name: "Anfragen",
        scope: "residential",
        is_default: true,
        column_name: "Angebote",
        column_type: "offer",
        position: 4,
        is_intake: false,
      },
    ]);
  });

  it("ordnet einen Rechner-Lead genau einmal der Eingangsspalte zu", async () => {
    const workspaceId = await createWorkspace();
    const value = payload();
    const identity = verifiedIdentity(workspaceId);

    const first = await withTenantOn(testPool, workspaceId, (tx) =>
      processRechnerIntake(tx, identity, value, meta(value)));
    const replay = await withTenantOn(testPool, workspaceId, (tx) =>
      processRechnerIntake(tx, identity, value, meta(value)));

    expect(first.duplicate).toBe(false);
    expect(replay.duplicate).toBe(true);

    const board = await withTenantOn(testPool, workspaceId, (tx) =>
      getDefaultRequestBoard(tx, editorCtx(workspaceId)));
    expect(board.name).toBe("Anfragen");
    expect(board.columns.map((column) => column.name)).toEqual([
      "Eingang",
      "In Prüfung",
      "Qualifiziert",
      "Angebote",
    ]);
    expect(board.columns[0].cards).toHaveLength(1);
    expect(board.columns.slice(1).flatMap((column) => column.cards)).toHaveLength(0);
  });

  it("minimiert das Board-DTO und kennzeichnet Blocker ohne Kontakt- oder Preisdetails", async () => {
    const workspaceId = await createWorkspace();
    await submit(workspaceId);
    const board = await withTenantOn(testPool, workspaceId, (tx) =>
      getDefaultRequestBoard(tx, editorCtx(workspaceId)));
    const serialized = JSON.stringify(board);

    expect(serialized).toContain("Solarrechner");
    expect(serialized).toContain("Erika Muster");
    expect(serialized).toContain("Dielheim");
    expect(serialized).not.toContain("erika.muster@example.com");
    expect(serialized).not.toContain("+49 6222 123456");
    expect(serialized).not.toContain("Mühlstraße");
    expect(serialized).not.toContain("2185000");
    expect(serialized).not.toContain("investmentCents");
  });

  it("liest für Viewer, sperrt external_only aber bis zum Assignment-Slice", async () => {
    const workspaceId = await createWorkspace();
    await submit(workspaceId);
    const board = await withTenantOn(testPool, workspaceId, (tx) =>
      getDefaultRequestBoard(tx, viewerCtx(workspaceId)));
    expect(board.permissions.canMoveCards).toBe(false);

    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      getDefaultRequestBoard(tx, externalCtx(workspaceId)))).rejects.toMatchObject({
        name: "PermissionDeniedError",
        reason: "external_only_without_assignment",
      });
  });

  it("verschweigt keine offene Anfrage in einer inaktiven Spalte", async () => {
    const workspaceId = await createWorkspace();
    const { projectId } = await submit(workspaceId);
    const ctx = editorCtx(workspaceId);
    const board = await withTenantOn(testPool, workspaceId, (tx) =>
      getDefaultRequestBoard(tx, ctx));
    const currentColumnId = board.columns[0].id;

    await withTenantOn(testPool, workspaceId, (tx) => tx.execute(sql`
      update kanban_column
      set archived_at = now()
      where id = ${currentColumnId}::uuid
    `));

    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      getDefaultRequestBoard(tx, ctx))).rejects.toThrow(
        "an open request project references an inactive board column",
      );
    await expect(withTenantOn(testPool, workspaceId, (tx) => moveProjectCard(tx, ctx, {
      projectId,
      expectedColumnId: currentColumnId,
      targetColumnId: currentColumnId,
    }))).rejects.toBeInstanceOf(ProjectMoveConflictError);
  });
});

describe("M1-05 persistente Triage-Mutationen", () => {
  let workspaceId: string;
  let projectId: string;
  let ctx: ServiceCtx;

  beforeEach(async () => {
    workspaceId = await createWorkspace();
    ({ projectId } = await submit(workspaceId));
    ctx = editorCtx(workspaceId);
  });

  it("verschiebt nur die Karte und schreibt Event/Audit atomar", async () => {
    const board = await withTenantOn(testPool, workspaceId, (tx) =>
      getDefaultRequestBoard(tx, ctx));
    const source = board.columns[0];
    const target = board.columns[1];

    await withTenantOn(testPool, workspaceId, (tx) => moveProjectCard(tx, ctx, {
      projectId,
      expectedColumnId: source.id,
      targetColumnId: target.id,
    }));

    const state = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      phase: string;
      outcome: string;
      kanban_column_id: string;
      move_events: number;
      move_audits: number;
      [key: string]: unknown;
    }>(sql`
      select p.phase, p.outcome, p.kanban_column_id,
        (select count(*)::int from domain_events e
          where e.aggregate_id = p.id and e.event_type = 'project.kanban_moved') as move_events,
        (select count(*)::int from audit_log a
          where a.details->>'projectId' = p.id::text
            and a.action = 'project.write' and a.allowed = true) as move_audits
      from project p
      where p.id = ${projectId}::uuid
    `));
    expect(state.rows[0]).toEqual({
      phase: "request",
      outcome: "open",
      kanban_column_id: target.id,
      move_events: 1,
      move_audits: 1,
    });

    const appendOnly = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      value: string;
      [key: string]: unknown;
    }>(sql`
      select payload::text as value from domain_events
      where event_type = 'project.kanban_moved'
      union all
      select details::text as value from audit_log
      where action = 'project.write' and details->>'projectId' = ${projectId}
    `));
    const serialized = appendOnly.rows.map((row) => row.value).join("\n");
    for (const forbidden of ["Erika", "Mühlstraße", "Dielheim", "2185000"])
      expect(serialized).not.toContain(forbidden);
  });

  it("weist stale expectedColumnId ohne Seiteneffekt zurück", async () => {
    const board = await withTenantOn(testPool, workspaceId, (tx) =>
      getDefaultRequestBoard(tx, ctx));
    await expect(withTenantOn(testPool, workspaceId, (tx) => moveProjectCard(tx, ctx, {
      projectId,
      expectedColumnId: randomUUID(),
      targetColumnId: board.columns[1].id,
    }))).rejects.toBeInstanceOf(ProjectMoveConflictError);

    const state = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      kanban_column_id: string;
      moves: number;
      [key: string]: unknown;
    }>(sql`
      select p.kanban_column_id,
        (select count(*)::int from domain_events e
          where e.aggregate_id = p.id and e.event_type = 'project.kanban_moved') as moves
      from project p where p.id = ${projectId}::uuid
    `));
    expect(state.rows[0]).toEqual({
      kanban_column_id: board.columns[0].id,
      moves: 0,
    });
  });

  it("Viewer und external_only dürfen keine Karte bewegen", async () => {
    const board = await withTenantOn(testPool, workspaceId, (tx) =>
      getDefaultRequestBoard(tx, ctx));
    const input = {
      projectId,
      expectedColumnId: board.columns[0].id,
      targetColumnId: board.columns[1].id,
    };

    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      moveProjectCard(tx, viewerCtx(workspaceId), input))).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      moveProjectCard(tx, externalCtx(workspaceId), input))).rejects.toMatchObject({
        reason: "external_only_without_assignment",
      });
  });

  it("Rollback nimmt Move, Event und Erfolgs-Audit gemeinsam zurück", async () => {
    const board = await withTenantOn(testPool, workspaceId, (tx) =>
      getDefaultRequestBoard(tx, ctx));
    await expect(withTenantOn(testPool, workspaceId, async (tx) => {
      await moveProjectCard(tx, ctx, {
        projectId,
        expectedColumnId: board.columns[0].id,
        targetColumnId: board.columns[1].id,
      });
      throw new Error("rollback-after-move");
    })).rejects.toThrow("rollback-after-move");

    const state = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      kanban_column_id: string;
      moves: number;
      audits: number;
      [key: string]: unknown;
    }>(sql`
      select p.kanban_column_id,
        (select count(*)::int from domain_events e
          where e.aggregate_id = p.id and e.event_type = 'project.kanban_moved') as moves,
        (select count(*)::int from audit_log a
          where a.action = 'project.write' and a.details->>'projectId' = p.id::text) as audits
      from project p where p.id = ${projectId}::uuid
    `));
    expect(state.rows[0]).toEqual({
      kanban_column_id: board.columns[0].id,
      moves: 0,
      audits: 0,
    });
  });
});

describe("M1-05 Projektakte und bewusste Pin-Bestätigung", () => {
  it("liefert ein minimiertes Detail mit dauerhaftem Rechner-Warnhinweis", async () => {
    const workspaceId = await createWorkspace();
    const { projectId } = await submit(workspaceId);
    const detail = await withTenantOn(testPool, workspaceId, (tx) =>
      getProjectTriageDetail(tx, viewerCtx(workspaceId), projectId));

    expect(detail).not.toBeNull();
    expect(detail?.calculatorEstimate.label).toBe(
      "Unverifizierter Richtwert – kein Angebotspreis",
    );
    expect(detail?.calculatorEstimate.integrity).toBe("client_reported_unverified");
    expect(detail?.calculatorEstimate.priceSource).toBe("market_estimate");
    expect(detail?.permissions).toEqual({
      canMoveCard: false,
      canConfirmPin: false,
      canCorrectAddress: false,
    });
    expect(JSON.stringify(detail)).not.toContain("snapshot\"");
  });

  it("bestätigt einen hausgenauen ausgewählten Pin genau einmal", async () => {
    const workspaceId = await createWorkspace();
    const { projectId } = await submit(workspaceId);
    const ctx = editorCtx(workspaceId);

    const first = await withTenantOn(testPool, workspaceId, (tx) =>
      confirmProjectSitePin(tx, ctx, { projectId, expectedAddressRevision: 1 }));
    const replay = await withTenantOn(testPool, workspaceId, (tx) =>
      confirmProjectSitePin(tx, ctx, { projectId, expectedAddressRevision: 1 }));
    expect(first).toMatchObject({ confirmed: true, changed: true });
    expect(replay).toMatchObject({ confirmed: true, changed: false });

    const state = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      pin_confirmed: boolean;
      events: number;
      audits: number;
      [key: string]: unknown;
    }>(sql`
      select s.pin_confirmed,
        (select count(*)::int from domain_events e
          where e.aggregate_id = s.id and e.event_type = 'site.pin_confirmed') as events,
        (select count(*)::int from audit_log a
          where a.action = 'project.write'
            and a.resource = 'site_pin'
            and a.details->>'projectId' = p.id::text) as audits
      from project p
      join site s on s.workspace_id = p.workspace_id and s.id = p.site_id
      where p.id = ${projectId}::uuid
    `));
    expect(state.rows[0]).toEqual({ pin_confirmed: true, events: 1, audits: 1 });
  });

  it("lehnt regionale Schätzung und Viewer ohne Seiteneffekt ab", async () => {
    const workspaceId = await createWorkspace();
    const regional = payload();
    regional.site = {
      addressMode: "regional_estimate",
      formattedAddress: "Region Rhein-Neckar",
      street: null,
      houseNumber: null,
      postalCode: null,
      city: null,
      countryCode: "DE",
      latitude: 49.4,
      longitude: 8.7,
      geocodeSource: "regional_default",
      precision: "region",
    };
    const { projectId } = await submit(workspaceId, regional);

    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      confirmProjectSitePin(tx, editorCtx(workspaceId), {
        projectId,
        expectedAddressRevision: 1,
      })))
      .rejects.toBeInstanceOf(SitePinNotConfirmableError);
    await expect(withTenantOn(testPool, workspaceId, (tx) =>
      confirmProjectSitePin(tx, viewerCtx(workspaceId), {
        projectId,
        expectedAddressRevision: 1,
      })))
      .rejects.toBeInstanceOf(PermissionDeniedError);

    const state = await withTenantOn(testPool, workspaceId, (tx) => tx.execute<{
      pin_confirmed: boolean;
      events: number;
      [key: string]: unknown;
    }>(sql`
      select s.pin_confirmed,
        (select count(*)::int from domain_events e
          where e.aggregate_id = s.id and e.event_type = 'site.pin_confirmed') as events
      from project p
      join site s on s.workspace_id = p.workspace_id and s.id = p.site_id
      where p.id = ${projectId}::uuid
    `));
    expect(state.rows[0]).toEqual({ pin_confirmed: false, events: 0 });
  });
});
