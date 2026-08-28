import { auditLog } from "./db/schema";
import type { TenantTx } from "./db/tenant";

// ═══════════════════════════════════════════════════════════════════════
// WICHTIG — Transaktionsgrenzen-Vertrag für writeAudit (Controller-Ruling):
//
// writeAudit(tx, ...) schreibt IN der übergebenen Transaktion. Das ist
// korrekt für Audits ERFOLGREICHER Mutationen (allowed: true) — der
// Audit-Eintrag committet zusammen mit der fachlichen Änderung, oder beide
// rollen gemeinsam zurück.
//
// Für ABGELEHNTE Zugriffe (allowed: false) gilt das NICHT: Services dürfen
// einen Denial-Audit NIEMALS in der eigenen (dann aussterbenden) Transaktion
// schreiben, bevor sie werfen — ein writeAudit(tx, { allowed: false, ... })
// gefolgt von throw würde mit dem abgebrochenen tx zusammen zurückgerollt
// und wäre spurlos verschwunden, obwohl gerade die Ablehnung dokumentiert
// werden sollte.
//
// Ruling: Services schreiben KEINEN Denial-Audit in-tx. Sie werfen einen
// typisierten Fehler; die AUFRUFGRENZE (der Caller, der die Transaktion
// geöffnet hat bzw. den Abort sieht) schreibt den Denial-Audit in einer
// EIGENEN, NEUEN Transaktion NACH dem Abort. Savepoints lösen das Problem
// NICHT (ein Savepoint-Rollback nimmt einen zuvor darin geschriebenen
// Audit-Eintrag ebenso mit — das Problem ist nicht die Verschachtelungstiefe,
// sondern dass JEDE Transaktion, die abbricht, alles innerhalb von ihr
// mitreißt).
//
// Dieses Boundary-Pattern wird in lib/action.ts vollzogen — writeAudit hier
// bleibt bewusst ein simpler, transaktionsloser Baustein ohne eigene
// Entscheidung darüber, WANN/WESSEN Transaktion er nutzt. Diese Entscheidung
// liegt beim Aufrufer.
// ═══════════════════════════════════════════════════════════════════════

// Auch ABGELEHNTE Zugriffe (allowed: false) landen hier (Architektur §4) —
// writeAudit trifft dazu keine eigene Entscheidung, das ist Sache des
// Aufrufers (z. B. eines Autorisierungs-Guards). Siehe Transaktionsgrenzen-
// Vertrag oben: bei allowed: false MUSS der Aufrufer eine eigene, neue
// Transaktion nach einem Abort verwenden, nicht das hier übergebene tx.
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
