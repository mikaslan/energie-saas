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
// Die TCP-/Clientfrist steht am Pool. Die serverseitigen Fristen setzt dessen
// verifizierter Initializer einmal SESSION-weit mit set_config(..., false),
// bevor pg-pool den Client erstmals ausgibt. Damit gibt es weder wirkungsloses
// SET LOCAL noch providerabhängige Startup-Parameter.
// ═══════════════════════════════════════════════════════════════════════
import { Pool, type PoolConfig } from "pg";
import { createServer, type Server } from "node:http";
import { servicePoolConfig } from "../lib/db/role-env";

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
 *  - `statement_timeout`: serverseitig, wird vom Pool-Verify SESSION-weit
 *    gesetzt (kein `SET LOCAL` und kein Startup-Parameter). Der Server canceled
 *    die Query selbst.
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
    ...servicePoolConfig(connectionString, "app_worker", 1, {
      connectionMs: timeoutMs,
      lockMs: timeoutMs,
      statementMs: timeoutMs,
      queryMs: timeoutMs,
      idleInTransactionMs: timeoutMs,
    }),
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
  assertOperational: () => void = () => undefined,
): HealthProbe {
  const pool = new Pool(healthPoolConfig(connectionString, timeoutMs));
  pool.on("error", (err: unknown) => console.error("[health-probe]", err));
  const strictRoleContract = (process.env.DB_ROLE_MODE ?? "strict") === "strict";

  return {
    async probe(): Promise<void> {
      assertOperational();
      const client = await pool.connect();
      try {
        if (strictRoleContract) {
          // Eine reine `select 1`-Probe bleibt grün, wenn pg-boss seine
          // Schema-/Tabellenrechte verloren hat. Ownerdrift macht die echte
          // Poll-/Jobverarbeitung unbrauchbar und muss deshalb readiness-rot
          // werden, auch wenn der Server selbst noch antwortet.
          const ownership = await client.query<{ intact: boolean }>(`
            select coalesce((
                     select owner.rolname = current_user
                     from pg_catalog.pg_namespace namespace
                     join pg_catalog.pg_roles owner on owner.oid = namespace.nspowner
                     where namespace.nspname = 'pgboss'
                   ), false)
                   and pg_catalog.to_regclass('pgboss.version') is not null
                   and pg_catalog.to_regclass('pgboss.queue') is not null
                   and pg_catalog.to_regclass('pgboss.job') is not null
                   and not exists (
                     select 1
                     from pg_catalog.pg_class relation
                     join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
                     where namespace.nspname = 'pgboss'
                       and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
                       and relation.relowner <> pg_catalog.to_regrole(current_user)
                   )
                   and not exists (
                     select 1
                     from pg_catalog.pg_proc routine
                     join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
                     where namespace.nspname = 'pgboss'
                       and routine.proowner <> pg_catalog.to_regrole(current_user)
                   ) as intact
          `);
          if (ownership.rows[0]?.intact !== true) {
            throw new Error("pg-boss-Ownership-/Zugriffsvertrag ist nicht intakt.");
          }
        } else {
          await client.query("select 1");
        }
        assertOperational();
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
 *
 * Vertragsdetails (Codex-Review #4/#5): Ticks werden REKURSIV geplant — der
 * nächste startet erst, wenn der vorherige komplett fertig ist (kein Überlappen
 * bei hängendem Monitoring-Dienst); der Fetch trägt einen 10-s-Timeout; nach
 * stop() pingt auch ein gerade laufender Tick nicht mehr; ein Nicht-2xx vom
 * Ping-Endpunkt ist KEINE Zustellung (healthchecks.io: 404/409/429/5xx) und
 * wird geloggt.
 */
export function startHeartbeat(
  probe: HealthProbe,
  pingUrl: string,
  intervalMs = 60_000,
  fetchFn: typeof fetch = fetch,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    try {
      await probe.probe();
    } catch (err) {
      console.error("[heartbeat] Probe fehlgeschlagen, Ping unterdrückt:", err);
      return;
    }
    if (stopped) return;
    try {
      const res = await fetchFn(pingUrl, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.error(`[heartbeat] Ping abgelehnt: HTTP ${res.status}`);
    } catch (err) {
      console.error("[heartbeat] Ping nicht zustellbar:", err);
    }
  };

  const run = async () => {
    await tick();
    if (stopped) return;
    timer = setTimeout(() => void run(), intervalMs);
    // Der Timer darf einen Shutdown/Testlauf nicht am Leben halten.
    timer.unref?.();
  };
  void run();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
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
        // Der Endpoint ist zwar nur an Loopback gebunden, kann später aber
        // hinter einem Reverse Proxy landen. Rollen-, Host- und Querydetails
        // gehören ausschließlich ins lokale Log, nicht in den HTTP-Body.
        res.end(JSON.stringify({ ok: false, startedAt, error: "worker_unavailable" }));
      },
    );
  });
}
