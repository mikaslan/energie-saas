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
 * F2.8 Portal-Draw-Signatur — Chromium-E2E (isolierter Workspace).
 * Freigegebene Issuance + Request + Invite per Kapsel-Seed (M2-04-Fixture),
 * dann Portal-Fluss ohne Login: Unterschrift auf Canvas zeichnen →
 * "Gezeichnet annehmen" → Status signiert, Attestierung Modus draw mit
 * PNG-Artefakt (SHA-geprüft). Ohne Striche bleibt Submit disabled;
 * POST ohne Datei fällt auf ?sign=fehler (kein Orakel).
 */

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

async function drawStroke(page: Page): Promise<void> {
  const canvas = page.getByTestId("draw-signature-canvas");
  const box = await canvas.boundingBox();
  expect(box, "Canvas hat messbare Box").not.toBeNull();
  const startX = box!.x + box!.width * 0.2;
  const startY = box!.y + box!.height * 0.5;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(startX + (box!.width * 0.6 * step) / 10, startY + (step % 2 === 0 ? -8 : 8), { steps: 2 });
  }
  await page.mouse.up();
}

test("F208-E2E-01: Portal Zeichnen und Annehmen je Dokument (Modus draw + PNG-Nachweis)", async ({ page }) => {
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
    await expect(page.getByRole("heading", { name: "Dokumente", exact: true })).toBeVisible();

    // Klick-Pfad bleibt sichtbar (No-JS-Default), Draw per Disclosure.
    await expect(page.getByRole("button", { name: "Angebot annehmen", exact: true })).toBeVisible();
    const disclosure = page.getByTestId("draw-signature-disclosure");
    await expect(disclosure).toBeVisible();
    await disclosure.click();
    const canvas = page.getByTestId("draw-signature-canvas");
    await expect(canvas).toBeVisible();

    // Ohne Striche: Submit disabled.
    const submit = page.getByTestId("draw-signature-submit");
    await expect(submit).toBeDisabled();

    // Zeichnen → Submit enabled → Annehmen → ?sign=ok.
    await drawStroke(page);
    await expect(submit).toBeEnabled();
    await submit.click();
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

  expect(errors, "Browser-Konsole und Page-Errors der Draw-Signatur").toEqual([]);
});

test("F208-E2E-02: Draw-POST ohne Datei und mit Fake-PNG faellt auf ?sign=fehler (kein Orakel)", async ({ page }) => {
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

    // POST ohne Datei → fehler (303 auf ?sign=fehler).
    const missing = await page.request.post(`${world.tokenPath}/signatur`, {
      maxRedirects: 0,
      multipart: { action: "sign_draw", issuanceId: world.issuanceId, lang: "de" },
    });
    expect(missing.status()).toBe(303);
    expect(missing.headers()["location"] ?? "").toContain("sign=fehler");

    // POST mit Fake-PNG (falsche Magic) → fehler.
    const fake = await page.request.post(`${world.tokenPath}/signatur`, {
      maxRedirects: 0,
      multipart: {
        action: "sign_draw",
        issuanceId: world.issuanceId,
        lang: "de",
        signature: { name: "fake.png", mimeType: "image/png", buffer: Buffer.from("kein-png", "utf8") },
      },
    });
    expect(fake.status()).toBe(303);
    expect(fake.headers()["location"] ?? "").toContain("sign=fehler");

    // POST mit totem Invite-Token, aber valider PNG-Magic → fehler (Invite-Pfad).
    const dead = await page.request.post(`/p/KeinEchterInviteToken123456789012/signatur`, {
      maxRedirects: 0,
      multipart: {
        action: "sign_draw",
        issuanceId: world.issuanceId,
        lang: "de",
        signature: {
          name: "echt.png",
          mimeType: "image/png",
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        },
      },
    });
    expect(dead.status()).toBe(303);
    expect(dead.headers()["location"] ?? "").toContain("sign=fehler");

    // Request weiter pending (keine Mutation durch Fehlversuche).
    const status = await tenantFn(
      pool,
      world.workspaceId,
      editorIdentityId,
      `select status from signature_request where workspace_id = $1::uuid and issuance_id = $2::uuid`,
      [world.workspaceId, world.issuanceId],
    );
    expect((status.rows[0] as { status: string }).status).toBe("pending");
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }

  expect(errors, "Browser-Konsole und Page-Errors der Draw-Fehlpfade").toEqual([]);
});
