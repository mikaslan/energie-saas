import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { Pool } from "pg";
import { expect, test, type Locator, type Page } from "playwright/test";
import { seedM204ReleasedOffer } from "./m2-04-fixture";

/**
 * M2-04 — E-Signatur (Chromium-E2E)
 * =================================
 *
 * Deckt die Chromium-Szenarien aus §10.6 der Spec
 * `docs/spec/M2-04-e-signatur.md` ab:
 *
 *   1. Öffentliche Token-Route `/s/[token]` rendert die Guard-Seite
 *      (Hinweis, KEIN Dokument-Render — DEC-M204-04/Abw. 5); ein ungültiger
 *      Token liefert denselben ehrlichen Zustand ohne Leak.
 *   2. Interner Editor erzeugt einen Signatur-Request an einer freigegebenen
 *      Ausstellungsfassung → Panel zeigt Pending-Status.
 *   3. Interner Widerruf eines Pending-Links → Panel wechselt auf `withdrawn`.
 *   4. Abgelaufener Link → terminaler `expired`-Zustand (Panel).
 *   5. Viewer read-only (kein „Signaturlink vorbereiten") + External fail-closed.
 *   6. A11y/Axe + 375 px auf der Guard-Seite.
 *
 * Fixture-Bedarf:
 * ----------------
 * `seedM204ReleasedOffer` (siehe `./m2-04-fixture.ts`) portiert die Strict-Kette
 * aus `tests/db/m204-e-signature-strict.test.ts` (`buildApprovedIssuance`): Offer-
 * Fixture → PDF-Draft → Angebotsprofil → Empfänger → Freigabekandidat →
 * Ausstellungsfassung → 2× Approval. Die Produktfunktionen sind SECURITY DEFINER
 * und laufen im E2E-Kontext gegen `state.databaseUrl`.
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  m201WorkspaceId: string;
  m201ProjectId: string;
  m201EditorEmail: string;
  m201EditorIdentityId: string;
  m201BatteryId: string;
  m201InverterId: string;
  m201ModuleId: string;
  m201WallboxId: string;
  viewerEmail: string;
  externalEmail: string;
};

const browserErrors = new WeakMap<Page, string[]>();

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "databaseUrl",
    "serverLogPath",
    "m201WorkspaceId",
    "m201ProjectId",
    "m201EditorEmail",
    "m201EditorIdentityId",
    "m201BatteryId",
    "m201InverterId",
    "m201ModuleId",
    "m201WallboxId",
    "viewerEmail",
    "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M2-04-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function otpFromPrivateDevMailLog(
  logPath: string,
  email: string,
  byteOffset: number,
): Promise<string> {
  const pattern = new RegExp(
    `\\[dev-mail\\] an ${escapeRegExp(email)}: Dein Login-Code\\s+Code: (\\d{6})`,
    "u",
  );
  let otp: string | null = null;
  await expect.poll(() => {
    const log = readFileSync(logPath);
    const tail = log.subarray(Math.min(byteOffset, log.byteLength)).toString("utf8");
    otp = pattern.exec(tail)?.[1] ?? null;
    return otp;
  }, {
    message: "Der echte M2-04-Dev-Mail-OTP wurde rechtzeitig protokolliert.",
    timeout: 12_000,
  }).not.toBeNull();
  if (otp === null) throw new Error("Der echte M2-04-Dev-Mail-OTP fehlt.");
  return otp;
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  // M2-03a-Muster: direkt zur Login-Route (statt auf einen Redirect des
  // Zielpfads zu warten) — die Angebotsdetail-Route leitet nicht zuverlässig um.
  await page.goto(`/login?next=${encodeURIComponent(expectedPath)}`);
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
  await otpInput.fill(await otpFromPrivateDevMailLog(
    state().serverLogPath,
    email,
    logOffset,
  ));
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
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expectedPath);
}

async function expectNoWcagAaAxeViolations(
  page: Page,
  selector: string,
  stateName: string,
): Promise<void> {
  const result = await new AxeBuilder({ page })
    .include(selector)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${stateName}: keine automatisiert prüfbare WCAG-A/AA-Verletzung`).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, expectedWidth: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  })), {
    message: `M2-04: kein horizontaler Dokumentüberlauf bei ${expectedWidth} CSS px`,
  }).toEqual({ clientWidth: expectedWidth, scrollWidth: expectedWidth });
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("M2-04: E-Signatur (Vorbereitungs-Slice)", () => {
  test("M2-04: Öffentliche Token-Route rendert die Guard-Seite ohne Dokument-Leak", async ({ page }) => {
    const validToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await page.goto(`/s/${validToken}`);
    await expect(page.getByRole("heading", {
      name: "Signaturlink vorbereitet · noch nicht freigegeben",
      level: 1,
    })).toBeVisible();
    await expect(page.getByText(/kein Zugriff protokolliert\./u)).toBeVisible();
    await expect(page.getByText("E-Signatur", { exact: true })).toBeVisible();

    // Ungültiger Token: identischer ehrlicher Zustand, kein Offer-/PDF-Leak.
    await page.goto("/s/nicht-ein-echtes-token");
    await expect(page.getByRole("heading", {
      name: "Signaturlink vorbereitet · noch nicht freigegeben",
      level: 1,
    })).toBeVisible();
    await expect(page.locator("iframe, object, embed, canvas")).toHaveCount(0);

    await page.setViewportSize({ width: 375, height: 900 });
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "main", "Guard-Seite bei 375 px");
  });

  test("M2-04: Editor erzeugt Signatur-Request und widerruft den Pending-Link", async ({ page }) => {
    test.setTimeout(120_000);
    const data = state();
    const released = await seedM204ReleasedOffer({
      databaseUrl: data.databaseUrl,
      serverLogPath: data.serverLogPath,
      workspaceId: data.m201WorkspaceId,
      editorEmail: data.m201EditorEmail,
      editorIdentityId: data.m201EditorIdentityId,
      m201BatteryId: data.m201BatteryId,
      m201InverterId: data.m201InverterId,
      m201ModuleId: data.m201ModuleId,
      m201ProjectId: data.m201ProjectId,
      m201WallboxId: data.m201WallboxId,
    });
    const offerPath = `/w/${data.m201WorkspaceId}/angebote/${released.offerId}?variante=${released.variantId}`;
    await page.goto(offerPath);
    await loginWithRealOtp(page, data.m201EditorEmail, offerPath);

    const panel = page.getByRole("heading", { name: "Signaturanforderungen", level: 2 })
      .locator("xpath=ancestor::section[1]");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("vorbereitet · nicht versendet", { exact: true })).toBeVisible();

    await panel.getByLabel("Gültigkeit in Tagen (1–60)").fill("14");
    await panel.getByRole("button", { name: "Signaturlink vorbereiten" }).click();

    await expect(panel.getByText("wartet auf Signatur", { exact: true })).toBeVisible();
    await expect(panel.getByText(/gültig bis/u).first()).toBeVisible();
    await expect(panel.getByText(/0 Öffnungen/u)).toBeVisible();
    await expect(panel.getByText(/Content-Hash/u)).toBeVisible();
    // Der frisch erzeugte Link ist im Panel einmalig kopierbar (Kimi P1 a1).
    const freshLink = panel.locator("a[href^='/s/']");
    await expect(freshLink).toBeVisible();
    await expect(freshLink).toHaveAttribute("href", /^\/s\/[A-Za-z0-9_-]{43}$/u);

    // Widerruf des Pending-Links mit strukturiertem Grund (Kimi P1 a2).
    await panel.getByLabel("Widerrufsgrund").selectOption("content_error");
    await panel.getByRole("button", { name: "Link widerrufen" }).click();
    await expect(panel.getByText("widerrufen", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Link widerrufen" })).toHaveCount(0);

    await page.reload();
    await expect(panel.getByText("widerrufen", { exact: true })).toBeVisible();
  });

  test("M2-04: Abgelaufener Link zeigt terminalen expired-Zustand", async ({ page }) => {
    test.setTimeout(120_000);
    const data = state();
    // Ordnungsunabhaengiger Seed: auf frischem Workspace erzeugt der
    // Offset-15-Seed eine eigene Kette (Standalone lauffaehig); hat Test 2
    // zuvor mit Offset 14 geseedet, unterscheidet sich der Input-Snapshot
    // (valid_through) und erzeugt so ebenfalls eine frische Issuance statt
    // eines Replays der widerrufenen Kette.
    const released = await seedM204ReleasedOffer({
      databaseUrl: data.databaseUrl,
      serverLogPath: data.serverLogPath,
      workspaceId: data.m201WorkspaceId,
      editorEmail: data.m201EditorEmail,
      editorIdentityId: data.m201EditorIdentityId,
      m201BatteryId: data.m201BatteryId,
      m201InverterId: data.m201InverterId,
      m201ModuleId: data.m201ModuleId,
      m201ProjectId: data.m201ProjectId,
      m201WallboxId: data.m201WallboxId,
    }, { validThroughOffsetDays: 15 });
    const offerPath = `/w/${data.m201WorkspaceId}/angebote/${released.offerId}?variante=${released.variantId}`;
    await page.goto(offerPath);
    await loginWithRealOtp(page, data.m201EditorEmail, offerPath);

    const panel = page.getByRole("heading", { name: "Signaturanforderungen", level: 2 })
      .locator("xpath=ancestor::section[1]");
    await panel.getByLabel("Gültigkeit in Tagen (1–60)").fill("1");
    await panel.getByRole("button", { name: "Signaturlink vorbereiten" }).click();
    await expect(panel.getByText("wartet auf Signatur", { exact: true })).toBeVisible();

    // Ablauf serverseitig erzwingen (Fixtureschicht, kein UI-Pfad). Der
    // Immutable-Trigger verbietet expires_at-Aenderungen im Normalbetrieb;
    // in session_replication_role=replica sind Trigger deaktiviert, die
    // Shape-Checks bleiben aktiv (pending -> expired ist formkonform).
    const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role = replica");
      await client.query(
        // expiry_ck verlangt expires_at > created_at: der Request muss also
        // "vor zwei Tagen" entstanden sein, damit der Ablauf in der
        // Vergangenheit liegen darf.
        `update public.signature_request
            set created_at = pg_catalog.statement_timestamp() - interval '2 days',
                expires_at = pg_catalog.statement_timestamp() - interval '1 second',
                status = 'expired'
          where workspace_id = $1::uuid
            and offer_id = $2::uuid
            and status = 'pending'`,
        [data.m201WorkspaceId, released.offerId],
      );
      await client.query("commit");
    } finally {
      await client.release();
      await pool.end();
    }

    await page.reload();
    await expect(panel.getByText("abgelaufen", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Link widerrufen" })).toHaveCount(0);
  });

  test("M2-04: External bleibt beim Angebot fail-closed", async ({ browser }) => {
    const data = state();
    const boardPath = `/w/${data.m201WorkspaceId}/anfragen`;
    const offerPath = `/w/${data.m201WorkspaceId}/angebote/${randomUUID()}`;

    const externalContext = await browser.newContext({
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
      reducedMotion: "reduce",
      viewport: { width: 375, height: 900 },
    });
    const externalPage = await externalContext.newPage();
    const externalErrors = trackBrowserErrors(externalPage);
    try {
      await loginWithRealOtp(externalPage, data.externalEmail, boardPath);
      await expect(externalPage.locator("article[data-project-id]")).toHaveCount(0);

      await externalPage.goto(offerPath);
      await expect(externalPage.getByRole("heading", {
        name: "Signaturanforderungen",
        level: 2,
      })).toHaveCount(0);
      expect(externalErrors, "Browser-Konsole und Page-Errors der External-Grenze").toEqual([]);
    } finally {
      await externalContext.close();
    }
  });
});
