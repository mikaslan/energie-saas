export class InvoicingValidationError extends Error {
  constructor() {
    super("invoicing input is invalid");
    this.name = "InvoicingValidationError";
  }
}

export class InvoicingNotFoundError extends Error {
  constructor() {
    super("invoicing settings were not found");
    this.name = "InvoicingNotFoundError";
  }
}

export class InvoicingConflictError extends Error {
  constructor(public readonly currentRevision?: number) {
    super("invoicing settings revision is stale");
    this.name = "InvoicingConflictError";
  }
}

export class InvoicingPreconditionConflictError extends Error {
  constructor(public readonly reason: string) {
    super(`issuing details are incomplete: ${reason}`);
    this.name = "InvoicingPreconditionConflictError";
  }
}
