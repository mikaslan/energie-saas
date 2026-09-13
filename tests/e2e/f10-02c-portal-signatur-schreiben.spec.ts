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
 * F10-02c Portal-Signatur schreiben — Chromium-E2E (isolierter Workspace).
 * Freigegebene Issuance + Request + Invite per Kapsel-Seed (M2-04-Fixture),
 * dann Portal-Fluss ohne Login: Annehmen (Klick-Modus) → Status signiert,
 * Widerrufen → Status widerrufen. Token werden lokal erzeugt (32 Byte
 * base64url, SHA-256 in der DB — Vertragsformat, kein Lib-Import).
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
};

function state(): E2EState {
  const full = fixtureState();
  for (const key of ["baseURL", "databaseUrl"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F10-02c-E2E-State ist unvollständig (${key}).`);
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

async function expectNoPageErrors(page: Page, errors: string[]): Promise<void> {
  expect(errors, "Browser-Konsole und Page-Errors der Portal-Signatur").toEqual([]);
}

test("F10-02c-E2E-01: Portal Annehmen und Widerrufen je Dokument", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const editorIdentityId = await resolveEditorId();
  const released = await seedM204ReleasedOffer(
    { databaseUrl: data.databaseUrl, editorIdentityId, workspaceId: "" } as never,
    { isolatedWorkspace: true },
  );
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
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

    const tokenPath = `/p/${invite.token}`;
    await page.goto(tokenPath);
    await expect(page.getByRole("heading", { name: "Dokumente", exact: true })).toBeVisible();

    const acceptButton = page.getByRole("button", { name: "Angebot annehmen", exact: true });
    await expect(acceptButton).toBeVisible();
    await acceptButton.click();
    await page.waitForURL((url) => url.searchParams.get("sign") === "ok");
    await expect(page.getByTestId("portal-signature-sign-feedback")).toContainText("angenommen");
    const revokeButton = page.getByRole("button", { name: "Widerrufen", exact: true });
    await expect(revokeButton).toBeVisible();
    await expect(acceptButton).toHaveCount(0);

    await revokeButton.click();
    await page.waitForURL((url) => url.searchParams.get("revoke") === "ok");
    await expect(page.getByTestId("portal-signature-revoke-feedback")).toContainText("widerrufen");
    await expect(page.getByRole("button", { name: "Widerrufen", exact: true })).toHaveCount(0);
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }

  await expectNoPageErrors(page, errors);
});
