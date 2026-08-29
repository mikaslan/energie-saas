import { writeAudit } from "./audit";
import { withSessionTenant, withTenant } from "./db/tenant";
import type { TenantTx } from "./db/types";
import { PermissionDeniedError, WORKSPACE_ACCESS, type DeniedAction, type ServiceCtx } from "./permissions";
import { getSessionUser } from "./session";

export class NotAuthenticatedError extends Error {
  constructor() {
    super("not authenticated");
    this.name = "NotAuthenticatedError";
  }
}

async function captureUnverifiedWorkspaceAccess(input: {
  authUserId: string;
  workspaceId: string;
  action: DeniedAction;
  resource: string;
}): Promise<void> {
  if (!process.env.SENTRY_DSN) return;

  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureMessage("workspace access denied without membership", {
      level: "warning",
      extra: input,
    });
  } catch {
    // Sentry ist nur System-Beobachtung. Ein Monitoring-Ausfall darf den
    // eigentlichen PermissionDeniedError nicht ueberdecken.
  }
}

export async function authorizedAction<T>(
  workspaceId: string,
  action: DeniedAction,
  resource: string,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    // Ohne Session fehlt ein belastbarer Akteur; ein Audit auf die Request-UUID
    // wäre nur ein authentifizierungsloser Audit-Spam-Vektor.
    throw new NotAuthenticatedError();
  }

  let verifiedActor: string | undefined;
  try {
    return await withSessionTenant(sessionUser.authUserId, workspaceId, async (tx, ctx) => {
      verifiedActor = ctx.actor;
      return fn(tx, ctx);
    });
  } catch (error) {
    if (!(error instanceof PermissionDeniedError)) {
      throw error;
    }

    const boundaryDenied = error.action === WORKSPACE_ACCESS;
    if (boundaryDenied) {
      // Ohne verifizierten Bezug zwischen Akteur und Workspace ist ein
      // Tenant-Audit kein Nachweis, sondern ein vom Angreifer beschreibbares
      // Feld in einer append-only-Tabelle. Das ist dieselbe Logik wie beim
      // Fall ohne Session: nicht in audit_log schreiben, aber als
      // System-Sicherheitsereignis beobachten.
      await captureUnverifiedWorkspaceAccess({
        authUserId: sessionUser.authUserId,
        workspaceId,
        action,
        resource,
      });
      throw error;
    }

    // Service-Denials laufen erst nach gebautem ctx. Falls ein Service den
    // Actor im Fehler vergisst, bleibt der bereits verifizierte ctx.actor der
    // einzige Fallback; die auth_user.id gehoert nicht in den Tenant-Audit.
    const actor = error.actor ?? verifiedActor;
    if (!actor) throw error;

    await withTenant(workspaceId, (tx) =>
      writeAudit(tx, {
        workspaceId,
        actor,
        action: error.action,
        resource: error.resource,
        allowed: false,
        details: { reason: error.reason ?? "denied" },
      }),
    );

    throw error;
  }
}
