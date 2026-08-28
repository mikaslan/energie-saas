import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_POSTGRES_URL = process.env.POSTGRES_URL;
const ORIGINAL_POSTGRES_URL_AUTH = process.env.POSTGRES_URL_AUTH;
const ORIGINAL_BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
const ORIGINAL_VITEST = process.env.VITEST;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_NEXT_PHASE = process.env.NEXT_PHASE;

function setzen(name: string, wert: string | undefined): void {
  if (wert === undefined) delete process.env[name];
  else process.env[name] = wert;
}

function restoreEnv(): void {
  setzen("POSTGRES_URL", ORIGINAL_POSTGRES_URL);
  setzen("POSTGRES_URL_AUTH", ORIGINAL_POSTGRES_URL_AUTH);
  setzen("BETTER_AUTH_SECRET", ORIGINAL_BETTER_AUTH_SECRET);
  setzen("VITEST", ORIGINAL_VITEST);
  setzen("NODE_ENV", ORIGINAL_NODE_ENV);
  setzen("NEXT_PHASE", ORIGINAL_NEXT_PHASE);
}

function alsLaufzeit(secret: string | undefined): void {
  setzen("POSTGRES_URL", undefined);
  setzen("POSTGRES_URL_AUTH", undefined);
  setzen("VITEST", undefined);
  setzen("NODE_ENV", "production");
  setzen("NEXT_PHASE", undefined);
  setzen("BETTER_AUTH_SECRET", secret);
}

afterEach(() => {
  restoreEnv();
  vi.resetModules();
});

describe("Auth-Modulimport beim Build", () => {
  it("konstruiert beim bloßen Import keine Auth- oder DB-Instanz", async () => {
    delete process.env.POSTGRES_URL;
    delete process.env.POSTGRES_URL_AUTH;
    delete process.env.BETTER_AUTH_SECRET;

    // Minimaler eigener Env-Zustand: globalSetup liefert POSTGRES_URL_TEST,
    // dieser Test prüft aber bewusst den Build-Import ohne produktive Auth-Env.
    vi.resetModules();

    await expect(import("@/lib/auth")).resolves.toBeDefined();
    await expect(import("@/app/api/auth/[...all]/route")).resolves.toEqual(
      expect.objectContaining({
        GET: expect.any(Function),
        POST: expect.any(Function),
      }),
    );
  });

  it("wirft zur Laufzeit beim Konstruieren der Auth-Instanz ohne gueltiges Secret", async () => {
    alsLaufzeit(undefined);
    vi.resetModules();
    const ohneSecret = await import("@/lib/auth");

    expect(() => ohneSecret.getAuth()).toThrow(/nicht gesetzt/);

    alsLaufzeit("zu-kurz");
    vi.resetModules();
    const zuKurz = await import("@/lib/auth");

    expect(() => zuKurz.getAuth()).toThrow(/zu kurz/);
  });
});
