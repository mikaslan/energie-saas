import type { PoolClient } from "pg";

const M110_MIGRATION_CREATED_AT = "1788211758291";
export const M110_PROJECT_TASK_ACTIVITY_INDEX =
  "domain_events_project_task_activity_idx" as const;
const TASK_EVENT_TYPES = [
  "project.task_created",
  "project.task_updated",
  "project.task_checklist_changed",
  "project.task_completed",
  "project.task_reopened",
  "project.task_archived",
] as const;

export const M110_PROJECT_TASK_ACTIVITY_INDEX_SQL = `
CREATE INDEX CONCURRENTLY ${M110_PROJECT_TASK_ACTIVITY_INDEX}
ON public.domain_events USING btree (
  workspace_id,
  aggregate_id,
  occurred_at DESC NULLS FIRST,
  id DESC NULLS FIRST
)
WHERE aggregate_type = 'project'
  AND event_type IN (
    'project.task_created', 'project.task_updated',
    'project.task_checklist_changed', 'project.task_completed',
    'project.task_reopened', 'project.task_archived'
  )
`;

type IndexState = {
  indisvalid: boolean;
  indisready: boolean;
  indisunique: boolean;
  access_method: string;
  columns: string[] | string;
  options: number[] | string;
  predicate: string | null;
};

async function m110MigrationWasApplied(client: PoolClient): Promise<boolean> {
  const journal = await client.query<{ journal: string | null }>(`
    select pg_catalog.to_regclass('drizzle.__drizzle_migrations')::text as journal
  `);
  if (!journal.rows[0]?.journal) return false;
  const applied = await client.query<{ applied: boolean }>(`
    select exists (
      select 1
        from drizzle.__drizzle_migrations
       where created_at = $1::numeric
    ) as applied
  `, [M110_MIGRATION_CREATED_AT]);
  return applied.rows[0]?.applied === true;
}

async function readIndexState(client: PoolClient): Promise<IndexState | null> {
  const result = await client.query<IndexState>(`
    select index_record.indisvalid,
           index_record.indisready,
           index_record.indisunique,
           access_method.amname as access_method,
           array(
             select attribute_record.attname
               from unnest(index_record.indkey::smallint[])
                    with ordinality as key_record(attnum, position)
               join pg_catalog.pg_attribute attribute_record
                 on attribute_record.attrelid = index_record.indrelid
                and attribute_record.attnum = key_record.attnum
              order by key_record.position
           ) as columns,
           index_record.indoption::smallint[] as options,
           pg_catalog.pg_get_expr(index_record.indpred, index_record.indrelid)
             as predicate
      from pg_catalog.pg_index index_record
      join pg_catalog.pg_class index_class
        on index_class.oid = index_record.indexrelid
      join pg_catalog.pg_namespace namespace_record
        on namespace_record.oid = index_class.relnamespace
      join pg_catalog.pg_class table_class
        on table_class.oid = index_record.indrelid
      join pg_catalog.pg_am access_method
        on access_method.oid = index_class.relam
     where namespace_record.nspname = 'public'
       and index_class.relname = $1
       and table_class.relname = 'domain_events'
  `, [M110_PROJECT_TASK_ACTIVITY_INDEX]);
  return result.rows[0] ?? null;
}

function assertCanonicalIndex(state: IndexState | null): asserts state is IndexState {
  if (!state || !state.indisvalid || !state.indisready || state.indisunique) {
    throw new Error(`${M110_PROJECT_TASK_ACTIVITY_INDEX} ist nicht gültig und bereit.`);
  }
  if (state.access_method !== "btree") {
    throw new Error(`${M110_PROJECT_TASK_ACTIVITY_INDEX} verwendet nicht btree.`);
  }
  const expectedColumns = ["workspace_id", "aggregate_id", "occurred_at", "id"];
  const columns = Array.isArray(state.columns)
    ? state.columns
    : state.columns.replace(/^\{|\}$/gu, "").split(",");
  if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) {
    throw new Error(`${M110_PROJECT_TASK_ACTIVITY_INDEX} besitzt falsche Spalten.`);
  }
  // pg_index: bit 0 = DESC, bit 1 = NULLS FIRST.
  const options = Array.isArray(state.options)
    ? state.options.map(Number)
    : state.options.replace(/^\{|\}$/gu, "").split(",").map(Number);
  if (JSON.stringify(options) !== JSON.stringify([0, 0, 3, 3])) {
    throw new Error(`${M110_PROJECT_TASK_ACTIVITY_INDEX} besitzt falsche Sortoptionen.`);
  }
  const predicate = state.predicate ?? "";
  if (!predicate.includes("aggregate_type") || !predicate.includes("'project'")) {
    throw new Error(`${M110_PROJECT_TASK_ACTIVITY_INDEX} besitzt kein Project-Prädikat.`);
  }
  const eventTypes = [...new Set(
    predicate.match(/project\.task_[a-z_]+/gu) ?? [],
  )].sort();
  if (JSON.stringify(eventTypes) !== JSON.stringify([...TASK_EVENT_TYPES].sort())) {
    throw new Error(`${M110_PROJECT_TASK_ACTIVITY_INDEX} besitzt eine falsche Event-Allowlist.`);
  }
}

export async function ensureM110ProjectTaskActivityIndex(
  client: PoolClient,
): Promise<void> {
  if (!await m110MigrationWasApplied(client)) return;

  let state = await readIndexState(client);
  if (state && (!state.indisvalid || !state.indisready)) {
    await client.query(
      `DROP INDEX CONCURRENTLY IF EXISTS public.${M110_PROJECT_TASK_ACTIVITY_INDEX}`,
    );
    state = null;
  }
  if (state) {
    assertCanonicalIndex(state);
    return;
  }

  await client.query(M110_PROJECT_TASK_ACTIVITY_INDEX_SQL);
  assertCanonicalIndex(await readIndexState(client));
}
