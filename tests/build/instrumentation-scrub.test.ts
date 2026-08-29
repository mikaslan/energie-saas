import { describe, expect, it } from "vitest";
import { scrubSensitiveRequestData } from "@/instrumentation";

describe("Sentry Request-Scrubbing", () => {
  it("entfernt Rechner-PII, Signaturheader und Querystrings", () => {
    const event = scrubSensitiveRequestData({
      request: {
        url: "https://clone.test/api/inbound/rechner/v1?email=geheim@example.com",
        data: { email: "geheim@example.com" },
        cookies: { session: "geheim" },
        query_string: "email=geheim@example.com",
        headers: {
          "Content-Type": "application/json",
          "X-Rechner-Signature": "v1=geheim",
          "Idempotency-Key": "geheim",
          Cookie: "session=geheim",
        },
      },
      contexts: {
        nextjs: {
          request_path: "/api/inbound/rechner/v1?email=geheim@example.com",
          router_kind: "App Router",
        },
      },
    });
    expect(event.request).toEqual({
      url: "https://clone.test/api/inbound/rechner/v1",
      data: undefined,
      cookies: undefined,
      query_string: undefined,
      headers: { "Content-Type": "application/json" },
    });
    expect(event.contexts?.nextjs).toEqual({
      request_path: "/api/inbound/rechner/v1",
      router_kind: "App Router",
    });
    expect(JSON.stringify(event)).not.toContain("geheim");
  });
});
