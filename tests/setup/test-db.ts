import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/lib/db/schema";
import { createDrainTrackedPool } from "./pg-pool-drain";

export const testPool = createDrainTrackedPool({
  connectionString: process.env.POSTGRES_URL_TEST,
});
export const testDb = drizzle(testPool, { schema });
