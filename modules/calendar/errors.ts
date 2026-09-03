export class AppointmentValidationError extends Error {
  constructor() {
    super("project appointment command is invalid");
    this.name = "AppointmentValidationError";
  }
}

export class AppointmentNotFoundError extends Error {
  constructor() {
    super("project appointment was not found");
    this.name = "AppointmentNotFoundError";
  }
}

export class AppointmentConflictError extends Error {
  constructor(public readonly currentRevision?: number) {
    super("project appointment revision is stale");
    this.name = "AppointmentConflictError";
  }
}
