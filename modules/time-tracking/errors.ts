export class TimeTrackingNotFoundError extends Error {
  constructor(public readonly resource: string, public readonly id: string) {
    super(`time tracking resource not found: ${resource} ${id}`);
    this.name = "TimeTrackingNotFoundError";
  }
}

export class TimeTrackingConflictError extends Error {
  constructor(public readonly name: string) {
    super(`time event type name conflict: ${name}`);
    this.name = "TimeTrackingConflictError";
  }
}

export class TimeTrackingValidationError extends Error {
  constructor(message = "time tracking validation failed") {
    super(message);
    this.name = "TimeTrackingValidationError";
  }
}
