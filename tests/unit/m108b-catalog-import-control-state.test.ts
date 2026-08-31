import { describe, expect, it } from "vitest";

import {
  selectCatalogImportActionState,
} from "@/app/w/[workspaceId]/katalog/importe/[importId]/import-control-state";

const denied = { status: "denied" } as const;
const started = { status: "success", state: "queued", replayed: false } as const;
const cancelled = {
  status: "success",
  state: "cancelled_before_start",
  replayed: false,
} as const;

describe("M108B catalog import control feedback", () => {
  it("zeigt nur das Ergebnis der zuletzt gestarteten Operation", () => {
    expect(selectCatalogImportActionState({
      lastOperation: "start",
      startState: started,
      cancelState: denied,
      startPending: false,
      cancelPending: false,
    })).toBe(started);
    expect(selectCatalogImportActionState({
      lastOperation: "cancel",
      startState: denied,
      cancelState: cancelled,
      startPending: false,
      cancelPending: false,
    })).toBe(cancelled);
  });

  it("blendet alte Meldungen während der aktiven Operation aus", () => {
    expect(selectCatalogImportActionState({
      lastOperation: "start",
      startState: denied,
      cancelState: cancelled,
      startPending: true,
      cancelPending: false,
    })).toEqual({ status: "idle" });
    expect(selectCatalogImportActionState({
      lastOperation: "cancel",
      startState: started,
      cancelState: denied,
      startPending: false,
      cancelPending: true,
    })).toEqual({ status: "idle" });
  });
});
