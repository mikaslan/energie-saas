import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { expect, test, type Download, type Locator, type Page, type Route } from "playwright/test";

import {
  claimOfferPdfDraftJob,
  finalizeOfferPdfDraftSuccess,
} from "../../worker/offer-pdf-database";
import {
  claimOfferReleaseCandidate,
  finalizeOfferReleaseCandidateSuccess,
} from "../../worker/offer-release-candidate-database";
import {
  readM201Offer,
  withM201Database,
  type M201RuntimeState,
} from "./m2-01-fixture";

const browserErrors = new WeakMap<Page, string[]>();
const SYNTHETIC_RECIPIENT_EMAIL = "kunde-m203a@example.test";
const SYNTHETIC_BILLING_STREET = "NurTestallee";
const SYNTHETIC_STALE_LOCAL_RECIPIENT = {
  displayName: "SYNTHETIC LOCAL STALE RECIPIENT",
  email: "stale-recipient-m203a@example.test",
  postalCode: "ABCDE",
  street: "LokalerNichtSpeichernWeg",
} as const;
const SYNTHETIC_RECIPIENT_REVISION_TWO = {
  displayName: "Synthetischer Empfänger Revision Zwei",
  company: "Externe Testrevision GmbH",
  email: "recipient-rev2-m203a@example.test",
  billingAddress: {
    street: "Parallelweg",
    houseNumber: "22",
    postalCode: "50667",
    city: "Köln",
    country: "DE" as const,
  },
} as const;
const RELEASE_PANEL_SELECTOR = "#offer-release-candidate";

type SerializedM203aState = {
  databaseUrl: string;
  m201BatteryId: string;
  m201EditorEmail: string;
  m201EditorIdentityId: string;
  m201InverterId: string;
  m201ModuleId: string;
  m201ProjectId: string;
  m201WallboxId: string;
  m201WorkspaceId: string;
  serverLogPath: string;
};

type QueuedPdfDraft = {
  jobId: string;
  state: string;
  variantRevision: number;
};

type ReleaseVariant = {
  variantId: string;
};

type RecipientSnapshotEvidence = {
  recipientRevisionId: string;
  revision: number;
  snapshotSha256: string;
  displayName: string;
  company: string | null;
  email: string;
  billingAddress: {
    street: string;
    houseNumber: string;
    postalCode: string;
    city: string;
    country: "DE";
  };
};

type ExternalRecipientRevision = {
  recipientRevisionId: string;
  revision: number;
  snapshot: RecipientSnapshotEvidence;
};

type CandidateInputRecipientEvidence = {
  displayName: string;
  company: string | null;
  billingAddress: {
    street: string;
    houseNumber: string;
    postalCode: string;
    city: string;
    country: "DE";
    formattedAddress: string;
  };
};

type QueuedReleaseCandidate = {
  candidateId: string;
  inputRecipient: CandidateInputRecipientEvidence;
  recipientRevision: number;
  recipientRevisionId: string;
  recipientSnapshotSha256: string;
  state: string;
  variantRevision: number;
};

type SyntheticPdfArtifact = {
  mimeType: "application/pdf";
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
};

type ReadyReleaseCandidateEvidence = {
  artifactVersion: string;
  state: "ready_for_approval";
};

type ApprovedReleaseCandidateEvidence = {
  approvalArtifactVersion: string;
  candidateArtifactVersion: string;
  candidateState: "ready_for_approval";
  expectedArtifactVersion: string;
};

type ReflowEvidence = {
  clientWidth: number;
  scrollWidth: number;
  innerWidth: number;
  devicePixelRatio: number;
  offenders: string[];
};

function runtimeState(): M201RuntimeState {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedM203aState>;
  const required: Array<keyof SerializedM203aState> = [
    "databaseUrl",
    "m201BatteryId",
    "m201EditorEmail",
    "m201EditorIdentityId",
    "m201InverterId",
    "m201ModuleId",
    "m201ProjectId",
    "m201WallboxId",
    "m201WorkspaceId",
    "serverLogPath",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M2-03a-E2E-State ist unvollständig.");
  }
  const complete = parsed as SerializedM203aState;
  return {
    databaseUrl: complete.databaseUrl,
    editorEmail: complete.m201EditorEmail,
    editorIdentityId: complete.m201EditorIdentityId,
    m201BatteryId: complete.m201BatteryId,
    m201InverterId: complete.m201InverterId,
    m201ModuleId: complete.m201ModuleId,
    m201ProjectId: complete.m201ProjectId,
    m201WallboxId: complete.m201WallboxId,
    serverLogPath: complete.serverLogPath,
    workspaceId: complete.m201WorkspaceId,
  };
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
    if (match) return match[1];
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte M2-03a-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, expectedTarget: string): Promise<void> {
  const state = runtimeState();
  const loginSurface = page.getByLabel("E-Mail-Adresse");
  const sessionExpiredSurface = page.locator('[data-offer-detail-state="unauthenticated"]');
  const surface = await Promise.race([
    loginSurface.waitFor({ state: "visible" }).then(() => "login" as const),
    sessionExpiredSurface.waitFor({ state: "visible" }).then(() => "session_expired" as const),
  ]);
  if (surface === "session_expired") {
    await page.goto(`/login?next=${encodeURIComponent(expectedTarget)}`);
  }
  await page.waitForURL((url) => url.pathname === "/login");
  expect(new URL(page.url()).searchParams.get("next")).toBe(expectedTarget);

  const logOffset = statSync(state.serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(state.editorEmail);
  const sendResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST"
  ));
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otp = await otpFromPrivateDevMailLog(state.serverLogPath, state.editorEmail, logOffset);
  const otpInput = page.getByLabel("Sechsstelliger Code");
  await otpInput.fill(otp);
  const signInResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST"
  ));
  try {
    await page.getByRole("button", { name: "Anmelden" }).click();
    expect((await signInResponsePromise).status()).toBe(200);
  } finally {
    if (await otpInput.isVisible().catch(() => false)) {
      await otpInput.fill("").catch(() => undefined);
    }
  }
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expectedTarget);
}

async function submitWithPendingFocusEvidence(
  page: Page,
  button: Locator,
  options: {
    pendingClassName?: string;
    whilePending?: () => Promise<void>;
  } = {},
): Promise<void> {
  let releaseRequest: () => void = () => undefined;
  const requestGate = new Promise<void>((resolveRelease) => {
    releaseRequest = resolveRelease;
  });
  let settleActionRoute: () => void = () => undefined;
  const actionRouteSettled = new Promise<void>((resolveSettled) => {
    settleActionRoute = resolveSettled;
  });
  const routeHandler = async (route: Route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"] !== undefined) {
      await requestGate;
      try {
        await route.continue();
      } finally {
        settleActionRoute();
      }
      return;
    }
    await route.fallback();
  };
  await page.route("**/*", routeHandler);
  let actionRequested = false;
  try {
    const buttonElement = await button.elementHandle();
    if (buttonElement === null) {
      throw new Error("Der fokussierbare Submit-Button fehlt vor dem Pending-Beleg.");
    }
    const actionRequest = page.waitForRequest((request) => (
      request.method() === "POST" && request.headers()["next-action"] !== undefined
    ));
    await buttonElement.click();
    await actionRequest;
    actionRequested = true;
    await expect.poll(() => buttonElement.getAttribute("aria-disabled")).toBe("true");
    await expect.poll(() => buttonElement.getAttribute("aria-busy")).toBe("true");
    await expect.poll(() => buttonElement.evaluate((element) => (
      document.activeElement === element
    ))).toBe(true);
    expect(await buttonElement.getAttribute("disabled")).toBeNull();
    if (options.pendingClassName) {
      await expect.poll(() => buttonElement.getAttribute("class"))
        .toContain(options.pendingClassName);
    }
    await options.whilePending?.();
  } finally {
    releaseRequest();
    if (actionRequested) await actionRouteSettled;
    await page.unroute("**/*", routeHandler);
  }
}

function dirtyNavigationDialog(page: Page): Locator {
  return page.getByRole("dialog", {
    name: "Möchtest du den lokalen Entwurf verlassen?",
  });
}

async function setEditorRole(state: M201RuntimeState, role: "admin" | "editor"): Promise<void> {
  const pool = new Pool({ connectionString: state.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.actor_id', '', true), set_config('app.workspace_id', $1, true)",
      [state.workspaceId],
    );
    const result = await client.query(
      `update membership
          set role = $3
        where workspace_id = $1::uuid
          and user_id = $2::uuid`,
      [state.workspaceId, state.editorIdentityId, role],
    );
    if (result.rowCount !== 1) throw new Error("Die M2-03a-Testrolle wurde nicht eindeutig aktualisiert.");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function syntheticPdfArtifact(label: string): SyntheticPdfArtifact {
  const content = [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    `(${label} - synthetic E2E evidence, not a production render) Tj`,
    "ET",
    "",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}endstream`,
  ];
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets: number[] = [];
  let byteOffset = chunks[0].length;
  for (const [index, body] of objects.entries()) {
    const objectBytes = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, "ascii");
    offsets.push(byteOffset);
    chunks.push(objectBytes);
    byteOffset += objectBytes.length;
  }
  const xrefOffset = byteOffset;
  const xrefEntries = offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  chunks.push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xrefEntries}`
      + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
      + `startxref\n${xrefOffset}\n%%EOF\n`,
    "ascii",
  ));
  const bytes = Buffer.concat(chunks);
  return {
    mimeType: "application/pdf",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
}

async function readQueuedPdfDraft(
  state: M201RuntimeState,
  offerId: string,
  variantId: string,
): Promise<QueuedPdfDraft> {
  return withM201Database(state, async (tx) => {
    const result = await tx.execute<QueuedPdfDraft & { [key: string]: unknown }>(sql`
      select id as "jobId", state, variant_revision as "variantRevision"
        from offer_pdf_draft
       where workspace_id = ${state.workspaceId}::uuid
         and offer_id = ${offerId}::uuid
         and variant_id = ${variantId}::uuid
       order by created_at desc, id desc
       limit 1
    `);
    const row = result.rows[0];
    if (!row || !["queued", "succeeded"].includes(row.state)) {
      throw new Error("Der sichtbare M2-03a-Quellentwurf ist weder queued noch erfolgreich persistiert.");
    }
    return row;
  });
}

async function readLatestReleaseVariant(
  state: M201RuntimeState,
  offerId: string,
): Promise<ReleaseVariant> {
  return withM201Database(state, async (tx) => {
    const result = await tx.execute<ReleaseVariant & { [key: string]: unknown }>(sql`
      select id as "variantId"
        from offer_variant
       where workspace_id = ${state.workspaceId}::uuid
         and offer_id = ${offerId}::uuid
       order by ordinal desc, id desc
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Für M2-03a fehlt eine aktuelle Angebotsvariante.");
    return row;
  });
}

async function createExternalRecipientRevision(
  state: M201RuntimeState,
  offerId: string,
  expectedCurrentRevision: number,
): Promise<ExternalRecipientRevision> {
  return withM201Database(state, async (tx) => {
    const result = await tx.execute<{ result: unknown; [key: string]: unknown }>(sql`
      select public.revise_offer_recipient(
        ${state.workspaceId}::uuid,
        ${offerId}::uuid,
        ${expectedCurrentRevision}::integer,
        ${SYNTHETIC_RECIPIENT_REVISION_TWO.displayName}::text,
        ${SYNTHETIC_RECIPIENT_REVISION_TWO.company}::text,
        ${SYNTHETIC_RECIPIENT_REVISION_TWO.email}::text,
        ${JSON.stringify(SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress)}::jsonb,
        true::boolean
      ) as result
    `);
    const raw = result.rows[0]?.result;
    if (raw === null || typeof raw !== "object") {
      throw new Error("Die externe M2-03a-Empfängerrevision lieferte kein Ergebnis.");
    }
    const revised = raw as Partial<ExternalRecipientRevision> & { status?: unknown };
    const snapshot = revised.snapshot;
    if (
      revised.status !== "revised"
      || typeof revised.recipientRevisionId !== "string"
      || revised.revision !== expectedCurrentRevision + 1
      || snapshot === undefined
      || snapshot.recipientRevisionId !== revised.recipientRevisionId
      || snapshot.revision !== revised.revision
      || !/^[0-9a-f]{64}$/u.test(snapshot.snapshotSha256)
      || snapshot.displayName !== SYNTHETIC_RECIPIENT_REVISION_TWO.displayName
      || snapshot.company !== SYNTHETIC_RECIPIENT_REVISION_TWO.company
      || snapshot.email !== SYNTHETIC_RECIPIENT_REVISION_TWO.email
      || snapshot.billingAddress.street
        !== SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress.street
      || snapshot.billingAddress.houseNumber
        !== SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress.houseNumber
      || snapshot.billingAddress.postalCode
        !== SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress.postalCode
      || snapshot.billingAddress.city
        !== SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress.city
      || snapshot.billingAddress.country
        !== SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress.country
    ) {
      throw new Error("Die externe M2-03a-Empfängerrevision ist nicht kanonisch als Revision 2 gebunden.");
    }
    return {
      recipientRevisionId: revised.recipientRevisionId,
      revision: revised.revision,
      snapshot,
    };
  });
}

async function readQueuedReleaseCandidate(
  state: M201RuntimeState,
  offerId: string,
  variantId: string,
): Promise<QueuedReleaseCandidate> {
  return withM201Database(state, async (tx) => {
    const result = await tx.execute<QueuedReleaseCandidate & { [key: string]: unknown }>(sql`
      select id as "candidateId", state, variant_revision as "variantRevision",
             recipient_revision_id::text as "recipientRevisionId",
             recipient_revision as "recipientRevision",
             encode(recipient_snapshot_sha256, 'hex') as "recipientSnapshotSha256",
             input_snapshot->'recipient' as "inputRecipient"
        from offer_release_candidate
       where workspace_id = ${state.workspaceId}::uuid
         and offer_id = ${offerId}::uuid
         and variant_id = ${variantId}::uuid
       order by created_at desc, id desc
       limit 1
    `);
    const row = result.rows[0];
    if (!row || row.state !== "queued" || !row.inputRecipient) {
      throw new Error("Der sichtbare M2-03a-Freigabekandidat ist nicht queued persistiert.");
    }
    return row;
  });
}

async function completePdfDraft(
  state: M201RuntimeState,
  queued: QueuedPdfDraft,
): Promise<SyntheticPdfArtifact> {
  if (queued.state !== "queued") {
    throw new Error("Nur ein queued M2-03a-Quellentwurf darf durch den Test abgeschlossen werden.");
  }
  const leaseToken = randomUUID();
  const claim = await withM201Database(state, (tx) => claimOfferPdfDraftJob(tx, {
    workspaceId: state.workspaceId,
    jobId: queued.jobId,
    leaseToken,
  }));
  if (claim === null) throw new Error("Der M2-03a-Quellentwurf war nicht claimbar.");
  const artifact = syntheticPdfArtifact("M2-03a source draft");
  const result = await withM201Database(state, (tx) => finalizeOfferPdfDraftSuccess(tx, {
    workspaceId: state.workspaceId,
    jobId: claim.jobId,
    leaseToken: claim.leaseToken,
    attemptCount: claim.attemptCount,
    artifact,
  }));
  expect(result).toEqual({ state: "succeeded", attemptCount: 1, replayed: false });
  return artifact;
}

async function completeReleaseCandidate(
  state: M201RuntimeState,
  queued: QueuedReleaseCandidate,
): Promise<{ artifact: SyntheticPdfArtifact; artifactVersion: string }> {
  const leaseToken = randomUUID();
  const claim = await withM201Database(state, (tx) => claimOfferReleaseCandidate(tx, {
    workspaceId: state.workspaceId,
    candidateId: queued.candidateId,
    leaseToken,
  }));
  if (claim === null) throw new Error("Der M2-03a-Freigabekandidat war nicht claimbar.");
  expect(claim.input.variant.revision).toBe(queued.variantRevision);
  const artifact = syntheticPdfArtifact("M2-03a release candidate");
  const result = await withM201Database(state, (tx) =>
    finalizeOfferReleaseCandidateSuccess(tx, {
      workspaceId: state.workspaceId,
      candidateId: claim.candidateId,
      leaseToken: claim.leaseToken,
      attemptCount: claim.attemptCount,
      artifact,
    }));
  expect(result).toEqual({ state: "ready_for_approval", attemptCount: 1, replayed: false });
  const evidence = await withM201Database(state, async (tx) => {
    const ready = await tx.execute<ReadyReleaseCandidateEvidence & { [key: string]: unknown }>(sql`
      select artifact_version::text as "artifactVersion", state
        from offer_release_candidate
       where workspace_id = ${state.workspaceId}::uuid
         and id = ${queued.candidateId}::uuid
       limit 1
    `);
    return ready.rows[0];
  });
  if (
    evidence?.state !== "ready_for_approval"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      evidence.artifactVersion,
    )
  ) {
    throw new Error("Der fertige M2-03a-Kandidat hat keine opake UUID-Artefaktversion.");
  }
  return { artifact, artifactVersion: evidence.artifactVersion };
}

async function readApprovedReleaseCandidateEvidence(
  state: M201RuntimeState,
  candidateId: string,
): Promise<ApprovedReleaseCandidateEvidence> {
  return withM201Database(state, async (tx) => {
    const result = await tx.execute<ApprovedReleaseCandidateEvidence & { [key: string]: unknown }>(sql`
      select candidate.state as "candidateState",
             candidate.artifact_version::text as "candidateArtifactVersion",
             approval.artifact_version::text as "approvalArtifactVersion",
             approval.approval_command->>'expectedArtifactVersion' as "expectedArtifactVersion"
        from offer_release_candidate as candidate
        join offer_release_candidate_approval as approval
          on approval.workspace_id = candidate.workspace_id
         and approval.candidate_id = candidate.id
       where candidate.workspace_id = ${state.workspaceId}::uuid
         and candidate.id = ${candidateId}::uuid
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Die M2-03a-Abschlussfreigabe wurde nicht versiegelt persistiert.");
    return row;
  });
}

async function bytesFromDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function expectNoWcagAaAxeViolations(page: Page, selector: string, label: string) {
  const result = await new AxeBuilder({ page })
    .include(selector)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${label}: keine automatisiert prüfbare WCAG-A/AA-Verletzung`).toEqual([]);
}

async function reflowEvidence(page: Page): Promise<ReflowEvidence> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const viewportRight = root.clientWidth;
    const offenders = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        return rect.right > viewportRight + 1 || rect.left < -1;
      })
      .slice(0, 12)
      .map((element) => {
        const id = element.id ? `#${element.id}` : "";
        const name = element.getAttribute("name");
        return `${element.tagName.toLowerCase()}${id}${name ? `[name=${name}]` : ""}`;
      });
    return {
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      innerWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio,
      offenders,
    };
  });
}

async function expectNoHorizontalOverflow(
  page: Page,
  expectedCssWidth: number,
  label: string,
): Promise<void> {
  await expect.poll(async () => {
    const evidence = await reflowEvidence(page);
    return evidence.scrollWidth - evidence.clientWidth;
  }, { message: `${label}: kein horizontaler Dokumentüberlauf` }).toBeLessThanOrEqual(0);
  const evidence = await reflowEvidence(page);
  expect(evidence.clientWidth, `${label}: tatsächliche CSS-Viewportbreite`).toBe(expectedCssWidth);
  expect(evidence.innerWidth, `${label}: tatsächliche Layoutbreite`).toBe(expectedCssWidth);
  expect(evidence.offenders, `${label}: sichtbare Elemente bleiben im Viewport`).toEqual([]);
}

async function expectBrowserZoomReflow(
  page: Page,
  zoom: 2 | 4,
  label: string,
): Promise<void> {
  const physicalWidth = 1280;
  const cssWidth = physicalWidth / zoom;
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: cssWidth,
      height: 900,
      deviceScaleFactor: zoom,
      mobile: false,
      screenWidth: physicalWidth,
      screenHeight: 900 * zoom,
    });
    await expect.poll(() => page.evaluate(() => window.devicePixelRatio), {
      message: `${label}: emulierter Browser-Zoomfaktor`,
    }).toBe(zoom);
    await expectNoHorizontalOverflow(page, cssWidth, label);
    await expect(page.locator(RELEASE_PANEL_SELECTOR)).toBeVisible();
  } finally {
    await session.send("Emulation.clearDeviceMetricsOverride");
    await session.detach();
  }
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "M2-03a Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("M2-03a Freigabekandidaten-Oberfläche", () => {
  test("durchläuft Profil, Empfänger, Rendern und kandidatenlokale Abschlussprüfung vollständig zugänglich", async ({ page }) => {
    test.setTimeout(180_000);
    const state = runtimeState();
    const seededOffer = await readM201Offer(state);
    const releaseVariant = await readLatestReleaseVariant(state, seededOffer.offerId);
    const offer = { offerId: seededOffer.offerId, variantId: releaseVariant.variantId };
    const offerPath = `/w/${state.workspaceId}/angebote/${offer.offerId}?variante=${offer.variantId}`;
    const settingsPath = `/w/${state.workspaceId}/einstellungen/angebotsprofile`;

    await setEditorRole(state, "admin");
    try {
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto(offerPath);
      await loginWithRealOtp(page, offerPath);

      await test.step("synthetisches Angebotsprofil mit separater Betreiberprüfung aktivieren", async () => {
        await page.goto(settingsPath);
        await expect(page.getByRole("heading", { name: "Angebotsprofile", level: 1 })).toBeVisible();
        const values: Readonly<Record<string, string>> = {
          "profile-name": "Synthetisches M2-03a Profil",
          "legal-name": "Beispiel Energie Testgesellschaft mbH",
          "represented-by": "Synthetische Testvertretung",
          "sender-street": "Testweg",
          "sender-house-number": "7",
          "sender-postal-code": "69168",
          "sender-city": "Dielheim",
          "sender-email": "angebot-m203a@example.test",
          "terms-title": "Synthetische Angebotsbedingungen",
          "terms-text": "Ausschließlich synthetischer Testtext für den Browsernachweis.",
          "withdrawal-title": "Synthetische Widerrufsinformation",
          "withdrawal-text": "Ausschließlich synthetischer Testtext für den Browsernachweis.",
          "privacy-title": "Synthetischer Datenschutzhinweis",
          "privacy-text": "Ausschließlich synthetischer Testtext für den Browsernachweis.",
        };
        for (const [id, value] of Object.entries(values)) {
          const field = page.locator(`#${id}`);
          await expect(field).toHaveAccessibleName(/\S/u);
          await field.fill(value);
        }
        const profilePostalCode = page.locator("#sender-postal-code");
        await profilePostalCode.fill("ABCDE");
        await page.getByRole("button", { name: "Neue Profilrevision speichern" }).click();

        const profileSummary = page.locator("#profile-revise-feedback");
        await expect(profileSummary).toBeFocused();
        await expect(profileSummary).toHaveAttribute("role", "alert");
        await expect(profileSummary.getByRole("link", { name: "Postleitzahl" }))
          .toHaveAttribute("href", "#sender-postal-code");
        await expect(profilePostalCode).toHaveAttribute("aria-invalid", "true");
        await expect(page.locator("#profile-name")).toHaveValue(values["profile-name"]);
        await expect(page.locator("#terms-text")).toHaveValue(values["terms-text"]);
        await expect(profilePostalCode).toHaveValue("ABCDE");

        await profilePostalCode.fill(values["sender-postal-code"]);
        await expect(profilePostalCode).not.toHaveAttribute("aria-invalid", "true");
        await expect(profilePostalCode).not.toHaveAttribute("aria-describedby", /profile-revise-feedback/u);
        await page.getByRole("button", { name: "Neue Profilrevision speichern" }).click();
        await expect(page.getByText(
          "Profilrevision 1 wurde gespeichert. Prüfe den Inhalt und aktiviere ihn anschließend getrennt.",
          { exact: true },
        )).toBeVisible();
        await page.reload();

        const operatorReview = page.getByRole("checkbox", {
          name: /Betreiberverantwortung für ihre Aktivierung/u,
        });
        const activateButton = page.getByRole("button", {
          name: "Revision 1 als geprüft aktivieren",
        });
        await expect(operatorReview).toHaveAccessibleName(/Betreiberverantwortung/u);
        await activateButton.click();
        await expect(operatorReview).toBeFocused();
        await expect(operatorReview).not.toBeChecked();
        await page.keyboard.press("Space");
        await expect(operatorReview).toBeChecked();
        await page.keyboard.press("Tab");
        await expect(activateButton).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.getByText(
          "Profilrevision 1 ist als intern geprüft aktiv.",
          { exact: true },
        )).toBeVisible();
        await page.reload();
        await expect(page.getByText("Intern geprüft und aktiv", { exact: true })).toBeVisible();
        await expectNoWcagAaAxeViolations(page, "main", "aktiviertes Angebotsprofil");
      });

      await test.step("Statuslinks bei ungespeichertem Editorstand fail-closed abfangen", async () => {
        await page.goto(offerPath);
        const description = page.locator("#variant-description");
        const variantName = page.locator("#variant-name");
        const savedDescription = await description.inputValue();
        const savedVariantName = await variantName.inputValue();
        const dirtyDescription = "SYNTHETIC M2-03A DIRTY STATUS NAVIGATION";
        await description.fill(dirtyDescription);
        await expect(page.getByText("Lokaler Draft: ungespeichert", { exact: true }))
          .toBeVisible();
        await expect.poll(() => page.evaluate(() => (
          (window.history.state as { offerDirtyGuard?: unknown } | null)?.offerDirtyGuard === true
        ))).toBe(true);
        const historyLengthWithSentinel = await page.evaluate(() => window.history.length);

        const releaseStatusLink = page.locator(RELEASE_PANEL_SELECTOR).getByRole("link", {
          name: "Status aktualisieren",
          exact: true,
        });
        await releaseStatusLink.click();
        const dialog = dirtyNavigationDialog(page);
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("Freigabestatus aktualisieren");
        await expect(page).toHaveURL(offerPath);
        await expect(description).toHaveValue(dirtyDescription);
        const stayButton = dialog.getByRole("button", { name: "Bleiben", exact: true });
        await expect(stayButton).toBeFocused();
        await stayButton.click();
        await expect(dialog).toBeHidden();
        await expect(releaseStatusLink).toBeFocused();
        await expect(description).toHaveValue(dirtyDescription);

        await variantName.fill("");
        await page.getByRole("button", { name: "Angebotsentwurf speichern" }).click();
        const localValidationSummary = page.locator("#offer-editor-error-summary");
        await expect(page.locator('[data-offer-detail-state="validation"]')).toBeVisible();
        await expect(localValidationSummary).toBeVisible();
        await expect(localValidationSummary.locator('a[href="#variant-name"]')).toBeVisible();
        await expect(variantName).toBeFocused();
        await expect(variantName).toHaveAttribute("aria-invalid", "true");
        await expect(variantName).toHaveAttribute("aria-describedby", "variant-name-error");
        await expect(page.locator("#variant-name-error")).toBeVisible();

        const pdfPanel = page.locator("#offer-pdf-draft");
        await expect(pdfPanel).toBeVisible();
        const pdfStatusLink = pdfPanel.getByRole("link", {
          name: "Status aktualisieren",
          exact: true,
        });
        await pdfStatusLink.click();
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("PDF-Status aktualisieren");
        await expect(page).toHaveURL(offerPath);
        await expect(description).toHaveValue(dirtyDescription);
        await expect(stayButton).toBeFocused();
        const discardButton = dialog.getByRole("button", { name: "Verwerfen", exact: true });
        await discardButton.click();
        await expect(dialog).toBeHidden();
        await expect(description).toHaveValue(savedDescription);
        await expect(variantName).toHaveValue(savedVariantName);
        await expect(variantName).not.toHaveAttribute("aria-invalid", "true");
        await expect(variantName).not.toHaveAttribute("aria-describedby", "variant-name-error");
        await expect(localValidationSummary).toHaveCount(0);
        await expect(page.locator("#variant-name-error")).toHaveCount(0);
        await expect(page.locator('[data-offer-detail-state="validation"]')).toHaveCount(0);
        await expect(page.getByText(/Gespeicherte Revision \d+/u)).toBeVisible();
        await expect(page).toHaveURL(offerPath);
        await expect.poll(() => page.evaluate(() => (
          (window.history.state as { offerDirtyGuard?: unknown } | null)?.offerDirtyGuard === true
        ))).toBe(false);
        expect(await page.evaluate(() => window.history.length)).toBe(historyLengthWithSentinel);

        await page.goBack();
        await expect(page).toHaveURL(settingsPath);
        await expect(dialog).toBeHidden();
        await page.goForward();
        await expect(page).toHaveURL(offerPath);
        await expect(description).toHaveValue(savedDescription);

        const saveAndRefreshDescription = "SYNTHETIC M2-03A SAVE AND REFRESH";
        await description.fill(saveAndRefreshDescription);
        await expect(page.getByText("Lokaler Draft: ungespeichert", { exact: true }))
          .toBeVisible();
        await releaseStatusLink.click();
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("Freigabestatus aktualisieren");
        const saveAndContinueButton = dialog.getByRole("button", {
          name: "Speichern und fortfahren",
          exact: true,
        });
        await submitWithPendingFocusEvidence(page, saveAndContinueButton, {
          whilePending: async () => {
            const pendingSaveButton = dialog.getByRole("button", {
              name: "Speichert …",
              exact: true,
            });
            await expect(dialog).toHaveAttribute("aria-modal", "true");
            await expect(pendingSaveButton).toBeFocused();
            for (const dialogButton of [stayButton, discardButton, pendingSaveButton]) {
              await expect(dialogButton).toHaveAttribute("aria-disabled", "true");
              expect(await dialogButton.getAttribute("disabled")).toBeNull();
            }
            await page.keyboard.press("Tab");
            await expect(stayButton).toBeFocused();
            expect(await dialog.evaluate((element) => (
              element.contains(document.activeElement)
            ))).toBe(true);
            await page.keyboard.press("Shift+Tab");
            await expect(pendingSaveButton).toBeFocused();
          },
        });
        await expect(dialog).toBeHidden();
        await expect(page).toHaveURL(offerPath);
        await expect(description).toHaveValue(saveAndRefreshDescription);
        await expect(page.getByText(/Gespeicherte Revision \d+/u)).toBeVisible();
        await expect.poll(() => page.evaluate(() => (
          (window.history.state as { offerDirtyGuard?: unknown } | null)?.offerDirtyGuard === true
        ))).toBe(false);

      });

      await test.step("revisionsgleichen internen PDF-Quellentwurf vorbereiten", async () => {
        const pdfPanel = page.locator("#offer-pdf-draft");
        await expect(pdfPanel).toBeVisible();
        const generatePdfButton = pdfPanel.getByRole("button", {
          name: "Internen PDF-Entwurf erzeugen",
          exact: true,
        });
        await submitWithPendingFocusEvidence(page, generatePdfButton, {
          pendingClassName: "bg-slate-700",
        });
        await expect(pdfPanel.getByText(/wurde angenommen|vorhandene Auftrag/u)).toBeVisible();
        const queued = await readQueuedPdfDraft(state, offer.offerId, offer.variantId);
        if (queued.state === "queued") await completePdfDraft(state, queued);
        await page.reload();
        await expect(pdfPanel.getByText(
          `Revision ${queued.variantRevision} · PDF-Entwurf ist bereit`,
          { exact: true },
        )).toBeVisible();
      });

      const recipientRevisionTwo = await test.step("Empfängerfehler und parallelen Revision-2-Refresh atomar abbilden", async () => {
        const panel = page.locator(RELEASE_PANEL_SELECTOR);
        await expect(panel).toBeVisible();
        const releaseSkipLink = page.getByRole("link", {
          name: "Zur Angebotsfreigabe springen",
        });
        await expect(releaseSkipLink).toHaveAttribute("href", RELEASE_PANEL_SELECTOR);
        const releaseRegion = page.getByRole("region", {
          name: "Angebots-Freigabekandidat",
        });
        await expect(releaseRegion).toHaveCount(1);
        await releaseSkipLink.focus();
        await expect(releaseSkipLink).toBeFocused();
        await expect(releaseSkipLink).toBeVisible();
        await page.keyboard.press("Enter");
        await expect(releaseRegion).toBeFocused();
        for (const heading of [
          "Schritt 1 von 3: Empfänger und Rechnungsadresse",
          "Schritt 2 von 3: Freigabekandidat rendern",
          "Schritt 3 von 3: Finale Prüfung der erzeugten PDF-Bytes",
        ]) {
          await expect(panel.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        }
        const recipientName = panel.getByLabel("Empfängername");
        await expect(recipientName).toHaveAccessibleName("Empfängername");
        const syntheticDisplayName = await recipientName.inputValue();
        expect(syntheticDisplayName.trim()).not.toBe("");
        await panel.getByLabel("E-Mail").fill(SYNTHETIC_RECIPIENT_EMAIL);
        await panel.getByLabel("Straße").fill(SYNTHETIC_BILLING_STREET);
        await panel.getByLabel("Hausnummer").fill("99");
        await panel.getByLabel("Postleitzahl").fill("ABCDE");
        await panel.getByLabel("Ort").fill("Teststadt");
        await panel.getByRole("checkbox", {
          name: "Ich habe Empfänger und Rechnungsadresse für dieses Angebot geprüft.",
        }).check();
        await panel.getByRole("button", { name: "Empfängerstand speichern" }).click();

        const summary = panel.locator("#recipient-action-feedback");
        await expect(summary).toBeFocused();
        await expect(summary).toHaveAttribute("role", "alert");
        await expect(summary.getByRole("link", { name: "Postleitzahl" })).toHaveAttribute(
          "href",
          "#billing-postal-code",
        );
        const postalCode = panel.getByLabel("Postleitzahl");
        await expect(postalCode).toHaveAttribute("aria-invalid", "true");
        await expect(postalCode).toHaveAttribute("aria-describedby", /recipient-action-feedback/u);
        await expect(summary).toContainText(
          "Die Prüfbestätigung wurde nach dem Antwortlauf zurückgesetzt. Prüfe die Angaben und bestätige sie vor einem erneuten Speichern nochmals.",
        );
        const recipientDomAfterServerError = {
          displayName: await recipientName.inputValue(),
          company: await panel.getByLabel("Firma (optional)").inputValue(),
          email: await panel.getByLabel("E-Mail").inputValue(),
          street: await panel.getByLabel("Straße").inputValue(),
          houseNumber: await panel.getByLabel("Hausnummer").inputValue(),
          postalCode: await postalCode.inputValue(),
          city: await panel.getByLabel("Ort").inputValue(),
          billingDetailsConfirmed: await panel.getByRole("checkbox", {
            name: "Ich habe Empfänger und Rechnungsadresse für dieses Angebot geprüft.",
          }).isChecked(),
        };
        expect(recipientDomAfterServerError).toEqual({
          displayName: syntheticDisplayName,
          company: "",
          email: SYNTHETIC_RECIPIENT_EMAIL,
          street: SYNTHETIC_BILLING_STREET,
          houseNumber: "99",
          postalCode: "ABCDE",
          city: "Teststadt",
          billingDetailsConfirmed: false,
        });

        await postalCode.fill("69168");
        await expect(postalCode).toBeFocused();
        await expect(postalCode).not.toHaveAttribute("aria-invalid", "true");
        await expect(postalCode).not.toHaveAttribute("aria-describedby", /recipient-action-feedback/u);
        await panel.getByRole("checkbox", {
          name: "Ich habe Empfänger und Rechnungsadresse für dieses Angebot geprüft.",
        }).check();
        await submitWithPendingFocusEvidence(
          page,
          panel.getByRole("button", { name: "Empfängerstand speichern" }),
        );
        await expect(panel.getByText(
          "Empfänger und Rechnungsadresse wurden als Revision 1 gespeichert.",
          { exact: true },
        )).toBeVisible();
        await expect(panel.locator("#release-step-render")).toBeFocused();
        await page.reload();
        await expect(panel.getByText(
          "Gespeicherter und geprüfter Empfängerstand ist vorhanden: Revision 1.",
          { exact: true },
        )).toBeVisible();
        const recipientForm = panel.getByRole("button", {
          name: "Empfängerstand speichern",
        }).locator("xpath=ancestor::form");
        const candidateForm = panel.getByRole("button", {
          name: "Freigabekandidat erzeugen",
        }).locator("xpath=ancestor::form");
        const expectedCurrentRevision = recipientForm.locator(
          'input[name="expectedCurrentRevision"]',
        );
        const candidateRecipientRevisionId = candidateForm.locator(
          'input[name="recipientRevisionId"]',
        );
        const expectedRecipientRevision = candidateForm.locator(
          'input[name="expectedRecipientRevision"]',
        );
        await expect(expectedCurrentRevision).toHaveValue("1");
        await expect(expectedRecipientRevision).toHaveValue("1");
        const recipientRevisionOneId = await candidateRecipientRevisionId.inputValue();
        expect(recipientRevisionOneId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        );

        await recipientName.fill(SYNTHETIC_STALE_LOCAL_RECIPIENT.displayName);
        await panel.getByLabel("E-Mail").fill(SYNTHETIC_STALE_LOCAL_RECIPIENT.email);
        await panel.getByLabel("Straße").fill(SYNTHETIC_STALE_LOCAL_RECIPIENT.street);
        await postalCode.fill(SYNTHETIC_STALE_LOCAL_RECIPIENT.postalCode);
        await panel.getByRole("checkbox", {
          name: "Ich habe Empfänger und Rechnungsadresse für dieses Angebot geprüft.",
        }).check();
        await panel.getByRole("button", { name: "Empfängerstand speichern" }).click();
        await expect(summary).toBeFocused();
        await expect(summary).toHaveAttribute("role", "alert");
        await expect(postalCode).toHaveAttribute("aria-invalid", "true");
        const externalRevision = await createExternalRecipientRevision(
          state,
          offer.offerId,
          1,
        );
        expect(externalRevision.revision).toBe(2);
        expect(externalRevision.recipientRevisionId).not.toBe(recipientRevisionOneId);
        await expect(recipientName).toHaveValue(SYNTHETIC_STALE_LOCAL_RECIPIENT.displayName);
        await expect(panel.getByLabel("Straße"))
          .toHaveValue(SYNTHETIC_STALE_LOCAL_RECIPIENT.street);
        await expect(expectedCurrentRevision).toHaveValue("1");
        await expect(candidateRecipientRevisionId).toHaveValue(recipientRevisionOneId);
        await expect(expectedRecipientRevision).toHaveValue("1");

        await panel.getByRole("link", {
          name: "Status aktualisieren",
          exact: true,
        }).click();
        await expect(panel.getByText(
          "Gespeicherter und geprüfter Empfängerstand ist vorhanden: Revision 2.",
          { exact: true },
        )).toBeVisible();
        await expect(recipientName)
          .toHaveValue(SYNTHETIC_RECIPIENT_REVISION_TWO.displayName);
        await expect(panel.getByLabel("Firma (optional)"))
          .toHaveValue(SYNTHETIC_RECIPIENT_REVISION_TWO.company);
        await expect(panel.getByLabel("E-Mail"))
          .toHaveValue(SYNTHETIC_RECIPIENT_REVISION_TWO.email);
        await expect(panel.getByLabel("Straße"))
          .toHaveValue(SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress.street);
        await expect(panel.getByLabel("Hausnummer"))
          .toHaveValue(SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress.houseNumber);
        await expect(panel.getByLabel("Postleitzahl"))
          .toHaveValue(SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress.postalCode);
        await expect(panel.getByLabel("Ort"))
          .toHaveValue(SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress.city);
        await expect(summary).toHaveAttribute("role", "status");
        await expect(summary).toBeEmpty();
        await expect(postalCode).not.toHaveAttribute("aria-invalid", "true");
        await expect(postalCode)
          .not.toHaveAttribute("aria-describedby", /recipient-action-feedback/u);
        await expect(expectedCurrentRevision).toHaveValue("2");
        await expect(candidateRecipientRevisionId)
          .toHaveValue(externalRevision.recipientRevisionId);
        await expect(expectedRecipientRevision).toHaveValue("2");
        const visibleRecipientValues = await recipientForm
          .locator('input:not([type="hidden"])')
          .evaluateAll((inputs) => inputs.map((input) => (
            input instanceof HTMLInputElement ? input.value : ""
          )));
        expect(visibleRecipientValues).not.toContain(
          SYNTHETIC_STALE_LOCAL_RECIPIENT.displayName,
        );
        expect(visibleRecipientValues).not.toContain(
          SYNTHETIC_STALE_LOCAL_RECIPIENT.email,
        );
        expect(visibleRecipientValues).not.toContain(
          SYNTHETIC_STALE_LOCAL_RECIPIENT.street,
        );
        return externalRevision;
      });

      const preparedRelease = await test.step(
        "serverbegrenztes Datum binden und Freigabekandidat rendern",
        async () => {
        const panel = page.locator(RELEASE_PANEL_SELECTOR);
        const validThrough = panel.getByLabel("Gültig bis");
        await expect(validThrough).toHaveAccessibleName("Gültig bis");
        const min = await validThrough.getAttribute("min");
        const max = await validThrough.getAttribute("max");
        const selected = await validThrough.inputValue();
        if (min === null || max === null) {
          throw new Error("Die serverseitigen Datumsgrenzen fehlen am Gültigkeitsfeld.");
        }
        expect(min).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
        expect(max).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
        expect(selected).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
        expect(selected >= min && selected <= max).toBe(true);
        expect((Date.parse(`${max}T00:00:00Z`) - Date.parse(`${min}T00:00:00Z`)) / 86_400_000)
          .toBe(59);
        await expect(panel.getByText(/1 bis 60 Kalendertage nach dem serverseitigen Dokumentdatum/u))
          .toBeVisible();

        const invalidDate = new Date(`${min}T12:00:00.000Z`);
        invalidDate.setUTCDate(invalidDate.getUTCDate() - 1);
        const outsideServerWindow = invalidDate.toISOString().slice(0, 10);
        const candidateForm = validThrough.locator("xpath=ancestor::form");
        await candidateForm.evaluate((form: HTMLFormElement) => {
          form.noValidate = true;
        });
        await validThrough.fill(outsideServerWindow);
        const candidateButton = panel.getByRole("button", {
          name: "Freigabekandidat erzeugen",
        });
        await candidateButton.click();
        const candidateFeedback = panel.locator("#candidate-action-feedback");
        await expect(candidateFeedback).toBeFocused();
        await expect(candidateFeedback).toHaveAttribute("role", "alert");
        await expect(candidateFeedback).toContainText(
          "Das Gültigkeitsdatum liegt nicht mehr im erlaubten Zeitraum.",
        );
        await expect(validThrough).toHaveValue(outsideServerWindow);

        await validThrough.fill(selected);
        await expect(validThrough).toBeFocused();
        await expect(validThrough).not.toHaveAttribute("aria-invalid", "true");
        await candidateForm.evaluate((form: HTMLFormElement) => {
          form.noValidate = false;
        });
        await candidateButton.click();
        await expect(panel.getByText(/wurde zur Erstellung angenommen/u)).toBeVisible();
        await expect(panel.locator("#release-step-approval")).toBeFocused();
        const queued = await readQueuedReleaseCandidate(
          state,
          offer.offerId,
          offer.variantId,
        );
        expect(queued.recipientRevisionId).toBe(recipientRevisionTwo.recipientRevisionId);
        expect(queued.recipientRevision).toBe(recipientRevisionTwo.revision);
        expect(queued.recipientSnapshotSha256)
          .toBe(recipientRevisionTwo.snapshot.snapshotSha256);
        expect(queued.inputRecipient).toMatchObject({
          displayName: SYNTHETIC_RECIPIENT_REVISION_TWO.displayName,
          company: SYNTHETIC_RECIPIENT_REVISION_TWO.company,
          billingAddress: SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress,
        });
        for (const addressPart of [
          SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress.street,
          SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress.houseNumber,
          SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress.postalCode,
          SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress.city,
        ]) {
          expect(queued.inputRecipient.billingAddress.formattedAddress).toContain(addressPart);
        }
        expect(JSON.stringify(queued.inputRecipient))
          .not.toContain(SYNTHETIC_STALE_LOCAL_RECIPIENT.street);
        const completed = await completeReleaseCandidate(state, queued);
        await page.reload();
        await expect(panel.getByText(
          `Variantenrevision ${queued.variantRevision} · Bereit für die finale Prüfung`,
          { exact: true },
        )).toBeVisible();
        return {
          approvalArtifactVersion: completed.artifactVersion,
          queuedCandidate: queued,
          releaseArtifact: completed.artifact,
        };
      });

      await test.step("voll interaktive Drei-Stufen-Fläche auf Namen, Axe und Reflow prüfen", async () => {
        const panelSelector = RELEASE_PANEL_SELECTOR;
        const panel = page.locator(panelSelector);
        await expect(panel.locator("form")).toHaveCount(3);
        await expect(panel.getByText(
          "Freigabekandidat · nicht ausgestellt · nicht versendet",
          { exact: true },
        )).toBeVisible();
        for (const name of [
          "Empfängername",
          "E-Mail",
          "Straße",
          "Hausnummer",
          "Postleitzahl",
          "Ort",
          "Gültig bis",
        ]) {
          await expect(panel.getByLabel(name))
            .toHaveAccessibleName(name);
        }
        for (const button of [
          "Empfängerstand speichern",
          "Freigabekandidat erzeugen",
          "Abschlussfreigabe speichern",
        ]) {
          await expect(panel.getByRole("button", { name: button })).toHaveAccessibleName(button);
        }
        const approvalForm = panel.locator("form").filter({
          has: page.getByRole("button", { name: "Abschlussfreigabe speichern" }),
        });
        const artifactVersionField = approvalForm.locator('input[name="expectedArtifactVersion"]');
        await expect(artifactVersionField).toHaveCount(1);
        await expect(artifactVersionField).toHaveAttribute("type", "hidden");
        await expect(artifactVersionField).toHaveValue(preparedRelease.approvalArtifactVersion);
        await expect(artifactVersionField).toBeHidden();
        expect(await panel.innerText()).not.toContain(preparedRelease.approvalArtifactVersion);
        expect(preparedRelease.approvalArtifactVersion).not.toBe(
          preparedRelease.releaseArtifact.sha256,
        );
        await expectNoWcagAaAxeViolations(page, panelSelector, "interaktiver Drei-Schritt");

        await page.setViewportSize({ width: 1280, height: 1000 });
        await expectNoHorizontalOverflow(page, 1280, "Desktop 1280 CSS px");

        const textZoom = await page.addStyleTag({
          content: ":root { font-size: 200% !important; }",
        });
        await expect.poll(() => page.evaluate(() =>
          Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize)))
          .toBeGreaterThanOrEqual(32);
        await expectNoHorizontalOverflow(page, 1280, "echtes 200-%-Textzoom");
        await textZoom.evaluate((element) => element.parentNode?.removeChild(element));

        await expectBrowserZoomReflow(page, 2, "200-%-Browserzoom-Reflow bei 640 CSS px");
        await expectBrowserZoomReflow(page, 4, "400-%-Browserzoom-Reflow bei 320 CSS px");
        await page.setViewportSize({ width: 320, height: 900 });
        await expectNoHorizontalOverflow(page, 320, "mobiler 320-CSS-px-Viewport");
        await expectNoWcagAaAxeViolations(page, panelSelector, "interaktiver 320-CSS-px-Zustand");
        await page.setViewportSize({ width: 1280, height: 1000 });
      });

      const readyCandidate = preparedRelease.queuedCandidate;
      const readyArtifact = preparedRelease.releaseArtifact;
      const approvalArtifactVersion = preparedRelease.approvalArtifactVersion;

      await test.step("PDF laden und kandidatenlokale Prüfpunkte vollständig per Tastatur bestätigen", async () => {
        const panel = page.locator(RELEASE_PANEL_SELECTOR);
        const downloadLink = panel.getByRole("link", { name: "Freigabekandidat-PDF laden" });
        const downloadPath = await downloadLink.getAttribute("href");
        if (!downloadPath) throw new Error("Der private Kandidaten-Download hat kein Ziel.");
        const [downloadResponse, download] = await Promise.all([
          page.waitForResponse((response) => (
            response.request().method() === "GET"
            && new URL(response.url()).pathname === downloadPath
          )),
          page.waitForEvent("download"),
          downloadLink.click(),
        ]);
        const downloadedBytes = await bytesFromDownload(download);
        expect(downloadResponse.status()).toBe(200);
        expect(downloadResponse.headers()["cache-control"]).toBe("private, no-store, max-age=0");
        expect(downloadResponse.headers()["x-content-type-options"]).toBe("nosniff");
        expect(downloadResponse.headers()["referrer-policy"]).toBe("no-referrer");
        expect(downloadResponse.headers()["content-security-policy"]).toBe("sandbox; default-src 'none'");
        expect(downloadedBytes.equals(readyArtifact.bytes)).toBe(true);
        expect(createHash("sha256").update(downloadedBytes).digest("hex"))
          .toBe(readyArtifact.sha256);

        const approvalForm = panel.locator("form").filter({
          has: page.getByRole("button", { name: "Abschlussfreigabe speichern" }),
        });
        const artifactVersionField = approvalForm.locator('input[name="expectedArtifactVersion"]');
        await expect(artifactVersionField).toHaveValue(approvalArtifactVersion);
        const checkboxes = approvalForm.getByRole("checkbox");
        const checkboxCount = await checkboxes.count();
        expect(checkboxCount).toBeGreaterThanOrEqual(4);
        expect(checkboxCount).toBeLessThanOrEqual(5);

        for (let index = 0; index < checkboxCount; index += 1) {
          await checkboxes.nth(index).check();
        }
        await artifactVersionField.evaluate((input: HTMLInputElement, value) => {
          input.value = value;
        }, randomUUID());
        const approvalButton = approvalForm.getByRole("button", {
          name: "Abschlussfreigabe speichern",
        });
        await approvalButton.click();
        const feedback = panel.locator(`#approval-action-feedback-${readyCandidate.candidateId}`);
        await expect(feedback).toBeFocused();
        await expect(feedback).toHaveAttribute("role", "alert");
        await expect(feedback).toContainText(
          "Alle Prüfpunkte wurden nach dem Antwortlauf zurückgesetzt. Prüfe das PDF und bestätige jeden Punkt vor einem erneuten Versuch nochmals.",
        );
        for (let index = 0; index < checkboxCount; index += 1) {
          await expect(checkboxes.nth(index)).not.toBeChecked();
        }
        await expect(artifactVersionField).toHaveValue(approvalArtifactVersion);
        await page.keyboard.press("Shift+Tab");
        await expect(approvalButton).toBeFocused();

        await downloadLink.focus();
        await page.keyboard.press("Tab");
        for (let index = 0; index < checkboxCount; index += 1) {
          const checkbox = checkboxes.nth(index);
          await expect(checkbox).toBeFocused();
          await expect(checkbox).toHaveAccessibleName(/\S/u);
          await page.keyboard.press("Space");
          await expect(checkbox).toBeChecked();
          await page.keyboard.press("Tab");
        }
        await expect(approvalButton).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(feedback).toContainText("Die Abschlussfreigabe wurde gespeichert.");
        await expect(feedback).toContainText("nicht ausgestellt und nicht versendet");
        await expect(panel.locator(`#candidate-status-${readyCandidate.candidateId}`)).toBeFocused();
        const persistedApproval = await readApprovedReleaseCandidateEvidence(
          state,
          readyCandidate.candidateId,
        );
        expect(persistedApproval).toEqual({
          approvalArtifactVersion,
          candidateArtifactVersion: approvalArtifactVersion,
          candidateState: "ready_for_approval",
          expectedArtifactVersion: approvalArtifactVersion,
        });
      });

      await test.step("fehlendes Prepare-Recht hält Empfänger-PII aus HTML/RSC-Payload fern", async () => {
        await setEditorRole(state, "editor");
        await page.reload();
        const panel = page.locator(RELEASE_PANEL_SELECTOR);
        await expect(panel.getByText(
          `Gespeicherter und geprüfter Empfängerstand ist vorhanden: Revision ${recipientRevisionTwo.revision}.`,
          { exact: true },
        )).toBeVisible();
        await expect(panel.getByText(/Personenbezogene Empfängerdetails werden/u)).toBeVisible();
        await expect(panel.locator("form")).toHaveCount(0);
        const forbiddenRecipientPii = [
          SYNTHETIC_RECIPIENT_EMAIL,
          SYNTHETIC_BILLING_STREET,
          SYNTHETIC_RECIPIENT_REVISION_TWO.email,
          SYNTHETIC_RECIPIENT_REVISION_TWO.billingAddress.street,
        ];
        const documentHtml = await page.content();
        for (const piiValue of forbiddenRecipientPii) {
          expect(documentHtml).not.toContain(piiValue);
        }
        const rawResponse = await page.request.get(offerPath);
        expect(rawResponse.status()).toBe(200);
        const rawPayload = await rawResponse.text();
        for (const piiValue of forbiddenRecipientPii) {
          expect(rawPayload).not.toContain(piiValue);
        }
      });
    } finally {
      await setEditorRole(state, "editor");
    }
  });
});
