import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";

type Db = NodePgDatabase<typeof schema>;

// Reiner Vertragstyp ohne Tenant-Einstiegsfunktionen. Fachmodule dürfen
// TenantTx annehmen, aber weder withTenant noch withAuthorizedTenant selbst
// importieren; diese Grenze erzwingt dependency-cruiser.
export type TenantTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
