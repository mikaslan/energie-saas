import { describe, expect, it } from "vitest";

import {
  CalculationQueueBootstrapError,
  classifyCalculationQueueBootstrap,
  type CalculationQueueBootstrapSnapshot,
} from "../../scripts/pgboss-bootstrap.mjs";

const legacyQueue = {
  policy: "exclusive",
  retry_limit: 0,
  retry_delay: 0,
  retry_backoff: false,
  retry_delay_max: null,
  expire_seconds: 900,
  notify: false,
};

const currentQueue = {
  policy: "exclusive",
  retry_limit: 10,
  retry_delay: 1,
  retry_backoff: true,
  retry_delay_max: 60,
  expire_seconds: 900,
  notify: false,
};

function snapshot(
  overrides: Partial<CalculationQueueBootstrapSnapshot> = {},
): CalculationQueueBootstrapSnapshot {
  return {
    schemaVersion: 38,
    queue: null,
    dispatchFunctionDefinition: null,
    queuedJobCount: 0,
    ...overrides,
  };
}

describe("M1-07 pg-boss Fresh-Install-Bootstrap", () => {
  it("legt vor 0025 ausschließlich den unveränderlichen Legacy-Vertrag an", () => {
    expect(classifyCalculationQueueBootstrap(snapshot())).toBe("create_legacy");
    expect(classifyCalculationQueueBootstrap(snapshot({ queue: legacyQueue })))
      .toBe("keep_legacy");
  });

  it("repariert eine verfrüht auf Retry 10 gesetzte leere Fresh-Queue", () => {
    expect(classifyCalculationQueueBootstrap(snapshot({ queue: currentQueue })))
      .toBe("repair_premature_current_to_legacy");
    expect(() => classifyCalculationQueueBootstrap(snapshot({
      queue: currentQueue,
      queuedJobCount: 1,
    }))).toThrow(CalculationQueueBootstrapError);
  });

  it("lässt einen partiellen Stand 0025/0026 auf Retry 0", () => {
    expect(classifyCalculationQueueBootstrap(snapshot({
      queue: legacyQueue,
      dispatchFunctionDefinition: "queue_config.retry_limit <> 0",
    }))).toBe("keep_legacy");
  });

  it("stuft den wirksamen 0029-Vertrag niemals auf Retry 0 zurück", () => {
    expect(classifyCalculationQueueBootstrap(snapshot({
      queue: currentQueue,
      dispatchFunctionDefinition: "queue_config.retry_limit <> 10",
      queuedJobCount: 9,
    }))).toBe("keep_current");
  });

  it("scheitert bei Queue-/Funktionsdrift fail-closed", () => {
    for (const value of [
      snapshot({
        queue: currentQueue,
        dispatchFunctionDefinition: "queue_config.retry_limit <> 0",
      }),
      snapshot({
        queue: legacyQueue,
        dispatchFunctionDefinition: "queue_config.retry_limit <> 10",
      }),
      snapshot({
        queue: { ...currentQueue, notify: true },
        dispatchFunctionDefinition: "queue_config.retry_limit <> 10",
      }),
      snapshot({
        queue: currentQueue,
        dispatchFunctionDefinition:
          "queue_config.retry_limit <> 0 and queue_config.retry_limit <> 10",
      }),
      snapshot({ schemaVersion: 39 }),
    ]) {
      expect(() => classifyCalculationQueueBootstrap(value))
        .toThrow(CalculationQueueBootstrapError);
    }
  });
});
