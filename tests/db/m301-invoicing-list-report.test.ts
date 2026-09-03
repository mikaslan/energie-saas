import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LIST_VERSION,
  INVOICING_REPORT_COMMAND_VERSION,
  INVOICING_REPORT_CSV_VERSION,
  INVOICING_REPORT_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  exportInvoicingReport,
  getInvoicingReport,
  listDocuments,
  InvoicingValidationError,
} from "@/modules/invoicing";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'M3-01 A4')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@m301a4.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@m301a4.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{"invoicing":true}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, viewerId };
}

type SeedDoc = {
  type: "invoice" | "credit_note" | "letter" | "order_confirmation" | "purchase_order" | "delivery_note";
  name: string;
  status?: "draft" | "issued" | "voided";
  issuedAt?: string;
  createdAt: string;
  netCents?: number;
  taxCents?: number;
  grossCents?: number;
  paymentStatus?: "unpaid" | "partially_paid" | "paid" | "overdue" | "uncollectable" | null;
  paidCents?: number;
  paymentUpdatedAt?: string;
  dueDate?: string | null;
  dueOffsetDays?: number;
  deliveryDate?: string | null;
  validityDate?: string | null;
  sequence?: number;
  creditNoteType?: string | null;
  archivedAt?: string | null;
  sentAt?: string | null;
  voidedAt?: string | null;
  voidReason?: string | null;
  number?: string | null;
};

const ZERO_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

// Berliner Kalenderdatum n Tage vor heute (Europe/Berlin), als "YYYY-MM-DD".
// Berliner Zeitstempel n Minuten vor heute als ISO-8601 mit +02:00 (CEST).
function berlinIsoMinutesAgo(minutesAgo: number): string {
  const date = new Date(Date.now() - minutesAgo * 60_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+02:00`;
}

function berlinDateDaysAgo(daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function seedDocument(fixture: Fixture, doc: SeedDoc): Promise<string> {
  const id = randomUUID();
  const issued = doc.status === "issued" || doc.status === "voided";
  // Direkte Inserts laufen als autorisierter Editor (RLS-Actor-Policies),
  // analog zu den Zeilen-Inserts in m301-invoicing-axes.test.ts.
  await withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into commercial_document (
        id, workspace_id, type, status, name, created_by, created_at,
        issued_at, issued_snapshot, snapshot_sha256, issued_by,
        goebd_retention_until, number, number_year, number_sequence,
        net_cents, tax_cents, gross_cents, payment_status, paid_cents,
        payment_updated_at, due_date, delivery_date, validity_date,
        credit_note_type, archived_at, sent_at, voided_at, void_reason
      ) values (
        ${id}::uuid, ${fixture.workspaceId}::uuid, ${doc.type}, ${doc.status ?? "draft"},
        ${doc.name}, ${fixture.editorId}::uuid, ${sql`${doc.createdAt}::timestamptz`},
        ${issued ? sql`${doc.issuedAt}::timestamptz` : sql`null`},
        ${issued ? sql`'{"schemaVersion":"document-snapshot.v1"}'::jsonb` : sql`null`},
        ${issued ? sql`decode(${ZERO_HASH}, 'hex')` : sql`null`},
        ${issued ? sql`${fixture.editorId}::uuid` : sql`null`},
        ${issued ? sql`'2036-12-31'::date` : sql`null`},
        ${issued ? sql`${doc.number ?? `RE-${id.slice(0, 8)}`}` : sql`null`},
        ${issued ? 2026 : null}, ${issued ? (doc.sequence ?? 1) : null},
        ${doc.netCents ?? 0}, ${doc.taxCents ?? 0}, ${doc.grossCents ?? 0},
        ${doc.paymentStatus ?? null},
        ${doc.paidCents ?? 0},
        ${doc.paymentUpdatedAt === undefined ? sql`null` : sql`${doc.paymentUpdatedAt}::timestamptz`},
        ${doc.dueOffsetDays !== undefined ? sql`${berlinDateDaysAgo(doc.dueOffsetDays)}::date` : doc.dueDate === undefined ? sql`null` : doc.dueDate === null ? sql`null` : sql`${doc.dueDate}::date`},
        ${doc.deliveryDate === undefined ? sql`null` : doc.deliveryDate === null ? sql`null` : sql`${doc.deliveryDate}::date`},
        ${doc.validityDate === undefined ? sql`null` : doc.validityDate === null ? sql`null` : sql`${doc.validityDate}::date`},
        ${doc.creditNoteType ?? null},
        ${doc.archivedAt === undefined ? sql`null` : doc.archivedAt === null ? sql`null` : sql`${doc.archivedAt}::timestamptz`},
        ${doc.sentAt === undefined ? sql`null` : doc.sentAt === null ? sql`null` : sql`${doc.sentAt}::timestamptz`},
        ${doc.voidedAt === undefined ? sql`null` : doc.voidedAt === null ? sql`null` : sql`${doc.voidedAt}::timestamptz`},
        ${doc.voidReason ?? null}
      )
    `);
  });
  return id;
}

function listCommand(
  type: "invoice" | "credit_note" | "order_confirmation" | "purchase_order" | "delivery_note" | "letter",
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION,
    type,
    ...overrides,
  };
}

describe("M3-01 A4 — Liste/Filter je Typ + Berichte (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
    // Rechnungen
    let minutesAgo = 130;
    const createdAt = () => {
      minutesAgo -= 10;
      return berlinIsoMinutesAgo(minutesAgo);
    };
    await seedDocument(fixture, {
      type: "invoice", name: "PV-Anlage", status: "issued", createdAt: createdAt(),
      issuedAt: "2026-09-05T10:00:00+02:00", grossCents: 11900, netCents: 10000, taxCents: 1900,
      paymentStatus: "unpaid", dueDate: "2026-10-01", number: "Rechnung-2026-09-1", sequence: 1,
    });
    await seedDocument(fixture, {
      type: "invoice", name: "Speicher", status: "issued", createdAt: createdAt(),
      issuedAt: "2026-08-10T10:00:00+02:00", grossCents: 20000, netCents: 16807, taxCents: 3193,
      paymentStatus: "paid", paidCents: 20000, paymentUpdatedAt: "2026-09-10T10:00:00+02:00",
      dueDate: "2026-08-25", number: "Rechnung-2026-08-1", sequence: 2,
    });
    await seedDocument(fixture, {
      type: "invoice", name: "Storniert", status: "voided", createdAt: createdAt(),
      issuedAt: "2026-09-20T10:00:00+02:00", grossCents: 5000, netCents: 4202, taxCents: 798,
      paymentStatus: "unpaid", dueDate: "2026-09-30",
      voidedAt: "2026-09-21T10:00:00+02:00", voidReason: "cancelled", number: "Rechnung-2026-09-2", sequence: 3,
    });
    await seedDocument(fixture, {
      type: "invoice", name: "PV;Anlage", status: "issued", createdAt: createdAt(),
      issuedAt: "2026-09-15T10:00:00+02:00", grossCents: 8000, netCents: 6723, taxCents: 1277,
      paymentStatus: "overdue", paidCents: 3000, dueOffsetDays: 5, number: "Rechnung-2026-09-3", sequence: 4,
    });
    await seedDocument(fixture, {
      type: "invoice", name: "Entwurf", createdAt: createdAt(),
      paymentStatus: "unpaid", dueDate: "2026-12-31",
    });
    await seedDocument(fixture, {
      type: "invoice", name: "Archiviert", createdAt: createdAt(),
      paymentStatus: "unpaid", dueDate: "2026-12-31",
      archivedAt: berlinIsoMinutesAgo(5),
    });
    // Überfälligkeits-Buckets (Rechnungen, issue-datum August — außerhalb des
    // September-Fensters, aber in den Buckets/offenen KPIs enthalten)
    await seedDocument(fixture, {
      type: "invoice", name: "Sonder-Rechnung", status: "issued", createdAt: createdAt(),
      issuedAt: "2026-08-20T10:00:00+02:00", grossCents: 4000, netCents: 3361, taxCents: 639,
      paymentStatus: "overdue", paidCents: 0, dueOffsetDays: 10, number: "Rechnung-2026-08-2", sequence: 5,
    });
    await seedDocument(fixture, {
      type: "invoice", name: "Alt-45", status: "issued", createdAt: createdAt(),
      issuedAt: "2026-08-21T10:00:00+02:00", grossCents: 500, netCents: 420, taxCents: 80,
      paymentStatus: "overdue", paidCents: 0, dueOffsetDays: 45, number: "Rechnung-2026-08-3", sequence: 6,
    });
    await seedDocument(fixture, {
      type: "invoice", name: "Alt-75", status: "issued", createdAt: createdAt(),
      issuedAt: "2026-08-22T10:00:00+02:00", grossCents: 300, netCents: 252, taxCents: 48,
      paymentStatus: "overdue", paidCents: 0, dueOffsetDays: 75, number: "Rechnung-2026-08-4", sequence: 7,
    });
    await seedDocument(fixture, {
      type: "invoice", name: "Alt-100", status: "issued", createdAt: createdAt(),
      issuedAt: "2026-08-23T10:00:00+02:00", grossCents: 200, netCents: 168, taxCents: 32,
      paymentStatus: "overdue", paidCents: 0, dueOffsetDays: 100, number: "Rechnung-2026-08-5", sequence: 8,
    });
    // Gutschrift + Brief (Sept)
    await seedDocument(fixture, {
      type: "credit_note", name: "Minderleistung", status: "issued", createdAt: createdAt(),
      issuedAt: "2026-09-17T10:00:00+02:00", grossCents: 2000, netCents: 1681, taxCents: 319,
      paymentStatus: "unpaid", deliveryDate: "2026-09-17",
      creditNoteType: "minderleistung", number: "CRN-2026-09-17-1",
    });
    await seedDocument(fixture, {
      type: "letter", name: "Ankündigung", status: "issued", createdAt: createdAt(),
      issuedAt: "2026-09-16T10:00:00+02:00", grossCents: 0,
      paymentStatus: null, paidCents: 0, validityDate: "2026-09-16", number: "LE-2026-09-16-1",
    });
  });

  describe("M301-06 — listDocuments", () => {
    it("M301-LIST-01: Typ-Filter + Standard-Sortierung + totalCount", async () => {
      const result = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice")),
      );
      expect(result.schemaVersion).toBe(COMMERCIAL_DOCUMENT_LIST_VERSION);
      // 10 Rechnungen gesamt, 1 davon archiviert → Standard filtert sie aus.
      expect(result.totalCount).toBe(9);
      expect(result.items).toHaveLength(9);
      expect(result.nextCursor).toBeNull();
      for (const item of result.items) {
        expect(item.type).toBe("invoice");
      }
      // Sortierung: neueste zuerst (Archiviert ist per Default ausgefiltert)
      expect(result.items[0].name).toBe("Alt-100");
      // Standard: nur nicht archivierte
      expect(result.items.every((item) => item.archivedAt === null)).toBe(true);
      expect(result.permissions.canWrite).toBe(true);
    });

    it("M301-LIST-02: Status-/Zahlungsstatus-/Ausstellungs-Filter", async () => {
      const voided = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
          filters: { status: "voided", archived: "all" },
        })),
      );
      expect(voided.totalCount).toBe(1);
      expect(voided.items[0].name).toBe("Storniert");

      const paid = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
          filters: { paymentStatus: "paid" },
        })),
      );
      expect(paid.totalCount).toBe(1);
      expect(paid.items[0].name).toBe("Speicher");

      const september = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
          filters: { issuedFrom: "2026-09-01", issuedTo: "2026-09-30", archived: "all" },
        })),
      );
      expect(september.totalCount).toBe(3);
      expect(september.items.map((item) => item.name).sort()).toEqual([
        "PV-Anlage", "PV;Anlage", "Storniert",
      ]);
    });

    it("M301-LIST-03: Fach-Datumsfilter (Fälligkeit) + Gutschrift-Typ + Suche", async () => {
      const dueAfter = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
          filters: { typeDateFrom: "2026-10-01", archived: "all" },
        })),
      );
      expect(dueAfter.totalCount).toBe(3);
      expect(dueAfter.items.map((item) => item.name).sort()).toEqual([
        "Archiviert", "Entwurf", "PV-Anlage",
      ]);

      const creditNotes = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("credit_note", {
          filters: { creditNoteType: "minderleistung" },
        })),
      );
      expect(creditNotes.totalCount).toBe(1);
      expect(creditNotes.items[0].name).toBe("Minderleistung");

      const searched = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
          filters: { search: "sonder" },
        })),
      );
      expect(searched.totalCount).toBe(1);
      expect(searched.items[0].name).toBe("Sonder-Rechnung");

      // Kimi-P2-3: LIKE-Wildcards sind escaped — "PV%" sucht das LITERALE
      // Prozentzeichen und findet nichts (ungeescaped träfe es PV-Anlage +
      // PV;Anlage).
      const wildcard = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
          filters: { search: "PV%" },
        })),
      );
      expect(wildcard.totalCount).toBe(0);
      const underscore = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
          filters: { search: "PV_Anlage" },
        })),
      );
      expect(underscore.totalCount).toBe(0);
    });

    it("M301-LIST-04: Archiv-Achse (active/archived/all)", async () => {
      const archived = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
          filters: { archived: "archived" },
        })),
      );
      expect(archived.totalCount).toBe(1);
      expect(archived.items[0].name).toBe("Archiviert");
      expect(archived.items[0].archivedAt).toBeTruthy();

      const all = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
          filters: { archived: "all" },
        })),
      );
      expect(all.totalCount).toBe(10);
    });

    it("M301-LIST-05: Keyset-Paginierung ohne Überlappung; ungültiger Cursor abgelehnt", async () => {
      const page1 = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
          filters: { archived: "all" }, limit: 3,
        })),
      );
      expect(page1.items).toHaveLength(3);
      expect(page1.totalCount).toBe(10);
      expect(page1.nextCursor).toBeTruthy();

      const page2 = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
          filters: { archived: "all" }, limit: 3, cursor: page1.nextCursor,
        })),
      );
      expect(page2.items).toHaveLength(3);
      const page1Ids = new Set(page1.items.map((item) => item.id));
      expect(page2.items.every((item) => !page1Ids.has(item.id))).toBe(true);

      // Bis zum Ende laufen → nextCursor null, 11 Elemente insgesamt ohne Duplikate.
      let cursor: string | null = page2.nextCursor;
      const seen = new Set([...page1Ids, ...page2.items.map((item) => item.id)]);
      while (cursor !== null) {
        const page = await withAuthorizedTenantOn(
          testPool, fixture.editorId, fixture.workspaceId,
          (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
            filters: { archived: "all" }, limit: 3, cursor,
          })),
        );
        for (const item of page.items) seen.add(item.id);
        cursor = page.nextCursor;
      }
      expect(seen.size).toBe(10);

      await expect(withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
          cursor: "kein-echter-cursor",
        })),
      )).rejects.toBeInstanceOf(InvoicingValidationError);

      // Kimi-P2-1: wohlgeformtes base64url-JSON, aber ungültige Formen —
      // muss als ValidationError scheitern, nicht im ::timestamptz-Cast.
      const forgedCursor = Buffer.from(
        JSON.stringify({ c: "garbage", i: "nicht-eine-uuid" }),
        "utf8",
      ).toString("base64url");
      await expect(withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
          cursor: forgedCursor,
        })),
      )).rejects.toBeInstanceOf(InvoicingValidationError);
      const forgedDate = Buffer.from(
        JSON.stringify({ c: "2026-09-01T10:00:00.000Z", i: "nicht-eine-uuid" }),
        "utf8",
      ).toString("base64url");
      await expect(withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", {
          cursor: forgedDate,
        })),
      )).rejects.toBeInstanceOf(InvoicingValidationError);
    });

    it("M301-LIST-06: Viewer liest read-only; Fremdtenant sieht nichts; Fremder scheitert", async () => {
      const viewerList = await withAuthorizedTenantOn(
        testPool, fixture.viewerId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice")),
      );
      expect(viewerList.permissions.canWrite).toBe(false);
      expect(viewerList.totalCount).toBeGreaterThan(0);

      // Fremdtenant: eigenes Workspace mit eigener Rechnung.
      const otherWorkspace = randomUUID();
      const otherEditor = randomUUID();
      await withTenantOn(testPool, otherWorkspace, async (tx) => {
        await tx.execute(sql`insert into workspace (id, name) values (${otherWorkspace}::uuid, 'Fremd')`);
        await tx.execute(sql`
          insert into user_identity (id, email) values (${otherEditor}::uuid, ${`other-${otherEditor}@m301a4.test`})
        `);
        await tx.execute(sql`
          insert into membership (id, workspace_id, user_id, role, capabilities)
          values (${randomUUID()}::uuid, ${otherWorkspace}::uuid, ${otherEditor}::uuid,
                  'editor', '{"invoicing":true}'::jsonb)
        `);
      });
      await seedDocument(
        { workspaceId: otherWorkspace, editorId: otherEditor, viewerId: otherEditor },
        { type: "invoice", name: "Fremd-Rechnung", status: "issued", createdAt: berlinIsoMinutesAgo(50), issuedAt: "2026-09-01T10:00:00+02:00", grossCents: 1000, netCents: 840, taxCents: 160, paymentStatus: "unpaid", dueDate: "2026-12-31" },
      );
      const crossTenant = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice", { filters: { archived: "all" } })),
      );
      expect(crossTenant.totalCount).toBe(10);
      expect(crossTenant.items.some((item) => item.name === "Fremd-Rechnung")).toBe(false);

      // Kein Membership → fail-closed.
      const stranger = randomUUID();
      await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
        await tx.execute(sql`
          insert into user_identity (id, email) values (${stranger}::uuid, ${`stranger-${stranger}@m301a4.test`})
        `);
      });
      await expect(withAuthorizedTenantOn(
        testPool, stranger, fixture.workspaceId,
        (tx, ctx) => listDocuments(tx, ctx, listCommand("invoice")),
      )).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  describe("M301-07 — getInvoicingReport", () => {
    it("M301-REP-01: KPI-Werte + Vormonats-Delta (Fluss-KPIs)", async () => {
      const report = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => getInvoicingReport(tx, ctx, {
          schemaVersion: INVOICING_REPORT_COMMAND_VERSION, month: "2026-09",
        }),
      );
      expect(report.schemaVersion).toBe(INVOICING_REPORT_VERSION);
      expect(report.monthStart).toBe("2026-09-01");
      expect(report.monthEnd).toBe("2026-10-01");
      // Einnahmen Sept: PV-Anlage 11900 + PV;Anlage 8000 + Gutschrift 2000
      // (voided ausgeschlossen, letter ohne Betrag).
      expect(report.revenueThisMonthCents).toBe(21900);
      expect(report.previousMonth.month).toBe("2026-08");
      expect(report.previousMonth.revenueCents).toBe(25000);
      // Cashflow Sept: Zahlungs-Update Speicher (20000).
      expect(report.cashflowThisMonthCents).toBe(20000);
      expect(report.previousMonth.cashflowCents).toBe(0);
      // Bestands-KPIs (all-time): offen 11900 + 5000 + 2000 + 5000.
      expect(report.outstandingCents).toBe(23900);
      expect(report.overdueCents).toBe(10000);
      // DECIDED: Bestands-KPIs ohne historische Momentaufnahme.
      expect(report.previousMonth.outstandingCents).toBeNull();
      expect(report.previousMonth.overdueCents).toBeNull();
      expect(report.permissions.canWrite).toBe(true);
    });

    it("M301-REP-02: Einnahmen-nach-Status = disjunkte Partition", async () => {
      const report = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => getInvoicingReport(tx, ctx, {
          schemaVersion: INVOICING_REPORT_COMMAND_VERSION, month: "2026-09",
        }),
      );
      const buckets = report.revenueByStatus;
      expect(buckets.draftCount).toBe(2);
      expect(buckets.voidedCount).toBe(1);
      expect(buckets.paidCount).toBe(1);
      expect(buckets.overdueCount).toBe(5);
      expect(buckets.sentCount).toBe(3);
      // Partition deckt alle 12 Dokumente ab.
      expect(
        buckets.draftCount + buckets.voidedCount + buckets.paidCount
        + buckets.overdueCount + buckets.sentCount,
      ).toBe(12);
      // Brutto-Summen: 0 + 5000 + 20000 + 13000 + 13900 = 51900.
      expect(buckets.voidedCents).toBe(5000);
      expect(buckets.paidCents).toBe(20000);
      expect(buckets.overdueCents).toBe(13000);
      expect(buckets.sentCents).toBe(13900);
    });

    it("M301-REP-03: Überfälligkeits-Buckets disjunkt + Gesamtausstand", async () => {
      const report = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => getInvoicingReport(tx, ctx, {
          schemaVersion: INVOICING_REPORT_COMMAND_VERSION, month: "2026-09",
        }),
      );
      const buckets = report.overdueBuckets;
      // 5 Tage (5000) + 10 Tage (4000) → 0–30; 45 (500); 75 (300); 100 (200).
      expect(buckets.days0To30Cents).toBe(9000);
      expect(buckets.days31To60Cents).toBe(500);
      expect(buckets.days61To90Cents).toBe(300);
      expect(buckets.over90Cents).toBe(200);
      expect(buckets.totalOutstandingCents).toBe(report.outstandingCents);
    });

    it("M301-REP-04: Neueste Dokumente max. 10, neueste zuerst; leerer Monat; Viewer", async () => {
      const report = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => getInvoicingReport(tx, ctx, {
          schemaVersion: INVOICING_REPORT_COMMAND_VERSION, month: "2026-09",
        }),
      );
      expect(report.latestDocuments.length).toBeLessThanOrEqual(10);
      expect(report.latestDocuments[0].name).toBe("Ankündigung");

      const empty = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => getInvoicingReport(tx, ctx, {
          schemaVersion: INVOICING_REPORT_COMMAND_VERSION, month: "2026-01",
        }),
      );
      expect(empty.revenueThisMonthCents).toBe(0);
      expect(empty.cashflowThisMonthCents).toBe(0);
      expect(empty.previousMonth.revenueCents).toBe(0);
      expect(empty.latestDocuments).toHaveLength(10);

      const viewer = await withAuthorizedTenantOn(
        testPool, fixture.viewerId, fixture.workspaceId,
        (tx, ctx) => getInvoicingReport(tx, ctx, {
          schemaVersion: INVOICING_REPORT_COMMAND_VERSION, month: "2026-09",
        }),
      );
      expect(viewer.permissions.canWrite).toBe(false);
    });

    it("M301-REP-05: ungültiger Monat abgelehnt", async () => {
      await expect(withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => getInvoicingReport(tx, ctx, {
          schemaVersion: INVOICING_REPORT_COMMAND_VERSION, month: "2026-13",
        }),
      )).rejects.toBeInstanceOf(InvoicingValidationError);
    });
  });

  describe("M301-07 — exportInvoicingReport (CSV)", () => {
    it("M301-CSV-01: Format, Euro-Dezimal, ISO-Daten, Escaping, Reihenfolge", async () => {
      const csv = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => exportInvoicingReport(tx, ctx, {
          schemaVersion: INVOICING_REPORT_COMMAND_VERSION, month: "2026-09",
        }),
      );
      expect(csv.schemaVersion).toBe(INVOICING_REPORT_CSV_VERSION);
      expect(csv.fileName).toBe("invoicing-report-2026-09.csv");
      expect(csv.contentType).toBe("text/csv; charset=utf-8");
      const lines = csv.content.split("\r\n");
      expect(lines[0]).toBe(
        "Typ;Nummer;Name;Status;Zahlungsstatus;Ausstellungsdatum;Fälligkeitsdatum;Netto (EUR);Steuer (EUR);Brutto (EUR);Bezahlt (EUR)",
      );
      // Issued-Dokumente im September: PV-Anlage (05.), PV;Anlage (15.),
      // Ankündigung (16.), Minderleistung (17.) — voided ist ausgeschlossen.
      const rows = lines.slice(1, -1);
      expect(rows).toHaveLength(4);
      expect(rows[0].startsWith("invoice;Rechnung-2026-09-1;PV-Anlage;issued;unpaid;2026-09-05;2026-10-01;100.00;19.00;119.00;0.00")).toBe(true);
      expect(rows[1].startsWith(
        `invoice;Rechnung-2026-09-3;"PV;Anlage";issued;overdue;2026-09-15;${berlinDateDaysAgo(5)};67.23;12.77;80.00;30.00`,
      )).toBe(true);
      expect(rows[2].startsWith("letter;LE-2026-09-16-1;Ankündigung;issued;;2026-09-16;;0.00;0.00;0.00;0.00")).toBe(true);
      expect(rows[3].startsWith("credit_note;CRN-2026-09-17-1;Minderleistung;issued;unpaid;2026-09-17;;16.81;3.19;20.00;0.00")).toBe(true);
      // Datei endet mit CRLF.
      expect(csv.content.endsWith("\r\n")).toBe(true);
    });

    it("M301-CSV-03: Quoting bei Anführungszeichen/Zeilenumbruch + Formula-Guard", async () => {
      // Eigener Workspace, damit die Partition-/KPI-Zählungen des geteilten
      // Fixtures unberührt bleiben (Kimi-P2-3/P2-5).
      const csvWorkspace = randomUUID();
      const csvEditor = randomUUID();
      await withTenantOn(testPool, csvWorkspace, async (tx) => {
        await tx.execute(sql`insert into workspace (id, name) values (${csvWorkspace}::uuid, 'CSV')`);
        await tx.execute(sql`
          insert into user_identity (id, email) values (${csvEditor}::uuid, ${`csv-${csvEditor}@m301a4.test`})
        `);
        await tx.execute(sql`
          insert into membership (id, workspace_id, user_id, role, capabilities)
          values (${randomUUID()}::uuid, ${csvWorkspace}::uuid, ${csvEditor}::uuid,
                  'editor', '{"invoicing":true}'::jsonb)
        `);
      });
      const csvFixture = { workspaceId: csvWorkspace, editorId: csvEditor, viewerId: csvEditor };
      await seedDocument(csvFixture, {
        type: "invoice", name: 'Heizung "Pro"\nZeile zwei', status: "issued",
        createdAt: berlinIsoMinutesAgo(30), issuedAt: "2026-09-10T10:00:00+02:00",
        grossCents: 11900, netCents: 10000, taxCents: 1900,
        paymentStatus: "unpaid", dueDate: "2026-10-01", number: "Rechnung-2026-09-9", sequence: 9,
      });
      await seedDocument(csvFixture, {
        type: "invoice", name: "=SUM(A1:A2)", status: "issued",
        createdAt: berlinIsoMinutesAgo(20), issuedAt: "2026-09-11T10:00:00+02:00",
        grossCents: 1000, netCents: 840, taxCents: 160,
        paymentStatus: "unpaid", dueDate: "2026-10-02", number: "Rechnung-2026-09-10", sequence: 10,
      });
      const csv = await withAuthorizedTenantOn(
        testPool, csvEditor, csvWorkspace,
        (tx, ctx) => exportInvoicingReport(tx, ctx, {
          schemaVersion: INVOICING_REPORT_COMMAND_VERSION, month: "2026-09",
        }),
      );
      const lines = csv.content.split("\r\n");
      expect(lines).toHaveLength(4);
      // Anführungszeichen verdoppelt, Zeilenumbruch bleibt im Feld erhalten.
      expect(lines[1].includes('"Heizung ""Pro""\nZeile zwei"')).toBe(true);
      // Formula-Guard: führendes = wird mit ' neutralisiert.
      expect(lines[2].includes("'=SUM(A1:A2)")).toBe(true);
    });

    it("M301-CSV-02: leerer Monat liefert nur den Header", async () => {
      const csv = await withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => exportInvoicingReport(tx, ctx, {
          schemaVersion: INVOICING_REPORT_COMMAND_VERSION, month: "2026-01",
        }),
      );
      const lines = csv.content.split("\r\n");
      expect(lines).toHaveLength(2);
      expect(lines[0].startsWith("Typ;Nummer;Name;Status")).toBe(true);
      expect(lines[1]).toBe("");
    });
  });
});
