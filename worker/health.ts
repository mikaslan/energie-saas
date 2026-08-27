// ═══════════════════════════════════════════════════════════════════════
// Health-Probe des Workers — mit ECHTEN, ABBRECHENDEN Timeouts.
//
// Vorgeschichte (Codex-Review #26 und die Re-Review-Feststellung danach):
//
//  1. /health lieferte nach einem erfolgreichen Start DAUERHAFT HTTP 200, auch
//     wenn die Datenbank längst weg war. Ein Worker, der keinen einzigen Job
//     mehr verarbeiten kann, blieb health-grün. Behoben durch eine AKTUELLE
//     Probe je Request statt "hat mal gestartet".
//
//  2. Die erste Fassung dieser Probe hatte aber gar keinen wirksamen Timeout:
//       * `set local statement_timeout = …` lief AUSSERHALB einer Transaktion.
//         LOCAL wirkt nur bis zum Ende der umgebenden Transaktion — ohne
//         explizites BEGIN ist das das SET-Statement selbst, der Wert war für
//         die Folge-Query also wieder weg (PostgreSQL 17, SET).
//       * `Promise.race` liefert nur früher ein abgelehntes Promise. Es
//         STORNIERT weder `pool.connect()` noch die laufende Query: der Waiter
//         blieb in der Pool-Warteschlange, der Socket offen. Bei einer hängenden
//         DB sammeln sich so mit jedem /health-Request Waiter an, bis Recovery
//         oder Shutdown blockieren.
//
// Die Timeouts stehen deshalb jetzt als VERBINDUNGS-Optionen des Pools, nicht
// als SQL im Probe-Pfad — sie greifen damit unabhängig davon, an welcher Stelle
// es hängt, und sie brechen tatsächlich ab.
// ═══════════════════════════════════════════════════════════════════════
import { Pool, type PoolConfig } from "pg";
import { createServer, type Server } from "node:http";

export const PROBE_TIMEOUT_MS = 2_000;

/**
 * Poolkonfiguration der Probe. Eigener kleiner Pool statt des pg-boss-internen:
 * der ist nicht öffentlich zugesichert, und eine unabhängige Verbindung misst
 * genau das, was der Worker zum Arbeiten braucht.
 *
 * Die vier Timeouts decken vier verschiedene Hänger ab:
 *  - `connectionTimeoutMillis`: TCP/Startup antwortet nicht. pg-pool zerstört
 *    danach den Socket (`client.connection.stream.destroy()`) UND entfernt den
 *    Waiter aus der Warteschlange — genau das, was Promise.race nicht konnte.
 *  - `statement_timeout`: serverseitig, wird als Startup-Parameter der
 *    Verbindung mitgeschickt (kein `SET LOCAL` im Probe-Pfad). Der Server
 *    canceled die Query selbst.
 *  - `query_timeout`: clientseitig, falls der Server gar nicht mehr antwortet
 *    und deshalb auch kein statement_timeout mehr feuern kann.
 *  - `idle_in_transaction_session_timeout`: die Probe öffnet keine Transaktion;
 *    der Wert ist die Absicherung dagegen, dass eine künftige Erweiterung eine
 *    offene Transaktion auf dieser Verbindung liegen lässt.
 */
export function healthPoolConfig(
  connectionString: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): PoolConfig {
  return {
    connectionString,
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
    idle_in_transaction_session_timeout: timeoutMs,
    idleTimeoutMillis: 10_000,
    // Der Pool darf den Prozess nicht künstlich am Leben halten; Server und
    // pg-boss tun das. Wichtig, damit ein Testlauf sauber endet.
    allowExitOnIdle: true,
  };
}

export interface ProbeStats {
  total: number;
  idle: number;
  waiting: number;
}

export interface HealthProbe {
  probe(): Promise<void>;
  stats(): ProbeStats;
  close(): Promise<void>;
}

export function createHealthProbe(
  connectionString: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): HealthProbe {
  const pool = new Pool(healthPoolConfig(connectionString, timeoutMs));
  pool.on("error", (err: unknown) => console.error("[health-probe]", err));

  return {
    async probe(): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("select 1");
      } catch (err) {
        // Eine abgebrochene oder getimeoutete Verbindung ist in unbekanntem
        // Zustand (query_timeout bricht mitten im Protokoll ab). release(true)
        // ZERSTÖRT den Client, statt ihn in den Pool zurückzugeben — sonst
        // erbt die nächste Probe den kaputten Socket.
        client.release(true);
        throw err;
      }
      client.release();
    },
    stats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
    close: () => pool.end(),
  };
}

/**
 * Dead-Man-Switch-Heartbeat (healthchecks.io-Muster, siehe
 * docs/tooling/entscheidungen.md §15): Der Worker pingt die URL nur nach einer
 * ERFOLGREICHEN Probe. Bei Fehler wird bewusst NICHT gepingt — das Ausbleiben
 * des Pings ist das Alarmsignal; ein Fehler-Ping würde den Alarm gerade
 * unterdrücken. Fetch-Fehler (Monitoring-Dienst nicht erreichbar) dürfen den
 * Worker nie beeinträchtigen.
 */
export function startHeartbeat(
  probe: HealthProbe,
  pingUrl: string,
  intervalMs = 60_000,
  fetchFn: typeof fetch = fetch,
): () => void {
  const tick = async () => {
    try {
      await probe.probe();
    } catch (err) {
      console.error("[heartbeat] Probe fehlgeschlagen, Ping unterdrückt:", err);
      return;
    }
    try {
      await fetchFn(pingUrl, { method: "POST" });
    } catch (err) {
      console.error("[heartbeat] Ping nicht zustellbar:", err);
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  // Der Timer darf einen Shutdown/Testlauf nicht am Leben halten.
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}

export function createHealthServer(probe: HealthProbe, startedAt: string): Server {
  return createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    probe.probe().then(
      () => res.end(JSON.stringify({ ok: true, startedAt })),
      (err: unknown) => {
        console.error("[worker] Health-Probe fehlgeschlagen:", err);
        res.writeHead(503);
        res.end(JSON.stringify({ ok: false, startedAt, error: String(err) }));
      },
    );
  });
}
