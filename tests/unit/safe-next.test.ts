import { describe, expect, it } from "vitest";
import { safeInternalNextPath } from "@/lib/safe-next";

describe("safeInternalNextPath", () => {
  it.each([
    [undefined, "/"],
    [null, "/"],
    [["/safe", "//evil.example"], "/"],
    ["https://evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["//evil.example", "/"],
    ["///evil.example", "/"],
    ["/\\evil.example", "/"],
    ["/%5Cevil.example", "/"],
    ["/%255Cevil.example", "/"],
    ["/%2F%2Fevil.example", "/"],
    ["/%252F%252Fevil.example", "/"],
    ["/a/..//evil.example", "/"],
    ["/%2e%2e//evil.example", "/"],
    ["/a/%2e%2e//evil.example", "/"],
    ["/.//evil.example", "/"],
    ["/safe%0d%0aSet-Cookie:test", "/"],
    ["/safe%250aheader", "/"],
    ["/%", "/"],
    ["/login", "/"],
    ["/login/", "/"],
    ["/LOGIN?next=/safe", "/"],
    ["/a/../login", "/"],
    ["/%6Cogin", "/"],
    ["/%256Cogin", "/"],
    ["/", "/"],
    ["/loginish", "/loginish"],
    ["/w/id/anfragen?status=neu#karte", "/w/id/anfragen?status=neu#karte"],
    ["/w/id?at=2026-08-29T12:30:00Z", "/w/id?at=2026-08-29T12:30:00Z"],
    ["/w/id?return=https%3A%2F%2Fexample.test", "/w/id?return=https%3A%2F%2Fexample.test"],
  ])("bildet %j auf %s ab", (input, expected) => {
    expect(safeInternalNextPath(input)).toBe(expected);
  });
});
