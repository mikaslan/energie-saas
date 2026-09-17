import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { Pool, QueryResultRow } from "pg";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "playwright/test";
import { sql } from "drizzle-orm";
import {
  claimOfferPdfDraftJob,
  finalizeOfferPdfDraftSuccess,
} from "../../worker/offer-pdf-database";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";
import {
  CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
  RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
} from "../../lib/integrations/catalog/contract";
import {
  activateCatalogComponent,
  resolveProjectCatalog,
  reviseCatalogComponentPricing,
} from "../../modules/catalog";
import {
  M2_01_E2E_CONTACT,
  seedM201ReadyProject,
  withM201Database,
} from "./m2-01-fixture";

/**
 * F16-14 Angebots-Bulk-Update — Chromium-E2E (RED-first).
 *
 * Bindung: `docs/spec/F16-14-bulk-update.md` (Abschnitte UI + Tests). Diese
 * Datei MUSS rot sein, bis UI und Batch-Befehl existieren: Die Bulk-Sektion
 * auf der Angebotsdetailseite gibt es noch nicht.
 *
 * Seed (eigener isolierter Workspace per randomUUID + Membership-Insert,
 * niemals der geteilte E2E-Workspace): M201-Projekt, Angebot mit den
 * Varianten "Basis" + "F1614 Quelle B" (beide outdated nach Katalogdrift auf
 * Kat.-Rev. 2) + "F1614 Wartend" (echte Signaturanfrage, M2-04-Muster,
 * Status pending — Projekt bleibt offen, Variante per Content-Lock
 * gesperrt). Angebot, Duplikate, PDF-Entwurf und Signaturanfrage laufen
 * über die echten Produktpfade im Browser; nur der Katalog (Modul ohne
 * Server-Bindung) und die Freigabekette (produktive SQL-Funktionen, Muster
 * `m2-04-fixture`) werden per Datenbank angesteuert. Signiert/widerrufen/
 * geschlossen deckt die DB-Ebene ab (DB-05/07/13): `loadCurrentBasis`
 * verweigert ausfuehrbare Zeilen auf geschlossenem Projekt
 * (`project_not_eligible`, modules/offers/service.ts) — Bulk-Erfolg im
 * Browser braucht daher das offene Projekt.
 *
 * Festgeschriebene UI-Namen (fuer die Implementierung bindend):
 * - Sektion mit Heading "Bulk-Update" (exact) + Scope-Attribut
 *   `[data-f1614-bulk-section]` (nur Axe-Scope, fail-closed geprueft).
 * - Je outdated Zeile: Steuer-Select `Steuer für {Quellname}` (Default leer),
 *   Nachfolgername `Nachfolgername für {Quellname}` (vorbelegt
 *   `{Quellname} · Kat.-Rev. 2`, U+00B7).
 * - Genau ein Confirm `2 Nachfolger auf Kat.-Rev. 2 anlegen` (exact).
 * - Skip-Gruende: `Übersprungen:` + `{Name} — wartet auf Signatur` (Em-Dash;
 *   weitere Zeilen: `— signiert`, `— vom Kunden widerrufen`,
 *   `— bereits aktuell`).
 */

const browserErrors = new WeakMap<Page, string[]>();

type SerializedF1614State = {
  databaseUrl: string;
  editorEmail: string;
  editorIdentityId: string;
  serverLogPath: string;
};

type F1614Db = {
  databaseUrl: string;
  workspaceId: string;
  editorIdentityId: string;
};

type F1614Products = {
  module: string;
  inverter: string;
  battery: string;
  wallbox: string;
};

function runtimeState(): SerializedF1614State {
  const statePath = process.env.M1_05_E2E_STATE;
  if (!statePath) {
    throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  }
  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SerializedF1614State>;
  const required: Array<keyof SerializedF1614State> = [
    "databaseUrl",
    "editorEmail",
    "editorIdentityId",
    "serverLogPath",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F16-14-E2E-State ist unvollständig.");
  }
  return parsed as SerializedF1614State;
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
  throw new Error("Der echte F16-14-Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedTarget: string): Promise<void> {
  const data = runtimeState();
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.searchParams.get("next")).toBe(expectedTarget);

  const logOffset = statSync(data.serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otpInput = page.getByLabel("Sechsstelliger Code");
  await otpInput.fill(await otpFromPrivateDevMailLog(data.serverLogPath, email, logOffset));
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
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expectedTarget);
}

function selectedVariantId(page: Page): string {
  const variantId = new URL(page.url()).searchParams.get("variante");
  if (!variantId) throw new Error("F16-14-E2E-URL enthält keine aktive Variante.");
  return variantId;
}

function selectedOfferId(page: Page): string {
  const offerId = new URL(page.url()).pathname.split("/").at(-1);
  if (!offerId) throw new Error("F16-14-E2E-URL enthält kein Angebot.");
  return offerId;
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

const NEW_BATTERY_SALES_CENTS = 410_000;
const NEW_BATTERY_PURCHASE_CENTS = 255_000;

/** Katalogdrift (Batterie Rev. 2) + Re-Resolution: alle Rev.-1-Quellen outdated. */
async function driftBatteryToRevision2(
  db: F1614Db,
  projectId: string,
  products: F1614Products,
): Promise<void> {
  const revised = await withM201Database(db, (tx, ctx) =>
    reviseCatalogComponentPricing(tx, ctx, {
      schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
      componentId: products.battery,
      expectedRevision: 1,
      commercial: {
        currency: "EUR",
        basis: "net",
        purchasePriceNetCents: NEW_BATTERY_PURCHASE_CENTS,
        salesPriceNetCents: NEW_BATTERY_SALES_CENTS,
        purchaseProvenance: {
          sourceKind: "supplier_price_list",
          reference: "PRIVATE-F1614-E2E-EK-battery-2",
          observedOn: "2026-08-30",
          rightsBasis: "supplier_authorized",
          sourceDocumentSha256: null,
        },
        salesProvenance: {
          sourceKind: "workspace_pricing",
          reference: "SYNTHETIC-F1614-E2E-VK-battery-2",
          observedOn: "2026-08-30",
          rightsBasis: "workspace_owned",
          sourceDocumentSha256: null,
        },
      },
    }));
  expect(revised.revision).toBe(2);
  await withM201Database(db, (tx, ctx) =>
    activateCatalogComponent(tx, ctx, {
      componentId: products.battery,
      expectedRevision: 2,
      expectedStatus: "draft",
    }));
  await withM201Database(db, (tx, ctx) =>
    resolveProjectCatalog(tx, ctx, {
      schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
      projectId,
      expectedResolutionRevision: 1,
      expectedRequirementRevision: 1,
      expectedCalculationRevision: 1,
      selections: [
        { componentId: products.module, expectedComponentRevision: 1, quantity: 26 },
        { componentId: products.inverter, expectedComponentRevision: 1, quantity: 1 },
        { componentId: products.battery, expectedComponentRevision: 2, quantity: 1 },
        { componentId: products.wallbox, expectedComponentRevision: 1, quantity: 1 },
      ],
      acknowledgements: ["cross_component_compatibility_unverified"],
    }));
}

type VariantNameRow = {
  id: string;
  name: string;
  ordinal: number;
  [key: string]: unknown;
};

async function readVariantNames(db: F1614Db, offerId: string): Promise<VariantNameRow[]> {
  return withM201Database(db, async (tx) => {
    const result = await tx.execute<VariantNameRow>(sql`
      select id, name, ordinal
        from offer_variant
       where workspace_id = ${db.workspaceId}::uuid
         and offer_id = ${offerId}::uuid
       order by ordinal, id
    `);
    return [...result.rows];
  });
}

async function readSignatureAndProject(
  db: F1614Db,
  offerId: string,
  variantId: string,
  projectId: string,
): Promise<{ signatureStatus: string | null; phase: string; outcome: string }> {
  return withM201Database(db, async (tx) => {
    const signature = await tx.execute<{ status: string | null; [key: string]: unknown }>(sql`
      select max(status) as status
        from signature_request
       where workspace_id = ${db.workspaceId}::uuid
         and offer_id = ${offerId}::uuid
         and variant_id = ${variantId}::uuid
    `);
    const project = await tx.execute<{ phase: string; outcome: string; [key: string]: unknown }>(sql`
      select phase, outcome
        from project
       where workspace_id = ${db.workspaceId}::uuid
         and id = ${projectId}::uuid
    `);
    const projectRow = project.rows[0];
    if (!projectRow) throw new Error("F16-14: erwartetes Projekt fehlt.");
    return {
      signatureStatus: signature.rows[0]?.status ?? null,
      phase: projectRow.phase,
      outcome: projectRow.outcome,
    };
  });
}

type QueuedPdfDraft = {
  jobId: string;
  state: string;
  variantRevision: number;
};

async function readQueuedPdfDraft(
  db: F1614Db,
  offerId: string,
  variantId: string,
): Promise<QueuedPdfDraft> {
  return withM201Database(db, async (tx) => {
    const result = await tx.execute<QueuedPdfDraft & { [key: string]: unknown }>(sql`
      select id as "jobId", state, variant_revision as "variantRevision"
        from offer_pdf_draft
       where workspace_id = ${db.workspaceId}::uuid
         and offer_id = ${offerId}::uuid
         and variant_id = ${variantId}::uuid
       order by created_at desc, id desc
    `);
    if (result.rows.length !== 1 || result.rows[0]!.state !== "queued") {
      throw new Error("Der sichtbare F16-14-PDF-Auftrag ist nicht eindeutig queued persistiert.");
    }
    return result.rows[0]!;
  });
}

function syntheticPdfArtifact(marker: string): {
  mimeType: "application/pdf";
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
} {
  const bytes = Buffer.from(`%PDF-1.7\n${marker.repeat(12)}\n%%EOF`, "utf8");
  return {
    mimeType: "application/pdf",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
}

/**
 * Freigabekette bis zur zweifach freigegebenen Ausstellungsfassung (Muster
 * `m2-04-fixture`, produktive SQL-Funktionen): Offer-Phase, Admin-Akteure,
 * Release-Profil, Empfaenger, Freigabekandidat, Issuance + 2× Approval. Der
 * PDF-Entwurf kommt aus dem echten Browser-Pfad und ist bereits succeeded.
 */
async function prepareReleaseChain(input: {
  databaseUrl: string;
  workspaceId: string;
  editorIdentityId: string;
  projectId: string;
  offerId: string;
  variantId: string;
  draftJobId: string;
}): Promise<void> {
  const { databaseUrl, workspaceId, editorIdentityId, projectId, offerId, variantId, draftJobId } = input;
  const pool = createDrainTrackedPool({ connectionString: databaseUrl, max: 1 });
  try {
    await tenantFn(
      pool,
      workspaceId,
      null,
      "update public.project set phase = 'offer' where workspace_id = $1::uuid and id = $2::uuid",
      [workspaceId, projectId],
    );
    await tenantFn(
      pool,
      workspaceId,
      null,
      `update membership set role = 'admin', capabilities = '{}'::jsonb
        where workspace_id = $1::uuid and user_id = $2::uuid`,
      [workspaceId, editorIdentityId],
    );

    const sender = {
      legalName: "F1614 Energie GmbH",
      tradingName: "F1614",
      representedBy: "F1614 Vertretung",
      address: { street: "Testweg", houseNumber: "1", postalCode: "10115", city: "Berlin", country: "DE" },
      email: "office@f1614.invalid",
      phoneE164: "+493000000000",
      websiteHttpsUrl: "https://f1614.invalid",
      registerCourt: "F1614 Registergericht",
      registerNumber: "HRB F1614 1",
      vatId: "DE000000000",
    };
    const legalDocuments = {
      terms: { title: "Bedingungen", plainText: "Synthetische Bedingungen." },
      withdrawalInformation: { title: "Widerruf", plainText: "Synthetische Widerrufsinformation." },
      privacyNotice: { title: "Datenschutz", plainText: "Synthetischer Datenschutzhinweis." },
    };
    await tenantFn(
      pool,
      workspaceId,
      editorIdentityId,
      `select public.revise_offer_release_profile($1::uuid, 0, 'F1614 Profil', $2::jsonb, $3::jsonb)`,
      [workspaceId, JSON.stringify(sender), JSON.stringify(legalDocuments)],
    );
    const profile = await tenantFn<{ profile_id: string; profile_revision_id: string; profile_revision: number }>(
      pool,
      workspaceId,
      null,
      `select profile.id as profile_id, revision.id as profile_revision_id, revision.revision as profile_revision
         from offer_release_profile as profile
         join offer_release_profile_revision as revision
           on revision.workspace_id = profile.workspace_id
          and revision.profile_id = profile.id
          and revision.revision = profile.current_revision
        where profile.workspace_id = $1::uuid limit 1`,
      [workspaceId],
    );
    const profileHead = profile.rows[0];
    if (!profileHead) throw new Error("F16-14: Release-Profil fehlt.");
    await tenantFn(
      pool,
      workspaceId,
      editorIdentityId,
      `select public.activate_offer_release_profile($1::uuid, $2::uuid, $3::uuid, $4::integer)`,
      [workspaceId, profileHead.profile_id, profileHead.profile_revision_id, profileHead.profile_revision],
    );

    const billingAddress = { street: "Rechnungsweg", houseNumber: "8a", postalCode: "10999", city: "Berlin", country: "DE" };
    await tenantFn(
      pool,
      workspaceId,
      editorIdentityId,
      `select public.revise_offer_recipient($1::uuid, $2::uuid, 0, 'F1614 Rechnungsempfaenger', 'F1614 Kundin GmbH', 'rechnung@f1614.invalid', $3::jsonb, true)`,
      [workspaceId, offerId, JSON.stringify(billingAddress)],
    );
    const recipient = await tenantFn<{ recipient_revision_id: string; recipient_revision: number }>(
      pool,
      workspaceId,
      null,
      `select revision.id as recipient_revision_id, revision.revision as recipient_revision
         from offer_recipient as recipient
         join offer_recipient_revision as revision
           on revision.workspace_id = recipient.workspace_id
          and revision.recipient_id = recipient.id
          and revision.revision = recipient.current_revision
        where recipient.workspace_id = $1::uuid and recipient.offer_id = $2::uuid limit 1`,
      [workspaceId, offerId],
    );
    const recipientHead = recipient.rows[0];
    if (!recipientHead) throw new Error("F16-14: Empfaenger fehlt.");

    const preparedCandidate = await tenantFn<JsonResult>(
      pool,
      workspaceId,
      editorIdentityId,
      `select public.prepare_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::uuid, $7::uuid, $8::integer, $9::uuid, $10::integer, ((clock_timestamp() at time zone 'Europe/Berlin')::date + $11::integer)::date) as result`,
      [
        workspaceId,
        offerId,
        variantId,
        1,
        draftJobId,
        profileHead.profile_id,
        profileHead.profile_revision_id,
        profileHead.profile_revision,
        recipientHead.recipient_revision_id,
        recipientHead.recipient_revision,
        14,
      ],
    );
    if (preparedCandidate.rows[0]?.result?.status !== "prepared") {
      throw new Error(`F16-14: Release-Candidate-Vorbereitung fehlgeschlagen (${JSON.stringify(preparedCandidate.rows[0]?.result)}).`);
    }
    const candidate = await tenantFn<{ candidate_id: string }>(
      pool,
      workspaceId,
      null,
      `select id as candidate_id from offer_release_candidate
        where workspace_id = $1::uuid and offer_id = $2::uuid
        order by created_at desc, id desc limit 1`,
      [workspaceId, offerId],
    );
    const candidateId = candidate.rows[0]?.candidate_id;
    if (!candidateId) throw new Error("F16-14: Release-Kandidat fehlt.");

    await tenantFn(
      pool,
      workspaceId,
      null,
      `update offer_release_candidate set state = 'running', attempt_count = 1, lease_token = gen_random_uuid(),
              lease_expires_at = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp(),
              updated_at = clock_timestamp()
        where workspace_id = $1::uuid and id = $2::uuid and state = 'queued'`,
      [workspaceId, candidateId],
    );
    const candidateArtifact = Buffer.from(`%PDF-1.7\n${"f1614-release-candidate".repeat(8)}\n%%EOF`, "utf8");
    const artifactVersion = randomUUID();
    await tenantFn(
      pool,
      workspaceId,
      null,
      `update offer_release_candidate set state = 'ready_for_approval', lease_token = null, lease_expires_at = null,
              artifact_mime_type = 'application/pdf', artifact_bytes = $2::bytea, artifact_sha256 = sha256($2::bytea),
              artifact_size_bytes = octet_length($2::bytea), artifact_version = $3::uuid, finished_at = clock_timestamp(),
              updated_at = clock_timestamp()
        where workspace_id = $1::uuid and id = $4::uuid and state = 'running'`,
      [workspaceId, candidateArtifact, artifactVersion, candidateId],
    );
    const candidateApproval = await tenantFn<JsonResult>(
      pool,
      workspaceId,
      editorIdentityId,
      `select public.approve_offer_release_candidate($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, true, true, true, null) as result`,
      [workspaceId, offerId, candidateId, artifactVersion],
    );
    if (candidateApproval.rows[0]?.result?.status !== "approved") {
      throw new Error(`F16-14: Candidate-Freigabe fehlgeschlagen (${JSON.stringify(candidateApproval.rows[0]?.result)}).`);
    }

    const prepared = await tenantFn<JsonResult>(
      pool,
      workspaceId,
      editorIdentityId,
      `select public.prepare_offer_issuance($1::uuid, $2::uuid, $3::uuid) as result`,
      [workspaceId, offerId, candidateId],
    );
    if (prepared.rows[0]?.result?.status !== "prepared") {
      throw new Error(`F16-14: Ausstellungsreservation fehlgeschlagen (${JSON.stringify(prepared.rows[0]?.result)}).`);
    }
    const issuanceId = prepared.rows[0]?.result.issuanceId;
    if (typeof issuanceId !== "string") throw new Error("F16-14: Ausstellungsreservation fehlt.");

    const lease = randomUUID();
    await tenantFn(
      pool,
      workspaceId,
      null,
      `select public.claim_offer_issuance_render($1::uuid, $2::uuid, $3::uuid, 120) as result`,
      [workspaceId, issuanceId, lease],
    );
    const artifact = Buffer.from(`%PDF-1.7\n${"f1614-final-issuance".repeat(8)}\n%%EOF`, "utf8");
    await tenantFn(
      pool,
      workspaceId,
      null,
      `select public.finalize_offer_issuance_render_success($1::uuid, $2::uuid, $3::uuid, 1, $4::bytea) as result`,
      [workspaceId, issuanceId, lease, artifact],
    );

    const secondActor = randomUUID();
    await pool.query("insert into public.user_identity (id, email) values ($1, $2)", [
      secondActor,
      `f1614-${secondActor}@invalid`,
    ]);
    const membershipClient = await pool.connect();
    try {
      await membershipClient.query("begin");
      await membershipClient.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
      await membershipClient.query(
        "insert into public.membership (workspace_id, user_id, role, capabilities) values ($1, $2, 'admin', '{}'::jsonb)",
        [workspaceId, secondActor],
      );
      await membershipClient.query("commit");
    } finally {
      membershipClient.release();
    }

    const firstApproval = await tenantFn<JsonResult>(
      pool,
      workspaceId,
      editorIdentityId,
      `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`,
      [workspaceId, issuanceId],
    );
    if (firstApproval.rows[0]?.result.status !== "approved") {
      throw new Error(`F16-14: erste Ausstellungs-Freigabe fehlgeschlagen (${JSON.stringify(firstApproval.rows[0]?.result)}).`);
    }
    const secondApproval = await tenantFn<JsonResult>(
      pool,
      workspaceId,
      secondActor,
      `select public.approve_offer_issuance($1::uuid, $2::uuid, true, true, true, true, null) as result`,
      [workspaceId, issuanceId],
    );
    if (secondApproval.rows[0]?.result.status !== "approved") {
      throw new Error(`F16-14: zweite Ausstellungs-Freigabe fehlgeschlagen (${JSON.stringify(secondApproval.rows[0]?.result)}).`);
    }
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
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
    message: `F16-14: kein horizontaler Dokumentüberlauf bei ${expectedWidth} CSS px`,
  }).toEqual({ clientWidth: expectedWidth, scrollWidth: expectedWidth });
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
  expect(browserErrors.get(page) ?? [], "F16-14 Browser-Konsole und Page-Errors").toEqual([]);
});

test.describe("F16-14 Angebots-Bulk-Update", () => {
  let isolatedWorkspaceId = "";
  let projectId = "";
  let products: F1614Products = { module: "", inverter: "", battery: "", wallbox: "" };

  test.beforeAll(async () => {
    const data = runtimeState();
    // Eigener isolierter Workspace: Der Seed (Drift, Signatur mit Won) darf
    // keine andere Spec beeinflussen.
    isolatedWorkspaceId = randomUUID();
    const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("insert into workspace (id, name) values ($1::uuid, $2)", [
        isolatedWorkspaceId,
        "F16-14 isolierter Bulk-Workspace",
      ]);
      // Membership-DML verlangt Workspace-Kontext (RLS) auf derselben Verbindung.
      await client.query(
        "select set_config('app.actor_id', '', false), set_config('app.workspace_id', $1, false)",
        [isolatedWorkspaceId],
      );
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'editor',
           '{"manage_catalog":true,"edit_prices":true,"see_purchase_prices":true,
              "assign_projects":true,"convert_phase":true,"discounts":true}'::jsonb)`,
        [isolatedWorkspaceId, data.editorIdentityId],
      );
    } finally {
      client.release();
      await endPoolAndWaitForClientRemoval(pool);
    }
    const seed = await seedM201ReadyProject(data.databaseUrl, {
      workspaceId: isolatedWorkspaceId,
      editorIdentityId: data.editorIdentityId,
      skuSuffix: `f1614-${isolatedWorkspaceId.slice(0, 8)}`,
    });
    projectId = seed.projectId;
    products = seed.products;
  });

  test("F1614-E2E-01: 2 outdated + 1 wartende Variante, ein Confirm, Skip-Grund", async ({ page }) => {
    test.setTimeout(300_000);
    const data = runtimeState();
    const errors = browserErrors.get(page) ?? [];
    const db: F1614Db = {
      databaseUrl: data.databaseUrl,
      workspaceId: isolatedWorkspaceId,
      editorIdentityId: data.editorIdentityId,
    };

    // Angebot im Browser anlegen (Basisvariante "Basis"). Direkt zur
    // Login-Route (M2-04-Muster) statt auf einen Redirect der Zielroute zu warten.
    const projectPath = `/w/${isolatedWorkspaceId}/anfragen/${projectId}`;
    await page.goto(`/login?next=${encodeURIComponent(projectPath)}`);
    await loginWithRealOtp(page, data.editorEmail, projectPath);
    await expect(page.getByRole("heading", { name: M2_01_E2E_CONTACT, level: 1 })).toBeVisible();
    const createEntry = page.locator('[data-offer-create-state="ready"]');
    await expect(createEntry).toBeVisible();
    await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("12500");
    await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
    await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
    await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
    await page.waitForURL((url) =>
      /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
      && url.searchParams.has("variante"));
    const offerId = selectedOfferId(page);
    const variantA = selectedVariantId(page);
    const detailPath = `/w/${isolatedWorkspaceId}/angebote/${offerId}`;
    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();

    // Zwei Duplikate: zweite outdated Quelle + spaeter signierte Variante.
    const duplicateSection = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Variante duplizieren", exact: true }),
    });
    await duplicateSection.getByLabel("Name der Kopie").fill("F1614 Quelle B");
    await duplicateSection.getByRole("button", { name: "Duplizieren", exact: true }).click();
    await page.waitForURL((url) =>
      url.pathname === detailPath
      && url.searchParams.get("variante") !== variantA);
    const variantB = selectedVariantId(page);
    await duplicateSection.getByLabel("Name der Kopie").fill("F1614 Wartend");
    await duplicateSection.getByRole("button", { name: "Duplizieren", exact: true }).click();
    await page.waitForURL((url) =>
      url.pathname === detailPath
      && url.searchParams.get("variante") !== variantB);
    const variantC = selectedVariantId(page);

    // Negativpin: Alles aktuell, also keine Bulk-Sektion (gilt auch gruene Phase).
    const bulkAbsent = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Bulk-Update", exact: true }),
    });
    await expect(bulkAbsent).toHaveCount(0);

    // PDF-Entwurf fuer die spaeter signierte Variante ueber den echten
    // Browser-Pfad anfordern (noch aktuell, daher ohne Freshness-Risiko).
    await page.goto(`${detailPath}?variante=${variantC}`);
    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    const pdfPanel = page.locator("aside").filter({
      has: page.getByRole("heading", {
        name: "Interner, nicht verbindlicher PDF-Entwurf",
        exact: true,
      }),
    });
    await expect(pdfPanel).toBeVisible();
    const revisionValue = await pdfPanel
      .locator('input[name="expectedVariantRevision"]')
      .inputValue();
    expect(Number(revisionValue)).toBe(1);
    const generateResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST"
        && url.pathname === detailPath
        && url.searchParams.get("variante") === variantC;
    });
    await pdfPanel.getByRole("button", {
      name: "Internen PDF-Entwurf erzeugen",
      exact: true,
    }).click();
    expect((await generateResponsePromise).status()).toBe(200);
    await expect(pdfPanel.getByText(
      "Der PDF-Auftrag für Revision 1 wurde angenommen.",
      { exact: true },
    )).toBeVisible();
    const queued = await readQueuedPdfDraft(db, offerId, variantC);
    expect(queued.variantRevision).toBe(1);
    const leaseToken = randomUUID();
    const claim = await withM201Database(db, (tx) => claimOfferPdfDraftJob(tx, {
      workspaceId: isolatedWorkspaceId,
      jobId: queued.jobId,
      leaseToken,
    }));
    if (claim === null) throw new Error("Der queued F16-14-PDF-Auftrag war nicht claimbar.");
    const completion = await withM201Database(db, (tx) =>
      finalizeOfferPdfDraftSuccess(tx, {
        workspaceId: isolatedWorkspaceId,
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        attemptCount: claim.attemptCount,
        artifact: syntheticPdfArtifact("f1614-e2e-draft-"),
      }));
    expect(completion).toEqual({ state: "succeeded", attemptCount: 1, replayed: false });

    // Freigabekette + echte Signaturanfrage fuer Variante C (solange alles
    // aktuell ist): C ist danach pending-gesperrt, das Projekt bleibt offen.
    await prepareReleaseChain({
      databaseUrl: data.databaseUrl,
      workspaceId: isolatedWorkspaceId,
      editorIdentityId: data.editorIdentityId,
      projectId,
      offerId,
      variantId: variantC,
      draftJobId: queued.jobId,
    });
    await page.goto(`${detailPath}?variante=${variantC}`);
    await expect(page.locator('[data-offer-detail-state="loaded"]')).toBeVisible();
    const signaturePanel = page.getByRole("heading", { name: "Signaturanforderungen", level: 2 })
      .locator("xpath=ancestor::section[1]");
    await expect(signaturePanel).toBeVisible();
    await signaturePanel.getByLabel("Gültigkeit in Tagen (1–60)").fill("14");
    await signaturePanel.getByRole("button", { name: "Signaturlink vorbereiten" }).click();
    await expect(signaturePanel.getByText("wartet auf Signatur", { exact: true })).toBeVisible();
    const lockState = await readSignatureAndProject(db, offerId, variantC, projectId);
    expect(lockState.signatureStatus).toBe("pending");
    expect(lockState.phase).toBe("offer");
    expect(lockState.outcome).toBe("open");

    // Katalogdrift auf Kat.-Rev. 2: alle drei Quellen sind jetzt outdated,
    // C zusaetzlich per Content-Lock gesperrt.
    await driftBatteryToRevision2(db, projectId, products);
    const seededNames = await readVariantNames(db, offerId);
    expect(seededNames.map((row) => row.name).sort()).toEqual(
      ["Basis", "F1614 Quelle B", "F1614 Wartend"].sort(),
    );
    const nameById = new Map(seededNames.map((row) => [row.id, row.name]));
    const nameA = nameById.get(variantA)!;
    const nameB = nameById.get(variantB)!;
    const nameC = nameById.get(variantC)!;
    const successorA = `${nameA} · Kat.-Rev. 2`;
    const successorB = `${nameB} · Kat.-Rev. 2`;
    // Physik-Pin: Bulk-Erfolg braucht das offene Projekt (DB-13 sperrt
    // ausfuehrbare Zeilen auf geschlossenem Projekt).
    expect((await readSignatureAndProject(db, offerId, variantC, projectId)).outcome).toBe("open");

    await page.goto(`${detailPath}?variante=${variantA}`);
    await expect(page.locator('[data-offer-detail-state="outdated"]')).toBeVisible();
    await expect(page.getByText(
      "Die Projektgrundlage ist nicht mehr aktuell.",
      { exact: true },
    )).toBeVisible();

    // RED: Die Bulk-Sektion existiert noch nicht (keine UI, kein Service).
    await page.goto(`${detailPath}?variante=${variantA}`);
    await expect(page.locator('[data-offer-detail-state="outdated"]')).toBeVisible();
    const bulk = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Bulk-Update", exact: true }),
    });
    await expect(bulk).toBeVisible();
    await expect(page.locator("[data-f1614-bulk-section]")).toHaveCount(1);

    // Pro outdated Zeile: Steuer ausdruecklich waehlen, deterministischer
    // Nachfolgername ist vorbelegt.
    for (const sourceName of [nameA, nameB]) {
      const taxSelect = bulk.getByLabel(`Steuer für ${sourceName}`, { exact: true });
      await expect(taxSelect).toHaveValue("");
      await taxSelect.selectOption("standard_19");
      await expect(bulk.getByLabel(`Nachfolgername für ${sourceName}`, { exact: true }))
        .toHaveValue(`${sourceName} · Kat.-Rev. 2`);
    }

    // Genau ein Confirm legt beide Nachfolger an; die signierte Zeile wird
    // mit Grund uebersprungen.
    await bulk.getByRole("button", { name: "2 Nachfolger auf Kat.-Rev. 2 anlegen", exact: true }).click();
    const variantNavigation = page.getByRole("navigation", { name: "Angebotsvarianten" });
    for (const successorName of [successorA, successorB]) {
      await expect(variantNavigation.getByRole("link", {
        name: new RegExp(`^${escapeRegExp(successorName)}\\s*Rev\\.\\s*1$`, "u"),
      })).toBeVisible();
    }
    await expect(bulk.getByText("Übersprungen:", { exact: false })).toBeVisible();
    await expect(bulk.getByText(`${nameC} — wartet auf Signatur`, { exact: false })).toBeVisible();
    await expect.poll(async () => (await readVariantNames(db, offerId)).length, {
      message: "Der Bulk-Confirm muss genau 2 Nachfolger persistieren.",
      timeout: 15_000,
    }).toBe(5);
    const grownNames = (await readVariantNames(db, offerId)).map((row) => row.name);
    expect(grownNames).toContain(successorA);
    expect(grownNames).toContain(successorB);

    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await expect(bulk.getByRole("heading", { name: "Bulk-Update", exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page, width);
      await expectNoWcagAaAxeViolations(page, "[data-f1614-bulk-section]", `F16-14 Bulk-Sektion ${width}px`);
    }
    expect(errors, "Browser-Konsole bei Bulk-Update").toEqual([]);
  });
});
