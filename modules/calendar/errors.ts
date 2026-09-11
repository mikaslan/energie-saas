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

export class AppointmentTemplateNotFoundError extends Error {
  constructor() {
    super("appointment template was not found");
    this.name = "AppointmentTemplateNotFoundError";
  }
}

export class AppointmentTemplateConflictError extends Error {
  constructor() {
    super("appointment template name is taken");
    this.name = "AppointmentTemplateConflictError";
  }
}

export class AppointmentTemplateValidationError extends Error {
  constructor() {
    super("appointment template command is invalid");
    this.name = "AppointmentTemplateValidationError";
  }
}
