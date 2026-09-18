import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_POSTGRES_URL = process.env.POSTGRES_URL;
const ORIGINAL_KEYS = process.env.RECHNER_INTAKE_KEYS_JSON;
const ORIGINAL_BROKER_KEYS = process.env.BROKER_INTAKE_KEYS_JSON;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("POSTGRES_URL", ORIGINAL_POSTGRES_URL);
  restore("RECHNER_INTAKE_KEYS_JSON", ORIGINAL_KEYS);
  restore("BROKER_INTAKE_KEYS_JSON", ORIGINAL_BROKER_KEYS);
  vi.resetModules();
});

describe("Rechner-Intake-Routenimport", () => {
  it("konstruiert beim Build-Import weder DB-Pool noch Secret-Konfiguration", async () => {
    delete process.env.POSTGRES_URL;
    delete process.env.RECHNER_INTAKE_KEYS_JSON;
    delete process.env.BROKER_INTAKE_KEYS_JSON;
    vi.resetModules();

    await expect(import("@/app/api/inbound/rechner/v1/route")).resolves.toEqual(
      expect.objectContaining({
        POST: expect.any(Function),
        runtime: "nodejs",
      }),
    );
  });

  // F1-15 (0230): Broker-Route mit derselben Build-Import-Garantie.
  it("Broker-Route konstruiert beim Build-Import weder DB-Pool noch Secret-Konfiguration", async () => {
    delete process.env.POSTGRES_URL;
    delete process.env.RECHNER_INTAKE_KEYS_JSON;
    delete process.env.BROKER_INTAKE_KEYS_JSON;
    vi.resetModules();

    await expect(import("@/app/api/inbound/broker/v1/route")).resolves.toEqual(
      expect.objectContaining({
        POST: expect.any(Function),
        runtime: "nodejs",
      }),
    );
  });
});
