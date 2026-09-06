import { Pool, type PoolConfig } from "pg";

type ClientIdentity = object;

type EmbeddedPostgresStopHandle = {
  stop: () => Promise<void>;
};

type PgPoolInternals = {
  _clients?: unknown;
  ending?: unknown;
  ended?: unknown;
  options?: { idleTimeoutMillis?: unknown };
};

type PoolLifecycle = {
  activeClients: Set<ClientIdentity>;
  pendingConnectsAtEnd: Set<ClientIdentity>;
  firstFailure: Error | undefined;
  endStarted: boolean;
  drainResolvers: Set<() => void>;
  onConnect: (client: unknown) => void;
  onRemove: (client: unknown) => void;
};

const trackedLifecycles = new WeakMap<Pool, PoolLifecycle>();

function isClientIdentity(value: unknown): value is ClientIdentity {
  return typeof value === "object" && value !== null;
}

function internalClients(pool: Pool): ClientIdentity[] {
  const clients = (pool as unknown as PgPoolInternals)._clients;
  if (!Array.isArray(clients) || !clients.every(isClientIdentity)) {
    throw new Error("pg-Pool-Lifecycle kann _clients nicht defensiv erfassen.");
  }
  return clients;
}

function recordFailure(lifecycle: PoolLifecycle, message: string): void {
  lifecycle.firstFailure ??= new Error(message);
}

function resolveDrained(lifecycle: PoolLifecycle): void {
  if (lifecycle.activeClients.size !== 0) return;
  for (const resolve of lifecycle.drainResolvers) resolve();
  lifecycle.drainResolvers.clear();
}

/**
 * Muss unmittelbar nach `new Pool()` und vor jeder Nutzung aufgerufen werden.
 * Nur so bleiben auch Clients sichtbar, die ein Query-Fehler oder
 * `release(true)` schon vor dem abschließenden Pool.end() aus `_clients`
 * entfernt hat, deren Socket-Callback aber noch aussteht.
 */
export function trackPoolClientLifecycleAtCreation(pool: Pool): Pool {
  if (trackedLifecycles.has(pool)) {
    throw new Error("pg-Pool-Lifecycle wurde doppelt registriert.");
  }
  const internals = pool as unknown as PgPoolInternals;
  const clients = internalClients(pool);
  if (
    clients.length !== 0
    || pool.totalCount !== 0
    || internals.ending !== false
    || internals.ended !== false
    || internals.options?.idleTimeoutMillis !== 0
  ) {
    throw new Error(
      "pg-Pool-Lifecycle muss unbenutzt und mit idleTimeoutMillis=0 registriert werden.",
    );
  }

  const lifecycle: PoolLifecycle = {
    activeClients: new Set(),
    pendingConnectsAtEnd: new Set(),
    firstFailure: undefined,
    endStarted: false,
    drainResolvers: new Set(),
    onConnect: () => undefined,
    onRemove: () => undefined,
  };
  lifecycle.onConnect = (client: unknown): void => {
    if (!isClientIdentity(client)) {
      recordFailure(lifecycle, "pg-Pool connect lieferte keine Client-Identitaet.");
      return;
    }
    if (
      lifecycle.endStarted
      && !lifecycle.pendingConnectsAtEnd.delete(client)
    ) {
      recordFailure(
        lifecycle,
        "pg-Pool verband einen unbekannten Client nach Teardown-Beginn.",
      );
    }
    if (lifecycle.activeClients.has(client)) {
      recordFailure(lifecycle, "pg-Pool meldete dieselbe Client-Identitaet doppelt.");
      return;
    }
    lifecycle.activeClients.add(client);
  };
  lifecycle.onRemove = (client: unknown): void => {
    if (!isClientIdentity(client) || !lifecycle.activeClients.delete(client)) {
      recordFailure(lifecycle, "pg-Pool meldete ein unbekanntes remove(client).");
      return;
    }
    resolveDrained(lifecycle);
  };

  pool.on("connect", lifecycle.onConnect);
  pool.on("remove", lifecycle.onRemove);
  trackedLifecycles.set(pool, lifecycle);
  return pool;
}

/** Erstellt den Pool und registriert das Lifecycle-Tracking synchron. */
export function createDrainTrackedPool(config: PoolConfig): Pool {
  return trackPoolClientLifecycleAtCreation(new Pool({
    ...config,
    // Verhindert unsichtbare, timergetriebene Removes. Fehler-/Destroy-Removes
    // bleiben möglich und werden seit Pool-Erzeugung identitätsgenau verfolgt.
    idleTimeoutMillis: 0,
  }));
}

/**
 * `pg-pool` leert `_clients` synchron, löst Pool.end() dadurch aber unter
 * Umständen vor den socket-seitigen `remove(client)`-Callbacks auf. Dieser
 * Abschluss wartet ohne Sleep-Heuristik auf jede seit Erzeugung beobachtete
 * Client-Identität – auch wenn sie vor dem Aufruf bereits aus `_clients`
 * entfernt wurde.
 */
export async function endPoolAndWaitForClientRemoval(pool: Pool): Promise<void> {
  const lifecycle = trackedLifecycles.get(pool);
  if (!lifecycle) {
    throw new Error(
      "pg-Pool muss mit createDrainTrackedPool erzeugt worden sein.",
    );
  }
  if (lifecycle.endStarted) {
    throw new Error("pg-Pool-Teardown wurde doppelt gestartet.");
  }
  const internals = pool as unknown as PgPoolInternals;
  if (internals.ending !== false || internals.ended !== false) {
    throw new Error("pg-Pool.end wurde ausserhalb des Lifecycle-Helpers gestartet.");
  }
  lifecycle.endStarted = true;

  // `_clients` enthält neben verbundenen Clients auch laufende connect()-
  // Versuche. Letztere haben noch kein `connect`-Event und werden bei einem
  // Fehlschlag ohne `remove` aus pg-pool gefiltert. Deshalb dürfen sie NICHT
  // in activeClients gelangen; Pool.end() selbst wartet auf ihren Abschluss.
  const currentClients = internalClients(pool);
  const uniqueCurrentClients = new Set(currentClients);
  if (
    uniqueCurrentClients.size !== currentClients.length
    || currentClients.length !== pool.totalCount
  ) {
    recordFailure(
      lifecycle,
      "pg-Pool-Teardown: _clients und totalCount widersprechen sich.",
    );
  }
  for (const client of uniqueCurrentClients) {
    if (!lifecycle.activeClients.has(client)) {
      lifecycle.pendingConnectsAtEnd.add(client);
    }
  }

  const failures: unknown[] = [];
  try {
    try {
      await pool.end();
    } catch (error) {
      failures.push(error);
    }

    // Erst NACH Pool.end registrieren: Ein beim zwischenzeitlich erfolgreicher
    // Pending-Connect kann activeClients noch vergrößern. Resolver-Registrierung
    // plus unmittelbarer Recheck schließt auch das Nullwerden an dieser Grenze.
    if (lifecycle.activeClients.size !== 0) {
      await new Promise<void>((resolve) => {
        lifecycle.drainResolvers.add(resolve);
        if (lifecycle.activeClients.size === 0) {
          lifecycle.drainResolvers.delete(resolve);
          resolve();
        }
      });
    }

    const remainingClients = internalClients(pool);
    if (
      pool.totalCount !== 0
      || remainingClients.length !== 0
      || lifecycle.activeClients.size !== 0
    ) {
      recordFailure(lifecycle, "pg-Pool-Teardown blieb unvollstaendig.");
    }
    if (lifecycle.pendingConnectsAtEnd.size !== 0 && failures.length === 0) {
      // Erfolgreiches Pool.end + leere _clients beweist, dass diese Identitäten
      // als fehlgeschlagene Connects ohne remove beendet wurden.
      lifecycle.pendingConnectsAtEnd.clear();
    }
    if (lifecycle.pendingConnectsAtEnd.size !== 0) {
      recordFailure(
        lifecycle,
        "pg-Pool-Teardown hinterliess ungeklärte connect()-Versuche.",
      );
    }
    if (lifecycle.firstFailure) failures.push(lifecycle.firstFailure);
    if (failures.length > 0) {
      throw new AggregateError(failures, "pg-Pool-Teardown fehlgeschlagen.");
    }
  } finally {
    pool.off("connect", lifecycle.onConnect);
    pool.off("remove", lifecycle.onRemove);
    trackedLifecycles.delete(pool);
  }
}

/**
 * Drainiert alle Test-Pools parallel und stoppt Embedded Postgres erst danach.
 * Fehler werden gesammelt, damit auch bei einem fehlgeschlagenen Pool-Teardown
 * die übrigen Pools geschlossen und die Testinstanz aufgeräumt werden.
 */
export async function endPoolsAndStopEmbeddedPostgres(
  pools: readonly (Pool | null | undefined)[],
  embedded: EmbeddedPostgresStopHandle | null | undefined,
  failureMessage: string,
): Promise<void> {
  const presentPools = pools.filter((pool): pool is Pool => pool !== undefined && pool !== null);
  const uniquePools = new Set(presentPools);
  const failures: unknown[] = [];

  if (uniquePools.size !== presentPools.length) {
    failures.push(new Error("pg-Pool-Teardown enthielt dieselbe Pool-Identitaet mehrfach."));
  }

  const closeResults = await Promise.allSettled(
    [...uniquePools].map((pool) => endPoolAndWaitForClientRemoval(pool)),
  );
  for (const result of closeResults) {
    if (result.status === "rejected") failures.push(result.reason);
  }

  try {
    await embedded?.stop();
  } catch (error) {
    failures.push(error);
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, failureMessage);
  }
}
