import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const url = process.env.POSTGRES_URL;
if (!url) throw new Error("POSTGRES_URL ist nicht gesetzt");
export const pool = new Pool({ connectionString: url, max: 5 });
export const db = drizzle(pool, { schema });
