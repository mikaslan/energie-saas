export class WorkerStartupCancelledError extends Error {
  readonly code = "worker_startup_cancelled" as const;

  constructor() {
    super("worker startup was cancelled");
  }
}

export type WorkerStartupGate = {
  requestShutdown(): void;
  assertOpen(): void;
  readonly shutdownRequested: boolean;
};

export function createWorkerStartupGate(): WorkerStartupGate {
  let requested = false;
  return {
    requestShutdown() {
      requested = true;
    },
    assertOpen() {
      if (requested) throw new WorkerStartupCancelledError();
    },
    get shutdownRequested() {
      return requested;
    },
  };
}
