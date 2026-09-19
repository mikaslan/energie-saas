export class DedupeValidationError extends Error {
  constructor(message = "dedupe command is invalid") {
    super(message);
    this.name = "DedupeValidationError";
  }
}

export class DedupeNotFoundError extends Error {
  constructor(message = "flagged dedupe entry was not found") {
    super(message);
    this.name = "DedupeNotFoundError";
  }
}

export class DedupeConflictError extends Error {
  constructor(message = "dedupe entry changed concurrently", public readonly currentRevision?: number) {
    super(message);
    this.name = "DedupeConflictError";
  }
}
