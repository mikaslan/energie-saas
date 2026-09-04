export class SubsidyTemplateNotFoundError extends Error {
  constructor(public readonly templateId: string) {
    super(`subsidy template not found: ${templateId}`);
    this.name = "SubsidyTemplateNotFoundError";
  }
}

export class SubsidyTemplateConflictError extends Error {
  constructor(public readonly detail: number | string) {
    super(`subsidy template conflict: ${detail}`);
    this.name = "SubsidyTemplateConflictError";
  }
}

export class SubsidyTemplateValidationError extends Error {
  constructor(message = "subsidy template validation failed") {
    super(message);
    this.name = "SubsidyTemplateValidationError";
  }
}
