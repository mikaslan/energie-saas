import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
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
import { bootstrapCalculationQueue } from "../../scripts/pgboss-bootstrap.mjs";
import { applyRoleContract } from "../../scripts/db-role-contract.mjs";
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
import { seedM112aInboxTasks } from "./m1-12a-fixture.js";
import { seedM201ReadyProject } from "./m2-01-fixture.js";

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
  restrictedEditorIdentityId: string;
  externalEditorIdentityId: string;
  externalIdentityId: string;
  editorEmail: string;
  viewerEmail: string;
  restrictedEditorEmail: string;
  externalEditorEmail: string;
  externalEmail: string;
  m201WorkspaceId: string;
  m201EditorIdentityId: string;
  m201EditorEmail: string;
  // M1-12a bekommt einen eigenen Workspace. Die Inbox braucht mehr als eine
  // Seitengrenze an Aufgaben; ein zusätzliches Projekt im gemeinsamen
  // M1-05-Workspace würde dessen Anfrageboard-Erwartungen verändern.
  m112aWorkspaceId: string;
  m112aEditorIdentityId: string;
  m112aEditorEmail: string;
  m112aViewerIdentityId: string;
  m112aViewerEmail: string;
  m112aExternalIdentityId: string;
  m112aExternalEmail: string;
  // M1-11b (Cannot Fulfil) bekommt ebenfalls einen eigenen Workspace, damit
  // sein offenes Abschluss-Projekt die Board-/Archiv-Erwartungen des
  // gemeinsamen M1-05-Workspace (m1-05/m1-09/m1-10/m1-11a) nicht verändert.
  // Editor/Viewer/External werden als zusätzliche Memberships der bestehenden
  // Identitäten (editorIdentityId/viewerIdentityId/externalIdentityId) angelegt,
  // d. h. keine zweiten Accounts.
  m111bWorkspaceId: string;
  m111bContactName: string;
  // W3-Nachholblock: eigener isolierter Workspace (f7-03-Fix + 4 neue
  // Specs). Eigene Projekte je Spec — keine Kopplung an mainProjectId.
  w3WorkspaceId: string;
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
  | "restrictedEditorEmail"
  | "externalEditorEmail"
  | "externalEmail"
  | "m111bContactName"
  | "m111bWorkspaceId"
  | "w3WorkspaceId"
  | "mainContactName"
  | "foreignContactName"
> & {
  baseURL: string;
  databaseUrl: string;
  foreignProjectId: string;
  mainProjectId: string;
  m111bProjectId: string;
  f703ProjectId: string;
  f22ProjectId: string;
  f25ProjectId: string;
  f71ProjectId: string;
  f93ProjectId: string;
  f162ProjectId: string;
  f163dProjectId: string;
  f163cProjectId: string;
  f101ProjectId: string;
  f102ProjectId: string;
  f94ProjectId: string;
  f94dProjectId: string;
  f94cProjectId: string;
  w3WorkspaceId: string;
  m112aProjectId: string;
  m112aWorkspaceId: string;
  m112aEditorEmail: string;
  m112aViewerEmail: string;
  m112aExternalEmail: string;
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

type StrictServiceUrls = Readonly<{
  auth: string;
  migrator: string;
  runtime: string;
  worker: string;
}>;

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
let workerLogFd: number | undefined;
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
    "M1_05_E2E_GREP",
    "WORKER_E2E_CATALOG_IMPORT_ONLY",
  ]) {
    delete env[name];
  }
  env.NEXT_TELEMETRY_DISABLED = "1";
  return env;
}

function strictServiceUrl(
  databaseUrl: string,
  role: "app_auth" | "app_migrator" | "app_runtime" | "app_worker",
  password: string,
): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function provisionStrictServices(
  database: EmbeddedTestDatabase,
): Promise<StrictServiceUrls> {
  const passwords = {
    auth: randomBytes(24).toString("base64url"),
    migrator: randomBytes(24).toString("base64url"),
    runtime: randomBytes(24).toString("base64url"),
    system: randomBytes(24).toString("base64url"),
    worker: randomBytes(24).toString("base64url"),
  };
  if (!Object.values(passwords).every((password) => /^[A-Za-z0-9_-]{32}$/u.test(password))) {
    throw new Error("Die ephemeren E2E-Rollenpasswörter sind nicht SQL-sicher kodiert.");
  }
  const databaseName = decodeURIComponent(new URL(database.url).pathname.slice(1));
  if (databaseName !== "energie_saas_test") {
    throw new Error("Der strikte E2E-Rollenaufbau darf nur die ephemere Testdatenbank verändern.");
  }
  const admin = new Pool({ connectionString: database.superuserUrl, max: 1 });
  try {
    await admin.query(`
      revoke app_membership_writer from app_test;

      create role app_owner nologin noinherit nosuperuser nobypassrls
        nocreatedb nocreaterole noreplication;
      create role app_migrator login password '${passwords.migrator}'
        noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
      create role app_runtime login password '${passwords.runtime}'
        noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
      create role app_system login password '${passwords.system}'
        noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
      create role app_auth login password '${passwords.auth}'
        noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
      create role app_worker login password '${passwords.worker}'
        noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
      create role app_erasure nologin noinherit nosuperuser nobypassrls
        nocreatedb nocreaterole noreplication;
      create role identity_reconciler nologin noinherit nosuperuser nobypassrls
        nocreatedb nocreaterole noreplication;

      grant app_owner to app_migrator
        with admin false, inherit false, set true;
      grant app_worker to app_migrator
        with admin false, inherit false, set true;
      grant app_membership_writer to app_owner
        with admin false, inherit false, set false;
      grant app_membership_writer to app_system
        with admin false, inherit false, set false;
      grant identity_reconciler to app_owner
        with admin true, inherit false, set false;

      alter database energie_saas_test owner to app_owner;
      revoke all privileges on database energie_saas_test from app_test;
      revoke all privileges on database energie_saas_test from public;
      grant connect on database energie_saas_test to public;
      alter schema public owner to app_owner;
      revoke all on schema public from public, app_test;
      create schema pgboss authorization app_worker;
    `);
  } finally {
    await admin.end();
  }
  const urls = {
    auth: strictServiceUrl(database.url, "app_auth", passwords.auth),
    migrator: strictServiceUrl(database.url, "app_migrator", passwords.migrator),
    runtime: strictServiceUrl(database.url, "app_runtime", passwords.runtime),
    worker: strictServiceUrl(database.url, "app_worker", passwords.worker),
  } satisfies StrictServiceUrls;
  await bootstrapCalculationQueue(urls.worker);
  return urls;
}

function migrationEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...cleanEnvironment(),
    NODE_ENV: "test",
    DB_ROLE_MODE: "strict",
    POSTGRES_URL_MIGRATE: databaseUrl,
  };
}

function nextEnvironment(
  database: Pick<StrictServiceUrls, "auth" | "runtime">,
  authSecret: string,
  credentials: IntakeCredential[],
  geocodingStub: GeoapifyStub,
  readyFile: string,
  readyToken: string,
  demoLoginEmail: string | null,
): NodeJS.ProcessEnv {
  return {
    ...cleanEnvironment(),
    NODE_ENV: "development",
    DB_ROLE_MODE: "strict",
    POSTGRES_URL: database.runtime,
    POSTGRES_URL_AUTH: database.auth,
    BETTER_AUTH_SECRET: authSecret,
    ENERGIE_SAAS_LOCAL_PREVIEW: process.env.ENERGIE_SAAS_LOCAL_PREVIEW ?? "",
    DEMO_LOGIN_EMAIL: demoLoginEmail ?? "",
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

function workerEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...cleanEnvironment(),
    NODE_ENV: "test",
    DB_ROLE_MODE: "strict",
    POSTGRES_URL_WORKER: databaseUrl,
    WORKER_HEALTH_PORT: "0",
    WORKER_E2E_CATALOG_IMPORT_ONLY: "1",
    SENTRY_DSN: "",
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

async function applyStrictRoleManifest(databaseUrl: string): Promise<void> {
  const pool = new Pool({
    connectionString: databaseUrl,
    options: "-c role=app_owner",
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await applyRoleContract(client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
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
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'editor',
           '{"manage_catalog":true,"edit_prices":true,"see_purchase_prices":true,
              "assign_projects":true}'::jsonb)`,
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
      await client.query(
        "insert into user_identity (id, email) values ($1::uuid, $2)",
        [data.restrictedEditorIdentityId, data.restrictedEditorEmail],
      );
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'editor', '{"manage_catalog":true}'::jsonb)`,
        [data.workspaceId, data.restrictedEditorIdentityId],
      );
      await client.query(
        "insert into user_identity (id, email) values ($1::uuid, $2)",
        [data.externalEditorIdentityId, data.externalEditorEmail],
      );
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'editor',
           '{"manage_catalog":true,"edit_prices":true,"see_purchase_prices":true,
              "external_only":true}'::jsonb)`,
        [data.workspaceId, data.externalEditorIdentityId],
      );
      await client.query(
        "insert into user_identity (id, email) values ($1::uuid, $2)",
        [data.externalIdentityId, data.externalEmail],
      );
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'viewer', '{"external_only":true}'::jsonb)`,
        [data.workspaceId, data.externalIdentityId],
      );
    });

    await withWorkspaceSeed(client, data.foreignWorkspaceId, async () => {
      await client.query(
        "insert into workspace (id, name) values ($1::uuid, $2)",
        [data.foreignWorkspaceId, "M1-05 fremder E2E Workspace"],
      );
    });

    await withWorkspaceSeed(client, data.m201WorkspaceId, async () => {
      await client.query(
        "insert into workspace (id, name) values ($1::uuid, $2)",
        [data.m201WorkspaceId, "M2-01 isolierter E2E Workspace"],
      );
      await client.query(
        "insert into user_identity (id, email) values ($1::uuid, $2)",
        [data.m201EditorIdentityId, data.m201EditorEmail],
      );
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'editor',
           '{"manage_catalog":true,"edit_prices":true,"convert_phase":true,
              "discounts":true,"see_purchase_prices":true}'::jsonb)`,
        [data.m201WorkspaceId, data.m201EditorIdentityId],
      );
    });

    await withWorkspaceSeed(client, data.m112aWorkspaceId, async () => {
      await client.query(
        "insert into workspace (id, name) values ($1::uuid, $2)",
        [data.m112aWorkspaceId, "M1-12a isolierter E2E Workspace"],
      );
      await client.query(
        "insert into user_identity (id, email) values ($1::uuid, $2), ($3::uuid, $4), ($5::uuid, $6)",
        [
          data.m112aEditorIdentityId, data.m112aEditorEmail,
          data.m112aViewerIdentityId, data.m112aViewerEmail,
          data.m112aExternalIdentityId, data.m112aExternalEmail,
        ],
      );
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'editor', '{}'::jsonb),
                ($1::uuid, $3::uuid, 'viewer', '{}'::jsonb),
                ($1::uuid, $4::uuid, 'viewer', '{"external_only":true}'::jsonb)`,
        [
          data.m112aWorkspaceId,
          data.m112aEditorIdentityId,
          data.m112aViewerIdentityId,
          data.m112aExternalIdentityId,
        ],
      );
    });

    await withWorkspaceSeed(client, data.m111bWorkspaceId, async () => {
      await client.query(
        "insert into workspace (id, name) values ($1::uuid, $2)",
        [data.m111bWorkspaceId, "M1-11b isolierter E2E Workspace"],
      );
      // Editor/Viewer/External werden als zusätzliche Memberships der
      // bestehenden Identitäten angelegt (kein zweiter Account). Der Editor
      // braucht assign_projects für die External-Zuweisung in der Spec.
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'editor', '{"assign_projects":true}'::jsonb),
                ($1::uuid, $3::uuid, 'viewer', '{}'::jsonb),
                ($1::uuid, $4::uuid, 'viewer', '{"external_only":true}'::jsonb)`,
        [
          data.m111bWorkspaceId,
          data.editorIdentityId,
          data.viewerIdentityId,
          data.externalIdentityId,
        ],
      );
    });

    await withWorkspaceSeed(client, data.w3WorkspaceId, async () => {
      await client.query(
        "insert into workspace (id, name) values ($1::uuid, $2)",
        [data.w3WorkspaceId, "Welle-03 isolierter E2E Workspace"],
      );
      // Bestehende Identitäten, keine zweiten Accounts (M1-11b-Muster).
      // Editor spiegelt die Main-Capabilities (Katalog-Vorlagen-Seite
      // braucht manage_catalog), Viewer ist plain read-only. Restricted
      // ist zweiter Schreiber (F9.3: Fremdnutzer-Einträge).
      await client.query(
        `insert into membership (workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, 'editor',
           '{"manage_catalog":true,"edit_prices":true,"see_purchase_prices":true,
              "assign_projects":true,"convert_phase":true,"discounts":true}'::jsonb),
                ($1::uuid, $3::uuid, 'viewer', '{}'::jsonb),
                ($1::uuid, $4::uuid, 'editor', '{}'::jsonb)`,
        [
          data.w3WorkspaceId,
          data.editorIdentityId,
          data.viewerIdentityId,
          data.restrictedEditorIdentityId,
        ],
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
  serverLogPath: string,
): Promise<ReadyState> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    if (child.exitCode !== null || child.signalCode !== null) {
      if (serverLogFd !== undefined) fsyncSync(serverLogFd);
      let diagnostic = "";
      try {
        diagnostic = safeMessage(readFileSync(serverLogPath, "utf8").slice(-12_000))
          .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, "[redacted-token]")
          .trim();
      } catch {
        // Der allgemeine Startfehler bleibt auch ohne lesbaren Privatlog stabil.
      }
      throw new Error(
        diagnostic.length > 0
          ? `Der isolierte Next-Prozess wurde vor der Bereitschaft beendet.\n${diagnostic}`
          : "Der isolierte Next-Prozess wurde vor der Bereitschaft beendet.",
      );
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

async function waitForWorker(
  child: ChildProcess,
  workerLogPath: string,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    if (child.exitCode !== null || child.signalCode !== null) {
      if (workerLogFd !== undefined) fsyncSync(workerLogFd);
      let diagnostic = "";
      try {
        diagnostic = safeMessage(readFileSync(workerLogPath, "utf8").slice(-12_000)).trim();
      } catch {
        // Der allgemeine Startfehler bleibt auch ohne lesbaren Privatlog stabil.
      }
      throw new Error(
        diagnostic.length > 0
          ? `Der isolierte Worker wurde vor der Bereitschaft beendet.\n${diagnostic}`
          : "Der isolierte Worker wurde vor der Bereitschaft beendet.",
      );
    }
    if (workerLogFd !== undefined) fsyncSync(workerLogFd);
    let healthPort: number | undefined;
    try {
      const match = /worker health on :(\d{1,5})/u.exec(readFileSync(workerLogPath, "utf8"));
      if (match) {
        const parsed = Number(match[1]);
        if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65_535) {
          healthPort = parsed;
        }
      }
    } catch {
      // Der Worker hat seinen privaten Log noch nicht angelegt.
    }
    if (healthPort !== undefined) {
      try {
        const response = await fetch(`http://127.0.0.1:${healthPort}/health`, {
          redirect: "error",
          signal: AbortSignal.timeout(2_000),
        });
        const body = await response.json() as { ok?: unknown };
        if (response.status === 200 && body.ok === true) return;
      } catch {
        // Registrierung ist geloggt; die aktuelle DB-Probe läuft noch an.
      }
    }
    await sleep(200);
  }
  throw new Error("Der isolierte Worker wurde nicht rechtzeitig arbeitsfähig.");
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
  payload.calculation!.calculatedAt = now;
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
  grep: string | undefined,
): Promise<number> {
  const args = ["test", "--config", resolve(REPO_ROOT, "playwright.config.ts")];
  if (grep) args.push("--grep", grep);
  // JSON-Report zusätzlich zur Konsolenausgabe: maschinenlesbarer
  // Abschluss für den CI-Artefakt-Upload (autonomer Loop). Die Datei
  // landet im privaten Verzeichnis und wird nach dem Lauf weggeräumt.
  args.push("--reporter", "line,json");
  const child = spawnTracked(
    resolve(REPO_ROOT, "node_modules/.bin/playwright"),
    args,
    {
      env: {
        ...playwrightEnvironment(statePath, outputPath, baseURL),
        PLAYWRIGHT_JSON_OUTPUT_NAME: join(outputPath, "results.json"),
      },
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
    restrictedEditorIdentityId: randomUUID(),
    externalEditorIdentityId: randomUUID(),
    externalIdentityId: randomUUID(),
    editorEmail: `m1-05-editor-${runSuffix}@example.test`,
    viewerEmail: `m1-05-viewer-${runSuffix}@example.test`,
    restrictedEditorEmail: `m108b-editor-ohne-preisrecht-${runSuffix}@example.test`,
    externalEditorEmail: `m108b-external-editor-${runSuffix}@example.test`,
    externalEmail: `m1-09-external-${runSuffix}@example.test`,
    m201WorkspaceId: randomUUID(),
    m201EditorIdentityId: randomUUID(),
    m201EditorEmail: `m2-01-editor-${runSuffix}@example.test`,
    m112aWorkspaceId: randomUUID(),
    m112aEditorIdentityId: randomUUID(),
    m112aEditorEmail: `m1-12a-editor-${runSuffix}@example.test`,
    m112aViewerIdentityId: randomUUID(),
    m112aViewerEmail: `m1-12a-viewer-${runSuffix}@example.test`,
    m112aExternalIdentityId: randomUUID(),
    m112aExternalEmail: `m1-12a-external-${runSuffix}@example.test`,
    m111bWorkspaceId: randomUUID(),
    m111bContactName: "Clara E2E Absage",
    w3WorkspaceId: randomUUID(),
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

    if (workerLogFd !== undefined) {
      try {
        closeSync(workerLogFd);
      } catch (error) {
        errors.push(error);
      }
      workerLogFd = undefined;
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
  const rawGrep = process.env.M1_05_E2E_GREP?.trim();
  if (rawGrep && (rawGrep.length > 120 || !/^[A-Za-z0-9._:/ |()-]+$/u.test(rawGrep))) {
    throw new Error("M1_05_E2E_GREP enthält kein zulässiges fokussiertes Testmuster.");
  }
  const grep = rawGrep || undefined;
  nextEnvSnapshot = snapshotFile(NEXT_ENV_PATH);
  console.log("[e2e] Isolierte M1-06-Testumgebung wird vorbereitet …");
  privateDirectory = mkdtempSync(join(tmpdir(), "energie-saas-m1-06-e2e-"));
  chmodSync(privateDirectory, PRIVATE_DIRECTORY_MODE);
  const migrationLogPath = join(privateDirectory, "migration.log");
  const serverLogPath = join(privateDirectory, "next.log");
  const workerLogPath = join(privateDirectory, "worker.log");
  const statePath = join(privateDirectory, "state.json");
  const readyFile = join(privateDirectory, "next-ready.json");
  const playwrightOutputPath = join(privateDirectory, "playwright-output");
  const readyToken = randomBytes(32).toString("base64url");

  embedded = await startEmbeddedPostgres();
  throwIfInterrupted();
  const serviceUrls = await provisionStrictServices(embedded);
  throwIfInterrupted();
  await runMigration(serviceUrls.migrator, migrationLogPath);
  throwIfInterrupted();
  await applyStrictRoleManifest(serviceUrls.migrator);

  throwIfInterrupted();

  const providerStub = await startGeoapifyContractStub();
  geoapifyStub = providerStub;
  throwIfInterrupted();

  const seedData = createSeedData();
  await seedInvitations(embedded.superuserUrl, seedData);
  const m201Seed = await seedM201ReadyProject(embedded.superuserUrl, {
    workspaceId: seedData.m201WorkspaceId,
    editorIdentityId: seedData.m201EditorIdentityId,
  });
  // Der Runner legt sonst keine Projektaufgaben an. Die Inbox braucht einen
  // deterministischen Bestand jenseits der 50er-Seitengrenze, der auch in
  // einem fokussierten Lauf ohne m1-10/m1-11a existiert.
  const m112aSeed = await seedM112aInboxTasks(embedded.superuserUrl, {
    workspaceId: seedData.m112aWorkspaceId,
    editorIdentityId: seedData.m112aEditorIdentityId,
    viewerIdentityId: seedData.m112aViewerIdentityId,
  });
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
  const m111bCredential: IntakeCredential = {
    keyId: `e2e-m111b-${randomUUID()}`,
    workspaceId: seedData.m111bWorkspaceId,
    secret: randomBytes(32),
  };
  const w3Credential: IntakeCredential = {
    keyId: `e2e-w3-${randomUUID()}`,
    workspaceId: seedData.w3WorkspaceId,
    secret: randomBytes(32),
  };
  const authSecret = randomBytes(48).toString("base64url");

  workerLogFd = openPrivateLog(workerLogPath);
  const workerChild = spawnTracked(
    process.execPath,
    ["--import", "tsx", resolve(REPO_ROOT, "worker/index.ts")],
    {
      env: workerEnvironment(serviceUrls.worker),
      stdio: ["ignore", workerLogFd, workerLogFd],
    },
  );
  await waitForWorker(workerChild, workerLogPath);
  throwIfInterrupted();

  serverLogFd = openPrivateLog(serverLogPath);
  const nextChild = spawnTracked(
    process.execPath,
    ["--import", "tsx", NEXT_SERVER_PATH],
    {
      env: nextEnvironment(
        serviceUrls,
        authSecret,
        [mainCredential, foreignCredential, m111bCredential, w3Credential],
        providerStub,
        readyFile,
        readyToken,
        seedData.editorEmail,
      ),
      stdio: ["ignore", serverLogFd, serverLogFd],
    },
  );
  const server = await waitForNext(nextChild, readyFile, readyToken, serverLogPath);
  throwIfInterrupted();

  const mainLead = await submitSignedLead(
    server,
    embedded.superuserUrl,
    mainCredential,
    intakePayload(seedData.mainContactName, `main-${randomUUID()}`, true),
  );
  const foreignLead = await submitSignedLead(
    server,
    embedded.superuserUrl,
    foreignCredential,
    intakePayload(seedData.foreignContactName, `foreign-${randomUUID()}`),
  );
  const m111bLead = await submitSignedLead(
    server,
    embedded.superuserUrl,
    m111bCredential,
    intakePayload(seedData.m111bContactName, `m111b-${randomUUID()}`, true),
  );
  // W3-Nachholblock: eigenes Projekt je Spec (M1-11b-Muster). Ready-
  // Projekte nutzen den parametrisierten M2-01-Seed im W3-Workspace.
  const w3F703Lead = await submitSignedLead(
    server,
    embedded.superuserUrl,
    w3Credential,
    intakePayload("Wilma W3 Nachholblock", `w3-f703-${randomUUID()}`, true),
  );
  const w3F22Seed = await seedM201ReadyProject(embedded.superuserUrl, {
    workspaceId: seedData.w3WorkspaceId,
    editorIdentityId: seedData.editorIdentityId,
    skuSuffix: "w3-f22",
  });
  const w3F162Seed = await seedM201ReadyProject(embedded.superuserUrl, {
    workspaceId: seedData.w3WorkspaceId,
    editorIdentityId: seedData.editorIdentityId,
    skuSuffix: "w3-f162",
  });
  const w3F163dSeed = await seedM201ReadyProject(embedded.superuserUrl, {
    workspaceId: seedData.w3WorkspaceId,
    editorIdentityId: seedData.editorIdentityId,
    skuSuffix: "w3-f163d",
  });
  const w3F163cSeed = await seedM201ReadyProject(embedded.superuserUrl, {
    workspaceId: seedData.w3WorkspaceId,
    editorIdentityId: seedData.editorIdentityId,
    skuSuffix: "w3-f163c",
  const w3F25Seed = await seedM201ReadyProject(embedded.superuserUrl, {
    workspaceId: seedData.w3WorkspaceId,
    editorIdentityId: seedData.editorIdentityId,
    skuSuffix: "w3-f25",
  });
  const w3F71Seed = await seedM201ReadyProject(embedded.superuserUrl, {
    workspaceId: seedData.w3WorkspaceId,
    editorIdentityId: seedData.editorIdentityId,
    skuSuffix: "w3-f71",
  });
  const w3F101Lead = await submitSignedLead(
    server,
    embedded.superuserUrl,
    w3Credential,
    intakePayload("Gisela W3 Portal", `w3-f101-${randomUUID()}`, true),
  );
  const w3F102Lead = await submitSignedLead(
    server,
    embedded.superuserUrl,
    w3Credential,
    intakePayload("Gustav W3 Termine", `w3-f102-${randomUUID()}`, true),
  );
  const w3F94cLead = await submitSignedLead(
    server,
    embedded.superuserUrl,
    w3Credential,
    intakePayload("Ferdinand W3 GPS", `w3-f94c-${randomUUID()}`, true),
  );
  const w3F94Lead = await submitSignedLead(
    server,
    embedded.superuserUrl,
    w3Credential,
    intakePayload("Friedrich W3 Export", `w3-f94-${randomUUID()}`, true),
  );
  const w3F94dLead = await submitSignedLead(
    server,
    embedded.superuserUrl,
    w3Credential,
    intakePayload("Franziska W3 Auslastung", `w3-f94d-${randomUUID()}`, true),
  );
  const w3F93Lead = await submitSignedLead(
    server,
    embedded.superuserUrl,
    w3Credential,
    intakePayload("Frieda W3 Zeiterfassung", `w3-f93-${randomUUID()}`, true),
  );
  throwIfInterrupted();

  writeState(statePath, {
    baseURL: server.baseURL,
    databaseUrl: embedded.superuserUrl,
    foreignProjectId: foreignLead.projectId,
    mainProjectId: mainLead.projectId,
    m111bContactName: seedData.m111bContactName,
    m111bProjectId: m111bLead.projectId,
    m111bWorkspaceId: seedData.m111bWorkspaceId,
    f703ProjectId: w3F703Lead.projectId,
    f22ProjectId: w3F22Seed.projectId,
    f25ProjectId: w3F25Seed.projectId,
    f71ProjectId: w3F71Seed.projectId,
    f93ProjectId: w3F93Lead.projectId,
    f162ProjectId: w3F162Seed.projectId,
    f163dProjectId: w3F163dSeed.projectId,
    f163cProjectId: w3F163cSeed.projectId,
    f101ProjectId: w3F101Lead.projectId,
    f102ProjectId: w3F102Lead.projectId,
    f94ProjectId: w3F94Lead.projectId,
    f94dProjectId: w3F94dLead.projectId,
    f94cProjectId: w3F94cLead.projectId,
    w3WorkspaceId: seedData.w3WorkspaceId,
    m112aProjectId: m112aSeed.projectId,
    m112aWorkspaceId: seedData.m112aWorkspaceId,
    m112aEditorEmail: seedData.m112aEditorEmail,
    m112aViewerEmail: seedData.m112aViewerEmail,
    m112aExternalEmail: seedData.m112aExternalEmail,
    m201BatteryId: m201Seed.products.battery,
    m201EditorEmail: seedData.m201EditorEmail,
    m201EditorIdentityId: seedData.m201EditorIdentityId,
    m201InverterId: m201Seed.products.inverter,
    m201ModuleId: m201Seed.products.module,
    m201ProjectId: m201Seed.projectId,
    m201WallboxId: m201Seed.products.wallbox,
    m201WorkspaceId: seedData.m201WorkspaceId,
    serverLogPath,
    workspaceId: seedData.workspaceId,
    foreignWorkspaceId: seedData.foreignWorkspaceId,
    editorEmail: seedData.editorEmail,
    viewerEmail: seedData.viewerEmail,
    restrictedEditorEmail: seedData.restrictedEditorEmail,
    externalEditorEmail: seedData.externalEditorEmail,
    externalEmail: seedData.externalEmail,
    mainContactName: seedData.mainContactName,
    foreignContactName: seedData.foreignContactName,
  });

  if (process.env.ENERGIE_SAAS_LOCAL_PREVIEW === "1") {
    // Mikail 2026-09-04: „localhost von ALLEN gebauten Funktionen" — die
    // Runner-Seeds decken Board/Katalog/Angebote bereits ab; hier kommen die
    // Bereiche hinzu, die sonst erst die Einzel-Specs befüllen würden:
    // Rechnungen (Stammdaten + Belege), Wirtschaftlichkeit, Kontakt, Termin.
    // superuserUrl: die Specs nutzen dieselbe URL — RLS/Schema-Härtung der
    // Service-Rollen bleibt wirksam, die Demo-Seeds laufen als Superuser.
    const previewPool = new Pool({ connectionString: embedded.superuserUrl, max: 1 });
    try {
      await previewPool.query("begin");
      await previewPool.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true)",
        [seedData.workspaceId],
      );
      // Actor-Kontext leer lassen: der membership-DML-Guard verbietet
      // Self-Mutation; als Superuser ist RLS ohnehin umgangen, die
      // Trigger brauchen nur einen nicht-selbst Actor.
      await previewPool.query("select pg_catalog.set_config('app.actor_id', '', true)");
      // Capabilities für Rechnungen + Wirtschaftlichkeit
      for (const capability of ["invoicing", "economics"]) {
        await previewPool.query(
          `update membership
              set capabilities = pg_catalog.jsonb_set(
                coalesce(capabilities, '{}'::jsonb), $2, 'true'::jsonb, true
              )
            where workspace_id = $1::uuid
              and user_id = (select id from user_identity where email = $3 limit 1)`,
          [seedData.workspaceId, `{${capability}}`, seedData.editorEmail],
        );
      }
      // Rechnungsstellung (vollständig, idempotent)
      await previewPool.query(
        `insert into workspace_invoicing_settings (
           id, workspace_id, company_name, company_email, company_country,
           company_address_line1, company_postal_code, company_city,
           accounting_method, revision, created_by,
           payment_account_holder, payment_iban, payment_bic
         ) select gen_random_uuid(), $1::uuid, 'Solarwerk Demo GmbH',
           'rechnung@demo.invalid', 'DE', 'Musterstraße 1', '10115', 'Berlin',
           'accrual', 1, (select id from user_identity where email = $2 limit 1),
           'Solarwerk Demo GmbH', 'DE89370400440532013000', 'MARKDEF1100'
         where not exists (
           select 1 from workspace_invoicing_settings where workspace_id = $1::uuid
         )`,
        [seedData.workspaceId, seedData.editorEmail],
      );
      // Rechnungen: Gruppe + Entwurf + ausgestellte Rechnung
      await previewPool.query(
        `insert into commercial_document_group (id, workspace_id, name, created_by)
         select gen_random_uuid(), $1::uuid, 'Solarprojekte 2026',
                (select id from user_identity where email = $2 limit 1)
         where not exists (
           select 1 from commercial_document_group
            where workspace_id = $1::uuid and name = 'Solarprojekte 2026'
         )`,
        [seedData.workspaceId, seedData.editorEmail],
      );
      await previewPool.query(
        `insert into commercial_document (
           id, workspace_id, type, status, name, created_by, due_date, payment_status
         ) select gen_random_uuid(), $1::uuid, 'invoice', 'draft',
           'Demo-Entwurf (ausstellbar)', u.id, (now()::date + 30), 'unpaid'
           from user_identity u where u.email = $2
            and not exists (
             select 1 from commercial_document
              where workspace_id = $1::uuid and name = 'Demo-Entwurf (ausstellbar)'
           )
         limit 1`,
        [seedData.workspaceId, seedData.editorEmail],
      );
      await previewPool.query(
        `insert into commercial_document (
           id, workspace_id, type, status, name, created_by, issued_at,
           issued_snapshot, snapshot_sha256, issued_by, goebd_retention_until,
           number, number_year, number_sequence, net_cents, tax_cents,
           gross_cents, payment_status, paid_cents, due_date
         ) select gen_random_uuid(), $1::uuid, 'invoice', 'issued',
           'Demo-Rechnung (ausgestellt)', u.id, (now() - interval '2 days'),
           '{"schemaVersion":"document-snapshot.v1"}'::jsonb,
           decode('0000000000000000000000000000000000000000000000000000000000000000', 'hex'),
           u.id, '2036-12-31'::date, 'Rechnung-Demo-2026-900001', 2026, 900001,
           10000, 1900, 11900, 'unpaid', 0, (now()::date + 14)
           from user_identity u where u.email = $2
            and not exists (
             select 1 from commercial_document
              where workspace_id = $1::uuid and name = 'Demo-Rechnung (ausgestellt)'
           )
         limit 1`,
        [seedData.workspaceId, seedData.editorEmail],
      );
      // Wirtschaftlichkeits-Defaults
      await previewPool.query(
        `insert into workspace_economics_settings (
           id, workspace_id, electricity_price_net_cents_per_kwh,
           escalation_rate_bps, oil_price_net_cents_per_liter,
           gas_price_net_cents_per_kwh, cashflow_horizon_years, revision, created_by
         ) select gen_random_uuid(), $1::uuid, 32, 150, 105, 12, 20, 1, u.id
           from user_identity u where u.email = $2
            and not exists (
             select 1 from workspace_economics_settings where workspace_id = $1::uuid
           )
         limit 1`,
        [seedData.workspaceId, seedData.editorEmail],
      );
      // Kontakt (M1-14) + Termin (M1-15) am Haupt-Projekt
      await previewPool.query(
        `insert into contact (
           id, workspace_id, display_name, first_name, last_name,
           is_business, email_primary, email_normalized
         ) select gen_random_uuid(), $1::uuid, 'Demo Kontakt GmbH',
           'Demo', 'Kontakt', true, 'kontakt@demo.invalid',
           'kontakt@demo.invalid'
         where not exists (
           select 1 from contact where workspace_id = $1::uuid
             and display_name = 'Demo Kontakt GmbH'
         )`,
        [seedData.workspaceId],
      );
      // Termin-Guard verlangt einen internen Editor/Admin als Actor —
      // nach den Membership-Updates darf der Editor-Kontext wieder gesetzt
      // werden (Self-Mutation betrifft nur membership-DML).
      await previewPool.query(
        `select pg_catalog.set_config('app.actor_id', u.id::text, true)
           from user_identity u where u.email = $1 limit 1`,
        [seedData.editorEmail],
      );
      await previewPool.query(
        `insert into calendar (id, workspace_id, name, calendar_type, created_by)
         select gen_random_uuid(), $1::uuid, 'Unternehmen', 'tenancy', u.id
           from user_identity u where u.email = $2
            and not exists (
             select 1 from calendar
              where workspace_id = $1::uuid and name = 'Unternehmen'
           )
         limit 1`,
        [seedData.workspaceId, seedData.editorEmail],
      );
      await previewPool.query(
        `insert into project_appointment (
           id, workspace_id, project_id, title, start_at, end_at,
           appointment_type, revision, calendar_id, created_by
         ) select gen_random_uuid(), $1::uuid, $3::uuid,
           'Demo-Termin Vor-Ort', (now() + interval '3 days'),
           (now() + interval '3 days 1 hour'), 'on_site', 1,
           calendar_record.id, u.id
           from user_identity u, calendar calendar_record
          where u.email = $2
            and calendar_record.workspace_id = $1::uuid
            and calendar_record.name = 'Unternehmen'
            and not exists (
             select 1 from project_appointment
              where workspace_id = $1::uuid and title = 'Demo-Termin Vor-Ort'
           )
         limit 1`,
        [seedData.workspaceId, seedData.editorEmail, mainLead.projectId],
      );
      await previewPool.query("commit");
    } finally {
      await previewPool.end();
    }

    const base = `/w/${seedData.workspaceId}`;
    console.log("[preview] Demo-Localhost mit ALLEN integrierten Bereichen:");
    console.log(`[preview]   Anfragen/Board:  ${server.baseURL}${base}/anfragen`);
    console.log(`[preview]   Katalog:         ${server.baseURL}${base}/katalog`);
    console.log(`[preview]   Angebote:        ${server.baseURL}${base}/angebote`);
    console.log(`[preview]   Rechnungen:      ${server.baseURL}${base}/rechnungen`);
    console.log(`[preview]   Rechnungsstellung: ${server.baseURL}${base}/einstellungen/rechnungsstellung`);
    console.log(`[preview]   Wirtschaftlichkeit: ${server.baseURL}${base}/einstellungen/wirtschaftlichkeit`);
    console.log(`[preview] Editor (invoicing+conomics): ${seedData.editorEmail}`);
    console.log(`[preview] Viewer:  ${seedData.viewerEmail}`);
    console.log(`[preview] External: ${seedData.externalEmail}`);
    console.log(`[preview] OTP-Login-Codes erscheinen im privaten Serverlog: ${serverLogPath}`);
    console.log("[preview] Beenden mit Ctrl+C; Testdaten und Server werden danach automatisch entfernt.");
    while (!interruptedBy) await sleep(1_000);
    return signalExitCode(interruptedBy);
  }

  console.log(grep
    ? `[e2e] Chromium prüft fokussiert: ${grep}`
    : "[e2e] Chromium prüft M1-06 bis M2-03b1, M1-08b-Import, M1-09-Zuweisung, Rollen, Fremdmandant und Axe …");

  const playwrightExitCode = await runPlaywright(
    statePath,
    playwrightOutputPath,
    server.baseURL,
    grep,
  );
  if (playwrightExitCode !== 0) {
    if (serverLogFd !== undefined) fsyncSync(serverLogFd);
    try {
      const diagnostic = safeMessage(readFileSync(serverLogPath, "utf8").slice(-20_000)).trim();
      if (diagnostic.length > 0) {
        console.error(`[e2e] Sanitisiertes Next-Diagnoseende:\n${diagnostic}`);
      }
    } catch {
      console.error("[e2e] Das sanitisierte Next-Diagnoseende war nicht lesbar.");
    }
  }
  try {
    // CI-Observability (autonomer Loop): Playwright-Output stabil
    // ablegen; test-results/ ist git-ignoriert. Best effort.
    mkdirSync(join(REPO_ROOT, "test-results", "e2e"), { recursive: true });
    cpSync(playwrightOutputPath, join(REPO_ROOT, "test-results", "e2e"), { recursive: true });
  } catch {
    // Absichtlich still: der Exit-Status oben bleibt maßgeblich.
  }
  const geoapifyExercised = geoapifyContractWasExercised(providerStub);
  const geoapifyUntouched = providerStub.violations.length === 0
    && providerStub.autocompleteRequests === 0
    && providerStub.detailsRequests === 0;
  if ((!grep && !geoapifyExercised) || (grep && !geoapifyExercised && !geoapifyUntouched)) {
    console.error("[e2e] Der lokale Geoapify-Vertrag war weder exakt 1/1 noch in einem fokussierten Lauf unberührt.");
    return 1;
  }
  console.log(geoapifyExercised
    ? "[e2e] Lokaler Geoapify-Vertrag: 1 Suche, 1 Detailauflösung, 0 Abweichungen."
    : "[e2e] Fokussierter Lauf ohne Geoapify-Pfad: 0/0 Aufrufe, 0 Abweichungen.");
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
