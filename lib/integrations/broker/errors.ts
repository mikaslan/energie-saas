export class BrokerAuthenticationError extends Error {
  constructor() {
    super("broker request authentication failed");
    this.name = "BrokerAuthenticationError";
  }
}

export class BrokerCredentialConfigurationError extends Error {
  constructor(reason: string) {
    super(`broker credential configuration invalid: ${reason}`);
    this.name = "BrokerCredentialConfigurationError";
  }
}

export class BrokerPayloadTooLargeError extends Error {
  constructor() {
    super("broker payload too large");
    this.name = "BrokerPayloadTooLargeError";
  }
}

export class BrokerUnsupportedMediaTypeError extends Error {
  constructor() {
    super("broker content type must be application/json");
    this.name = "BrokerUnsupportedMediaTypeError";
  }
}

export class BrokerInvalidRequestError extends Error {
  constructor() {
    super("broker request invalid");
    this.name = "BrokerInvalidRequestError";
  }
}

export class BrokerIdempotencyConflictError extends Error {
  constructor() {
    super("broker record was reused with a different payload");
    this.name = "BrokerIdempotencyConflictError";
  }
}

export class BrokerRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("broker intake rate limited");
    this.name = "BrokerRateLimitError";
  }
}

export class BrokerTemporarilyUnavailableError extends Error {
  constructor() {
    super("broker intake temporarily unavailable");
    this.name = "BrokerTemporarilyUnavailableError";
  }
}
