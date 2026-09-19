import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "playwright/test";
import type { Pool } from "pg";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";
import { seedM204ReleasedOffer } from "./m2-04-fixture";
import {
  resolveEditorId,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F2.8 Portal-Draw-Signatur Touch/Tablet — Chromium-E2E (isolierter Workspace).
 * Tablet-Kontext (820x1180 Portrait, Touch an): echter Touch-Drag per
 * CDP-TouchEvents zeichnet einen Strich → Submit enabled → ?sign=ok mit
 * Attestierung Modus draw + PNG-Artefakt (SHA-geprüft). Touch-Punkt ohne
 * Bewegung (M204-TOUCH, E2E-06b) muss Submit ebenfalls aktivieren.
 */

test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

type E2EState = {
  baseURL: string;
  databaseUrl: string;
};

function state(): E2EState {
  const full = fixtureState();
  for (const key of ["baseURL", "databaseUrl"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F208-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
}

function makeToken(): { token: string; tokenHash: Buffer } {
  const raw = randomBytes(32);
  return {
    token: raw.toString("base64url"),
    tokenHash: createHash("sha256").update(raw).digest(),
  };
}

async function tenantFn(
  pool: Pool,
  workspaceId: string,
  actorId: string | null,
  text: string,
  values: unknown[] = [],
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [actorId ?? ""]);
    const result = await client.query(text, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedPendingInvite(
  pool: Pool,
  databaseUrl: string,
  editorIdentityId: string,
): Promise<{ workspaceId: string; issuanceId: string; tokenPath: string }> {
  const released = await seedM204ReleasedOffer(
    { databaseUrl, editorIdentityId, workspaceId: "" } as never,
    { isolatedWorkspace: true },
  );
  const signature = makeToken();
  const signed = await tenantFn(
    pool,
    released.workspaceId,
    editorIdentityId,
    `select public.create_signature_request($1::uuid, $2::uuid, $3::uuid, 14, $4::bytea) as result`,
    [released.workspaceId, released.offerId, released.variantId, signature.tokenHash],
  );
  expect((signed.rows[0] as { result: { status: string } }).result.status).toBe("pending");

  const invite = makeToken();
  const invited = await tenantFn(
    pool,
    released.workspaceId,
    editorIdentityId,
    `select public.create_portal_invite($1::uuid, $2::uuid, 14, $3::bytea) as result`,
    [released.workspaceId, released.projectId, invite.tokenHash],
  );
  expect((invited.rows[0] as { result: { status: string } }).result.status).toBe("active");

  const issuance = await tenantFn(
    pool,
    released.workspaceId,
    editorIdentityId,
    `select issuance_id from signature_request
      where workspace_id = $1::uuid and project_id = $2::uuid
      order by created_at desc limit 1`,
    [released.workspaceId, released.projectId],
  );
  const issuanceId = (issuance.rows[0] as { issuance_id: string }).issuance_id;
  expect(issuanceId).toMatch(/^[0-9a-f-]{36}$/u);
  return { workspaceId: released.workspaceId, issuanceId, tokenPath: `/p/${invite.token}` };
}

async function openDrawCapture(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Dokumente", exact: true })).toBeVisible();
  const disclosure = page.getByTestId("draw-signature-disclosure");
  await expect(disclosure).toBeVisible();
  await disclosure.tap();
  await expect(page.getByTestId("draw-signature-canvas")).toBeVisible();
}

async function touchDragStroke(page: Page): Promise<void> {
  const canvas = page.getByTestId("draw-signature-canvas");
  const box = await canvas.boundingBox();
  expect(box, "Canvas hat messbare Box").not.toBeNull();
  const startX = box!.x + box!.width * 0.2;
  const endX = box!.x + box!.width * 0.8;
  const midY = box!.y + box!.height * 0.5;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: Math.round(startX), y: Math.round(midY) }],
  });
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    const x = startX + ((endX - startX) * step) / steps;
    const y = midY + (step % 2 === 0 ? -8 : 8);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: Math.round(x), y: Math.round(y) }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // Session abkoppeln: Eine offene zweite CDP-Session interferiert mit
  // Playwrights eigenem Touch-Input (submit.tap landete in CI daneben).
  await cdp.detach();
}

async function touchDot(page: Page): Promise<void> {
  const canvas = page.getByTestId("draw-signature-canvas");
  const box = await canvas.boundingBox();
  expect(box, "Canvas hat messbare Box").not.toBeNull();
  await page.touchscreen.tap(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
}

test("F208-E2E-06: Tablet-Touch-Drag zeichnet und signiert (Modus draw + PNG-Nachweis)", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const editorIdentityId = await resolveEditorId();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const world = await seedPendingInvite(pool, data.databaseUrl, editorIdentityId);
    await page.goto(world.tokenPath);
    await openDrawCapture(page);

    // Touch zeichnet ohne Scrollen: touch-action none am Canvas.
    const canvas = page.getByTestId("draw-signature-canvas");
    const touchAction = await canvas.evaluate((node) => getComputedStyle(node).touchAction);
    expect(touchAction).toBe("none");

    // Ohne Striche: Submit disabled.
    const submit = page.getByTestId("draw-signature-submit");
    await expect(submit).toBeDisabled();

    // Touch-Drag → Submit enabled → Annehmen → ?sign=ok.
    await touchDragStroke(page);
    await expect(submit).toBeEnabled();
    await submit.tap();
    await page.waitForURL((url) => url.searchParams.get("sign") === "ok");
    await expect(page.getByTestId("portal-signature-sign-feedback")).toContainText("angenommen");

    // Attestierung: Modus draw, PNG-Artefakt mit stimmigem SHA.
    const stored = await tenantFn(
      pool,
      world.workspaceId,
      editorIdentityId,
      `select attestation.mode, attestation.artifact_mime_type,
              attestation.artifact_size_bytes, attestation.artifact_bytes,
              attestation.artifact_sha256 = pg_catalog.sha256(attestation.artifact_bytes) as sha_ok
         from signature_attestation as attestation
         join signature_request as request_record
           on request_record.workspace_id = attestation.workspace_id
          and request_record.id = attestation.signature_request_id
        where request_record.workspace_id = $1::uuid and request_record.issuance_id = $2::uuid`,
      [world.workspaceId, world.issuanceId],
    );
    const row = stored.rows[0] as {
      mode: string;
      artifact_mime_type: string;
      artifact_size_bytes: number;
      artifact_bytes: Buffer;
      sha_ok: boolean;
    };
    expect(row.mode).toBe("draw");
    expect(row.artifact_mime_type).toBe("image/png");
    expect(row.artifact_size_bytes).toBeGreaterThan(0);
    expect(row.sha_ok).toBe(true);
    expect(row.artifact_bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }

  expect(errors, "Browser-Konsole und Page-Errors des Touch-Draw").toEqual([]);
});

test("F208-E2E-06b (M204-TOUCH): Touch-Punkt ohne Bewegung aktiviert Submit und signiert", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const editorIdentityId = await resolveEditorId();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const world = await seedPendingInvite(pool, data.databaseUrl, editorIdentityId);
    await page.goto(world.tokenPath);
    await openDrawCapture(page);

    // RED ohne M204-TOUCH-Fix: hasStrokes wird nur in handlePointerMove
    // gesetzt — ein Touch-Punkt (tap ohne Bewegung) lässt Submit disabled.
    const submit = page.getByTestId("draw-signature-submit");
    await expect(submit).toBeDisabled();
    await touchDot(page);
    await expect(submit).toBeEnabled();

    await submit.tap();
    await page.waitForURL((url) => url.searchParams.get("sign") === "ok");
    await expect(page.getByTestId("portal-signature-sign-feedback")).toContainText("angenommen");

    const stored = await tenantFn(
      pool,
      world.workspaceId,
      editorIdentityId,
      `select attestation.mode, attestation.artifact_mime_type
         from signature_attestation as attestation
         join signature_request as request_record
           on request_record.workspace_id = attestation.workspace_id
          and request_record.id = attestation.signature_request_id
        where request_record.workspace_id = $1::uuid and request_record.issuance_id = $2::uuid`,
      [world.workspaceId, world.issuanceId],
    );
    const row = stored.rows[0] as { mode: string; artifact_mime_type: string };
    expect(row.mode).toBe("draw");
    expect(row.artifact_mime_type).toBe("image/png");
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }

  expect(errors, "Browser-Konsole und Page-Errors des Touch-Punkts").toEqual([]);
});
