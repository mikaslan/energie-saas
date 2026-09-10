export class ProjectTaskValidationError extends Error {
  constructor() {
    super("project task command is invalid");
    this.name = "ProjectTaskValidationError";
  }
}

export class ProjectTaskNotFoundError extends Error {
  constructor() {
    super("project task was not found");
    this.name = "ProjectTaskNotFoundError";
  }
}

export class ProjectTaskConflictError extends Error {
  constructor(public readonly currentRevision?: number) {
    super("project task revision is stale");
    this.name = "ProjectTaskConflictError";
  }
}

export class ProjectTaskIllegalTransitionError extends Error {
  constructor() {
    super("project task transition is not allowed");
    this.name = "ProjectTaskIllegalTransitionError";
  }
}

export class ProjectTaskArchivedError extends Error {
  constructor() {
    super("project task is archived");
    this.name = "ProjectTaskArchivedError";
  }
}

export class ProjectTaskLimitError extends Error {
  constructor() {
    super("project task limit reached");
    this.name = "ProjectTaskLimitError";
  }
}

// F16-04: eigene Fehlerklasse für Vorlagen (keine Vermischung mit
// Aufgaben-Fehlern; keine neuen Permissions).
export class TaskTemplateNotFoundError extends Error {
  constructor() {
    super("task template was not found");
    this.name = "TaskTemplateNotFoundError";
  }
}

export class TaskTemplateConflictError extends Error {
  constructor() {
    super("task template name is already in use");
    this.name = "TaskTemplateConflictError";
  }
}

export class TaskTemplateValidationError extends Error {
  constructor() {
    super("task template command is invalid");
    this.name = "TaskTemplateValidationError";
  }
}
