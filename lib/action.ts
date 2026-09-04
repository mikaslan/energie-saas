import type { Pool } from "pg";
import { writeAudit } from "./audit";
import { runTokenCapsule, withSessionTenant, withTenant } from "./db/tenant";
import type { TenantTx } from "./db/types";
import {
  PermissionDeniedError,
  WORKSPACE_ACCESS,
  type Action,
  type DeniedAction,
  type ServiceCtx,
} from "./permissions";
import { getSessionUser } from "./session";
import type { VerifiedRechnerIdentity } from "./integrations/rechner/signature";

export class NotAuthenticatedError extends Error {
  constructor() {
    super("not authenticated");
    this.name = "NotAuthenticatedError";
  }
}

export function verifiedRechnerIntakeAction<T>(
  identity: VerifiedRechnerIdentity,
  fn: (tx: TenantTx, identity: VerifiedRechnerIdentity) => Promise<T>,
): Promise<T> {
  // Eine Integration ist weder Nutzer noch Workspace-Mitglied und bekommt
  // daher keinen kuenstlichen ServiceCtx. Das opaque Brand des erfolgreichen
  // HMAC-Verifiers bleibt bis in den Fachservice erhalten.
  return withTenant(identity.workspaceId, (tx) => fn(tx, identity));
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

async function authorizedCall<T>(
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

export function authorizedAction<T>(
  workspaceId: string,
  action: DeniedAction,
  resource: string,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  return authorizedCall(workspaceId, action, resource, fn);
}

/**
 * Offer mutations use a committed, content-free admission transaction before
 * the normal domain transaction. This is intentionally a separate boundary:
 * validation, replay, conflict, fine-grained denial, or a domain rollback can
 * never erase the attempt that was already admitted.
 */
export async function authorizedOfferMutationAction<T>(
  workspaceId: string,
  requiredActions: Action | readonly [Action, ...Action[]],
  resource: string,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  const actions = typeof requiredActions === "string"
    ? [requiredActions]
    : [...requiredActions];
  const primaryAction = actions[0];
  if (!primaryAction) throw new TypeError("offer mutation requires an action");
  const sessionUser = await getSessionUser();
  if (!sessionUser) throw new NotAuthenticatedError();

  // Keep the offer-only, server-marked admission module behind the offer
  // mutation boundary. General actions and their Client Component facades
  // import this module as well; eagerly pulling in `server-only` there would
  // make unrelated UI/build imports fail before an offer mutation is called.
  const {
    OfferRateLimitError,
    reserveOfferMutationAttempt,
  } = await import("./integrations/offers/admission");

  let admission;
  try {
    admission = await withSessionTenant(
      sessionUser.authUserId,
      workspaceId,
      (tx, ctx) => reserveOfferMutationAttempt(tx, ctx, actions),
    );
  } catch (error) {
    if (error instanceof PermissionDeniedError && error.action === WORKSPACE_ACCESS) {
      await captureUnverifiedWorkspaceAccess({
        authUserId: sessionUser.authUserId,
        workspaceId,
        action: primaryAction,
        resource,
      });
    }
    throw error;
  }

  if (admission.status === "rate_limited") {
    throw new OfferRateLimitError(admission.retryAfter);
  }
  if (admission.status === "denied") {
    const error = new PermissionDeniedError(
      admission.action,
      resource,
      admission.reason,
      admission.actor,
    );
    await withTenant(workspaceId, (tx) =>
      writeAudit(tx, {
        workspaceId,
        actor: admission.actor,
        action: admission.action,
        resource,
        allowed: false,
        details: { reason: admission.reason },
      }),
    );
    throw error;
  }

  // Re-resolve the session identity and membership in the domain transaction.
  return authorizedCall(workspaceId, primaryAction, resource, fn);
}

// Server-Component-/DAL-Grenze für autorisierte Reads. Sie teilt absichtlich
// exakt dieselbe Session→Identity→Membership-Auflösung und denselben
// Denial-Audit-Vertrag mit Server Actions: ein Render-Gate allein ist keine
// Sicherheitsgrenze, und die Workspace-UUID aus der Route bleibt untrusted.
export function authorizedQuery<T>(
  workspaceId: string,
  action: DeniedAction,
  resource: string,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  return authorizedCall(workspaceId, action, resource, fn);
}

// Öffentliche Token-Grenze (F10.1): einzige legale Aufrufgrenze für
// SECURITY-DEFINER-Token-Kapseln ohne Mandantenkontext. Keine Session, keine
// Capability — die Autorisierung ist allein das hoch-entropische Token.
// Der Pool wird direkt an die Modul-Funktion durchgereicht; Tabellen-Queries
// ausserhalb von DEFINER-Kapseln sind dem Aufrufer weiterhin unmoeglich.
export function publicTokenCapsule<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  return runTokenCapsule(fn);
}
