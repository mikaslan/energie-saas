export class ContactValidationError extends Error {
  constructor() {
    super("contact update command is invalid");
    this.name = "ContactValidationError";
  }
}

export class ContactNotFoundError extends Error {
  constructor() {
    super("contact was not found");
    this.name = "ContactNotFoundError";
  }
}

export class ContactConflictError extends Error {
  constructor(public readonly currentRevision?: number) {
    super("contact revision is stale");
    this.name = "ContactConflictError";
  }
}

export class ContactDeletedError extends Error {
  constructor() {
    super("contact is deleted");
    this.name = "ContactDeletedError";
  }
}
