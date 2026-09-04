export class ChecklistNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super(`project checklist not found: ${projectId}`);
    this.name = "ChecklistNotFoundError";
  }
}

export class ChecklistConflictError extends Error {
  constructor(public readonly currentVersion?: number) {
    super(`project checklist version conflict${currentVersion !== undefined ? ` (current: ${currentVersion})` : ""}`);
    this.name = "ChecklistConflictError";
  }
}

export class ChecklistValidationError extends Error {
  constructor(message = "checklist validation failed") {
    super(message);
    this.name = "ChecklistValidationError";
  }
}
