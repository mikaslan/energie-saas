export class LeadSourceNotFoundError extends Error {
  constructor(public readonly leadSourceId: string) {
    super(`lead_source not found: ${leadSourceId}`);
    this.name = "LeadSourceNotFoundError";
  }
}

export class LeadSourceConflictError extends Error {
  constructor(public readonly name: string) {
    super(`lead_source name conflict: ${name}`);
    this.name = "LeadSourceConflictError";
  }
}

export class LeadSourceValidationError extends Error {
  constructor(message = "lead_source validation failed") {
    super(message);
    this.name = "LeadSourceValidationError";
  }
}
