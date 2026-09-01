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
