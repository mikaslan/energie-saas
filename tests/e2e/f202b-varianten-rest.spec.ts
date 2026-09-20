import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Pool, QueryResultRow } from "pg";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";
import { seedM201ReadyProject } from "./m2-01-fixture";

/**
 * F2-02b Varianten-Rest — Chromium-E2E (RED).
 *
 * F202B-E2E-01: Duplikat-Then-Read-back (Bundles + Zahlart der Quelle landen auf
 * der Kopie, Kopie nie primary; Zahlart auf der Kopie sichtbar) + Override-Block
 * bei pending-Signatur (UI-Fehlermeldung per role=alert, kein Redirect, DB-Wert
 * unverändert).
 *
 * Muster: tests/e2e/f2-02-varianten-vertiefung.spec.ts (Login, Offer-Erzeugung,
 * Duplikat, Read-back) + tests/e2e/f2-05-zahlarten.spec.ts (Zahlart-Stammdaten
 * per UI, Varianten-Auswahl). Eigenes Projekt in isoliertem Workspace
 * (CI-Isolation: kein geteilter W3-Workspace mit F2.5).
 *
 * RED-Gründe: duplicateOfferVariant kopiert weder optional_bundles noch
 * payment_option_id (service.ts insertVariant ohne beide Felder); der
 * setTotalPriceOverride-Lock-Guard fehlt (kein readVariantContentLocks-Block);
 * variant-actions.ts kennt keinen blocked-Status (kein OfferBlockedError-Mapping).
 *
 * Eigenes Ready-Projekt per In-Spec-Seed (f16-11-Muster): seedM201ReadyProject
 * in test.beforeAll mit eindeutigem skuSuffix — kein neues State-Feld nötig,
 * kein Setup-Fail; editorIdentityId liefert der bestehende State (run.mts).
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  w3WorkspaceId: string;
  editorIdentityId: string;
  editorEmail: string;
};

const browserErrors = new WeakMap<Page, string[]>();

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "databaseUrl",
    "serverLogPath",
    "w3WorkspaceId",
    "editorIdentityId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F2-02b-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

let f202bProjectId = "";
let f202bWorkspaceId = "";

/** Eigener isolierter Workspace + Editor-Membership (F12-01/F9-14-Muster). */
async function seedIsolatedWorkspace(): Promise<string> {
  const data = state();
  const workspaceId = randomUUID();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const identities = await pool.query<{ id: string; email: string }>(
      "select id, email from user_identity where email = $1",
      [data.editorEmail],
    );
    const editorId = identities.rows.find((row) => row.email === data.editorEmail)?.id;
    if (!editorId) throw new Error("F202B: Editor-Identität fehlt.");
    const client = await pool.connect();
    try {
      await client.query("insert into workspace (id, name) values ($1::uuid, $2)", [
        workspaceId,
        "F202B isolierter Varianten-Workspace",
      ]);
      // Membership-DML verlangt Workspace-Kontext (RLS) auf derselben Verbindung.
      await client.query(
        "select set_config('app.actor_id', '', false), set_config('app.workspace_id', $1, false)",
        [workspaceId],
      );
      // W3-Capabilities spiegeln (Zahlart-/Angebot-UI + M2-01-Seed).
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'editor',
           '{"manage_catalog":true,"edit_prices":true,"see_purchase_prices":true,
              "assign_projects":true,"convert_phase":true,"discounts":true}'::jsonb)`,
        [workspaceId, editorId],
      );
    } finally {
      client.release();
    }
    return workspaceId;
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test.beforeAll(async () => {
  const data = state();
  f202bWorkspaceId = await seedIsolatedWorkspace();
  const seed = await seedM201ReadyProject(data.databaseUrl, {
    workspaceId: f202bWorkspaceId,
    editorIdentityId: data.editorIdentityId,
    skuSuffix: `w3-f202b-${randomUUID().slice(0, 8)}`,
  });
  f202bProjectId = seed.projectId;
});

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

type VariantRow = {
  id: string;
  ordinal: number;
  isPrimary: boolean;
  bundles: unknown;
  paymentOptionId: string | null;
  override: string | null;
};

async function readVariantState(offerId: string): Promise<VariantRow[]> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `select v.id::text as id, v.ordinal as ordinal,
              v.is_primary as "isPrimary", v.optional_bundles as bundles,
              v.payment_option_id::text as "paymentOptionId",
              o.total_price_override_net_cents::text as override
         from offer o
         join offer_variant v
           on v.workspace_id = o.workspace_id
          and v.offer_id = o.id
        where o.workspace_id = $1::uuid
          and o.id = $2::uuid
        order by v.ordinal asc`,
      [f202bWorkspaceId, offerId],
    );
    return result.rows as VariantRow[];
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

type JsonResult = QueryResultRow & { result: Record<string, unknown> };

async function tenantFn<Row extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  workspaceId: string,
  actorId: string | null,
  text: string,
  values: unknown[] = [],
): Promise<import("pg").QueryResult<Row>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    await client.query("select pg_catalog.set_config('app.actor_id', $1, true)", [actorId ?? ""]);
    const result = await client.query<Row>(text, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Test-only-Vorbedingung: pending-Signatur-Lock auf genau einer Variante.
 * M2-04-E2E-Muster (m2-04-fixture + f16-14-Releasekette auf UI-Angebot + f208):
 * PDF-Entwurf → Release-Profil → Empfänger → Freigabekandidat → Issuance +
 * 2× Approval über produktive SQL-Funktionen, dann create_signature_request.
 * Ein rohes signature_request-INSERT scheitert am M2-04-Trigger (interner
 * Editor/Admin-Akteur + freigegebene Ausstellungsfassung + created_by=Actor).
 * Akteure sind frische Admin-Identitäten (eigene UUIDs, rein additiv —
 * kein Shared-Membership-Umbau, Workspace ist isoliert).
 */
async function seedPendingSignatureLock(
  projectId: string,
  offerId: string,
  variantId: string,
): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const revision = await tenantFn<{ id: string; revision: number; snapshot_sha256: Buffer }>(
      pool,
      f202bWorkspaceId,
      null,
      `select id::text as id, revision, snapshot_sha256
         from offer_variant_revision
        where workspace_id = $1::uuid and offer_id = $2::uuid and variant_id = $3::uuid
        order by revision desc limit 1`,
      [f202bWorkspaceId, offerId, variantId],
    );
    const revisionRow = revision.rows[0];
    if (!revisionRow) throw new Error("F202B: Variantenrevision fehlt.");

    // Frische Admin-Akteure (m2-04-fixture-Zweitakteur-Muster, additiv).
    const adminA = randomUUID();
    const adminB = randomUUID();
    for (const [actor, tag] of [[adminA, "a"], [adminB, "b"]] as const) {
      await pool.query("insert into public.user_identity (id, email) values ($1, $2)", [
        actor,
        `f202b-${tag}-${actor}@invalid`,
      ]);
      await tenantFn(
        pool,
        f202bWorkspaceId,
        null,
        "insert into public.membership (workspace_id, user_id, role, capabilities) values ($1::uuid, $2::uuid, 'admin', '{}'::jsonb)",
        [f202bWorkspaceId, actor],
      );
    }

    await tenantFn(
      pool,
      f202bWorkspaceId,
      null,
      "update public.project set phase = 'offer' where workspace_id = $1::uuid and id = $2::uuid",
      [f202bWorkspaceId, projectId],
    );

    // PDF-Entwurf: queued-INSERT (Input leitet der BEFORE-Trigger aus der
    // versiegelten Revision ab), dann running→succeeded mit synthetischem Artefakt.
    const draft = await tenantFn<{ id: string }>(
      pool,
      f202bWorkspaceId,
      adminA,
      `insert into offer_pdf_draft (
         workspace_id, project_id, offer_id, variant_id, variant_revision_id,
         variant_revision, variant_snapshot_sha256, input_version,
         canonicalization_version, template_version, renderer_recipe_version,
         reservation_key, input_snapshot, input_sha256, created_by
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::integer, $7::bytea, 'offer-pdf-draft-input.v1',
         'offer-jcs.v1', 'offer-pdf-draft-template.v1',
         'offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac',
         $8::bytea, '{}'::jsonb, $8::bytea, $9::uuid
       ) returning id::text as id`,
      [
        f202bWorkspaceId,
        projectId,
        offerId,
        variantId,
        revisionRow.id,
        revisionRow.revision,
        revisionRow.snapshot_sha256,
        randomBytes(32),
        adminA,
      ],
    );
    const draftId = draft.rows[0]?.id;
    if (!draftId) throw new Error("F202B: PDF-Entwurf fehlt.");
    await tenantFn(
      pool,
      f202bWorkspaceId,
      null,
      `update offer_pdf_draft set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(),
              lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(),
              updated_at = clock_timestamp()
        where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`,
      [f202bWorkspaceId, draftId],
    );
    const draftArtifact = Buffer.from(`%PDF-1.7\n${"f202b-draft".repeat(8)}\n%%EOF`, "utf8");
    await tenantFn(
      pool,
      f202bWorkspaceId,
      null,
      `update offer_pdf_draft set state = 'succeeded', lease_token = null, lease_expires_at = null,
              artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea),
              artifact_size_bytes = octet_length($2::bytea), finished_at = clock_timestamp(), updated_at = clock_timestamp()
        where workspace_id = $1::uuid and id = $3::uuid and state = 'running'`,
      [f202bWorkspaceId, draftArtifact, draftId],
    );

    const sender = {
      legalName: "F202B Energie GmbH",
      tradingName: "F202B",
      representedBy: "F202B Vertretung",
      address: { street: "Testweg", houseNumber: "1", postalCode: "10115", city: "Berlin", country: "DE" },
      email: "office@f202b.invalid",
      phoneE164: "+493000000000",
      websiteHttpsUrl: "https://f202b.invalid",
      registerCourt: "F202B Registergericht",
      registerNumber: "HRB F202B 1",
      vatId: "DE000000000",
    };
    const legalDocuments = {
      terms: { title: "Bedingungen", plainText: "Synthetische Bedingungen." },
      withdrawalInformation: { title: "Widerruf", plainText: "Synthetische Widerrufsinformation." },
      privacyNotice: { title: "Datenschutz", plainText: "Synthetischer Datenschutzhinweis." },
    };
    await tenantFn(
      pool,
      f202bWorkspaceId,
      adminA,
      `select public.revise_offer_release_profile($1::uuid, 0, 'F202B Profil', $2::jsonb, $3::jsonb)`,
      [f202bWorkspaceId, JSON.stringify(sender), JSON.stringify(legalDocuments)],
    );
    const profile = await tenantFn<{ profile_id: string; profile_revision_id: string; profile_revision: number }>(
      pool,
      f202bWorkspaceId,
      null,
      `select profile.id as profile_id, revision.id as profile_revision_id, revision.revision as profile_revision
         from offer_release_profile as profile
         join offer_release_profile_revision as revision
           on revision.workspace_id = profile.workspace_id
          and revision.profile_id = profile.id
          and revision.revision = profile.current_revision
        where profile.workspace_id = $1::uuid limit 1`,
      [f202bWorkspaceId],
    );
    const profileHead = profile.rows[0];
    if (!profileHead) throw new Error("F202B: Release-Profil fehlt.");
    await tenantFn(
      pool,
      f202bWorkspaceId,
      adminA,
      `select public.activate_offer_release_profile($1::uuid, $2::uuid, $3::uuid, $4::integer)`,
      [f202bWorkspaceId, profileHead.profile_id, profileHead.profile_revision_id, profileHead.profile_revision],
    );

    const billingAddress = { street: "Rechnungsweg", houseNumber: "8a", postalCode: "10999", city: "Berlin", country: "DE" };
    await tenantFn(
      pool,
      f202bWorkspaceId,
      adminA,
      `select public.revise_offer_recipient($1::uuid, $2::uuid, 0, 'F202B Rechnungsempfaenger', 'F202B Kundin GmbH', 'rechnung@f202b.invalid', $3::jsonb, true)`,
      [f202bWorkspaceId, offerId, JSON.stringify(billingAddress)],
    );
    const recipient = await tenantFn<{ recipient_revision_id: string; recipient_revision: number }>(
      pool,
      f202bWorkspaceId,
      null,
      `select revision.id as recipient_revision_id, revision.revision as recipient_revision
         from offer_recipient as recipient
         join offer_recipient_revision as revision
           on revision.workspace_id = recipient.workspace_id
          and revision.recipient_id = recipient.id
          and revision.revision = recipient.current_revision
        where recipient.workspace_id = $1::uuid and recipient.offer_id = $2::uuid limit 1`,
      [f202bWorkspaceId, offerId],
    );
    const recipientHead = recipient.rows[0];
    if (!recipientHead) throw new Error("F202B: Empfaenger fehlt.");

    const preparedCandidate = await tenantFn<JsonResult>(
      pool,
      f202bWorkspaceId,
      adminA,
      `select public.prepare_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::uuid, $7::uuid, $8::integer, $9::uuid, $10::integer, ((clock_timestamp() at time zone 'Europe/Berlin')::date + $11::integer)::date) as result`,
      [
        f202bWorkspaceId,
        offerId,
        variantId,
        revisionRow.revision,
        draftId,
        profileHead.profile_id,
        profileHead.profile_revision_id,
        profileHead.profile_revision,
        recipientHead.recipient_revision_id,
        recipientHead.recipient_revision,
        14,
      ],
    );
    if (preparedCandidate.rows[0]?.result?.status !== "prepared") {
      throw new Error(`F202B: Release-Candidate-Vorbereitung fehlgeschlagen (${JSON.stringify(preparedCandidate.rows[0]?.result)}).`);
    }
    const candidate = await tenantFn<{ candidate_id: string }>(
      pool,
      f202bWorkspaceId,
      null,
      `select id as candidate_id from offer_release_candidate
        where workspace_id = $1::uuid and offer_id = $2::uuid
        order by created_at desc, id desc limit 1`,
      [f202bWorkspaceId, offerId],
    );
    const candidateId = candidate.rows[0]?.candidate_id;
    if (!candidateId) throw new Error("F202B: Release-Candidate fehlt.");
    await tenantFn(
      pool,
      f202bWorkspaceId,
      null,
      `update offer_release_candidate set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(),
              lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(),
              updated_at = clock_timestamp()
        where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`,
      [f202bWorkspaceId, candidateId],
    );
    const candidateArtifact = Buffer.from(`%PDF-1.7\n${"f202b-release-candidate".repeat(8)}\n%%EOF`, "utf8");
    const artifactVersion = randomUUID();
    await tenantFn(
      pool,
      f202bWorkspaceId,
      null,
      `update offer_release_candidate set state = 'ready_for_approval', lease_token = null, lease_expires_at = null,
              artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea),
              artifact_size_bytes = octet_length($2::bytea), artifact_version = $3::uuid, finished_at = clock_timestamp(),
              updated_at = clock_timestamp()
        where workspace_id = $1::uuid and id = $4::uuid and state = 'running'`,
      [f202bWorkspaceId, candidateArtifact, artifactVersion, candidateId],
    );
    const candidateApproval = await tenantFn<JsonResult>(
      pool,
      f202bWorkspaceId,
      adminA,
      `select public.approve_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, true, true, true, null) as result`,
      [f202bWorkspaceId, offerId, candidateId, artifactVersion],
    );
    if (candidateApproval.rows[0]?.result?.status !== "approved") {
      throw new Error(`F202B: Candidate-Freigabe fehlgeschlagen (${JSON.stringify(candidateApproval.rows[0]?.result)}).`);
    }

    const prepared = await tenantFn<JsonResult>(
      pool,
      f202bWorkspaceId,
      adminA,
      `select public.prepare_offer_issuance($1::uuid, $2::uuid, $3::uuid) as result`,
      [f202bWorkspaceId, offerId, candidateId],
    );
    if (prepared.rows[0]?.result?.status !== "prepared") {
      throw new Error(`F202B: Ausstellungsreservation fehlgeschlagen (${JSON.stringify(prepared.rows[0]?.result)}).`);
    }
    const issuanceId = prepared.rows[0]?.result.issuanceId;
    if (typeof issuanceId !== "string") throw new Error("F202B: Ausstellungsreservation fehlt.");
    const lease = randomUUID();
    await tenantFn(
      pool,
      f202bWorkspaceId,
      null,
      `select public.claim_offer_issuance_render($1::uuid, $2::uuid, $3::uuid, 120) as result`,
      [f202bWorkspaceId, issuanceId, lease],
    );
    const artifact = Buffer.from(`%PDF-1.7\n${"f202b-final-issuance".repeat(8)}\n%%EOF`, "utf8");
    await tenantFn(
      pool,
      f202bWorkspaceId,
      null,
      `select public.finalize_offer_issuance_render_success($1::uuid, $2::uuid, $3::uuid, 1, $4::bytea) as result`,
      [f202bWorkspaceId, issuanceId, lease, artifact],
    );
    for (const approver of [adminA, adminB]) {
      const approval = await tenantFn<JsonResult>(
        pool,
        f202bWorkspaceId,
        approver,
        `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`,
        [f202bWorkspaceId, issuanceId],
      );
      if (approval.rows[0]?.result?.status !== "approved") {
        throw new Error(`F202B: Ausstellungs-Freigabe fehlgeschlagen (${JSON.stringify(approval.rows[0]?.result)}).`);
      }
    }

    // Echter pending-Request über die Produktfunktion (f208-Muster).
    const tokenHash = createHash("sha256").update(randomBytes(32)).digest();
    const request = await tenantFn<JsonResult>(
      pool,
      f202bWorkspaceId,
      adminA,
      `select public.create_signature_request($1::uuid, $2::uuid, $3::uuid, 14, $4::bytea) as result`,
      [f202bWorkspaceId, offerId, variantId, tokenHash],
    );
    if (request.rows[0]?.result?.status !== "pending") {
      throw new Error(`F202B: Signatur-Request fehlt (${JSON.stringify(request.rows[0]?.result)}).`);
    }
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test("F202B-E2E-01: Duplikat kopiert Bundles + Zahlart; Override-Block bei pending-Signatur", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  // Zahlart-Stammdaten per UI (eigene Bezeichnung, Muster F2.5-E2E-02).
  const settingsPath = `/w/${f202bWorkspaceId}/einstellungen/zahlarten`;
  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await page.getByLabel("Schlüssel").selectOption("purchase");
  await page.getByLabel("Bezeichnung").fill("F202B E2E");
  await page.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("Zahlart angelegt.")).toBeVisible();

  // Angebot per UI erzeugen (Ready-Status aus dem M2-01-Seed).
  if (!f202bProjectId || !f202bWorkspaceId) throw new Error("F202B-Seed fehlt (beforeAll nicht gelaufen?).");
  const projectPath = `/w/${f202bWorkspaceId}/anfragen/${f202bProjectId}`;
  await page.goto(projectPath);
  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("9800");
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) =>
    /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
    && url.searchParams.has("variante"));
  const detailPath = new URL(page.url()).pathname;
  const sourceVariantId = new URL(page.url()).searchParams.get("variante");
  expect(sourceVariantId).toBeTruthy();
  const offerId = detailPath.split("/").pop();
  if (!offerId) throw new Error("Der Angebots-Pfad enthält keine Offer-ID.");
  await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();

  const controls = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Primärvariante und Deal-Wert", exact: true }),
  });
  await expect(controls).toBeVisible();

  // Quelle ausstatten: Bundle + Zahlart (D1-01-Kopiervorlage).
  await controls.getByRole("button", { name: "Bundle hinzufügen", exact: true }).click();
  await controls.getByLabel("Bundle-Name 1", { exact: true }).fill("F202B-Paket");
  await controls.getByRole("button", { name: "Bundles speichern", exact: true }).click();
  await expect(controls.getByText("Die optionalen Bundles wurden gespeichert.")).toBeVisible();

  const paymentPanel = page.locator("section").filter({
    has: page.getByRole("heading", { name: /Zahlart/, exact: false }),
  });
  await paymentPanel.getByLabel("Zahlart wählen").selectOption({ label: "F202B E2E (Kauf)" });
  await paymentPanel.getByRole("button", { name: "Zahlart speichern", exact: true }).click();
  await expect(paymentPanel.getByText("Die Zahlart wurde gespeichert.")).toBeVisible();

  // Duplizieren per UI.
  const duplicateSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Variante duplizieren", exact: true }),
  });
  await duplicateSection.getByLabel("Name der Kopie").fill("F202B-Kopie");
  await duplicateSection.getByRole("button", { name: "Duplizieren", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === detailPath
    && url.searchParams.get("variante") !== sourceVariantId);
  const copyVariantId = new URL(page.url()).searchParams.get("variante");
  expect(copyVariantId).toBeTruthy();
  await expect(page.locator("#variant-name")).toHaveValue("F202B-Kopie");

  // D1-01-Read-back: Kopie trägt Bundles + Zahlart der Quelle, nie primary.
  await expect.poll(async () => (await readVariantState(offerId)).length, {
    message: "Beide Varianten müssen persistiert sein.",
    timeout: 15_000,
  }).toBe(2);
  const variants = await readVariantState(offerId);
  const source = variants.find((row) => row.id === sourceVariantId);
  const copy = variants.find((row) => row.id === copyVariantId);
  expect(source?.isPrimary).toBe(true);
  expect(copy?.isPrimary).toBe(false);
  expect(copy?.bundles).toEqual([{ name: "F202B-Paket", position: 0 }]);
  expect(copy?.bundles).toEqual(source?.bundles);
  expect(source?.paymentOptionId).toBeTruthy();
  expect(copy?.paymentOptionId).toBe(source?.paymentOptionId);

  // Zahlart auf der Kopie sichtbar (kein „Keine Angabe"-Rückfall).
  const copyPaymentPanel = page.locator("section").filter({
    has: page.getByRole("heading", { name: /Zahlart/, exact: false }),
  });
  await expect(copyPaymentPanel.getByText(/Aktuell:/)).toContainText("F202B E2E");

  // D1-03: pending-Signatur auf der Kopie blockt den Offer-Override (Scope:
  // irgendeine Variante gelockt → Block). Kein Redirect, DB-Wert bleibt leer.
  await seedPendingSignatureLock(f202bProjectId, offerId, copyVariantId!);
  const copyControls = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Primärvariante und Deal-Wert", exact: true }),
  });
  await copyControls.getByLabel("Deal-Override netto in Euro (optional)").fill("99,00");
  await copyControls.getByRole("button", { name: "Override speichern", exact: true }).click();
  await expect(copyControls.getByRole("alert")).toContainText(/für die Signatur gesperrt/);
  expect(new URL(page.url()).pathname).toBe(detailPath);
  expect(new URL(page.url()).searchParams.get("variante")).toBe(copyVariantId);
  const blocked = await readVariantState(offerId);
  expect(blocked[0]?.override).toBeNull();
  expect(blocked[1]?.override).toBeNull();

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});
