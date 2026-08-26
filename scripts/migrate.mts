import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const url = process.env.POSTGRES_URL;
if (!url) throw new Error("POSTGRES_URL ist nicht gesetzt");
const pool = new Pool({ connectionString: url, max: 1 });
await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
await pool.end();
console.log("Migrationen angewendet:", url.replace(/:[^:@/]+@/, ":***@"));
