// Sentry-Server-Init über den Next.js-Instrumentation-Hook. Gerüst hinter
// Env-Flag (Tooling-Mission): ohne SENTRY_DSN passiert hier nichts. Die Org
// muss bei Anlage in der EU-Region (Frankfurt) erstellt werden — Schritte in
// docs/tooling/einkaufsliste.md. Source-Map-Upload (withSentryConfig +
// SENTRY_AUTH_TOKEN) folgt erst nach Key-Erhalt, siehe docs/tooling/STATUS.md.
import type { Instrumentation } from "next";

const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "idempotency-key",
  "x-rechner-key-id",
  "x-rechner-timestamp",
  "x-rechner-content-sha256",
  "x-rechner-signature",
]);

type ScrubbableEvent = {
  request?: {
    url?: string;
    data?: unknown;
    cookies?: unknown;
    query_string?: unknown;
    headers?: Record<string, string>;
  };
  contexts?: {
    nextjs?: {
      request_path?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

function withoutRechnerQuery(value: string): string | undefined {
  try {
    const url = new URL(value, "http://instrumentation.invalid");
    if (url.pathname !== "/api/inbound/rechner/v1") return value;
    url.search = "";
    url.hash = "";
    return url.origin === "http://instrumentation.invalid"
      ? url.pathname
      : url.toString();
  } catch {
    return undefined;
  }
}

export function scrubSensitiveRequestData<T extends ScrubbableEvent>(event: T): T {
  const request = event.request;
  if (request) {
    // Fehlertelemetrie darf keinen Request-Body oder Cookies dauerhaft kopieren.
    // Fuer den Rechner werden auch alle signatur-/idempotenzbezogenen Header
    // entfernt; die serverseitige requestId bleibt der Korrelationsschluessel.
    request.data = undefined;
    request.cookies = undefined;
    // Sentry kann Queryparameter getrennt von request.url ablegen. Sie werden
    // deshalb ebenfalls verworfen, statt nur den sichtbaren URL-String zu
    // bereinigen.
    request.query_string = undefined;
    if (request.headers) {
      request.headers = Object.fromEntries(
        Object.entries(request.headers).filter(
          ([name]) => !SENSITIVE_REQUEST_HEADERS.has(name.toLowerCase()),
        ),
      );
    }
    if (request.url) request.url = withoutRechnerQuery(request.url);
  }

  // @sentry/nextjs spiegelt req.url zusätzlich in diesen Context. Nur die
  // Event-Request-Felder zu bereinigen würde Query-PII deshalb nicht erfassen.
  const nextRequestPath = event.contexts?.nextjs?.request_path;
  if (typeof nextRequestPath === "string") {
    event.contexts!.nextjs!.request_path = withoutRechnerQuery(nextRequestPath);
  }
  return event;
}

export async function register() {
  if (!process.env.SENTRY_DSN || process.env.NEXT_RUNTIME !== "nodejs") return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    // Nur Fehler, kein Performance-Tracing — hält den Free-Plan (5k Events) frei.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event) {
      return scrubSensitiveRequestData(event);
    },
  });
}

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
};
