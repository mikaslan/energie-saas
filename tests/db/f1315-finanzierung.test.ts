import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { hashPortalToken, PORTAL_INVITE_CREATE_VERSION } from "@/lib/integrations/portal/portal-contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  createFinancingCase,
  FINANCING_CASE_TRANSITION_EVENT,
  FinancingCaseNotFoundError,
  FinancingCaseValidationError,
  getFinancingCase,
  isAllowedFinancingCaseTransition,
  listFinancingCases,
  nextFinancingCaseStatuses,
  postFinancingRequestByToken,
  setFinancingCaseStatus,
} from "@/modules/financing-cases";
import { createPortalInvite, resolvePortalByToken } from "@/modules/portal";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-15 Finanzierung')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1315.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1315.test`})
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

describe("F13-15 Finanzierungs-Intake (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  const seedProject = async (fx: Fixture): Promise<string> => {
    const lead = await asEditor(fx, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Finanz Lead", phone: "+49 171 4444444" }),
    );
    return lead.projectId;
  };

  const countEvents = async (fx: Fixture, eventType: string): Promise<number> =>
    withTenantOn(testPool, fx.workspaceId, async (tx) => {
      const result = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from domain_events
         where workspace_id = ${fx.workspaceId}::uuid
           and event_type = ${eventType}
      `);
      return result.rows[0]?.n ?? 0;
    });

  it("F1315-DB-01: Guards — Ratenkauf-Schranken, PSD frei, Provider-Mismatch (§1)", async () => {
    const projectId = await seedProject(fixture);
    const base = { projectId, produkttyp: "ratenkauf", provider: "bees_bears" } as const;

    // Laufzeit ausserhalb 1–25.
    await expect(
      asEditor(fixture, (tx, ctx) =>
        createFinancingCase(tx, ctx, { ...base, laufzeitJahre: 0, volumenEurCents: 1000 })),
    ).rejects.toBeInstanceOf(FinancingCaseValidationError);
    await expect(
      asEditor(fixture, (tx, ctx) =>
        createFinancingCase(tx, ctx, { ...base, laufzeitJahre: 26, volumenEurCents: 1000 })),
    ).rejects.toBeInstanceOf(FinancingCaseValidationError);
    // Volumen über 70.000 €.
    await expect(
      asEditor(fixture, (tx, ctx) =>
        createFinancingCase(tx, ctx, { ...base, laufzeitJahre: 10, volumenEurCents: 7_000_001 })),
    ).rejects.toBeInstanceOf(FinancingCaseValidationError);
    // Provider-Mismatch beidseitig.
    await expect(
      asEditor(fixture, (tx, ctx) =>
        createFinancingCase(tx, ctx, { ...base, provider: "psd_bank", laufzeitJahre: 10, volumenEurCents: 1000 })),
    ).rejects.toBeInstanceOf(FinancingCaseValidationError);
    await expect(
      asEditor(fixture, (tx, ctx) =>
        createFinancingCase(tx, ctx, {
          projectId, produkttyp: "kredit", provider: "bees_bears",
          laufzeitJahre: 10, volumenEurCents: 1000,
        })),
    ).rejects.toBeInstanceOf(FinancingCaseValidationError);

    // Grenzen gültig: 1 J. / 25 J. / 70.000 €.
    const min = await asEditor(fixture, (tx, ctx) =>
      createFinancingCase(tx, ctx, { ...base, laufzeitJahre: 1, volumenEurCents: 100 }));
    expect(min.status).toBe("beantragt");
    expect(min.beantragtAt).not.toBeNull();
    await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, { id: min.id, status: "storniert" }));
    const max = await asEditor(fixture, (tx, ctx) =>
      createFinancingCase(tx, ctx, { ...base, laufzeitJahre: 25, volumenEurCents: 7_000_000 }));

    // PSD-Kredit: ohne Katalogschranke (nur positiv + ganzzahlig).
    const psdProject = await seedProject(fixture);
    const psd = await asEditor(fixture, (tx, ctx) =>
      createFinancingCase(tx, ctx, {
        projectId: psdProject, produkttyp: "kredit", provider: "psd_bank",
        laufzeitJahre: 40, volumenEurCents: 500_000_00,
      }));
    expect(psd.status).toBe("beantragt");
    const psdProject2 = await seedProject(fixture);
    await expect(
      asEditor(fixture, (tx, ctx) =>
        createFinancingCase(tx, ctx, {
          projectId: psdProject2, produkttyp: "kredit", provider: "psd_bank",
          laufzeitJahre: 0, volumenEurCents: 1000,
        })),
    ).rejects.toBeInstanceOf(FinancingCaseValidationError);

    expect(max.volumenEurCents).toBe(7_000_000);
    expect(FINANCING_CASE_TRANSITION_EVENT).toBe("financing_case.transition");
  });

  it("F1315-DB-02: Maschine §2 — Kette, Kanten, terminal, No-op, 1-aktiv-UQ", async () => {
    const projectId = await seedProject(fixture);
    const created = await asEditor(fixture, (tx, ctx) =>
      createFinancingCase(tx, ctx, {
        projectId, produkttyp: "ratenkauf", provider: "bees_bears",
        laufzeitJahre: 12, volumenEurCents: 4237117,
      }));
    // KEIN created-Event (Owner-DECIDED).
    expect(await countEvents(fixture, "financing_case.created")).toBe(0);
    // Genau ein aktiver Vorgang: zweite Anlage scheitert (Service-Check).
    await expect(
      asEditor(fixture, (tx, ctx) =>
        createFinancingCase(tx, ctx, {
          projectId, produkttyp: "ratenkauf", provider: "bees_bears",
          laufzeitJahre: 5, volumenEurCents: 1000,
        })),
    ).rejects.toBeInstanceOf(FinancingCaseValidationError);
    // DB-Netz: direkter Zweit-Insert verletzt die partial-UQ (23505).
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const attempt = tx.execute(sql`
        insert into financing_case (
          workspace_id, project_id, produkttyp, laufzeit_jahre,
          volumen_eur_cents, provider, status, beantragt_at, created_by
        ) values (
          ${fixture.workspaceId}::uuid, ${projectId}::uuid, 'ratenkauf', 5,
          1000, 'bees_bears', 'beantragt', statement_timestamp(), ${fixture.editorId}::uuid
        )
      `);
      await expect(attempt).rejects.toMatchObject({ cause: { code: "23505" } });
    });

    // Sprung über bonitaet ist verboten.
    await expect(
      asEditor(fixture, (tx, ctx) =>
        setFinancingCaseStatus(tx, ctx, { id: created.id, status: "entschieden" })),
    ).rejects.toBeInstanceOf(FinancingCaseValidationError);

    // No-op (wertgleich): kein Event, kein Touch.
    const eventsBefore = await countEvents(fixture, "financing_case.transition");
    const noop = await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, { id: created.id, status: "beantragt" }));
    expect(noop.status).toBe("beantragt");
    expect(noop.updatedAt).toBe(created.updatedAt);
    expect(await countEvents(fixture, "financing_case.transition")).toBe(eventsBefore);

    // Kette mit Phasenstempeln + Referenz am Human-Gate.
    const bonitaet = await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, { id: created.id, status: "bonitaet" }));
    expect(bonitaet.status).toBe("bonitaet");
    const entschieden = await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, {
        id: created.id, status: "entschieden", providerReferenz: "BB-2026-REF-9",
      }));
    expect(entschieden.entschiedenAt).not.toBeNull();
    expect(entschieden.providerReferenz).toBe("BB-2026-REF-9");
    const ausgezahlt = await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, { id: created.id, status: "ausgezahlt" }));
    expect(ausgezahlt.ausgezahltAt).not.toBeNull();
    const done = await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, { id: created.id, status: "abgeschlossen" }));
    expect(done.abgeschlossenAt).not.toBeNull();

    // Event/Audit ohne PII über IDs/Status hinaus.
    const observed = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const events = await tx.execute<{ event_type: string; payload: unknown }>(sql`
        select event_type, payload from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid
           and event_type = 'financing_case.transition'
         order by occurred_at desc, id desc
         limit 1
      `);
      const audits = await tx.execute<{ action: string; details: unknown }>(sql`
        select action, details from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and action = 'financing_case.transition'
         order by occurred_at desc, id desc
         limit 1
      `);
      return { event: events.rows[0], audit: audits.rows[0] };
    });
    expect(observed.event?.payload).toMatchObject({ caseId: created.id, from: "ausgezahlt", to: "abgeschlossen" });
    expect(observed.audit?.details).toMatchObject({
      projectId, caseId: created.id, from: "ausgezahlt", to: "abgeschlossen",
    });
    expect(JSON.stringify(observed)).not.toContain("4237117");
    expect(JSON.stringify(observed)).not.toContain("BB-2026-REF-9");

    // Terminal: kein Ausgang aus abgeschlossen.
    await expect(
      asEditor(fixture, (tx, ctx) =>
        setFinancingCaseStatus(tx, ctx, { id: created.id, status: "bonitaet" })),
    ).rejects.toBeInstanceOf(FinancingCaseValidationError);
    expect(nextFinancingCaseStatuses("abgeschlossen")).toEqual([]);
    expect(nextFinancingCaseStatuses("abgelehnt")).toEqual([]);
    expect(nextFinancingCaseStatuses("storniert")).toEqual([]);
    expect(isAllowedFinancingCaseTransition("entschieden", "abgelehnt")).toBe(true);
    expect(isAllowedFinancingCaseTransition("ausgezahlt", "storniert")).toBe(false);

    // Reopen nur via neuen Vorgang: nach Abschluss ist Neuanlage frei.
    const fresh = await asEditor(fixture, (tx, ctx) =>
      createFinancingCase(tx, ctx, {
        projectId, produkttyp: "kredit", provider: "psd_bank",
        laufzeitJahre: 15, volumenEurCents: 2000000,
      }));
    expect(fresh.status).toBe("beantragt");
    const listed = await asEditor(fixture, (tx, ctx) => listFinancingCases(tx, ctx, { projectId }));
    expect(listed).toHaveLength(2);

    // abgelehnt/storniert-Kanten aus beantragt/bonitaet/entschieden.
    const p2 = await seedProject(fixture);
    const c2 = await asEditor(fixture, (tx, ctx) =>
      createFinancingCase(tx, ctx, {
        projectId: p2, produkttyp: "ratenkauf", provider: "bees_bears",
        laufzeitJahre: 7, volumenEurCents: 5000,
      }));
    const denied = await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, { id: c2.id, status: "abgelehnt" }));
    expect(denied.status).toBe("abgelehnt");
    expect(denied.entschiedenAt).toBeNull();
    const p3 = await seedProject(fixture);
    const c3 = await asEditor(fixture, (tx, ctx) =>
      createFinancingCase(tx, ctx, {
        projectId: p3, produkttyp: "ratenkauf", provider: "bees_bears",
        laufzeitJahre: 7, volumenEurCents: 5000,
      }));
    await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, { id: c3.id, status: "bonitaet" }));
    const cancelled = await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, { id: c3.id, status: "storniert" }));
    expect(cancelled.status).toBe("storniert");
    // Nach Ablehnung ist Neuanlage frei (terminale Historie).
    const afterDeny = await asEditor(fixture, (tx, ctx) =>
      createFinancingCase(tx, ctx, {
        projectId: p2, produkttyp: "ratenkauf", provider: "bees_bears",
        laufzeitJahre: 7, volumenEurCents: 5000,
      }));
    await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, { id: afterDeny.id, status: "bonitaet" }));
    await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, { id: afterDeny.id, status: "entschieden" }));
    await expect(
      asEditor(fixture, (tx, ctx) =>
        setFinancingCaseStatus(tx, ctx, { id: afterDeny.id, status: "storniert" })),
    ).resolves.toMatchObject({ status: "storniert" });
  });

  it("F1315-DB-03: Portal-Projektion — grober Stand, storniert→null, nie Details (§4)", async () => {
    const projectId = await seedProject(fixture);
    const created = await asEditor(fixture, (tx, ctx) =>
      createFinancingCase(tx, ctx, {
        projectId, produkttyp: "ratenkauf", provider: "bees_bears",
        laufzeitJahre: 12, volumenEurCents: 4237117,
      }));
    await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, { id: created.id, status: "bonitaet" }));
    await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, {
        id: created.id, status: "entschieden", providerReferenz: "BB-PORTAL-REF-7",
      }));
    const invite = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
        createPortalInvite(tx, ctx, {
          schemaVersion: PORTAL_INVITE_CREATE_VERSION,
          workspaceId: fixture.workspaceId,
          projectId,
          ttlDays: 14,
        }),
    );
    const view = await resolvePortalByToken(testPool, { token: invite.token });
    expect(view.financing).toMatchObject({ status: "entschieden", produkttyp: "ratenkauf" });
    expect(view.financing?.beantragtAt).not.toBeNull();
    expect(view.financing?.entschiedenAt).not.toBeNull();
    expect(Object.keys(view.financing ?? {}).sort()).toEqual([
      "abgeschlossenAt", "ausgezahltAt", "beantragtAt",
      "entschiedenAt", "produkttyp", "status",
    ]);
    // Nie-sensible-Nummern (§4): Referenz/Volumen/Laufzeit treten nie aus.
    expect(JSON.stringify(view)).not.toContain("BB-PORTAL-REF-7");
    expect(JSON.stringify(view)).not.toContain("4237117");
    expect(view.financing).not.toHaveProperty("providerReferenz");
    expect(view.financing).not.toHaveProperty("volumenEur");
    expect(view.financing).not.toHaveProperty("laufzeitJahre");

    // Storniert blendet als null aus (kein Portal-Block).
    await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, { id: created.id, status: "storniert" }));
    const afterCancel = await resolvePortalByToken(testPool, { token: invite.token });
    expect(afterCancel.financing).toBeNull();

    // P0-Repro (Owner): terminale Historie + aktiver Vorgang → Resolver
    // zeigt genau den aktiven (kein Multi-Row-Crash in der Subquery).
    const second = await asEditor(fixture, (tx, ctx) =>
      createFinancingCase(tx, ctx, {
        projectId, produkttyp: "kredit", provider: "psd_bank",
        laufzeitJahre: 15, volumenEurCents: 12_000_000,
      }));
    expect(second.status).toBe("beantragt");
    const withHistory = await resolvePortalByToken(testPool, { token: invite.token });
    expect(withHistory.financing).toMatchObject({ status: "beantragt", produkttyp: "kredit" });
  });

  it("F1315-DB-04: Lesen installation.read, Schreiben denied, NotFound, Isolation", async () => {
    const projectId = await seedProject(fixture);
    const created = await asEditor(fixture, (tx, ctx) =>
      createFinancingCase(tx, ctx, {
        projectId, produkttyp: "ratenkauf", provider: "bees_bears",
        laufzeitJahre: 10, volumenEurCents: 9000,
      }));

    const seen = await asViewer(fixture, (tx, ctx) => getFinancingCase(tx, ctx, created.id));
    expect(seen?.status).toBe("beantragt");
    expect(seen?.permissions.canWrite).toBe(false);
    const listed = await asViewer(fixture, (tx, ctx) => listFinancingCases(tx, ctx, { projectId }));
    expect(listed).toHaveLength(1);
    await expect(
      asViewer(fixture, (tx, ctx) =>
        createFinancingCase(tx, ctx, {
          projectId, produkttyp: "ratenkauf", provider: "bees_bears",
          laufzeitJahre: 10, volumenEurCents: 9000,
        })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      asViewer(fixture, (tx, ctx) =>
        setFinancingCaseStatus(tx, ctx, { id: created.id, status: "bonitaet" })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    // NotFound ohne Orakel: unbekannte IDs, fremdes Projekt.
    await expect(
      asEditor(fixture, (tx, ctx) => getFinancingCase(tx, ctx, randomUUID())),
    ).resolves.toBeNull();
    await expect(
      asEditor(fixture, (tx, ctx) =>
        setFinancingCaseStatus(tx, ctx, { id: randomUUID(), status: "bonitaet" })),
    ).rejects.toBeInstanceOf(FinancingCaseNotFoundError);
    await expect(
      asEditor(fixture, (tx, ctx) =>
        createFinancingCase(tx, ctx, {
          projectId: randomUUID(), produkttyp: "ratenkauf", provider: "bees_bears",
          laufzeitJahre: 10, volumenEurCents: 9000,
        })),
    ).rejects.toBeInstanceOf(FinancingCaseNotFoundError);

    // Fremdtenant sieht nichts.
    const foreign: Fixture = await seedFixture();
    const cross = await asEditor(fixture, (tx, ctx) => getFinancingCase(tx, ctx, created.id));
    expect(cross?.id).toBe(created.id);
    const foreignSeen = await withAuthorizedTenantOn(
      testPool, foreign.editorId, foreign.workspaceId, (tx, ctx) =>
        getFinancingCase(tx as never, ctx as never, created.id),
    );
    expect(foreignSeen).toBeNull();
  });

  it("F1315-DB-05: Antrags-Kapsel — Portal-Pfad, Guards, kein Orakel (Owner, §1/§5)", async () => {
    const projectId = await seedProject(fixture);
    const invite = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId, (tx, ctx) =>
        createPortalInvite(tx, ctx, {
          schemaVersion: PORTAL_INVITE_CREATE_VERSION,
          workspaceId: fixture.workspaceId,
          projectId,
          ttlDays: 14,
        }),
    );
    const request = {
      token: invite.token,
      produkttyp: "ratenkauf",
      laufzeitJahre: 12,
      volumenCents: 4_500_000,
      provider: "bees_bears",
    } as const;
    // Happy-Path via Wrapper: Fall-ID (uuid).
    const first = await postFinancingRequestByToken(testPool, { ...request });
    expect(first.caseId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Bereits-aktiver Vorgang → NotFound (kein Orakel).
    await expect(postFinancingRequestByToken(testPool, { ...request })).rejects.toBeInstanceOf(
      FinancingCaseNotFoundError,
    );
    // Toter Link → NotFound.
    await expect(
      postFinancingRequestByToken(testPool, { ...request, token: `f1315-tot-${randomUUID()}` }),
    ).rejects.toBeInstanceOf(FinancingCaseNotFoundError);

    // Terminal storniert → Kapsel-Direktaufrufe ohne active_exists-Schatten.
    const listed = await asEditor(fixture, (tx, ctx) => listFinancingCases(tx, ctx, { projectId }));
    expect(listed).toHaveLength(1);
    const [row] = listed;
    if (!row) throw new Error("Kapsel-Antrag legte keinen Vorgang an.");
    await asEditor(fixture, (tx, ctx) =>
      setFinancingCaseStatus(tx, ctx, { id: row.id, status: "storniert" }));

    const tokenHash = hashPortalToken(invite.token);
    expect(tokenHash).not.toBeNull();
    const capsule = async (produkttyp: string, laufzeit: number, volumen: number, provider: string) => {
      const res = await testPool.query<{ id: string | null }>(
        `select public.request_financing_case_by_token($1::bytea, $2::text, $3::integer, $4::integer, $5::text) as id`,
        [tokenHash, produkttyp, laufzeit, volumen, provider],
      );
      return res.rows[0]?.id ?? null;
    };
    // P1-Guard: Mismatch-Paarung kredit+bees_bears → NULL.
    expect(await capsule("kredit", 10, 100_000, "bees_bears")).toBeNull();
    // Ratenkauf-Übervolumen → NULL.
    expect(await capsule("ratenkauf", 10, 7_000_001, "bees_bears")).toBeNull();
    // Positiv-Kontrolle: korrekter Kredit legt an (nur die Paarung blockte).
    const second = await capsule("kredit", 10, 100_000, "psd_bank");
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
