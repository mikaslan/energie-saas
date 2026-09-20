import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  addBusinessDaysBerlin,
  isSubsidyCaseOverdue,
  isSubsidyCasePreApproval,
  SUBSIDY_CASE_BND_DUE_WORKDAYS,
  SUBSIDY_CASE_BZA_DUE_WORKDAYS,
  SUBSIDY_CASE_FEE_DEFAULT_CENTS,
  SUBSIDY_CASE_NAMEPLATE_SLOT,
} from "@/lib/subsidy-case";
import { bundHolidaysBerlin } from "@/lib/subsidy-holidays";
import {
  ensureSubsidyCase,
  getSubsidyCase,
  getSubsidyCaseFee,
  requestNameplatePhoto,
  setSubsidyCaseFee,
  SubsidyCaseNotFoundError,
  SubsidyCaseValidationError,
  transitionSubsidyCase,
} from "@/modules/subsidy-cases";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-13 Foerderung')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1313.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1313.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, viewerId };
}

// Berlin-Kalendertag eines Zeitpunkts — leitet den Versandtag aus dem
// persistierten Versand-Zeitstempel ab (mitternachtsfest, kein Heute-Raten).
function berlinDateOfInstant(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function holidaysAround(startIsoDate: string): string[] {
  const year = Number(startIsoDate.slice(0, 4));
  return [...bundHolidaysBerlin(year), ...bundHolidaysBerlin(year + 1)];
}

describe("F13-13 Förder-Fristen-Preis (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn);
  const asViewer = <T>(fx: Fixture, fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn);

  const seedProject = async (fx: Fixture, suffix: string): Promise<string> => {
    const lead = await asEditor(fx, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: `Foerder ${suffix}`, phone: "+49 171 4444444" }),
    );
    return lead.projectId;
  };

  it("F1313-DB-01: Stammdatum-Default, Snapshot-Altschutz, kein F8-Write", async () => {
    expect(SUBSIDY_CASE_FEE_DEFAULT_CENTS).toBe(21_000);
    expect(await asEditor(fixture, (tx, ctx) => getSubsidyCaseFee(tx, ctx))).toBe(21_000);

    const projectId = await seedProject(fixture, "Alt");
    const kase = await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    expect(kase.feeCents).toBe(21_000);
    expect(kase.bzaDueDate).toBeNull();
    expect(kase.bndDueDate).toBeNull();
    expect(kase.overdue).toBe(false);
    expect(kase.preApproval).toBe(true);

    const saved = await asEditor(fixture, (tx, ctx) =>
      setSubsidyCaseFee(tx, ctx, { projectId, feeCents: 25_000 }),
    );
    expect(saved).toBe(25_000);
    expect(await asEditor(fixture, (tx, ctx) => getSubsidyCaseFee(tx, ctx))).toBe(25_000);

    const projectId2 = await seedProject(fixture, "Neu");
    const fresh = await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId2));
    expect(fresh.feeCents).toBe(25_000);
    const kept = await asEditor(fixture, (tx, ctx) => getSubsidyCase(tx, ctx, projectId));
    expect(kept?.feeCents).toBe(21_000);

    // KEINE Auto-F8-Rechnung: commercial_document bleibt leer.
    const docs = await asEditor(fixture, (tx, ctx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from commercial_document
         where workspace_id = ${ctx.workspaceId}::uuid
      `).then((result) => result.rows[0]?.n),
    );
    expect(docs).toBe(0);

    // Fehlform + Rechte: negativ/NaN abgewiesen, Viewer darf lesen, nicht schreiben.
    await expect(
      asEditor(fixture, (tx, ctx) => setSubsidyCaseFee(tx, ctx, { projectId, feeCents: -1 })),
    ).rejects.toBeInstanceOf(SubsidyCaseValidationError);
    await expect(
      asEditor(fixture, (tx, ctx) => setSubsidyCaseFee(tx, ctx, { projectId, feeCents: NaN })),
    ).rejects.toBeInstanceOf(SubsidyCaseValidationError);
    await expect(
      asEditor(fixture, (tx, ctx) => setSubsidyCaseFee(tx, ctx, { projectId: "keine-uuid", feeCents: 100 })),
    ).rejects.toBeInstanceOf(SubsidyCaseValidationError);
    expect(await asViewer(fixture, (tx, ctx) => getSubsidyCaseFee(tx, ctx))).toBe(25_000);
    await expect(
      asViewer(fixture, (tx, ctx) => setSubsidyCaseFee(tx, ctx, { projectId, feeCents: 100 })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F1313-DB-02: AT-Fälligkeit, Überfällig nur bei offener Phase, Re-Transition", async () => {
    // Reine AT-Rechnung (deterministisch, Feiertagsquelle Bund).
    expect(SUBSIDY_CASE_BZA_DUE_WORKDAYS).toBe(3);
    expect(SUBSIDY_CASE_BND_DUE_WORKDAYS).toBe(5);
    const holidays2026 = bundHolidaysBerlin(2026);
    expect(holidays2026).toHaveLength(9);
    expect(holidays2026).toContain("2026-04-03");
    expect(holidays2026).toContain("2026-04-06");
    // Fr + 3 AT = Mi (Wochenende übersprungen).
    expect(addBusinessDaysBerlin("2026-09-18", 3, holidays2026)).toBe("2026-09-23");
    // Karfreitag-Sprung: Do + 1 AT = Di (Feiertag + WE + Ostermontag).
    expect(addBusinessDaysBerlin("2026-04-02", 1, holidays2026)).toBe("2026-04-07");
    // Mo + 5 AT = Mo.
    expect(addBusinessDaysBerlin("2026-09-14", 5, holidays2026)).toBe("2026-09-21");
    expect(
      isSubsidyCaseOverdue({ dueDate: "2026-01-01", todayIso: "2026-01-02", phaseOpen: true }),
    ).toBe(true);
    expect(
      isSubsidyCaseOverdue({ dueDate: "2026-01-01", todayIso: "2026-01-02", phaseOpen: false }),
    ).toBe(false);
    expect(
      isSubsidyCaseOverdue({ dueDate: null, todayIso: "2026-01-02", phaseOpen: true }),
    ).toBe(false);
    expect(
      isSubsidyCaseOverdue({ dueDate: "2026-01-02", todayIso: "2026-01-02", phaseOpen: true }),
    ).toBe(false);
    for (const status of ["draft", "vorbereitung", "bza_eingereicht", "korrektur"] as const) {
      expect(isSubsidyCasePreApproval(status)).toBe(true);
    }
    for (const status of ["bza_bewilligt", "bnd_eingereicht", "abgeschlossen", "storniert"] as const) {
      expect(isSubsidyCasePreApproval(status)).toBe(false);
    }

    // Verdrahtung: Versand setzt Fälligkeit ab Versandtag-Berlin-Datum.
    const projectId = await seedProject(fixture, "Frist");
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "vorbereitung" }));
    const dispatched = await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "bza_eingereicht" }));
    if (!dispatched.bzaSubmittedAt) throw new Error("bzaSubmittedAt fehlt");
    const bzaStart = berlinDateOfInstant(dispatched.bzaSubmittedAt);
    expect(dispatched.bzaDueDate).toBe(
      addBusinessDaysBerlin(bzaStart, SUBSIDY_CASE_BZA_DUE_WORKDAYS, holidaysAround(bzaStart)),
    );
    expect(dispatched.bndDueDate).toBeNull();
    expect(dispatched.overdue).toBe(false);
    expect(dispatched.preApproval).toBe(true);

    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "bza_bewilligt" }));
    const bndSent = await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "bnd_eingereicht" }));
    if (!bndSent.bndSubmittedAt) throw new Error("bndSubmittedAt fehlt");
    const bndStart = berlinDateOfInstant(bndSent.bndSubmittedAt);
    expect(bndSent.bzaDueDate).toBe(dispatched.bzaDueDate);
    expect(bndSent.bndDueDate).toBe(
      addBusinessDaysBerlin(bndStart, SUBSIDY_CASE_BND_DUE_WORKDAYS, holidaysAround(bndStart)),
    );
    expect(bndSent.overdue).toBe(false);
    expect(bndSent.preApproval).toBe(false);

    // Überfällig nur bei offener Phase (BnD-Seite).
    await asEditor(fixture, (tx, ctx) =>
      tx.execute(sql`
        update subsidy_case set bnd_due_date = '2000-01-05'::date
         where workspace_id = ${ctx.workspaceId}::uuid and project_id = ${projectId}::uuid
      `),
    );
    expect((await asEditor(fixture, (tx, ctx) => getSubsidyCase(tx, ctx, projectId)))?.overdue).toBe(true);
    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId, status: "abgeschlossen" }));
    expect((await asEditor(fixture, (tx, ctx) => getSubsidyCase(tx, ctx, projectId)))?.overdue).toBe(false);

    // Überfällig nur bei offener Phase (BzA-Seite) + Re-Transition setzt neu.
    const projectId2 = await seedProject(fixture, "Frist2");
    await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId2));
    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId: projectId2, status: "vorbereitung" }));
    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId: projectId2, status: "bza_eingereicht" }));
    await asEditor(fixture, (tx, ctx) =>
      tx.execute(sql`
        update subsidy_case set bza_due_date = '2000-01-05'::date
         where workspace_id = ${ctx.workspaceId}::uuid and project_id = ${projectId2}::uuid
      `),
    );
    expect((await asEditor(fixture, (tx, ctx) => getSubsidyCase(tx, ctx, projectId2)))?.overdue).toBe(true);
    await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId: projectId2, status: "korrektur" }));
    const resent = await asEditor(fixture, (tx, ctx) =>
      transitionSubsidyCase(tx, ctx, { projectId: projectId2, status: "bza_eingereicht" }));
    if (!resent.bzaSubmittedAt) throw new Error("bzaSubmittedAt fehlt");
    const resendStart = berlinDateOfInstant(resent.bzaSubmittedAt);
    expect(resent.bzaDueDate).toBe(
      addBusinessDaysBerlin(resendStart, SUBSIDY_CASE_BZA_DUE_WORKDAYS, holidaysAround(resendStart)),
    );
    expect(resent.bzaDueDate).not.toBe("2000-01-05");
    expect(resent.overdue).toBe(false);
  });

  it("F1313-DB-03: Typenschild-Foto-Slot als Akten-Beleg (ohne KI)", async () => {
    expect(SUBSIDY_CASE_NAMEPLATE_SLOT).toBe("typenschild-foto");
    const projectId = await seedProject(fixture, "Schild");
    await expect(
      asEditor(fixture, (tx, ctx) => requestNameplatePhoto(tx, ctx, { projectId })),
    ).rejects.toBeInstanceOf(SubsidyCaseNotFoundError);

    const kase = await asEditor(fixture, (tx, ctx) => ensureSubsidyCase(tx, ctx, projectId));
    const request = await asEditor(fixture, (tx, ctx) =>
      requestNameplatePhoto(tx, ctx, { projectId }),
    );
    expect(request.subsidyCaseId).toBe(kase.id);
    expect(request.title).toBe("typenschild-foto");
    expect(request.slotType).toBe("typenschild_foto");
    expect(request.status).toBe("offen");
    const stored = await asEditor(fixture, (tx, ctx) =>
      tx.execute<{ title: string; slot_type: string; subsidy_case_id: string }>(sql`
        select title, slot_type, subsidy_case_id from file_request
         where workspace_id = ${ctx.workspaceId}::uuid and id = ${request.id}::uuid
      `).then((result) => result.rows[0]),
    );
    expect(stored).toMatchObject({
      title: "typenschild-foto",
      slot_type: "typenschild_foto",
      subsidy_case_id: kase.id,
    });
  });
});
