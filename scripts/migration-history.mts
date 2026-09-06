import { readMigrationFiles } from "drizzle-orm/migrator";
import type { PoolClient, QueryResultRow } from "pg";

interface AppliedMigrationRow extends QueryResultRow {
  id: number;
  created_at: string;
  hash: string;
}

const SNAPSHOT_V3_MIGRATION_INDEX = 66;
const LEGACY_SNAPSHOT_V3_CREATED_AT = "1788565894444";
const CANONICAL_SNAPSHOT_V3_CREATED_AT = "1788567623493";
const SNAPSHOT_V3_SHA256 =
  "d95c615f131572c12008cc42bcd0d5cce663c3a2a30d255f16fbb3394994e98d";

interface LegacyMigrationCanonicalizationBase {
  journalRowId: number;
  migrationIndex: typeof SNAPSHOT_V3_MIGRATION_INDEX;
  hash: typeof SNAPSHOT_V3_SHA256;
  toCreatedAt: typeof CANONICAL_SNAPSHOT_V3_CREATED_AT;
}

export type LegacyMigrationCanonicalization =
  | LegacyMigrationCanonicalizationBase & {
      action: "timestamp_corrected";
      fromCreatedAt: typeof LEGACY_SNAPSHOT_V3_CREATED_AT;
    }
  | LegacyMigrationCanonicalizationBase & {
      action: "skipped_migration_replayed";
      previousLastMigrationIndex: number;
    };

export interface VerifiedMigrationHistory {
  appliedCount: number;
  localCount: number;
  appliedCreatedAt: readonly string[];
}

/**
 * Korrigiert genau den vor Integration entstandenen 0066-Metadatenfehler:
 *
 * - Wurde 0066 ausgeführt, darf ausschließlich sein exakter Hash vom alten
 *   auf den kanonischen Zeitstempel wechseln.
 * - Wurde 0066 wegen des alten, nicht-monotonen Zeitstempels übersprungen,
 *   muss die gesamte Historie exakt 0000..0065 + 0067..N sein. Nur dann wird
 *   exakt das lokal gepinnte 0066-SQL replayt und sein Marker eingefügt.
 *
 * Der Aufrufer muss diese Funktion unter dem globalen Migrations-Advisory-Lock
 * und zusammen mit verifyAppliedMigrationHistory() in EINER Transaktion
 * ausführen. Dadurch rollt die Korrektur bei jedem weiteren Historiendrift
 * vollständig zurück.
 *
 * Kein allgemeiner Reparaturpfad: unbekannter Hash, Zielkollision oder
 * doppelter Marker brechen fail-closed ab.
 */
export async function canonicalizeLegacySnapshotV3MigrationTimestamp(
  client: PoolClient,
  options: { migrationsFolder?: string } = {},
): Promise<LegacyMigrationCanonicalization | null> {
  const migrationsFolder = options.migrationsFolder ?? "./drizzle";
  const expected = readMigrationFiles({ migrationsFolder });
  const localMigration = expected[
    SNAPSHOT_V3_MIGRATION_INDEX
  ];
  if (
    !localMigration
    || localMigration.folderMillis !== Number(CANONICAL_SNAPSHOT_V3_CREATED_AT)
    || localMigration.hash !== SNAPSHOT_V3_SHA256
  ) {
    throw new Error(
      "Lokale Migration 0066 entspricht nicht dem gepinnten Snapshot-v3-Vertrag.",
    );
  }

  const journal = await client.query<{ journal_exists: boolean }>(`
    select pg_catalog.to_regclass('drizzle.__drizzle_migrations') is not null
      as journal_exists
  `);
  if (!journal.rows[0]?.journal_exists) return null;

  const applied = await client.query<AppliedMigrationRow>(`
    select id, created_at::text, hash
      from drizzle.__drizzle_migrations
     order by id
     for update
  `);

  const matchesExpected = (
    row: AppliedMigrationRow,
    expectedIndex: number,
    createdAtOverride?: string,
  ): boolean => {
    const expectedMigration = expected[expectedIndex];
    return expectedMigration !== undefined
      && row.hash === expectedMigration.hash
      && row.created_at === (
        createdAtOverride ?? String(expectedMigration.folderMillis)
      );
  };

  const isCanonicalPrefix = applied.rows.length <= expected.length
    && applied.rows.every((row, index) => matchesExpected(row, index));
  if (isCanonicalPrefix) return null;

  const hasExactLegacyTimestampShape =
    applied.rows.length > SNAPSHOT_V3_MIGRATION_INDEX
    && applied.rows.length <= expected.length
    && applied.rows.every((row, index) => matchesExpected(
      row,
      index,
      index === SNAPSHOT_V3_MIGRATION_INDEX
        ? LEGACY_SNAPSHOT_V3_CREATED_AT
        : undefined,
    ));

  if (hasExactLegacyTimestampShape) {
    const candidate = applied.rows[SNAPSHOT_V3_MIGRATION_INDEX]!;
    const corrected = await client.query<{ id: number }>(`
      update drizzle.__drizzle_migrations
         set created_at = $1::bigint
       where id = $2::integer
         and created_at = $3::bigint
         and hash = $4
      returning id
    `, [
      CANONICAL_SNAPSHOT_V3_CREATED_AT,
      candidate.id,
      LEGACY_SNAPSHOT_V3_CREATED_AT,
      SNAPSHOT_V3_SHA256,
    ]);
    if (corrected.rows.length !== 1) {
      throw new Error("Migration 0066 wurde waehrend der Kanonisierung veraendert.");
    }

    return {
      action: "timestamp_corrected",
      journalRowId: candidate.id,
      migrationIndex: SNAPSHOT_V3_MIGRATION_INDEX,
      hash: SNAPSHOT_V3_SHA256,
      fromCreatedAt: LEGACY_SNAPSHOT_V3_CREATED_AT,
      toCreatedAt: CANONICAL_SNAPSHOT_V3_CREATED_AT,
    };
  }

  // Eine unter dem alten Journal von 0065 auf >=0067 migrierte DB hat 0066
  // vollständig übersprungen: Position 66 entspricht dann lokalem Index 67.
  // Beliebige Lücken, Vertauschungen oder Hashabweichungen bleiben verboten.
  const hasExactSkippedMigrationShape =
    applied.rows.length > SNAPSHOT_V3_MIGRATION_INDEX
    && applied.rows.length < expected.length
    && applied.rows.every((row, position) => matchesExpected(
      row,
      position < SNAPSHOT_V3_MIGRATION_INDEX ? position : position + 1,
    ));

  if (!hasExactSkippedMigrationShape) {
    // Der unverändert strenge Verifier liefert anschließend die genaue erste
    // Abweichung. Bis dahin wurde keinerlei Journal oder Fachschema verändert.
    return null;
  }

  for (const statement of localMigration.sql) {
    await client.query(statement);
  }
  const inserted = await client.query<{ id: number }>(`
    insert into drizzle.__drizzle_migrations (hash, created_at)
    values ($1, $2::bigint)
    returning id
  `, [SNAPSHOT_V3_SHA256, CANONICAL_SNAPSHOT_V3_CREATED_AT]);
  if (inserted.rows.length !== 1) {
    throw new Error("Der replayte Marker fuer Migration 0066 fehlt.");
  }

  return {
    action: "skipped_migration_replayed",
    journalRowId: inserted.rows[0]!.id,
    migrationIndex: SNAPSHOT_V3_MIGRATION_INDEX,
    hash: SNAPSHOT_V3_SHA256,
    toCreatedAt: CANONICAL_SNAPSHOT_V3_CREATED_AT,
    previousLastMigrationIndex: applied.rows.length,
  };
}

/**
 * Beweist, dass das DB-Journal ein lückenloses und unverändertes Präfix der
 * versionierten Drizzle-Historie ist. Der Vergleich umfasst Zeitstempel und
 * Inhalts-Hash; ein bloßer Check der letzten Migration reicht nicht aus.
 */
export async function verifyAppliedMigrationHistory(
  client: PoolClient,
  options: {
    migrationsFolder?: string;
    requireJournal?: boolean;
  } = {},
): Promise<VerifiedMigrationHistory> {
  const migrationsFolder = options.migrationsFolder ?? "./drizzle";
  const journal = await client.query<{ journal_exists: boolean }>(`
    select pg_catalog.to_regclass('drizzle.__drizzle_migrations') is not null
      as journal_exists
  `);
  if (!journal.rows[0]?.journal_exists) {
    if (options.requireJournal) {
      throw new Error("Das Drizzle-Journal drizzle.__drizzle_migrations fehlt.");
    }
    const expected = readMigrationFiles({ migrationsFolder });
    return { appliedCount: 0, localCount: expected.length, appliedCreatedAt: [] };
  }

  const expected = readMigrationFiles({ migrationsFolder });
  const applied = await client.query<AppliedMigrationRow>(`
    select id, created_at::text, hash
    from drizzle.__drizzle_migrations
    order by created_at, id
  `);
  if (applied.rows.length > expected.length) {
    throw new Error("Das Migrationsjournal ist länger als die versionierte lokale Historie.");
  }

  for (const [index, migration] of applied.rows.entries()) {
    const expectedMigration = expected[index];
    if (
      !expectedMigration ||
      migration.created_at !== String(expectedMigration.folderMillis) ||
      migration.hash !== expectedMigration.hash
    ) {
      throw new Error(
        "Angewandte Migrationen müssen ein lückenloses, unverändertes Präfix der " +
          `lokalen Historie sein; Abweichung bei Journalposition ${index + 1} ` +
          `(created_at=${migration.created_at}).`,
      );
    }
  }

  return {
    appliedCount: applied.rows.length,
    localCount: expected.length,
    appliedCreatedAt: applied.rows.map((migration) => migration.created_at),
  };
}
