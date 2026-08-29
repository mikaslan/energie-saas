import { describe, expect, it } from "vitest";
import {
  isSensitiveGeocodingUrl,
  scrubSensitiveBreadcrumb,
  scrubSensitiveRequestData,
} from "@/instrumentation";

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

  it("verwirft Geoapify-Autocomplete-Breadcrumbs mitsamt Query und API-Key", () => {
    const breadcrumb = scrubSensitiveBreadcrumb({
      category: "http",
      type: "http",
      data: {
        url: "https://api.geoapify.com/v1/geocode/autocomplete",
        "http.query": "?text=Geheime+Adresse&apiKey=geheim",
      },
    });

    expect(breadcrumb).toBeNull();
  });

  it("verwirft Place-Details auch bei lokalem Provider-Override", () => {
    expect(
      scrubSensitiveBreadcrumb({
        category: "http",
        data: {
          url: "http://127.0.0.1:43123/v2/place-details",
          "http.query": "?id=geheime-place-id&apiKey=geheim",
        },
      }),
    ).toBeNull();
  });

  it("laesst unbeteiligte HTTP-Breadcrumbs unveraendert", () => {
    const breadcrumb = {
      category: "http",
      type: "http",
      data: { url: "https://example.test/health", "http.query": "?ok=1" },
    };

    expect(scrubSensitiveBreadcrumb(breadcrumb)).toBe(breadcrumb);
  });

  it("erkennt Providerpfade auch in nicht standardkonformen URL-Strings", () => {
    expect(
      isSensitiveGeocodingUrl("not a url :: /v1/geocode/autocomplete :: secret"),
    ).toBe(true);
  });
});
