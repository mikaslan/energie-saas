import { startEmbeddedPostgres } from "../tests/setup/embedded-postgres";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
const embedded = await startEmbeddedPostgres();
const host = embedded.url.replace(/^postgres:\/\//, "").split("/")[0];
const dbName = new URL(embedded.url).pathname.slice(1);
execFileSync("npx", ["tsx", "scripts/migrate.mts"], {
  env: { ...process.env, DB_ROLE_MODE: "strict", POSTGRES_URL_MIGRATE: `postgres://app_migrator:mig@${host}/${dbName}` },
  stdio: "inherit",
});
const p = new Pool({ connectionString: embedded.url });
const r = await p.query("select id, hash, created_at::text from drizzle.__drizzle_migrations order by id desc limit 4");
console.log(JSON.stringify(r.rows, null, 1));
