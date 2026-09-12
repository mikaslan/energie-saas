import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F7-13 Template Re-Apply (Merge/Reset) — Chromium-E2E.
 * Eigene Katalog-Komponenten + eigenes Projekt per SQL seeden, als Admin
 * zwei Vorlagen anlegen, Vorlage A anwenden, Punkt abhaken + speichern,
 * Vorlage B mergen (beide Blöcke, Haken bleibt), Vorlage A resetten
 * (Haken weg, Punkte frisch); Axe sauber; keine Konsolenfehler.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  adminEmail: string;
  editorEmail: string;
  viewerEmail: string;
  externalEmail: string;
};

const browserErrors = new WeakMap<Page, string[]>();

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "baseURL", "databaseUrl", "serverLogPath", "workspaceId",
    "adminEmail", "editorEmail", "viewerEmail", "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F7-13-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function otpFromPrivateDevMailLog(
  logPath: string,
  email: string,
  byteOffset: number,
): Promise<string> {
  const deadline = Date.now() + 12_000;
  const pattern = new RegExp(
    `\\[dev-mail\\] an ${escapeRegExp(email)}: Dein Login-Code\\s+Code: (\\d{6})`,
    "u",
  );
  while (Date.now() < deadline) {
    const log = readFileSync(logPath);
    const tail = log.subarray(Math.min(byteOffset, log.byteLength)).toString("utf8");
    const match = pattern.exec(tail);
    if (match) return match[1]!;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.pathname).toBe("/login");
  expect(current.searchParams.get("next")).toBe(expectedPath);

  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otpInput = page.getByLabel("Sechsstelliger Code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill(await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset));
  const signInResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST");
  try {
    await page.getByRole("button", { name: "Anmelden" }).click();
    expect((await signInResponsePromise).status()).toBe(200);
  } finally {
    if (await otpInput.isVisible().catch(() => false)) {
      await otpInput.fill("").catch(() => undefined);
    }
  }
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function seedComponentsAndProject(): Promise<string> {
  const data = state();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query("begin");
    await pool.query("select set_config('app.workspace_id', $1, true)", [data.workspaceId]);
    for (const sku of ["F713-A", "F713-B"]) {
      await pool.query(
        `insert into catalog_component (id, workspace_id, internal_sku, component_type, created_by)
         select $1::uuid, $2::uuid, $3, 'module', u.id
           from user_identity u
          where u.email = $4
         on conflict do nothing`,
        [randomUUID(), data.workspaceId, sku, data.adminEmail],
      );
    }
    await pool.query(
      `insert into contact (
         id, workspace_id, display_name, first_name, last_name,
         email_primary, email_normalized
       ) values ($1::uuid, $2::uuid, 'F713 Reapply', 'F7', 'Dreizehn', $3, $3)
       on conflict do nothing`,
      [contactId, data.workspaceId, `${contactId}@f713-e2e.test`],
    );
    await pool.query(
      `insert into site (id, workspace_id, contact_id, label)
       values ($1::uuid, $2::uuid, $3::uuid, 'F713 Site')
       on conflict do nothing`,
      [siteId, data.workspaceId, contactId],
    );
    const inserted = await pool.query(
      `insert into project (
         id, workspace_id, contact_id, site_id, kanban_board_id,
         kanban_column_id, name, source_key
       )
       select $1::uuid, $2::uuid, $3::uuid, $4::uuid, board.id,
              intake_column.id, 'F713 Reapply', $5
         from kanban_board board
         join kanban_column intake_column
           on intake_column.workspace_id = board.workspace_id
          and intake_column.board_id = board.id
          and intake_column.is_intake = true
          and intake_column.archived_at is null
        where board.workspace_id = $2::uuid
          and board.scope = 'residential'
          and board.is_default = true
          and board.archived_at is null`,
      [projectId, data.workspaceId, contactId, siteId, `f713-reapply-${projectId}`],
    );
    expect(inserted.rowCount).toBe(1);
    await pool.query("commit");
    return projectId;
  } catch (error) {
    await pool.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test("F713-E2E-01: Merge erhält Haken, Reset ersetzt", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const projectId = await seedComponentsAndProject();
  const stamp = Date.now();
  const templateA = `F713-A-Vorlage ${stamp}`;
  const templateB = `F713-B-Vorlage ${stamp}`;
  const settings = `/w/${data.workspaceId}/einstellungen/checklisten-vorlagen`;
  const checklist = `/w/${data.workspaceId}/anfragen/${projectId}/checkliste`;

  await page.goto(settings);
  await loginWithRealOtp(page, data.adminEmail, settings);
  await expect(page.getByRole("heading", { name: "Checklisten-Vorlagen", level: 1 })).toBeVisible();

  for (const [name, sku] of [[templateA, "F713-A"], [templateB, "F713-B"]] as const) {
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Position hinzufügen" }).click();
    await page.getByLabel("Komponente 1").selectOption({ label: sku });
    await page.getByLabel("Menge 1").fill("1");
    await page.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByText("Vorlage angelegt.", { exact: true })).toBeVisible();
  }

  await page.goto(checklist);
  await expect(page.getByRole("heading", { name: "Checkliste", level: 1 })).toBeVisible();
  await page.getByLabel("Vorlage").selectOption({ label: templateA });
  await page.getByRole("button", { name: "Checkliste erstellen" }).click();
  await expect(page.getByText("Vorlage angewendet (Version 1).", { exact: true })).toBeVisible();

  // Punkt abhaken + speichern, damit Merge etwas zu erhalten hat.
  const itemA = page.getByRole("checkbox", { name: "F713-A × 1", exact: true });
  await itemA.check();
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert (Version 2).", { exact: true })).toBeVisible();

  // Merge: zweiter Block kommt dazu, Haken bleibt.
  const section = page.getByTestId("reapply-template-section");
  await expect(section).toBeVisible();
  await section.getByTestId("reapply-template-select").selectOption({ label: templateB });
  await section.getByRole("button", { name: "Anwenden" }).click();
  await expect(page.getByText("Vorlage erneut angewendet (Version 3).", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "F713-A × 1", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "F713-B × 1", exact: true })).toBeVisible();

  // Reset: frischer Baum, Haken weg, B-Block weg.
  await section.getByTestId("reapply-template-select").selectOption({ label: templateA });
  await section.getByRole("radio", { name: "Zurücksetzen" }).check();
  await section.getByRole("button", { name: "Anwenden" }).click();
  await expect(page.getByText("Vorlage erneut angewendet (Version 4).", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "F713-A × 1", exact: true })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "F713-B × 1", exact: true })).toHaveCount(0);

  await expect(page).toHaveTitle(/.+/u);
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  }))).toEqual([]);

  expect(errors, "Browser-Konsole und Page-Errors der Checklisten-Grenze").toEqual([]);
});
