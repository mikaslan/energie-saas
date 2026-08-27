// Sentry-Client-Init. NEXT_PUBLIC_SENTRY_DSN wird zur Build-Zeit inlined —
// ohne gesetzten Wert bleibt der init-Zweig toter Code (Gerüst hinter
// Env-Flag, Tooling-Mission; Werte via docs/tooling/einkaufsliste.md).
import * as Sentry from "@sentry/nextjs";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0,
  });
}

// Pflicht-Export des Hooks für App-Router-Navigationen (No-op ohne init).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
