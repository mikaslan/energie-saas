import { describe, expect, it } from "vitest";

import {
  planSegmentSync,
  segmentOutboxKey,
  type SegmentOutboxEntry,
} from "@/lib/integrations/checklists/segment-outbox";

function entry(segmentId: string): SegmentOutboxEntry {
  return {
    workspaceId: "ws",
    projectId: "project",
    checklistId: "checklist",
    segmentId,
    queuedAt: "2026-09-12T10:00:00.000Z",
  };
}

describe("F7-04c Segment-Outbox-Planer", () => {
  it("F704C-U-01: offenes Segment wird mit aktueller Version replayt", () => {
    const plan = planSegmentSync(
      [entry("seg-1")],
      [{ segmentId: "seg-1", name: "Dach", completedAt: null }],
      4,
    );
    expect(plan.replay).toEqual([{ entry: entry("seg-1"), baseVersion: 4 }]);
    expect(plan.alreadyDone).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  it("F704C-U-02: abgeschlossenes Segment wird nie angefasst", () => {
    const plan = planSegmentSync(
      [entry("seg-1")],
      [{ segmentId: "seg-1", name: "Dach", completedAt: "2026-09-12T11:00:00.000Z" }],
      7,
    );
    expect(plan.replay).toEqual([]);
    expect(plan.alreadyDone).toEqual([entry("seg-1")]);
    expect(plan.missing).toEqual([]);
  });

  it("F704C-U-03: fehlendes Segment wird verworfen", () => {
    const plan = planSegmentSync([entry("weg")], [], 2);
    expect(plan.replay).toEqual([]);
    expect(plan.alreadyDone).toEqual([]);
    expect(plan.missing).toEqual([entry("weg")]);
  });

  it("F704C-U-04: Schlüssel sind je Checkliste+Segment eindeutig", () => {
    expect(segmentOutboxKey("c", "s")).toBe("c:s");
    const plan = planSegmentSync(
      [entry("seg-1"), entry("seg-1")],
      [{ segmentId: "seg-1", name: "Dach", completedAt: null }],
      1,
    );
    expect(plan.replay).toHaveLength(1);
  });
});
