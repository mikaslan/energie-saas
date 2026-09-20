// F3-03b Dach-Sperrzonen: eigene Fehlerdatei fuer
// modules/planning/roof-restrictions.ts.
export class PlanningRoofRestrictionNotFoundError extends Error {
  constructor(public readonly id?: string) {
    super(
      id
        ? `planning roof restriction not found: ${id}`
        : "planning roof restriction not found",
    );
    this.name = "PlanningRoofRestrictionNotFoundError";
  }
}

export class PlanningRoofRestrictionValidationError extends Error {
  constructor(message = "planning roof restriction input is invalid") {
    super(message);
    this.name = "PlanningRoofRestrictionValidationError";
  }
}

export { PlanningRoofRestrictionNotFoundError as NotFoundError };
export { PlanningRoofRestrictionNotFoundError as RestrictionNotFoundError };
export { PlanningRoofRestrictionValidationError as ValidationError };
export { PlanningRoofRestrictionValidationError as RestrictionValidationError };
