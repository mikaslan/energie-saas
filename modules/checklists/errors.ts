export class ChecklistNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super(`project checklist not found: ${projectId}`);
    this.name = "ChecklistNotFoundError";
  }
}

export class ChecklistConflictError extends Error {
  constructor(public readonly detail: number | string) {
    super(`checklist conflict: ${detail}`);
    this.name = "ChecklistConflictError";
  }
}

export class ChecklistValidationError extends Error {
  constructor(message = "checklist validation failed") {
    super(message);
    this.name = "ChecklistValidationError";
  }
}

export class ChecklistSegmentIncompleteError extends Error {
  constructor(public readonly remainingRequired: number) {
    super(`checklist segment has ${remainingRequired} unfinished required item(s)`);
    this.name = "ChecklistSegmentIncompleteError";
  }
}

export class ChecklistSegmentStateError extends Error {
  constructor(public readonly state: "completed" | "open" | "hidden") {
    super(`checklist segment state does not allow this operation: ${state}`);
    this.name = "ChecklistSegmentStateError";
  }
}
