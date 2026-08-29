import { timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { isAbsolute, resolve } from "node:path";

const HOST = "localhost";
const READY_ENDPOINT = "/__m1_05_e2e_ready";
const PRIVATE_FILE_MODE = 0o600;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type ReadyState = {
  token: string;
  pid: number;
  host: typeof HOST;
  port: number;
  baseURL: string;
};

type NextApplication = {
  close(): Promise<void>;
  getRequestHandler(): RequestListener;
  prepare(): Promise<void>;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Fehlende private Testserver-Konfiguration: ${name}.`);
  return value;
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return candidateBytes.byteLength === expectedBytes.byteLength
    && timingSafeEqual(candidateBytes, expectedBytes);
}

function writeReadyFile(path: string, state: ReadyState): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, "wx", PRIVATE_FILE_MODE);
    writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
    closeSync(fd);
    fd = undefined;
    chmodSync(temporaryPath, PRIVATE_FILE_MODE);
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

function removeReadyFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error("Die private Ready-Datei ist kein reguläres Dateiziel.");
    }
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function listenOnEphemeralPort(server: Server): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const onError = (error: Error): void => rejectPort(error);
    server.once("error", onError);
    server.listen(0, HOST, () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPort(new Error("Der private Testserver erhielt keinen TCP-Port."));
        return;
      }
      resolvePort(address.port);
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
    server.closeIdleConnections();
  });
}

const readyFile = requiredEnvironment("M1_05_E2E_READY_FILE");
const readyToken = requiredEnvironment("M1_05_E2E_READY_TOKEN");
if (!isAbsolute(readyFile)) throw new Error("Die private Ready-Datei muss absolut sein.");
if (!TOKEN_PATTERN.test(readyToken)) throw new Error("Der private Ready-Token ist ungültig.");

let ready = false;
let nextApplication: NextApplication | undefined;
let nextHandler: RequestListener | undefined;
let readyState: ReadyState | undefined;

const httpServer = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${HOST}`);
  if (requestUrl.pathname === READY_ENDPOINT) {
    const header = request.headers["x-m1-05-e2e-token"];
    const candidate = Array.isArray(header) ? undefined : header;
    if (
      request.method !== "GET"
      || !ready
      || !readyState
      || !tokenMatches(candidate, readyToken)
    ) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(`${JSON.stringify(readyState)}\n`);
    return;
  }

  if (!ready || !nextHandler) {
    response.writeHead(503, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "retry-after": "1",
    });
    response.end("Testserver wird vorbereitet.\n");
    return;
  }

  Promise.resolve(nextHandler(request, response)).catch(() => {
    if (!response.headersSent) {
      response.writeHead(500, { "cache-control": "no-store" });
      response.end();
    } else if (!response.writableEnded) {
      response.destroy();
    }
  });
});

let shutdownPromise: Promise<void> | undefined;
function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    ready = false;
    try {
      removeReadyFile(readyFile);
    } catch {
      // Der Elternprozess entfernt das private Laufverzeichnis ebenfalls.
    }
    await closeHttpServer(httpServer).catch(() => undefined);
    await nextApplication?.close().catch(() => undefined);
  })();
  return shutdownPromise;
}

let shutdownSignal: NodeJS.Signals | undefined;
function handleSignal(signal: NodeJS.Signals): void {
  if (shutdownSignal) return;
  shutdownSignal = signal;
  void shutdown().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
}

process.on("SIGINT", handleSignal);
process.on("SIGTERM", handleSignal);

try {
  const port = await listenOnEphemeralPort(httpServer);
  const baseURL = `http://${HOST}:${port}`;

  process.env.BETTER_AUTH_URL = baseURL;
  process.env.HOSTNAME = HOST;
  process.env.PORT = String(port);

  const { default: next } = await import("next");
  nextApplication = next({
    dev: true,
    dir: resolve(import.meta.dirname, "../.."),
    hostname: HOST,
    port,
    httpServer,
    quiet: true,
    turbopack: true,
  });
  const preparedHandler = nextApplication.getRequestHandler();
  await nextApplication.prepare();
  nextHandler = preparedHandler;
  readyState = { token: readyToken, pid: process.pid, host: HOST, port, baseURL };
  ready = true;
  writeReadyFile(readyFile, readyState);
} catch (error) {
  await shutdown();
  throw error;
}

await new Promise<void>(() => undefined);
