import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/lib/db/schema";

export const testPool = new Pool({ connectionString: process.env.POSTGRES_URL_TEST });
export const testDb = drizzle(testPool, { schema });
