export class RestAuthenticationError extends Error {
  constructor() {
    super("rest request authentication failed");
    this.name = "RestAuthenticationError";
  }
}

export class RestCredentialConfigurationError extends Error {
  constructor(reason: string) {
    super(`rest credential configuration invalid: ${reason}`);
    this.name = "RestCredentialConfigurationError";
  }
}

export class RestPayloadTooLargeError extends Error {
  constructor() {
    super("rest payload too large");
    this.name = "RestPayloadTooLargeError";
  }
}

export class RestUnsupportedMediaTypeError extends Error {
  constructor() {
    super("rest content type must be application/json");
    this.name = "RestUnsupportedMediaTypeError";
  }
}

export class RestInvalidRequestError extends Error {
  constructor() {
    super("rest request invalid");
    this.name = "RestInvalidRequestError";
  }
}

export class RestIdempotencyConflictError extends Error {
  constructor() {
    super("rest record was reused with a different payload");
    this.name = "RestIdempotencyConflictError";
  }
}

export class RestRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("rest intake rate limited");
    this.name = "RestRateLimitError";
  }
}

export class RestTemporarilyUnavailableError extends Error {
  constructor() {
    super("rest intake temporarily unavailable");
    this.name = "RestTemporarilyUnavailableError";
  }
}
