import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantTx } from "@/lib/db/types";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { listPartialInvoices } from "@/modules/invoicing/partial-service";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";

type ExecuteResponse = { rows: unknown[] };

function context(
  role: ServiceCtx["role"] = "editor",
  capabilities: ServiceCtx["capabilities"] = { invoicing: true },
): ServiceCtx {
  return {
    workspaceId: WORKSPACE_ID,
    actor: ACTOR_ID,
    role,
    capabilities,
    featureFlags: {},
  };
}

function transaction(responses: ExecuteResponse[]) {
  let index = 0;
  const queries: unknown[] = [];
  const execute = vi.fn(async (query: unknown) => {
    queries.push(query);
    return responses[index++] ?? { rows: [] };
  });
  const tx = { execute } as unknown as TenantTx;
  return { tx, execute, queries };
}

function sqlText(query: unknown): string {
  return JSON.stringify(query).toLowerCase();
}

const CREATED_AT = "2026-09-10T08:00:00.000Z";

function orderRow() {
  return {
    id: ORDER_ID,
    type: "order_confirmation",
    status: "issued",
    group_id: null,
    project_id: null,
    contact_id: null,
    name: "AB Eltern",
    number: "AB-1",
    net_cents: 950000,
    gross_cents: 1130500,
  };
}

function chainRow(overrides: Record<string, unknown> = {}) {
  return {
    partial_id: "a0000000-0000-4000-8000-000000000001",
    ordinal: 1,
    mode: "percent",
    percent_bps: 3000,
    created_at: CREATED_AT,
    invoice_id: "b0000000-0000-4000-8000-000000000001",
    invoice_number: "RE-1",
    invoice_name: "Teilrechnung 1",
    invoice_status: "issued",
    invoice_gross: 339150,
    invoice_net: 285000,
    invoice_skonto_percent: null,
    invoice_skonto_days: null,
    invoice_paid: 0,
    ...overrides,
  };
}

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    partial_id: "a0000000-0000-4000-8000-000000000001",
    ordinal: 1,
    mode: "percent",
    percent_bps: 3000,
    invoice_id: "b0000000-0000-4000-8000-000000000001",
    invoice_gross: 339150,
    ...overrides,
  };
}

function orderLineRow() {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    position: 1,
    name: "PV-Module",
    quantity_milli: 20000,
    unit: "piece",
    net_cents: 800000,
    tax_cents: 152000,
    tax_rate_bps: 1900,
  };
}

describe("F8-24b Eltern-Zahlungsstatus Projektion (Contract)", () => {
  it("F824B-CT-01a: paid/open/Status aus nicht-stornierten Kindern (teilbezahlt)", async () => {
    const { tx, queries } = transaction([
      { rows: [orderRow()] },
      {
        rows: [
          chainRow({ invoice_paid: 100000 }),
          chainRow({
            partial_id: "a0000000-0000-4000-8000-000000000002",
            ordinal: 2,
            invoice_id: "b0000000-0000-4000-8000-000000000002",
            invoice_number: "RE-2",
            invoice_name: "Teilrechnung 2",
            invoice_paid: 0,
          }),
        ],
      },
      {
        rows: [
          activeRow(),
          activeRow({
            partial_id: "a0000000-0000-4000-8000-000000000002",
            ordinal: 2,
            invoice_id: "b0000000-0000-4000-8000-000000000002",
          }),
        ],
      },
      { rows: [] },
      { rows: [orderLineRow()] },
    ]);
    const chain = await listPartialInvoices(tx, context(), { orderId: ORDER_ID });
    expect(chain.billedGrossCents).toBe(678300);
    expect(chain.paidGrossCents).toBe(100000);
    expect(chain.openGrossCents).toBe(578300);
    expect(chain.parentPaymentStatus).toBe("partially_paid");
    // Die Projektion liest paid_cents (keine Zweitquelle, kein Raten).
    expect(queries.map(sqlText).some((text) => text.includes("paid_cents"))).toBe(true);
  });

  it("F824B-CT-01b: vollbezahlt — open 0, Status paid", async () => {
    const { tx } = transaction([
      { rows: [orderRow()] },
      { rows: [chainRow({ invoice_gross: 100000, invoice_paid: 100000 })] },
      { rows: [activeRow({ invoice_gross: 100000 })] },
      { rows: [] },
      { rows: [orderLineRow()] },
    ]);
    const chain = await listPartialInvoices(tx, context(), { orderId: ORDER_ID });
    expect(chain.paidGrossCents).toBe(100000);
    expect(chain.openGrossCents).toBe(0);
    expect(chain.parentPaymentStatus).toBe("paid");
  });

  it("F824B-CT-01c: stornierte Kinder und leere Ketten bleiben unpaid (0-EUR-Regel)", async () => {
    const { tx } = transaction([
      { rows: [orderRow()] },
      {
        rows: [
          chainRow({ invoice_status: "voided", invoice_paid: 50000 }),
        ],
      },
      { rows: [] },
      { rows: [orderLineRow()] },
    ]);
    const chain = await listPartialInvoices(tx, context(), { orderId: ORDER_ID });
    expect(chain.billedGrossCents).toBe(0);
    expect(chain.paidGrossCents).toBe(0);
    expect(chain.openGrossCents).toBe(0);
    expect(chain.parentPaymentStatus).toBe("unpaid");
  });

  it("F824B-CT-01d: ohne Leserecht (external-only) kein Kettenzugriff", async () => {
    const { tx, execute } = transaction([]);
    await expect(
      listPartialInvoices(
        tx,
        context("editor", { invoicing: true, external_only: true }),
        { orderId: ORDER_ID },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(execute).not.toHaveBeenCalled();
  });
});
