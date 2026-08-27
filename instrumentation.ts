// Sentry-Server-Init über den Next.js-Instrumentation-Hook. Gerüst hinter
// Env-Flag (Tooling-Mission): ohne SENTRY_DSN passiert hier nichts. Die Org
// muss bei Anlage in der EU-Region (Frankfurt) erstellt werden — Schritte in
// docs/tooling/einkaufsliste.md. Source-Map-Upload (withSentryConfig +
// SENTRY_AUTH_TOKEN) folgt erst nach Key-Erhalt, siehe docs/tooling/STATUS.md.
import type { Instrumentation } from "next";

export async function register() {
  if (!process.env.SENTRY_DSN || process.env.NEXT_RUNTIME !== "nodejs") return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    // Nur Fehler, kein Performance-Tracing — hält den Free-Plan (5k Events) frei.
    tracesSampleRate: 0,
  });
}

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
};
