export class PlanningSettingsValidationError extends Error {
  constructor() {
    super("planning settings input is invalid");
    this.name = "PlanningSettingsValidationError";
  }
}

export class PlanningSettingsConflictError extends Error {
  constructor(public readonly currentRevision?: number) {
    super("planning settings revision is stale");
    this.name = "PlanningSettingsConflictError";
  }
}

export class PlanningSettingsIntegrityError extends Error {
  constructor() {
    super("planning settings data is invalid");
    this.name = "PlanningSettingsIntegrityError";
  }
}

export class PlanningTemplateValidationError extends Error {
  constructor() {
    super("planning template input is invalid");
    this.name = "PlanningTemplateValidationError";
  }
}

export class PlanningTemplateConflictError extends Error {
  constructor() {
    super("planning template name is already in use");
    this.name = "PlanningTemplateConflictError";
  }
}

export class PlanningTemplateNotFoundError extends Error {
  constructor() {
    super("planning template was not found");
    this.name = "PlanningTemplateNotFoundError";
  }
}
