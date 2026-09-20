// F3-02 Dachquellen-Registry: eigene Fehlerfläche (bewusst NICHT
// modules/planning/errors.ts — eigene Datei je Batch-Auftrag).
export class PlanningSourceNotFoundError extends Error {
  constructor(public readonly sourceId: string) {
    super(`planning source not found: ${sourceId}`);
    this.name = "PlanningSourceNotFoundError";
  }
}

export class PlanningSourceValidationError extends Error {
  constructor(message = "planning source validation failed") {
    super(message);
    this.name = "PlanningSourceValidationError";
  }
}
