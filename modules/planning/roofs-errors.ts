// F3-03 Dach-Minimal (Batch-1 F3-BATCH-1-vertrag): eigene Fehlerdatei
// fuer modules/planning/roofs.ts. modules/planning/errors.ts bleibt
// unangetastet (parallele Children schreiben eigene Dateien).
export class NotFoundError extends Error {
  constructor(public readonly id?: string) {
    super(id ? `planning roof not found: ${id}` : "planning roof not found");
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(message = "planning roof input is invalid") {
    super(message);
    this.name = "ValidationError";
  }
}

// Alias-Namen fuer instanceof-Pruefungen unter Konventionsnamen.
export { NotFoundError as PlanningRoofNotFoundError };
export { NotFoundError as RoofNotFoundError };
export { ValidationError as PlanningRoofValidationError };
export { ValidationError as RoofValidationError };
