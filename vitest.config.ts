import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: {
    globalSetup: ["./tests/setup/global-setup.ts"],
    include: ["tests/**/*.test.ts"],
    fileParallelism: false, // eine Test-DB, sequenzielle Suiten
  },
});
