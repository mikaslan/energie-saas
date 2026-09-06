import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { seedM204ReleasedOffer } from "./m2-04-fixture";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

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

const F208B_LOSS_REASON = "Kundenwiderruf nach Signatur";
const F208B_LOSS_COMMENT = "Kundin hat den bereits signierten Vertrag widerrufen.";

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

type SignatureAcceptanceEvidence = {
  phase: string;
  outcome: string;
  outcomeRevision: number;
  lossReasonLabel: string | null;
  signatureStatus: string;
  signatureMode: string | null;
  customerRevoked: boolean;
  attestationId: string | null;
  artifactSha256Hex: string | null;
  artifactSizeBytes: number | null;
  installationCount: number;
};

async function readSignatureAcceptanceEvidence(
  databaseUrl: string,
  workspaceId: string,
  projectId: string,
): Promise<SignatureAcceptanceEvidence | null> {
  const pool = createDrainTrackedPool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query<SignatureAcceptanceEvidence>(
      `select project_record.phase as phase,
              project_record.outcome as outcome,
              project_record.outcome_revision as "outcomeRevision",
              reason_record.label as "lossReasonLabel",
              request_record.status as "signatureStatus",
              attestation_record.mode as "signatureMode",
              request_record.revoked_by_customer_at is not null as "customerRevoked",
              attestation_record.id as "attestationId",
              encode(attestation_record.artifact_sha256, 'hex') as "artifactSha256Hex",
              attestation_record.artifact_size_bytes as "artifactSizeBytes",
              (select count(*)::integer
                 from public.installation as installation_record
                where installation_record.workspace_id = project_record.workspace_id
                  and installation_record.project_id = project_record.id) as "installationCount"
         from public.project as project_record
         join public.signature_request as request_record
           on request_record.workspace_id = project_record.workspace_id
          and request_record.project_id = project_record.id
         left join public.signature_attestation as attestation_record
           on attestation_record.workspace_id = request_record.workspace_id
          and attestation_record.signature_request_id = request_record.id
         left join public.project_loss_reason as reason_record
           on reason_record.workspace_id = project_record.workspace_id
          and reason_record.id = project_record.loss_reason_id
        where project_record.workspace_id = $1::uuid
          and project_record.id = $2::uuid
        order by request_record.created_at desc, request_record.id desc
        limit 1`,
      [workspaceId, projectId],
    );
    return result.rows[0] ?? null;
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
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
    // Offset 13 statt UI-Default 14: m2-03a legt im vollen Lauf auf demselben
    // Workspace einen +14-Kandidaten an; identischer Input waere ein
    // Reservations-Replay dessen Kandidaten.
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
    }, { validThroughOffsetDays: 13 });
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
    await expect(panel.locator("a[href^='/s/']")).toHaveCount(0);

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
    const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
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
      await endPoolAndWaitForClientRemoval(pool);
    }

    await page.reload();
    await expect(panel.getByText("abgelaufen", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Link widerrufen" })).toHaveCount(0);
  });

  test("F2.8b: Analog-Won bleibt nach Kundenwiderruf manuell als Lost abschließbar", async ({ page }) => {
    test.setTimeout(180_000);
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
    }, {
      isolatedWorkspace: true,
      lossReasonLabel: F208B_LOSS_REASON,
      validThroughOffsetDays: 16,
    });
    const offerPath = `/w/${released.workspaceId}/angebote/${released.offerId}?variante=${released.variantId}`;
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(offerPath);
    await loginWithRealOtp(page, data.m201EditorEmail, offerPath);

    const panel = page.getByRole("heading", { name: "Signaturanforderungen", level: 2 })
      .locator("xpath=ancestor::section[1]");
    await expect(panel).toBeVisible();
    await panel.getByLabel("Gültigkeit in Tagen (1–60)").fill("14");
    await panel.getByRole("button", { name: "Signaturlink vorbereiten" }).click();
    await expect(panel.getByText("wartet auf Signatur", { exact: true })).toBeVisible();
    const tokenHref = await panel.locator("a[href^='/s/']").getAttribute("href");
    if (!tokenHref?.startsWith("/s/")) throw new Error("F2.8b: Signaturtoken fehlt im frischen Link.");
    const signatureToken = tokenHref.slice("/s/".length);

    const analogButton = panel.getByRole("button", { name: "Analog hochladen" });
    const analogForm = analogButton.locator("xpath=ancestor::form[1]");
    const signingDate = new Date(Date.now() - 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 10);
    const analogArtifact = Buffer.from("%PDF-1.7\nm204-analog-e2e\n%%EOF", "utf8");
    await analogForm.getByLabel("Unterschriftsdatum").fill(signingDate);
    await analogForm.getByLabel("Unterschriebenes Dokument").setInputFiles({
      name: "m204-analog-signiert.pdf",
      mimeType: "application/pdf",
      buffer: analogArtifact,
    });
    await analogButton.click();

    await expect(panel.getByText("signiert", { exact: true })).toBeVisible();
    await expect(panel.getByText(`${released.contactName} (analog)`, { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Analog hochladen" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Link widerrufen" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "main", "analoge Signaturannahme");

    await expect.poll(() => readSignatureAcceptanceEvidence(
      data.databaseUrl,
      released.workspaceId,
      released.projectId,
    ), {
      message: "Signaturannahme muss Won setzen, Phase erhalten und darf keine Installation anlegen.",
      timeout: 15_000,
    }).toEqual({
      phase: "offer",
      outcome: "won",
      outcomeRevision: 1,
      lossReasonLabel: null,
      signatureStatus: "signed",
      signatureMode: "analog",
      customerRevoked: false,
      attestationId: expect.any(String),
      artifactSha256Hex: expect.stringMatching(/^[0-9a-f]{64}$/u),
      artifactSizeBytes: analogArtifact.length,
      installationCount: 0,
    });
    const acceptedEvidence = await readSignatureAcceptanceEvidence(
      data.databaseUrl,
      released.workspaceId,
      released.projectId,
    );
    if (!acceptedEvidence?.attestationId || !acceptedEvidence.artifactSha256Hex) {
      throw new Error("F2.8b: Signaturattestierung fehlt nach analoger Annahme.");
    }

    // Der öffentliche Customer-Withdrawal-Pfad ist in M2-04 noch ohne
    // öffentliche Seite; die echte Produktfunktion bildet den belegten
    // Kundenwiderruf ab. Danach bleibt das Projekt Won, bis ein interner
    // Nutzer es mit Grund manuell auf Lost setzt.
    const revocationPool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
    try {
      const tokenHash = createHash("sha256")
        .update(Buffer.from(signatureToken, "base64url"))
        .digest();
      const revoked = await revocationPool.query<{ result: unknown }>(
        "select public.revoke_signature_by_customer($1::bytea) as result",
        [tokenHash],
      );
      expect(revoked.rows).toEqual([{
        result: expect.objectContaining({
          status: "revoked_by_customer",
          revokedByCustomerAt: expect.any(String),
        }),
      }]);
    } finally {
      await endPoolAndWaitForClientRemoval(revocationPool);
    }
    await page.reload();
    await expect(panel.getByText("vom Kunden widerrufen", { exact: true })).toBeVisible();
    await expect(panel.getByText(`${released.contactName} (analog)`, { exact: true })).toBeVisible();

    await expect.poll(() => readSignatureAcceptanceEvidence(
      data.databaseUrl,
      released.workspaceId,
      released.projectId,
    ), {
      message: "Kundenwiderruf bewahrt Won und das unveränderte Analog-Artefakt.",
      timeout: 15_000,
    }).toEqual({
      phase: "offer",
      outcome: "won",
      outcomeRevision: 1,
      lossReasonLabel: null,
      signatureStatus: "revoked_by_customer",
      signatureMode: "analog",
      customerRevoked: true,
      attestationId: acceptedEvidence.attestationId,
      artifactSha256Hex: acceptedEvidence.artifactSha256Hex,
      artifactSizeBytes: analogArtifact.length,
      installationCount: 0,
    });

    const boardPath = `/w/${released.workspaceId}/anfragen`;
    await page.goto(boardPath);
    await expect(page.locator(`article[data-project-id="${released.projectId}"]`)).toHaveCount(0);

    const closedPath = `${boardPath}/abgeschlossen?filter=won`;
    await page.goto(closedPath);
    const closedRow = page.locator("li").filter({
      has: page.getByText(released.contactName, { exact: true }),
    });
    await expect(closedRow).toContainText("Gewonnen");
    await expect(closedRow).toContainText("Stand 1");
    await expect(closedRow.getByRole("link", { name: "Projektakte öffnen" })).toHaveAttribute(
      "href",
      `${boardPath}/${released.projectId}`,
    );
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "main", "Won-Archiv nach analoger Annahme");

    await closedRow.getByRole("link", { name: "Projektakte öffnen" }).click();
    await page.waitForURL((url) => url.pathname === `${boardPath}/${released.projectId}`);
    const outcome = page.locator("#project-outcome");
    await expect(outcome).toContainText("Gewonnen · Stand 1");
    await outcome.getByText("Als verloren abschließen", { exact: true }).click();
    await outcome.getByLabel("Verlustgrund").selectOption({ label: F208B_LOSS_REASON });
    await outcome.getByLabel("Interner Hinweis (optional)").fill(F208B_LOSS_COMMENT);
    await outcome.getByRole("button", { name: "Verloren verbindlich bestätigen" }).click();

    await expect(outcome.getByRole("status")).toHaveText(
      "Die Anfrage wurde als verloren abgeschlossen.",
    );
    await expect(outcome).toContainText("Verloren · Stand 2");
    await expect(outcome).toContainText(F208B_LOSS_REASON);
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "#project-outcome", "manueller Lost-Abschluss nach Kundenwiderruf");

    await expect.poll(() => readSignatureAcceptanceEvidence(
      data.databaseUrl,
      released.workspaceId,
      released.projectId,
    ), {
      message: "Manueller Lost-Abschluss bewahrt Signaturartefakt und erzeugt keine Installation.",
      timeout: 15_000,
    }).toEqual({
      phase: "offer",
      outcome: "lost",
      outcomeRevision: 2,
      lossReasonLabel: F208B_LOSS_REASON,
      signatureStatus: "revoked_by_customer",
      signatureMode: "analog",
      customerRevoked: true,
      attestationId: acceptedEvidence.attestationId,
      artifactSha256Hex: acceptedEvidence.artifactSha256Hex,
      artifactSizeBytes: analogArtifact.length,
      installationCount: 0,
    });

    await page.goto(`${boardPath}/abgeschlossen?filter=lost`);
    const lostRow = page.locator("li").filter({
      has: page.getByText(released.contactName, { exact: true }),
    });
    await expect(lostRow).toContainText("Verloren");
    await expect(lostRow).toContainText("Stand 2");
    await expect(lostRow).toContainText(`Verlustgrund: ${F208B_LOSS_REASON}`);
    await expectNoHorizontalOverflow(page, 375);
    await expectNoWcagAaAxeViolations(page, "main", "Lost-Archiv nach Kundenwiderruf");

    await page.goto(offerPath);
    await expect(panel.getByText("vom Kunden widerrufen", { exact: true })).toBeVisible();
    await expect(panel.getByText(`${released.contactName} (analog)`, { exact: true })).toBeVisible();
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
