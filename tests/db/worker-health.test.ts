// ═══════════════════════════════════════════════════════════════════════
// Worker-Health-Probe: die Timeouts müssen ECHT sein, nicht nur früher
// ablehnen (Codex-Re-Review, "Neue Brüche").
//
// Der alte Bruch war zweiteilig und beides ist hier direkt adressiert:
//  * `set local statement_timeout` außerhalb einer Transaktion ist wirkungslos,
//  * `Promise.race` storniert weder connect() noch die Query — Waiter blieben
//    in der Pool-Warteschlange stehen.
//
// Der schärfste Fall ist deshalb nicht "Port zu" (das schlägt sofort mit
// ECONNREFUSED fehl und wäre auch vorher grün gewesen), sondern ein TCP-Peer,
// der die Verbindung ANNIMMT und dann für immer schweigt: genau dort hing die
// alte Probe unbegrenzt.
// ═══════════════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { createHealthProbe, createHealthServer, healthPoolConfig, type HealthProbe } from "@/worker/health";

const PROBE_MS = 500;

interface Lauschend {
  listen: (port: number, host: string, cb: () => void) => unknown;
  address: () => AddressInfo | string | null;
}

async function listen(server: Lauschend): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("kein TCP-Port erhalten");
  return addr.port;
}

/** TCP-Peer, der Verbindungen annimmt und danach schweigt. */
function schwarzesLoch(): { server: TcpServer; sockets: Socket[] } {
  const sockets: Socket[] = [];
  const server = createTcpServer((socket) => {
    // Referenz halten: ohne das würde der Socket geschlossen und der Client
    // bekäme ein Verbindungsende statt zu hängen.
    sockets.push(socket);
  });
  return { server, sockets };
}

/**
 * Wartet, bis `pruefung()` zutrifft. Der abgebrochene Client verschwindet erst
 * aus `_clients`, wenn sein connect-Callback nach dem Socket-Destroy feuert —
 * das ist ein paar Ticks NACH der HTTP-Antwort. Ohne dieses Warten prüft der
 * Test eine Zwischenstellung statt des Ruhezustands.
 */
async function warteBis(pruefung: () => boolean, ms = 5_000): Promise<void> {
  const ende = Date.now() + ms;
  while (Date.now() < ende && !pruefung()) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function health(port: number): Promise<{ status: number; dauerMs: number; body: string }> {
  const start = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.text();
  return { status: res.status, dauerMs: Date.now() - start, body };
}

async function withProbeServer<T>(
  connectionString: string,
  run: (port: number, probe: HealthProbe) => Promise<T>,
): Promise<T> {
  const probe = createHealthProbe(connectionString, PROBE_MS);
  const server = createHealthServer(probe, new Date().toISOString());
  const port = await listen(server);
  try {
    return await run(port, probe);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await probe.close();
  }
}

describe("Worker-Health-Probe", () => {
  it("antwortet 200, solange die DB erreichbar ist", async () => {
    await withProbeServer(process.env.POSTGRES_URL_TEST!, async (port) => {
      const res = await health(port);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);
    });
  });

  it("antwortet 503, wenn auf dem Port niemand lauscht", async () => {
    // Freien Port ermitteln und sofort wieder freigeben.
    const leer = createTcpServer();
    const totPort = await listen(leer);
    await new Promise<void>((resolve) => leer.close(() => resolve()));

    await withProbeServer(`postgres://niemand:x@127.0.0.1:${totPort}/nichts`, async (port, probe) => {
      const res = await health(port);
      expect(res.status).toBe(503);
      expect(JSON.parse(res.body)).toMatchObject({
        ok: false,
        error: "worker_unavailable",
      });
      expect(res.body).not.toContain("ECONNREFUSED");
      expect(JSON.parse(res.body).ok).toBe(false);
      expect(probe.stats().waiting, "Waiter in der Warteschlange stehen geblieben").toBe(0);
    });
  });

  it("antwortet 503 INNERHALB der Frist, wenn der Peer die Verbindung annimmt und schweigt", async () => {
    const { server: loch, sockets } = schwarzesLoch();
    const lochPort = await listen(loch);

    try {
      await withProbeServer(`postgres://niemand:x@127.0.0.1:${lochPort}/nichts`, async (port, probe) => {
        const res = await health(port);
        expect(res.status, "hängende Verbindung wurde nicht als 503 gemeldet").toBe(503);
        // Frist großzügig, aber weit unterhalb von "hängt für immer": ohne
        // connectionTimeoutMillis kehrte dieser Request nie zurück.
        expect(res.dauerMs, `Probe brauchte ${res.dauerMs} ms`).toBeLessThan(PROBE_MS * 8);

        // Kein Handle-Leak: der Waiter ist entfernt, der Client zerstört.
        expect(probe.stats().waiting, "Waiter blieb in der Warteschlange").toBe(0);
        await warteBis(() => probe.stats().total === 0);
        expect(probe.stats().total, "toter Client blieb im Pool").toBe(0);
      });
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => loch.close(() => resolve()));
    }
  }, 20_000);

  it("mehrere Requests gegen eine hängende DB stauen keine Waiter an", async () => {
    const { server: loch, sockets } = schwarzesLoch();
    const lochPort = await listen(loch);

    try {
      await withProbeServer(`postgres://niemand:x@127.0.0.1:${lochPort}/nichts`, async (port, probe) => {
        const alle = await Promise.all([health(port), health(port), health(port)]);
        expect(alle.map((r) => r.status)).toEqual([503, 503, 503]);
        // Kernaussage: die Warteschlange ist leer. Ohne stornierbaren connect()
        // stünden hier drei Waiter, die niemand mehr abräumt.
        expect(probe.stats().waiting, "Waiter angesammelt — genau der alte Bruch").toBe(0);
        await warteBis(() => probe.stats().total === 0);
        expect(probe.stats().total, "toter Client blieb im Pool").toBe(0);
      });
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => loch.close(() => resolve()));
    }
  }, 20_000);
});

describe("Timeouts sind verifizierte Sessionwerte, kein SET LOCAL", () => {
  it("statement_timeout hängt an der Verbindung selbst", async () => {
    const pool = new Pool(healthPoolConfig(process.env.POSTGRES_URL_TEST!, PROBE_MS));
    try {
      const { rows } = await pool.query<{ statement_timeout: string }>(
        "select current_setting('statement_timeout') as statement_timeout",
      );
      // Der alte Pfad ließ hier "0" stehen: `set local` außerhalb einer
      // Transaktion war zum Zeitpunkt der Folge-Query längst wieder weg.
      expect(rows[0].statement_timeout, "statement_timeout ist nicht gesetzt").not.toBe("0");
    } finally {
      await pool.end();
    }
  });

  it("eine zu lange Query wird tatsächlich ABGEBROCHEN", async () => {
    const pool = new Pool(healthPoolConfig(process.env.POSTGRES_URL_TEST!, PROBE_MS));
    const start = Date.now();
    let caught: unknown;
    try {
      await pool.query("select pg_sleep(5)");
    } catch (error) {
      caught = error;
    } finally {
      await pool.end();
    }
    expect(caught, "pg_sleep(5) lief durch — kein wirksamer Timeout").toBeInstanceOf(Error);
    expect(Date.now() - start, "Abbruch kam zu spät").toBeLessThan(PROBE_MS * 8);
  }, 20_000);
});
