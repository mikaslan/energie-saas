import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function loadValidator(fileName: string) {
  const schema = JSON.parse(
    readFileSync(resolve(root, "contracts", fileName), "utf8"),
  ) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const PROJECT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("F13 contract schemas", () => {
  it("filing-core.v1 akzeptiert einen gueltigen Vorgang", () => {
    const validate = loadValidator("filing-core.v1.schema.json");
    expect(
      validate({
        contractVersion: "filing-core.v1",
        capability: "grid_registration",
        status: "draft",
        projectId: PROJECT_ID,
        frozenAt: null,
        priceSnapshot: {
          amountCents: 49900,
          currency: "EUR",
          source: "service_price",
        },
        auditRef: "audit-2026-0001",
      }),
    ).toBe(true);
  });

  it("filing-core.v1 weist Capability/Status/Preis-Verstoesse ab", () => {
    const validate = loadValidator("filing-core.v1.schema.json");
    expect(
      validate({
        contractVersion: "filing-core.v1",
        capability: "unknown_capability",
        status: "archived",
        projectId: PROJECT_ID,
        frozenAt: null,
        priceSnapshot: {
          amountCents: -100,
          currency: "USD",
          source: "service_price",
        },
        auditRef: "audit-2026-0001",
      }),
    ).toBe(false);
  });

  it("filing-transition.v1 akzeptiert einen gueltigen Uebergang", () => {
    const validate = loadValidator("filing-transition.v1.schema.json");
    expect(
      validate({
        contractVersion: "filing-transition.v1",
        from: "draft",
        to: "submitted",
        transitionedBy: "customer",
        reasonCode: "submit_filing",
        notifyCustomer: true,
        idempotencyKey: "idem-2026-0001-abc",
      }),
    ).toBe(true);
  });

  it("filing-transition.v1 weist Status/Rollen-Verstoesse ab", () => {
    const validate = loadValidator("filing-transition.v1.schema.json");
    expect(
      validate({
        contractVersion: "filing-transition.v1",
        from: "archived",
        to: "submitted",
        transitionedBy: "admin",
        reasonCode: "",
        notifyCustomer: true,
        idempotencyKey: "short",
      }),
    ).toBe(false);
  });

  it("service-price.v1 akzeptiert einen gueltigen Preis", () => {
    const validate = loadValidator("service-price.v1.schema.json");
    expect(
      validate({
        contractVersion: "service-price.v1",
        serviceType: "netz_pv",
        amountCents: 49900,
        currency: "EUR",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2026-12-31T23:59:59.000Z",
        revision: 1,
        sourceEstimate: false,
      }),
    ).toBe(true);
  });

  it("service-price.v1 weist Typ/Betrag/Revision-Verstoesse ab", () => {
    const validate = loadValidator("service-price.v1.schema.json");
    expect(
      validate({
        contractVersion: "service-price.v1",
        serviceType: "netz_speicher",
        amountCents: -1,
        currency: "USD",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2026-12-31T23:59:59.000Z",
        revision: 0,
        sourceEstimate: false,
      }),
    ).toBe(false);
  });

  it("typed-file-slot.v1 akzeptiert einen gueltigen Slot", () => {
    const validate = loadValidator("typed-file-slot.v1.schema.json");
    expect(
      validate({
        contractVersion: "typed-file-slot.v1",
        slot: "zaehlerfoto",
        required: true,
        minCount: 1,
        mimeAllowlist: ["image/jpeg", "image/png"],
        maxBytes: 10485760,
      }),
    ).toBe(true);
  });

  it("typed-file-slot.v1 weist Slot/Count/Mime-Verstoesse ab", () => {
    const validate = loadValidator("typed-file-slot.v1.schema.json");
    expect(
      validate({
        contractVersion: "typed-file-slot.v1",
        slot: "grundbuchauszug",
        required: true,
        minCount: -1,
        mimeAllowlist: [],
        maxBytes: 0,
      }),
    ).toBe(false);
  });
});
