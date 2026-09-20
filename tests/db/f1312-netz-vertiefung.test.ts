import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import {
  ensureGridRegistration,
  getGridRegistration,
  GRID_REGISTRATION_ADDONS,
  GRID_REGISTRATION_EDITABLE_STATUSES,
  GRID_REGISTRATION_FERTIGMELDUNG_MIN_PHOTOS,
  GRID_REGISTRATION_FERTIGMELDUNG_REQUIRES_METER,
  GridRegistrationValidationError,
  setGridRegistrationAddons,
  setGridRegistrationDetails,
  transitionGridRegistration,
} from "@/modules/grid-registration";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-12 Netz')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1312.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1312.test`})
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

describe("F13-12 Netzanmeldung-Vertiefung (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  const seedProject = async (fx: Fixture): Promise<string> => {
    const lead = await asEditor(fx, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: "Netz Lead", phone: "+49 171 2222222" }),
    );
    return lead.projectId;
  };

  const walkToEinspeisezusage = async (fx: Fixture, projectId: string): Promise<void> => {
    await asEditor(fx, (tx, ctx) => ensureGridRegistration(tx, ctx, projectId));
    for (const status of ["eingereicht", "genehmigt", "einspeisezusage"] as const) {
      const next = await asEditor(fx, (tx, ctx) =>
        transitionGridRegistration(tx, ctx, { projectId, status }),
      );
      expect(next.status).toBe(status);
    }
  };

  it("F1312-DB-01: Rückfrage-Loop, Einspeisezusage-Kette, Wiedereröffnung, terminal", async () => {
    const projectId = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureGridRegistration(tx, ctx, projectId));
    await asEditor(fixture, (tx, ctx) => setGridRegistrationDetails(tx, ctx, {
      projectId, operatorName: "Netze BW", meterNumber: "1EMH0099988776",
    }));

    // Rückfrage-Loop: eingereicht ↔ rueckfrage begehbar.
    await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "eingereicht" }));
    const loop = await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "rueckfrage" }));
    expect(loop.status).toBe("rueckfrage");
    const resubmitted = await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "eingereicht" }));
    expect(resubmitted.status).toBe("eingereicht");

    // Einspeisezusage-Kette: genehmigt → einspeisezusage → fertiggemeldet.
    await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "genehmigt" }));
    await expect(asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "fertiggemeldet", photoCount: 16 }),
    )).rejects.toBeInstanceOf(GridRegistrationValidationError);
    await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "einspeisezusage" }));
    const gemeldet = await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "fertiggemeldet", photoCount: 16 }));
    expect(gemeldet.status).toBe("fertiggemeldet");
    const done = await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "abgeschlossen" }));
    expect(done.status).toBe("abgeschlossen");

    // abgeschlossen bleibt terminal.
    await expect(asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "storniert" }),
    )).rejects.toBeInstanceOf(GridRegistrationValidationError);

    // Wiedereröffnung: storniert → vorbereitung möglich, sonst nichts.
    const reopened = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureGridRegistration(tx, ctx, reopened));
    await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId: reopened, status: "storniert" }));
    await expect(asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId: reopened, status: "eingereicht" }),
    )).rejects.toBeInstanceOf(GridRegistrationValidationError);
    const back = await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId: reopened, status: "vorbereitung" }));
    expect(back.status).toBe("vorbereitung");
  });

  it("F1312-DB-02: Fertigmeldungs-Guards (Zählernummer + ≥16 Fotos)", async () => {
    expect(GRID_REGISTRATION_FERTIGMELDUNG_REQUIRES_METER).toBe(true);
    expect(GRID_REGISTRATION_FERTIGMELDUNG_MIN_PHOTOS).toBe(16);

    // Ohne Zählernummer abgewiesen (trotz 16 Fotos).
    const noMeter = await seedProject(fixture);
    await walkToEinspeisezusage(fixture, noMeter);
    await expect(asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId: noMeter, status: "fertiggemeldet", photoCount: 16 }),
    )).rejects.toBeInstanceOf(GridRegistrationValidationError);

    // Mit Zählernummer, aber zu wenig / ohne Fotos abgewiesen.
    const fewPhotos = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureGridRegistration(tx, ctx, fewPhotos));
    await asEditor(fixture, (tx, ctx) => setGridRegistrationDetails(tx, ctx, {
      projectId: fewPhotos, operatorName: "Netze BW", meterNumber: "1EMH0011223344",
    }));
    for (const status of ["eingereicht", "genehmigt", "einspeisezusage"] as const) {
      await asEditor(fixture, (tx, ctx) =>
        transitionGridRegistration(tx, ctx, { projectId: fewPhotos, status }));
    }
    await expect(asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId: fewPhotos, status: "fertiggemeldet", photoCount: 15 }),
    )).rejects.toBeInstanceOf(GridRegistrationValidationError);
    await expect(asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId: fewPhotos, status: "fertiggemeldet" }),
    )).rejects.toBeInstanceOf(GridRegistrationValidationError);
    // NaN-hart: NaN < 16 ist false — trotzdem abgewiesen (Owner-Review-Fund).
    await expect(asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId: fewPhotos, status: "fertiggemeldet", photoCount: Number.NaN }),
    )).rejects.toBeInstanceOf(GridRegistrationValidationError);

    // Mit Zählernummer + 16 Fotos offen.
    const ok = await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId: fewPhotos, status: "fertiggemeldet", photoCount: 16 }));
    expect(ok.status).toBe("fertiggemeldet");
  });

  it("F1312-DB-03: Details-Sperre ab eingereicht, Frist = Einreichung + 6 Monate", async () => {
    expect(GRID_REGISTRATION_EDITABLE_STATUSES).toEqual(["vorbereitung", "rueckfrage"]);

    const projectId = await seedProject(fixture);
    await asEditor(fixture, (tx, ctx) => ensureGridRegistration(tx, ctx, projectId));

    // Offen in vorbereitung.
    const initial = await asEditor(fixture, (tx, ctx) => setGridRegistrationDetails(tx, ctx, {
      projectId, operatorName: "Netze BW", meterNumber: null,
    }));
    expect(initial.fertigmeldungDue).toBeNull();

    // Gesperrt ab eingereicht.
    const submitted = await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "eingereicht" }));
    expect(submitted.submittedAt).not.toBeNull();
    expect(submitted.fertigmeldungDue).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    await expect(asEditor(fixture, (tx, ctx) => setGridRegistrationDetails(tx, ctx, {
      projectId, operatorName: "Anderer VNB", meterNumber: null,
    }))).rejects.toBeInstanceOf(GridRegistrationValidationError);

    // Offen nach Rückfrage-Rückkehr.
    await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "rueckfrage" }));
    const fixed = await asEditor(fixture, (tx, ctx) => setGridRegistrationDetails(tx, ctx, {
      projectId, operatorName: "Netze BW", meterNumber: "1EMH0077766655",
    }));
    expect(fixed.meterNumber).toBe("1EMH0077766655");

    // Wieder gesperrt nach Wiedereinreichung + Genehmigung.
    await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "eingereicht" }));
    await asEditor(fixture, (tx, ctx) =>
      transitionGridRegistration(tx, ctx, { projectId, status: "genehmigt" }));
    await expect(asEditor(fixture, (tx, ctx) => setGridRegistrationDetails(tx, ctx, {
      projectId, operatorName: "Anderer VNB", meterNumber: null,
    }))).rejects.toBeInstanceOf(GridRegistrationValidationError);

    // Frist = Einreichungsdatum + 6 Monate (direkt in SQL geprüft,
    // ohne JS-Monatsarithmetik).
    const frist = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (async (tx: TenantTx, ctx: ServiceCtx) => {
        const checked = await tx.execute<{ ok: boolean }>(sql`
          select (fertigmeldung_due = (submitted_at + make_interval(months => 6))::date) as ok
            from grid_registration
           where workspace_id = ${ctx.workspaceId}::uuid
             and project_id = ${projectId}::uuid
        `);
        return checked.rows[0]?.ok ?? false;
      }) as never,
    );
    expect(frist).toBe(true);
  });

  it("F1312-DB-04: Add-on-Flags + Preis-Snapshot rundgespeichert", async () => {
    expect(GRID_REGISTRATION_ADDONS).toEqual(["mastr_addon", "wallbox_addon"]);

    const projectId = await seedProject(fixture);
    const fresh = await asEditor(fixture, (tx, ctx) => ensureGridRegistration(tx, ctx, projectId));
    expect(fresh.mastrAddon).toBe(false);
    expect(fresh.wallboxAddon).toBe(false);
    expect(fresh.addonProdukt).toBeNull();
    expect(fresh.addonBetragCents).toBeNull();

    // Dedizierter Setter rundgespeichert.
    const withAddons = await asEditor(fixture, (tx, ctx) => setGridRegistrationAddons(tx, ctx, {
      projectId, mastrAddon: true, wallboxAddon: false, addonProdukt: "pv", addonBetragCents: 49900,
    }));
    expect(withAddons.mastrAddon).toBe(true);
    expect(withAddons.addonProdukt).toBe("pv");
    expect(withAddons.addonBetragCents).toBe(49900);
    const reloaded = await asEditor(fixture, (tx, ctx) => getGridRegistration(tx, ctx, projectId));
    expect(reloaded?.mastrAddon).toBe(true);
    expect(reloaded?.wallboxAddon).toBe(false);
    expect(reloaded?.addonProdukt).toBe("pv");
    expect(reloaded?.addonBetragCents).toBe(49900);

    // Add-ons auch via setDetails (ein Formular, UI-Vertrag).
    const viaDetails = await asEditor(fixture, (tx, ctx) => setGridRegistrationDetails(tx, ctx, {
      projectId, operatorName: "Netze BW", meterNumber: null,
      wallboxAddon: true, addonProdukt: "wp", addonBetragCents: 129900,
    }));
    expect(viaDetails.mastrAddon).toBe(true);
    expect(viaDetails.wallboxAddon).toBe(true);
    expect(viaDetails.addonProdukt).toBe("wp");
    expect(viaDetails.addonBetragCents).toBe(129900);

    // Ungültiger Snapshot fail-closed.
    await expect(asEditor(fixture, (tx, ctx) => setGridRegistrationAddons(tx, ctx, {
      projectId, mastrAddon: false, wallboxAddon: false,
      addonProdukt: "xx" as "pv", addonBetragCents: null,
    }))).rejects.toBeInstanceOf(GridRegistrationValidationError);
    await expect(asEditor(fixture, (tx, ctx) => setGridRegistrationAddons(tx, ctx, {
      projectId, mastrAddon: false, wallboxAddon: false, addonProdukt: null, addonBetragCents: -1,
    }))).rejects.toBeInstanceOf(GridRegistrationValidationError);
  });
});
