import { describe, it, expect } from "vitest";
import { testDb } from "../setup/test-db";
import { workspace } from "@/lib/db/schema";

describe("db + schema", () => {
  it("verbindet sich und sieht die workspace-Tabelle", async () => {
    const rows = await testDb.select().from(workspace).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });
});
