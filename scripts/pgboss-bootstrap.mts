import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { PgBoss } from "pg-boss";

import { requireServiceDatabaseUrl } from "../lib/db/role-env.js";
import { createVerifiedPgBossDatabase } from "../worker/pgboss-database.js";

const QUEUE_NAME = "calculation.execute";
const OFFER_PDF_QUEUE_NAME = "pdf.render";
const OFFER_RELEASE_CANDIDATE_QUEUE_NAME = "offer.release-candidate.render";
const BOOTSTRAP_LOCK = [1701734769, 7] as const;

export const LEGACY_CALCULATION_QUEUE_OPTIONS = Object.freeze({
  policy: "exclusive" as const,
  retryLimit: 0,
  expireInSeconds: 900,
});

export const OFFER_PDF_QUEUE_OPTIONS = Object.freeze({
  policy: "exclusive" as const,
  retryLimit: 10,
  retryDelay: 1,
  retryBackoff: true,
  retryDelayMax: 60,
  expireInSeconds: 180,
});

export const OFFER_RELEASE_CANDIDATE_QUEUE_OPTIONS = Object.freeze({
  policy: "exclusive" as const,
  retryLimit: 10,
  retryDelay: 1,
  retryBackoff: true,
  retryDelayMax: 60,
  expireInSeconds: 180,
});

type QueueContractRow = {
  policy: string;
  retry_limit: number;
  retry_delay: number;
  retry_backoff: boolean;
  retry_delay_max: number | null;
  expire_seconds: number;
  notify: boolean;
};

export type CalculationQueueBootstrapSnapshot = {
  schemaVersion: number;
  queue: QueueContractRow | null;
  dispatchFunctionDefinition: string | null;
  queuedJobCount: number;
};

export type CalculationQueueBootstrapAction =
  | "create_legacy"
  | "repair_premature_current_to_legacy"
  | "keep_legacy"
  | "keep_current";

export class CalculationQueueBootstrapError extends Error {
  constructor(public readonly code: "calculation_queue_bootstrap_drift") {
    super("calculation.execute bootstrap contract drifted");
    this.name = "CalculationQueueBootstrapError";
  }
}

function isLegacyQueue(queue: QueueContractRow | null): boolean {
  return queue !== null
    && queue.policy === "exclusive"
    && queue.retry_limit === 0
    && queue.expire_seconds === 900
    && queue.notify === false;
}

function isCurrentQueue(queue: QueueContractRow | null): boolean {
  return queue !== null
    && queue.policy === "exclusive"
    && queue.retry_limit === 10
    && queue.retry_delay === 1
    && queue.retry_backoff === true
    && queue.retry_delay_max === 60
    && queue.expire_seconds === 900
    && queue.notify === false;
}

/**
 * 0025 und 0026 sind unveränderliche Historie und erwarten die initiale
 * Queue mit retry_limit=0. Erst 0029 hebt technische Vor-Claim-Retries auf 10.
 * Die Funktionsdefinition ist der worker-lesbare, migrationsgebundene Marker;
 * der Bootstrap benötigt keinerlei Zugriff auf das Drizzle-Journal.
 */
export function classifyCalculationQueueBootstrap(
  snapshot: CalculationQueueBootstrapSnapshot,
): CalculationQueueBootstrapAction {
  if (snapshot.schemaVersion !== 38) {
    throw new CalculationQueueBootstrapError("calculation_queue_bootstrap_drift");
  }
  const definition = snapshot.dispatchFunctionDefinition
    ?.replace(/\s+/gu, " ")
    .toLowerCase() ?? null;
  const expectsLegacy = definition?.includes("queue_config.retry_limit <> 0") === true;
  const expectsCurrent = definition?.includes("queue_config.retry_limit <> 10") === true;

  if (definition === null) {
    if (snapshot.queue === null) return "create_legacy";
    if (isLegacyQueue(snapshot.queue)) return "keep_legacy";
    if (isCurrentQueue(snapshot.queue) && snapshot.queuedJobCount === 0) {
      return "repair_premature_current_to_legacy";
    }
    throw new CalculationQueueBootstrapError("calculation_queue_bootstrap_drift");
  }

  if (expectsLegacy !== expectsCurrent) {
    if (expectsLegacy && isLegacyQueue(snapshot.queue)) return "keep_legacy";
    if (expectsCurrent && isCurrentQueue(snapshot.queue)) return "keep_current";
  }
  throw new CalculationQueueBootstrapError("calculation_queue_bootstrap_drift");
}

async function readBootstrapSnapshot(
  database: ReturnType<typeof createVerifiedPgBossDatabase>,
): Promise<CalculationQueueBootstrapSnapshot> {
  const result = await database.executeSql(`
    select (
             select pg_catalog.max(version)::int from pgboss.version
           ) as schema_version,
           case
             when routine.oid is null then null
             else pg_catalog.pg_get_functiondef(routine.oid)
           end as dispatch_function_definition,
           queue.policy::text,
           queue.retry_limit,
           queue.retry_delay,
           queue.retry_backoff,
           queue.retry_delay_max,
           queue.expire_seconds,
           queue.notify,
           (
             select pg_catalog.count(*)::int
               from pgboss.job job
              where job.name = '${QUEUE_NAME}'
           ) as queued_job_count
      from (select pg_catalog.to_regprocedure(
             'pgboss.enqueue_project_calculation(uuid,uuid)'
           )::oid as oid) marker
      left join pg_catalog.pg_proc routine on routine.oid = marker.oid
      left join pgboss.queue queue on queue.name = '${QUEUE_NAME}'
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new CalculationQueueBootstrapError("calculation_queue_bootstrap_drift");
  }
  const hasQueue = row.policy !== null && row.policy !== undefined;
  const schemaVersion = Number(row.schema_version);
  const queuedJobCount = Number(row.queued_job_count);
  if (
    !Number.isSafeInteger(schemaVersion)
    || !Number.isSafeInteger(queuedJobCount)
    || queuedJobCount < 0
  ) {
    throw new CalculationQueueBootstrapError("calculation_queue_bootstrap_drift");
  }
  return {
    schemaVersion,
    dispatchFunctionDefinition:
      typeof row.dispatch_function_definition === "string"
        ? row.dispatch_function_definition
        : null,
    queuedJobCount,
    queue: hasQueue
      ? {
          policy: String(row.policy),
          retry_limit: Number(row.retry_limit),
          retry_delay: Number(row.retry_delay),
          retry_backoff: row.retry_backoff === true,
          retry_delay_max:
            row.retry_delay_max === null ? null : Number(row.retry_delay_max),
          expire_seconds: Number(row.expire_seconds),
          notify: row.notify === true,
        }
      : null,
  };
}

export async function bootstrapCalculationQueue(
  connectionString: string,
): Promise<CalculationQueueBootstrapAction> {
  let asynchronousFailure: Error | undefined;
  const database = createVerifiedPgBossDatabase(
    connectionString,
    1,
    (error) => { asynchronousFailure ??= error; },
  );
  const boss = new PgBoss({ db: database, schema: "pgboss", createSchema: false });
  boss.on("error", (error) => {
    asynchronousFailure ??= error instanceof Error ? error : new Error(String(error));
  });

  let started = false;
  let locked = false;
  try {
    await boss.start();
    started = true;
    await database.executeSql(
      "select pg_catalog.pg_advisory_lock($1::int, $2::int)",
      [...BOOTSTRAP_LOCK],
    );
    locked = true;
    if (asynchronousFailure) {
      throw new CalculationQueueBootstrapError("calculation_queue_bootstrap_drift");
    }

    const before = await readBootstrapSnapshot(database);
    const action = classifyCalculationQueueBootstrap(before);
    if (action === "create_legacy" || action === "repair_premature_current_to_legacy") {
      await boss.createQueue(QUEUE_NAME, LEGACY_CALCULATION_QUEUE_OPTIONS);
      const after = await readBootstrapSnapshot(database);
      if (classifyCalculationQueueBootstrap(after) !== "keep_legacy") {
        throw new CalculationQueueBootstrapError("calculation_queue_bootstrap_drift");
      }
    }
    // M2-02 besitzt keine historische Zwischenmigration: Die Queue kann von
    // Anfang an mit dem aktuellen technischen Retry-Vertrag angelegt werden.
    // Fachliche Versuche bleiben davon getrennt und werden in
    // offer_pdf_draft per Lease/CAS auf drei begrenzt.
    await boss.createQueue(OFFER_PDF_QUEUE_NAME, OFFER_PDF_QUEUE_OPTIONS);
    const pdfQueue = await database.executeSql(`
      select policy::text, retry_limit, retry_delay, retry_backoff,
             retry_delay_max, expire_seconds, notify
        from pgboss.queue
       where name = '${OFFER_PDF_QUEUE_NAME}'
    `);
    const pdf = pdfQueue.rows[0] as Record<string, unknown> | undefined;
    if (
      pdf === undefined
      || pdf.policy !== "exclusive"
      || Number(pdf.retry_limit) !== 10
      || Number(pdf.retry_delay) !== 1
      || pdf.retry_backoff !== true
      || Number(pdf.retry_delay_max) !== 60
      || Number(pdf.expire_seconds) !== 180
      || pdf.notify !== false
    ) {
      throw new CalculationQueueBootstrapError("calculation_queue_bootstrap_drift");
    }
    // M2-03a uses an independent queue because its input, template and
    // completion state are deliberately distinct from the internal M2-02
    // preview. Domain attempts remain limited to three by its own lease/CAS.
    await boss.createQueue(
      OFFER_RELEASE_CANDIDATE_QUEUE_NAME,
      OFFER_RELEASE_CANDIDATE_QUEUE_OPTIONS,
    );
    const releaseQueue = await database.executeSql(`
      select policy::text, retry_limit, retry_delay, retry_backoff,
             retry_delay_max, expire_seconds, notify
        from pgboss.queue
       where name = '${OFFER_RELEASE_CANDIDATE_QUEUE_NAME}'
    `);
    const release = releaseQueue.rows[0] as Record<string, unknown> | undefined;
    if (
      release === undefined
      || release.policy !== "exclusive"
      || Number(release.retry_limit) !== 10
      || Number(release.retry_delay) !== 1
      || release.retry_backoff !== true
      || Number(release.retry_delay_max) !== 60
      || Number(release.expire_seconds) !== 180
      || release.notify !== false
    ) {
      throw new CalculationQueueBootstrapError("calculation_queue_bootstrap_drift");
    }
    if (asynchronousFailure) {
      throw new CalculationQueueBootstrapError("calculation_queue_bootstrap_drift");
    }
    return action;
  } finally {
    if (locked) {
      await database.executeSql(
        "select pg_catalog.pg_advisory_unlock($1::int, $2::int)",
        [...BOOTSTRAP_LOCK],
      ).catch(() => undefined);
    }
    if (started) {
      await boss.stop({ graceful: false, close: false }).catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const connectionString = requireServiceDatabaseUrl("POSTGRES_URL_WORKER", "app_worker");
    const action = await bootstrapCalculationQueue(connectionString);
    console.log(`[pgboss-bootstrap] calculation.execute: ${action}`);
  } catch (error) {
    const code = error instanceof CalculationQueueBootstrapError
      ? error.code
      : "calculation_queue_bootstrap_failed";
    console.error(`[pgboss-bootstrap] ${code}`);
    process.exitCode = 1;
  }
}
