import { auditLog } from "./db/schema";
import type { TenantTx } from "./db/tenant";

// Auch ABGELEHNTE Zugriffe (allowed: false) landen hier (Architektur §4) —
// writeAudit trifft dazu keine eigene Entscheidung, das ist Sache des
// Aufrufers (z. B. eines Autorisierungs-Guards).
export async function writeAudit(
  tx: TenantTx,
  a: {
    workspaceId: string;
    actor: string;
    action: string;
    resource: string;
    allowed: boolean;
    details?: unknown;
  },
): Promise<void> {
  await tx.insert(auditLog).values({ ...a, details: a.details ?? {} });
}
