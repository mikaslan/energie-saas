// Schaltplan-Fehlerklassen ohne Server-Bindung (kein `server-only`):
// lesende Aufrufer und Tests duerfen diese Datei direkt importieren, ohne
// die service-Kette zu laden (Muster modules/offers/errors.ts).
export { SchematicScopeError } from "@/lib/integrations/schematic/single-line-v1";

export class SchematicValidationError extends Error {
  constructor(public readonly paths: string[] = []) {
    super("schematic command is invalid");
    this.name = "SchematicValidationError";
  }
}

export class SchematicConflictError extends Error {
  constructor(public readonly currentRevision?: number) {
    super("schematic changed since it was loaded");
    this.name = "SchematicConflictError";
  }
}
