// Angebots-Fehlerklassen ohne Server-Bindung (kein `server-only`):
// lesende Module (z. B. Installations-Workbook) und E2E-Seeds duerfen
// diese Datei direkt importieren, ohne die service-Kette zu laden.
export class OfferNotFoundError extends Error {
  constructor() {
    super("offer was not found");
    this.name = "OfferNotFoundError";
  }
}

export class OfferIntegrityError extends Error {
  constructor() {
    super("stored offer data failed integrity validation");
    this.name = "OfferIntegrityError";
  }
}
