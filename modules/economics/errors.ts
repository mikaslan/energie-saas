export class EconomicsValidationError extends Error {
  constructor() {
    super("economics settings input is invalid");
    this.name = "EconomicsValidationError";
  }
}

export class EconomicsNotFoundError extends Error {
  constructor() {
    super("economics settings were not found");
    this.name = "EconomicsNotFoundError";
  }
}

export class EconomicsConflictError extends Error {
  constructor(public readonly currentRevision?: number) {
    super("economics settings revision is stale");
    this.name = "EconomicsConflictError";
  }
}
