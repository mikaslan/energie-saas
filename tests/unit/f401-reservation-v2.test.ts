import { describe, expect, it } from "vitest";

import { reservationHashV2 } from "@/lib/integrations/calculation/reservation-v2";

// F4.1 v2-Reservation (rein): Idempotenzschluessel ueber exaktem v2-Tupel.
// Preparation-Schema/Geometrie sind Bestand (preparation-v2.ts + Contract-Test).

const ids = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  siteId: "33333333-3333-4333-8333-333333333333",
  addressRevision: 1,
  profileId: "44444444-4444-4444-8444-444444444444",
  profileRevision: 1,
  requirementId: "55555555-5555-4555-8555-555555555555",
  requirementRevision: 1,
  sourceSnapshotId: "66666666-6666-4666-8666-666666666666",
};

describe("F4.1 v2 reservation hash", () => {
  it("ist deterministisch und bindungssensitiv", () => {
    const first = reservationHashV2(ids).toString("hex");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(reservationHashV2({ ...ids }).toString("hex")).toBe(first);
    expect(reservationHashV2({ ...ids, profileRevision: 2 }).toString("hex")).not.toBe(first);
    expect(reservationHashV2({ ...ids, addressRevision: 2 }).toString("hex")).not.toBe(first);
    expect(
      reservationHashV2({ ...ids, requirementId: ids.profileId }).toString("hex"),
    ).not.toBe(first);
  });
});
