import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { startEmbeddedPostgres, type EmbeddedTestDatabase } from "../setup/embedded-postgres.js";
import {
  RECHNER_INTAKE_PATH,
  signatureMessage,
} from "../../lib/integrations/rechner/signature.js";
import type {
  RechnerIntakeReceiptV1,
  RechnerIntakeV1,
} from "../../lib/integrations/rechner/types.js";
import {
  M1_06_E2E_ADDRESS,
  M1_06_E2E_REGION,
} from "./m1-06-fixture.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NEXT_ENV_PATH = resolve(REPO_ROOT, "next-env.d.ts");
const NEXT_SERVER_PATH = resolve(REPO_ROOT, "tests/e2e/next-server.mts");
const READY_ENDPOINT = "/__m1_05_e2e_ready";
const LOOPBACK_HOST = "localhost";
const PRIVATE_LOG_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const START_TIMEOUT_MS = 90_000;
const CHILD_STOP_TIMEOUT_MS = 5_000;
const GEOAPIFY_STUB_API_KEY = "local-m1-06-contract-key";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const AMBIENT_DATABASE_VARIABLES = [
  "PGUSER",
  "PGDATABASE",
  "PGPORT",
  "PGHOST",
  "PGPASSWORD",
  "PGBINARY",
  "PGOPTIONS",
  "PGSSLMODE",
  "PGSSLNEGOTIATION",
  "PGCLIENT_ENCODING",
  "PGCLIENTENCODING",
  "PGREPLICATION",
  "PGAPPNAME",
  "PGCONNECT_TIMEOUT",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

type SeedData = {
  workspaceId: string;
  foreignWorkspaceId: string;
  editorIdentityId: string;
  viewerIdentityId: string;
  editorEmail: string;
  viewerEmail: string;
  mainContactName: string;
  foreignContactName: string;
};

type IntakeCredential = {
  keyId: string;
  workspaceId: string;
  secret: Buffer;
};

type E2EState = Pick<
  SeedData,
  | "workspaceId"
  | "foreignWorkspaceId"
  | "editorEmail"
  | "viewerEmail"
  | "mainContactName"
  | "foreignContactName"
> & {
  baseURL: string;
  foreignProjectId: string;
  serverLogPath: string;
};

type SubmittedLead = {
  receiptId: string;
  projectId: string;
};

type ReadyState = {
  token: string;
  pid: number;
  host: typeof LOOPBACK_HOST;
  port: number;
  baseURL: string;
};

type FileSnapshot =
  | { existed: false }
  | { existed: true; content: Buffer; mode: number };

type GeoapifyStub = {
  server: Server;
  origin: string;
  autocompleteRequests: number;
  detailsRequests: number;
  violations: string[];
};

let embedded: EmbeddedTestDatabase | undefined;
let privateDirectory: string | undefined;
let serverLogFd: number | undefined;
let interruptedBy: NodeJS.Signals | undefined;
let cleanupPromise: Promise<unknown[]> | undefined;
let nextEnvSnapshot: FileSnapshot | undefined;
let geoapifyStub: GeoapifyStub | undefined;
const runningChildren = new Set<ChildProcess>();

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function exactSearchParameters(
  url: URL,
  expected: Readonly<Record<string, string>>,
): boolean {
  const expectedNames = Object.keys(expected);
  const actualNames = [...url.searchParams.keys()];
  return actualNames.length === expectedNames.length
    && expectedNames.every((name) => {
      const values = url.searchParams.getAll(name);
      return values.length === 1 && values[0] === expected[name];
    });
}

function respondWithJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function closeLocalServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
    server.closeIdleConnections();
  });
}

async function startGeoapifyContractStub(): Promise<GeoapifyStub> {
  const stub = {
    server: undefined as unknown as Server,
    origin: "",
    autocompleteRequests: 0,
    detailsRequests: 0,
    violations: [] as string[],
  } satisfies GeoapifyStub;

  const server = createServer((request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
    } catch {
      stub.violations.push("invalid_url");
      respondWithJson(response, 400, { error: "invalid_request" });
      return;
    }

    const validTransport = request.method === "GET"
      && request.headers.accept === "application/json";
    if (url.pathname === "/v1/geocode/autocomplete") {
      const validContract = validTransport && exactSearchParameters(url, {
        text: M1_06_E2E_ADDRESS.query,
        lang: "de",
        format: "json",
        limit: "5",
        filter: "countrycode:de",
        apiKey: GEOAPIFY_STUB_API_KEY,
      });
      if (!validContract) {
        stub.violations.push("autocomplete_contract");
        respondWithJson(response, 400, { error: "invalid_request" });
        return;
      }

      stub.autocompleteRequests += 1;
      respondWithJson(response, 200, {
        results: [{
          place_id: M1_06_E2E_ADDRESS.placeId,
          street: M1_06_E2E_ADDRESS.street,
          housenumber: M1_06_E2E_ADDRESS.houseNumber,
          postcode: M1_06_E2E_ADDRESS.postalCode,
          city: M1_06_E2E_ADDRESS.city,
          country_code: "de",
          lat: M1_06_E2E_ADDRESS.latitude,
          lon: M1_06_E2E_ADDRESS.longitude,
          result_type: "building",
        }],
      });
      return;
    }

    if (url.pathname === "/v2/place-details") {
      const validContract = validTransport && exactSearchParameters(url, {
        id: M1_06_E2E_ADDRESS.placeId,
        features: "details",
        lang: "de",
        apiKey: GEOAPIFY_STUB_API_KEY,
      });
      if (!validContract) {
        stub.violations.push("details_contract");
        respondWithJson(response, 400, { error: "invalid_request" });
        return;
      }

      stub.detailsRequests += 1;
      respondWithJson(response, 200, {
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: {
            place_id: M1_06_E2E_ADDRESS.placeId,
            feature_type: "details",
            street: M1_06_E2E_ADDRESS.street,
            housenumber: M1_06_E2E_ADDRESS.houseNumber,
            postcode: M1_06_E2E_ADDRESS.postalCode,
            city: M1_06_E2E_ADDRESS.city,
            country_code: "de",
            lat: M1_06_E2E_ADDRESS.latitude,
            lon: M1_06_E2E_ADDRESS.longitude,
          },
          geometry: {
            type: "Point",
            coordinates: [M1_06_E2E_ADDRESS.longitude, M1_06_E2E_ADDRESS.latitude],
          },
        }],
      });
      return;
    }

    stub.violations.push("unexpected_route");
    respondWithJson(response, 404, { error: "not_found" });
  });
  stub.server = server;

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener("error", onError);
      resolveListen();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeLocalServer(server);
    throw new Error("Der lokale Geoapify-Vertragsserver erhielt keinen TCP-Port.");
  }
  stub.origin = `http://${LOOPBACK_HOST}:${address.port}`;
  return stub;
}

function geoapifyContractWasExercised(stub: GeoapifyStub): boolean {
  return stub.violations.length === 0
    && stub.autocompleteRequests === 1
    && stub.detailsRequests === 1;
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 143;
}

function requestInterruption(signal: NodeJS.Signals): void {
  if (interruptedBy) return;
  interruptedBy = signal;
  for (const child of runningChildren) signalChild(child, "SIGTERM");
}

function throwIfInterrupted(): void {
  if (interruptedBy) throw new Error("E2E-Lauf wurde beendet.");
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function childExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code) => resolveExit(code));
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalChild(child, "SIGTERM");
  const stopped = await Promise.race([
    childExit(child).then(() => true),
    sleep(CHILD_STOP_TIMEOUT_MS).then(() => false),
  ]);
  if (!stopped) {
    signalChild(child, "SIGKILL");
    await Promise.race([childExit(child), sleep(1_000)]).catch(() => undefined);
  }
}

function spawnTracked(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: ["ignore", number | "inherit", number | "inherit"];
  },
): ChildProcess {
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: options.env,
    stdio: options.stdio,
    detached: true,
  });
  runningChildren.add(child);
  child.once("exit", () => runningChildren.delete(child));
  return child;
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  for (const name of AMBIENT_DATABASE_VARIABLES) delete env[name];
  for (const name of [
    "POSTGRES_URL",
    "POSTGRES_URL_AUTH",
    "POSTGRES_URL_MIGRATE",
    "POSTGRES_URL_TEST",
    "POSTGRES_URL_TEST_SUPERUSER",
    "POSTGRES_URL_WORKER",
    "POSTGRES_TEST_TARGET_CONFIRM",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "RECHNER_INTAKE_KEYS_JSON",
    "RESEND_API_KEY",
    "GEOAPIFY_API_KEY",
    "GEOAPIFY_BASE_URL",
    "M1_05_E2E_STATE",
    "M1_05_E2E_OUTPUT_DIR",
    "M1_05_E2E_BASE_URL",
    "M1_05_E2E_READY_FILE",
    "M1_05_E2E_READY_TOKEN",
  ]) {
    delete env[name];
  }
  env.NEXT_TELEMETRY_DISABLED = "1";
  return env;
}

function destructiveTestConfirmation(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  const database = decodeURI(parsed.pathname.replace(/^\//, ""));
  return `${parsed.hostname}:${parsed.port}/${encodeURIComponent(database)}:ALLOW-DESTRUCTIVE-TESTS`;
}

function migrationEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...cleanEnvironment(),
    NODE_ENV: "test",
    VITEST: "true",
    DB_ROLE_MODE: "test-legacy-single",
    POSTGRES_URL_MIGRATE: databaseUrl,
    POSTGRES_TEST_TARGET_CONFIRM: destructiveTestConfirmation(databaseUrl),
  };
}

function nextEnvironment(
  databaseUrl: string,
  authSecret: string,
  credentials: IntakeCredential[],
  geocodingStub: GeoapifyStub,
  readyFile: string,
  readyToken: string,
): NodeJS.ProcessEnv {
  return {
    ...cleanEnvironment(),
    NODE_ENV: "development",
    VITEST: "true",
    DB_ROLE_MODE: "test-legacy-single",
    POSTGRES_URL: databaseUrl,
    POSTGRES_URL_AUTH: databaseUrl,
    POSTGRES_TEST_TARGET_CONFIRM: destructiveTestConfirmation(databaseUrl),
    BETTER_AUTH_SECRET: authSecret,
    RECHNER_INTAKE_KEYS_JSON: JSON.stringify(credentials.map((credential) => ({
      keyId: credential.keyId,
      workspaceId: credential.workspaceId,
      scope: "rechner-intake.write",
      secretBase64: credential.secret.toString("base64"),
    }))),
    RESEND_API_KEY: "",
    SENTRY_DSN: "",
    NEXT_PUBLIC_SENTRY_DSN: "",
    GEOAPIFY_API_KEY: GEOAPIFY_STUB_API_KEY,
    GEOAPIFY_BASE_URL: geocodingStub.origin,
    M1_05_E2E_READY_FILE: readyFile,
    M1_05_E2E_READY_TOKEN: readyToken,
  };
}

function playwrightEnvironment(
  statePath: string,
  outputPath: string,
  baseURL: string,
): NodeJS.ProcessEnv {
  return {
    ...cleanEnvironment(),
    NODE_ENV: "test",
    M1_05_E2E_STATE: statePath,
    M1_05_E2E_OUTPUT_DIR: outputPath,
    M1_05_E2E_BASE_URL: baseURL,
  };
}

function openPrivateLog(path: string): number {
  const fd = openSync(path, "a", PRIVATE_LOG_MODE);
  chmodSync(path, PRIVATE_LOG_MODE);
  return fd;
}

function snapshotFile(path: string): FileSnapshot {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) {
      throw new Error("next-env.d.ts ist vor dem E2E-Lauf keine reguläre Datei.");
    }
    return {
      existed: true,
      content: readFileSync(path),
      mode: stat.mode & 0o7777,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { existed: false };
    throw error;
  }
}

function fileMatchesSnapshot(path: string, snapshot: Extract<FileSnapshot, { existed: true }>): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile()
      && (stat.mode & 0o7777) === snapshot.mode
      && readFileSync(path).equals(snapshot.content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function restoreFile(path: string, snapshot: FileSnapshot): void {
  if (!snapshot.existed) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw new Error("next-env.d.ts wurde durch ein unerwartetes Dateiziel ersetzt.");
      }
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }

  if (fileMatchesSnapshot(path, snapshot)) return;

  const temporaryPath = resolve(
    dirname(path),
    `.next-env.d.ts.m1-05-${process.pid}-${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, "wx", PRIVATE_LOG_MODE);
    writeFileSync(fd, snapshot.content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temporaryPath, snapshot.mode);
    renameSync(temporaryPath, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function runMigration(databaseUrl: string, logPath: string): Promise<void> {
  const logFd = openPrivateLog(logPath);
  try {
    const child = spawnTracked(
      resolve(REPO_ROOT, "node_modules/.bin/tsx"),
      ["scripts/migrate.mts"],
      {
        env: migrationEnvironment(databaseUrl),
        stdio: ["ignore", logFd, logFd],
      },
    );
    const exitCode = await childExit(child);
    throwIfInterrupted();
    if (exitCode !== 0) {
      throw new Error("Die echten Datenbankmigrationen sind fehlgeschlagen.");
    }
  } finally {
    closeSync(logFd);
  }
}

async function withWorkspaceSeed<T>(
  client: PoolClient,
  workspaceId: string,
  seed: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    await client.query("set local transaction isolation level read committed");
    await client.query(
      "select set_config('app.actor_id', '', true), set_config('app.workspace_id', $1, true)",
      [workspaceId],
    );
    const result = await seed();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function seedInvitations(databaseUrl: string, data: SeedData): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await withWorkspaceSeed(client, data.workspaceId, async () => {
      await client.query(
        "insert into workspace (id, name) values ($1::uuid, $2)",
        [data.workspaceId, "M1-05 E2E Workspace"],
      );
      await client.query(
        "insert into user_identity (id, email) values ($1::uuid, $2)",
        [data.editorIdentityId, data.editorEmail],
      );
      await client.query(
        "insert into membership (workspace_id, user_id, role) values ($1::uuid, $2::uuid, 'editor')",
        [data.workspaceId, data.editorIdentityId],
      );
      await client.query(
        "insert into user_identity (id, email) values ($1::uuid, $2)",
        [data.viewerIdentityId, data.viewerEmail],
      );
      await client.query(
        "insert into membership (workspace_id, user_id, role) values ($1::uuid, $2::uuid, 'viewer')",
        [data.workspaceId, data.viewerIdentityId],
      );
    });

    await withWorkspaceSeed(client, data.foreignWorkspaceId, async () => {
      await client.query(
        "insert into workspace (id, name) values ($1::uuid, $2)",
        [data.foreignWorkspaceId, "M1-05 fremder E2E Workspace"],
      );
    });
  } finally {
    client.release();
    await pool.end();
  }
}

function parseReadyState(path: string, expectedToken: string, child: ChildProcess): ReadyState | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o777) !== PRIVATE_LOG_MODE || stat.size > 4_096) {
      throw new Error("Die private Ready-Datei hat unerwartete Metadaten.");
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ReadyState>;
    if (
      parsed.token !== expectedToken
      || parsed.pid !== child.pid
      || parsed.host !== LOOPBACK_HOST
      || !Number.isInteger(parsed.port)
      || (parsed.port ?? 0) < 1
      || (parsed.port ?? 0) > 65_535
    ) {
      throw new Error("Die private Ready-Datei gehört nicht zum gestarteten Testserver.");
    }
    const expectedBaseURL = `http://${LOOPBACK_HOST}:${parsed.port}`;
    if (parsed.baseURL !== expectedBaseURL) {
      throw new Error("Die private Ready-Datei enthält keine kanonische Loopback-URL.");
    }
    return parsed as ReadyState;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function sameReadyState(candidate: Partial<ReadyState>, expected: ReadyState): boolean {
  return candidate.token === expected.token
    && candidate.pid === expected.pid
    && candidate.host === expected.host
    && candidate.port === expected.port
    && candidate.baseURL === expected.baseURL;
}

async function confirmReadyState(state: ReadyState): Promise<void> {
  const response = await fetch(`${state.baseURL}${READY_ENDPOINT}`, {
    headers: { "x-m1-05-e2e-token": state.token },
    redirect: "error",
    signal: AbortSignal.timeout(2_000),
  });
  if (response.status !== 200) {
    await response.arrayBuffer();
    throw new Error("Der dynamische Testserver bestätigte den privaten Ready-Token nicht.");
  }
  const body = await response.text();
  if (body.length > 4_096) {
    throw new Error("Der dynamische Testserver lieferte eine ungültige Ready-Antwort.");
  }
  let parsed: Partial<ReadyState>;
  try {
    parsed = JSON.parse(body) as Partial<ReadyState>;
  } catch {
    throw new Error("Der dynamische Testserver lieferte keine gültige Ready-Antwort.");
  }
  if (!sameReadyState(parsed, state)) {
    throw new Error("Der dynamische Testserver konnte nicht eindeutig bestätigt werden.");
  }
}

async function waitForNext(
  child: ChildProcess,
  readyFile: string,
  readyToken: string,
): Promise<ReadyState> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Der isolierte Next-Prozess wurde vor der Bereitschaft beendet.");
    }
    const readyState = parseReadyState(readyFile, readyToken, child);
    if (readyState) {
      try {
        await confirmReadyState(readyState);
        const response = await fetch(`${readyState.baseURL}/login`, {
          redirect: "manual",
          signal: AbortSignal.timeout(5_000),
        });
        await response.arrayBuffer();
        if (response.status < 500) return readyState;
      } catch {
        // Der bestätigte Prozess kompiliert die erste App-Route noch.
      }
    }
    await sleep(200);
  }
  throw new Error("Der isolierte Next-Prozess wurde nicht rechtzeitig bereit.");
}

function intakePayload(
  contactName: string,
  contactSuffix: string,
  regionalEstimate = false,
): RechnerIntakeV1 {
  const fixturePath = resolve(REPO_ROOT, "contracts/examples/rechner-intake.v1.json");
  const payload = JSON.parse(readFileSync(fixturePath, "utf8")) as RechnerIntakeV1;
  const now = new Date().toISOString();
  payload.submissionId = randomUUID();
  payload.submittedAt = now;
  payload.calculation.calculatedAt = now;
  payload.customer.displayName = contactName;
  payload.customer.email = `lead-${contactSuffix}@example.test`;
  payload.customer.phoneRaw = `+49 6222 ${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  if (regionalEstimate) {
    payload.site = {
      addressMode: "regional_estimate",
      formattedAddress: M1_06_E2E_REGION.formattedAddress,
      street: null,
      houseNumber: null,
      postalCode: null,
      city: null,
      countryCode: "DE",
      latitude: M1_06_E2E_REGION.latitude,
      longitude: M1_06_E2E_REGION.longitude,
      geocodeSource: "regional_default",
      precision: "region",
    };
  }
  return payload;
}

async function submitSignedLead(
  server: ReadyState,
  databaseUrl: string,
  credential: IntakeCredential,
  payload: RechnerIntakeV1,
): Promise<SubmittedLead> {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const contentSha256 = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", credential.secret)
    .update(signatureMessage({
      method: "POST",
      path: RECHNER_INTAKE_PATH,
      keyId: credential.keyId,
      timestamp,
      idempotencyKey: payload.submissionId,
      contentSha256,
    }))
    .digest("base64url");

  // Keine signierte Nutzlast verlässt den Runner, bevor genau dieser Kindprozess
  // den laufbezogenen Token auf seinem dynamischen Port erneut bestätigt hat.
  await confirmReadyState(server);
  const response = await fetch(`${server.baseURL}${RECHNER_INTAKE_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": payload.submissionId,
      "x-rechner-key-id": credential.keyId,
      "x-rechner-timestamp": timestamp,
      "x-rechner-content-sha256": contentSha256,
      "x-rechner-signature": `v1=${signature}`,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status !== 201) {
    let code = "unbekannt";
    try {
      const parsed = JSON.parse(await response.text()) as { error?: { code?: unknown } };
      if (typeof parsed.error?.code === "string") code = parsed.error.code;
    } catch {
      // Antwortinhalte werden absichtlich nicht in den Runner-Output gespiegelt.
    }
    throw new Error(`Der signierte Rechner-Endpoint lehnte den Lead ab (HTTP ${response.status}, ${code}).`);
  }

  let receipt: Partial<RechnerIntakeReceiptV1>;
  try {
    receipt = JSON.parse(await response.text()) as Partial<RechnerIntakeReceiptV1>;
  } catch {
    throw new Error("Der signierte Rechner-Endpoint lieferte keinen gültigen Receipt.");
  }
  if (
    receipt.contractVersion !== "rechner-intake-receipt.v1"
    || receipt.status !== "processed"
    || receipt.duplicate !== false
    || receipt.submissionId !== payload.submissionId
    || typeof receipt.receiptId !== "string"
    || !UUID_PATTERN.test(receipt.receiptId)
  ) {
    throw new Error("Der signierte Rechner-Endpoint lieferte einen unerwarteten Receipt.");
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const projectId = await withWorkspaceSeed(client, credential.workspaceId, async () => {
      const result = await client.query<{ project_id: string }>(
        `select project_id::text
           from inbound_receipt
          where workspace_id = $1::uuid
            and id = $2::uuid
            and submission_id = $3::uuid`,
        [credential.workspaceId, receipt.receiptId, payload.submissionId],
      );
      if (result.rowCount !== 1 || !UUID_PATTERN.test(result.rows[0]?.project_id ?? "")) {
        throw new Error("Der echte Receipt konnte keinem Projekt zugeordnet werden.");
      }
      return result.rows[0].project_id;
    });
    return { receiptId: receipt.receiptId, projectId };
  } finally {
    client.release();
    await pool.end();
  }
}

async function runPlaywright(
  statePath: string,
  outputPath: string,
  baseURL: string,
): Promise<number> {
  const child = spawnTracked(
    resolve(REPO_ROOT, "node_modules/.bin/playwright"),
    ["test", "--config", resolve(REPO_ROOT, "playwright.config.ts")],
    {
      env: playwrightEnvironment(statePath, outputPath, baseURL),
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  const exitCode = await childExit(child);
  return exitCode ?? 1;
}

function createSeedData(): SeedData {
  const runSuffix = randomUUID().slice(0, 8);
  return {
    workspaceId: randomUUID(),
    foreignWorkspaceId: randomUUID(),
    editorIdentityId: randomUUID(),
    viewerIdentityId: randomUUID(),
    editorEmail: `m1-05-editor-${runSuffix}@example.test`,
    viewerEmail: `m1-05-viewer-${runSuffix}@example.test`,
    mainContactName: "Erika E2E Muster",
    foreignContactName: "Fremdmandant E2E Geheim",
  };
}

function writeState(path: string, state: E2EState): void {
  writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: PRIVATE_LOG_MODE });
  chmodSync(path, PRIVATE_LOG_MODE);
}

async function cleanup(): Promise<unknown[]> {
  cleanupPromise ??= (async () => {
    const errors: unknown[] = [];
    const children = [...runningChildren];
    const childResults = await Promise.allSettled(children.map((child) => stopChild(child)));
    for (const result of childResults) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    runningChildren.clear();

    const providerStub = geoapifyStub;
    geoapifyStub = undefined;
    if (providerStub) {
      try {
        await closeLocalServer(providerStub.server);
      } catch (error) {
        errors.push(error);
      }
    }

    const snapshot = nextEnvSnapshot;
    nextEnvSnapshot = undefined;
    if (snapshot) {
      try {
        restoreFile(NEXT_ENV_PATH, snapshot);
      } catch (error) {
        errors.push(error);
      }
    }

    if (serverLogFd !== undefined) {
      try {
        closeSync(serverLogFd);
      } catch (error) {
        errors.push(error);
      }
      serverLogFd = undefined;
    }

    const database = embedded;
    embedded = undefined;
    if (database) {
      try {
        await database.stop();
      } catch (error) {
        errors.push(error);
      }
    }

    if (privateDirectory) {
      try {
        rmSync(privateDirectory, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
      privateDirectory = undefined;
    }

    return errors;
  })();
  return cleanupPromise;
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/giu, "postgres://[redacted]")
    .replace(/\b\d{6}\b/gu, "[redacted-code]");
}

async function main(): Promise<number> {
  nextEnvSnapshot = snapshotFile(NEXT_ENV_PATH);
  console.log("[e2e] Isolierte M1-06-Testumgebung wird vorbereitet …");
  privateDirectory = mkdtempSync(join(tmpdir(), "energie-saas-m1-06-e2e-"));
  chmodSync(privateDirectory, PRIVATE_DIRECTORY_MODE);
  const migrationLogPath = join(privateDirectory, "migration.log");
  const serverLogPath = join(privateDirectory, "next.log");
  const statePath = join(privateDirectory, "state.json");
  const readyFile = join(privateDirectory, "next-ready.json");
  const playwrightOutputPath = join(privateDirectory, "playwright-output");
  const readyToken = randomBytes(32).toString("base64url");

  embedded = await startEmbeddedPostgres();
  throwIfInterrupted();
  await runMigration(embedded.url, migrationLogPath);
  throwIfInterrupted();

  const providerStub = await startGeoapifyContractStub();
  geoapifyStub = providerStub;
  throwIfInterrupted();

  const seedData = createSeedData();
  await seedInvitations(embedded.url, seedData);
  throwIfInterrupted();

  const mainCredential: IntakeCredential = {
    keyId: `e2e-main-${randomUUID()}`,
    workspaceId: seedData.workspaceId,
    secret: randomBytes(32),
  };
  const foreignCredential: IntakeCredential = {
    keyId: `e2e-foreign-${randomUUID()}`,
    workspaceId: seedData.foreignWorkspaceId,
    secret: randomBytes(32),
  };
  const authSecret = randomBytes(48).toString("base64url");

  serverLogFd = openPrivateLog(serverLogPath);
  const nextChild = spawnTracked(
    process.execPath,
    ["--import", "tsx", NEXT_SERVER_PATH],
    {
      env: nextEnvironment(
        embedded.url,
        authSecret,
        [mainCredential, foreignCredential],
        providerStub,
        readyFile,
        readyToken,
      ),
      stdio: ["ignore", serverLogFd, serverLogFd],
    },
  );
  const server = await waitForNext(nextChild, readyFile, readyToken);
  throwIfInterrupted();

  await submitSignedLead(
    server,
    embedded.url,
    mainCredential,
    intakePayload(seedData.mainContactName, `main-${randomUUID()}`, true),
  );
  const foreignLead = await submitSignedLead(
    server,
    embedded.url,
    foreignCredential,
    intakePayload(seedData.foreignContactName, `foreign-${randomUUID()}`),
  );
  throwIfInterrupted();

  writeState(statePath, {
    baseURL: server.baseURL,
    foreignProjectId: foreignLead.projectId,
    serverLogPath,
    workspaceId: seedData.workspaceId,
    foreignWorkspaceId: seedData.foreignWorkspaceId,
    editorEmail: seedData.editorEmail,
    viewerEmail: seedData.viewerEmail,
    mainContactName: seedData.mainContactName,
    foreignContactName: seedData.foreignContactName,
  });

  console.log("[e2e] Chromium prüft M1-06-Golden-Flow, Viewer-Grenze, Fremdmandant und Axe …");
  const playwrightExitCode = await runPlaywright(statePath, playwrightOutputPath, server.baseURL);
  if (!geoapifyContractWasExercised(providerStub)) {
    console.error("[e2e] Der lokale Geoapify-Vertrag wurde nicht exakt einmal vollständig durchlaufen.");
    return 1;
  }
  console.log("[e2e] Lokaler Geoapify-Vertrag: 1 Suche, 1 Detailauflösung, 0 Abweichungen.");
  return playwrightExitCode;
}

// Listener bis zum abgeschlossenen finally behalten: ein zweites Terminalsignal
// darf die laufende Restore-/Cleanup-Sequenz nicht auf Node-Defaultverhalten abkürzen.
process.on("SIGINT", requestInterruption);
process.on("SIGTERM", requestInterruption);

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  if (!interruptedBy) console.error(`[e2e] ${safeMessage(error)}`);
} finally {
  const cleanupErrors = await cleanup();
  if (cleanupErrors.length > 0) {
    console.error(`[e2e] Aufräumen war in ${cleanupErrors.length} Schritt(en) nicht vollständig.`);
    if (!interruptedBy) exitCode = 1;
  }
  process.removeListener("SIGINT", requestInterruption);
  process.removeListener("SIGTERM", requestInterruption);
}

process.exit(interruptedBy ? signalExitCode(interruptedBy) : exitCode);
