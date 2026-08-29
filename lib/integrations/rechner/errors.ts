export class RechnerAuthenticationError extends Error {
  constructor() {
    super("rechner request authentication failed");
    this.name = "RechnerAuthenticationError";
  }
}

export class RechnerCredentialConfigurationError extends Error {
  constructor(reason: string) {
    super(`rechner credential configuration invalid: ${reason}`);
    this.name = "RechnerCredentialConfigurationError";
  }
}

export class RechnerPayloadTooLargeError extends Error {
  constructor() {
    super("rechner payload too large");
    this.name = "RechnerPayloadTooLargeError";
  }
}

export class RechnerUnsupportedMediaTypeError extends Error {
  constructor() {
    super("rechner content type must be application/json");
    this.name = "RechnerUnsupportedMediaTypeError";
  }
}

export class RechnerInvalidRequestError extends Error {
  constructor() {
    super("rechner request invalid");
    this.name = "RechnerInvalidRequestError";
  }
}

export class RechnerIdempotencyConflictError extends Error {
  constructor() {
    super("rechner idempotency key was reused with a different payload");
    this.name = "RechnerIdempotencyConflictError";
  }
}

export class RechnerRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("rechner intake rate limited");
    this.name = "RechnerRateLimitError";
  }
}

export class RechnerTemporarilyUnavailableError extends Error {
  constructor() {
    super("rechner intake temporarily unavailable");
    this.name = "RechnerTemporarilyUnavailableError";
  }
}
