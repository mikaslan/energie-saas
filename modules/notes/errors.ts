export class NoteValidationError extends Error {
  constructor() {
    super("project note command is invalid");
    this.name = "NoteValidationError";
  }
}

export class NoteNotFoundError extends Error {
  constructor() {
    super("project note was not found");
    this.name = "NoteNotFoundError";
  }
}

export class NoteConflictError extends Error {
  constructor(public readonly currentRevision?: number) {
    super("project note revision is stale");
    this.name = "NoteConflictError";
  }
}
