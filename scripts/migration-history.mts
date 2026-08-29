import { readMigrationFiles } from "drizzle-orm/migrator";
import type { PoolClient, QueryResultRow } from "pg";

interface AppliedMigrationRow extends QueryResultRow {
  created_at: string;
  hash: string;
}

export interface VerifiedMigrationHistory {
  appliedCount: number;
  localCount: number;
  appliedCreatedAt: readonly string[];
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
    select created_at::text, hash
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
