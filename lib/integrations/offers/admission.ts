import "server-only";

import { sql } from "drizzle-orm";
import type { TenantTx } from "@/lib/db/types";
import { can, isExternalOnly, type Action, type ServiceCtx } from "@/lib/permissions";

export class OfferRateLimitError extends Error {
  constructor(public readonly retryAfter: string) {
    super("offer mutation rate limited");
    this.name = "OfferRateLimitError";
  }
}

export type OfferMutationAdmission =
  | { status: "admitted"; actor: string }
  | { status: "denied"; actor: string; action: Action; reason: string }
  | { status: "rate_limited"; actor: string; retryAfter: string };

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("invalid offer admission clock");
  return parsed.toISOString();
}

/**
 * Reserve one authenticated offer-mutation attempt.
 *
 * The caller MUST run this in its own membership-authenticated transaction
 * and MUST commit the returned result before it throws a denial/rate error or
 * opens the domain transaction. Returning a status instead of throwing is
 * deliberate: actor attempts survive coarse permission denials and an
 * exhausted workspace quota.
 */
export async function reserveOfferMutationAttempt(
  tx: TenantTx,
  ctx: ServiceCtx,
  coarseActions: Action | readonly Action[],
): Promise<OfferMutationAdmission> {
  const requiredActions = typeof coarseActions === "string"
    ? [coarseActions]
    : [...coarseActions];
  const primaryAction = requiredActions[0];
  if (!primaryAction) throw new Error("offer admission requires an action");
  // All callers take locks in this global order. The clock is captured only
  // after both locks, so a waiter crossing a UTC quarter-hour is charged to
  // the window in which it actually acquires admission.
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(
      ${`offer-rate:workspace:${ctx.workspaceId}`}, 0
    ))
  `);
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(
      ${`offer-rate:actor:${ctx.workspaceId}:${ctx.actor}`}, 0
    ))
  `);
  const clock = await tx.execute<{
    database_now: Date | string;
    window_start: Date | string;
    retry_after: Date | string;
    [key: string]: unknown;
  }>(sql`
    with captured as materialized (
      select clock_timestamp() as database_now
    )
    select database_now,
           date_bin(
             interval '15 minutes', database_now,
             timestamptz '1970-01-01 00:00:00+00'
           ) as window_start,
           date_bin(
             interval '15 minutes', database_now,
             timestamptz '1970-01-01 00:00:00+00'
           ) + interval '15 minutes' as retry_after
      from captured
  `);
  const current = clock.rows[0];
  if (!current) throw new Error("offer admission clock unavailable");

  const actorAttempt = await tx.execute<{ attempts: number; [key: string]: unknown }>(sql`
    insert into offer_mutation_rate_window (
      workspace_id, scope, actor_id, window_start, attempts,
      created_at, updated_at
    ) values (
      ${ctx.workspaceId}::uuid, 'actor', ${ctx.actor}::uuid,
      ${current.window_start}::timestamptz, 1,
      ${current.database_now}::timestamptz, ${current.database_now}::timestamptz
    )
    on conflict (workspace_id, actor_id, window_start) where scope = 'actor'
    do update set attempts = offer_mutation_rate_window.attempts + 1,
                  updated_at = ${current.database_now}::timestamptz
      where offer_mutation_rate_window.attempts < 120
    returning attempts
  `);
  if (!actorAttempt.rows[0]) {
    return {
      status: "rate_limited",
      actor: ctx.actor,
      retryAfter: iso(current.retry_after),
    };
  }

  if (isExternalOnly(ctx)) {
    return {
      status: "denied",
      actor: ctx.actor,
      action: primaryAction,
      reason: "external_only_without_assignment",
    };
  }
  for (const requiredAction of requiredActions) {
    if (!can(ctx, requiredAction)) {
      return {
        status: "denied",
        actor: ctx.actor,
        action: requiredAction,
        reason: "capability",
      };
    }
  }

  const workspaceAttempt = await tx.execute<{ attempts: number; [key: string]: unknown }>(sql`
    insert into offer_mutation_rate_window (
      workspace_id, scope, actor_id, window_start, attempts,
      created_at, updated_at
    ) values (
      ${ctx.workspaceId}::uuid, 'workspace', null,
      ${current.window_start}::timestamptz, 1,
      ${current.database_now}::timestamptz, ${current.database_now}::timestamptz
    )
    on conflict (workspace_id, window_start) where scope = 'workspace'
    do update set attempts = offer_mutation_rate_window.attempts + 1,
                  updated_at = ${current.database_now}::timestamptz
      where offer_mutation_rate_window.attempts < 1200
    returning attempts
  `);
  if (!workspaceAttempt.rows[0]) {
    return {
      status: "rate_limited",
      actor: ctx.actor,
      retryAfter: iso(current.retry_after),
    };
  }
  return { status: "admitted", actor: ctx.actor };
}
