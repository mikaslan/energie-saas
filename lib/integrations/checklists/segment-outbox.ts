import { z } from "zod";

// F7-04c Segment-Outbox: reine Replay-Planung (kein DB-Zugriff, kein I/O).
// Die Sync-Komponente entscheidet gegen den jeweils aktuellen Server-Stand
// (Props nach Revalidierung); nie gegen Queue-alte Versionen.

export const segmentOutboxEntrySchema = z.strictObject({
  workspaceId: z.string().min(1).max(120),
  projectId: z.string().min(1).max(120),
  checklistId: z.string().min(1).max(120),
  segmentId: z.string().min(1).max(120),
  queuedAt: z.string().min(1).max(120),
});
export type SegmentOutboxEntry = z.infer<typeof segmentOutboxEntrySchema>;

export const segmentSyncStateSchema = z.strictObject({
  segmentId: z.string().min(1).max(120),
  name: z.string().min(1).max(300),
  completedAt: z.string().nullable(),
});
export type SegmentSyncState = z.infer<typeof segmentSyncStateSchema>;

export function segmentOutboxKey(checklistId: string, segmentId: string): string {
  return `${checklistId}:${segmentId}`;
}

export interface SegmentSyncPlan {
  replay: Array<{ entry: SegmentOutboxEntry; baseVersion: number }>;
  alreadyDone: SegmentOutboxEntry[];
  missing: SegmentOutboxEntry[];
}

// Entscheidungsregel: fehlend/verworfen zuerst, abgeschlossene nie
// anfassen (kein Overwrite fremder oder eigener Evidenz), Rest mit der
// aktuellen Version replayen. Rundenbegrenzung lebt in der Komponente.
export function planSegmentSync(
  entries: readonly SegmentOutboxEntry[],
  segments: readonly SegmentSyncState[],
  version: number,
): SegmentSyncPlan {
  const byId = new Map(segments.map((segment) => [segment.segmentId, segment]));
  const plan: SegmentSyncPlan = { replay: [], alreadyDone: [], missing: [] };
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = segmentOutboxKey(entry.checklistId, entry.segmentId);
    if (seen.has(key)) continue;
    seen.add(key);
    const current = byId.get(entry.segmentId);
    if (!current) {
      plan.missing.push(entry);
    } else if (current.completedAt !== null) {
      plan.alreadyDone.push(entry);
    } else {
      plan.replay.push({ entry, baseVersion: version });
    }
  }
  return plan;
}
