export class DiscountTemplateNotFoundError extends Error {
  constructor(public readonly templateId: string) {
    super(`discount template not found: ${templateId}`);
    this.name = "DiscountTemplateNotFoundError";
  }
}

export class DiscountTemplateConflictError extends Error {
  constructor(public readonly detail: number | string) {
    super(`discount template conflict: ${detail}`);
    this.name = "DiscountTemplateConflictError";
  }
}

export class DiscountTemplateValidationError extends Error {
  constructor(message = "discount template validation failed") {
    super(message);
    this.name = "DiscountTemplateValidationError";
  }
}
