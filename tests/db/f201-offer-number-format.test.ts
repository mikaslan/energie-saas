import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withTenantOn } from "@/lib/db/tenant";
import type { ServiceCtx } from "@/lib/permissions";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  OFFER_NUMBER_FORMAT_COMMAND_VERSION,
  type SetOfferNumberFormatCommand,
} from "@/lib/integrations/offers/contract";
import {
  getOfferNumberFormat,
  OfferNumberFormatConflictError,
  OfferNumberFormatValidationError,
  setOfferNumberFormat,
} from "@/modules/offers";
import { testPool } from "../setup/test-db";

type Members = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
};

async function createMembers(tag: string): Promise<Members> {
  const members = {
    workspaceId: randomUUID(),
    editorId: randomUUID(),
    viewerId: randomUUID(),
  };
  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name) values (${members.workspaceId}::uuid, ${tag})
    `);
    for (const userId of [members.editorId, members.viewerId]) {
      await tx.execute(sql`
        insert into user_identity (id, email) values (${userId}::uuid, ${`${userId}@f201.test`})
      `);
    }
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values
        (${members.workspaceId}::uuid, ${members.editorId}::uuid, 'editor', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  return members;
}

function ctxFor(members: Members, actor: "editor" | "viewer"): ServiceCtx {
  return actor === "viewer"
    ? { workspaceId: members.workspaceId, actor: members.viewerId, role: "viewer", capabilities: {}, featureFlags: {} }
    : { workspaceId: members.workspaceId, actor: members.editorId, role: "editor", capabilities: {}, featureFlags: {} };
}

function setCommand(overrides: Partial<SetOfferNumberFormatCommand> = {}): SetOfferNumberFormatCommand {
  return {
    schemaVersion: OFFER_NUMBER_FORMAT_COMMAND_VERSION,
    prefix: "PV",
    padding: 4,
    expectedRevision: null,
    ...overrides,
  };
}

describe("F2.1 Angebotsnummernformat (PostgreSQL)", () => {
  it("F201-DB-01: Default ohne Satz (ANG/6), Setzen + Lesen mit Revision", async () => {
    const members = await createMembers("F2.1-Format");
    const initial = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getOfferNumberFormat(tx, ctxFor(members, "editor")),
    );
    expect(initial.prefix).toBe("ANG");
    expect(initial.padding).toBe(6);
    expect(initial.isDefault).toBe(true);
    expect(initial.preview).toMatch(/^ANG-[0-9]{4}-[0-9]{6}$/u);

    const stored = await withTenantOn(testPool, members.workspaceId, (tx) =>
      setOfferNumberFormat(tx, ctxFor(members, "editor"), setCommand()),
    );
    expect(stored.prefix).toBe("PV");
    expect(stored.padding).toBe(4);
    expect(stored.revision).toBe(1);
    expect(stored.isDefault).toBe(false);
    expect(stored.preview).toMatch(/^PV-[0-9]{4}-[0-9]{4}$/u);

    const reread = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getOfferNumberFormat(tx, ctxFor(members, "editor")),
    );
    expect(reread).toMatchObject({ prefix: "PV", padding: 4, revision: 1, isDefault: false });

    const updated = await withTenantOn(testPool, members.workspaceId, (tx) =>
      setOfferNumberFormat(tx, ctxFor(members, "editor"), setCommand({ prefix: "AN", padding: 5, expectedRevision: 1 })),
    );
    expect(updated).toMatchObject({ prefix: "AN", padding: 5, revision: 2 });
  });

  it("F201-DB-02: ungueltige Prefixe/Padding scheitern, falsche Revision konfligiert", async () => {
    const members = await createMembers("F2.1-Validierung");
    const editor = ctxFor(members, "editor");
    for (const prefix of ["A", "TOOLONGPREFIX", "ang gueltig?", "PV!", ""]) {
      await expect(
        withTenantOn(testPool, members.workspaceId, (tx) =>
          setOfferNumberFormat(tx, editor, setCommand({ prefix })),
        ),
      ).rejects.toBeInstanceOf(OfferNumberFormatValidationError);
    }
    for (const padding of [3, 9, 0]) {
      await expect(
        withTenantOn(testPool, members.workspaceId, (tx) =>
          setOfferNumberFormat(tx, editor, setCommand({ padding })),
        ),
      ).rejects.toBeInstanceOf(OfferNumberFormatValidationError);
    }
    // Kleinbuchstaben werden normalisiert (kein Fail-closed-Falle).
    const lowered = await withTenantOn(testPool, members.workspaceId, (tx) =>
      setOfferNumberFormat(tx, editor, setCommand({ prefix: "pv" })),
    );
    expect(lowered.prefix).toBe("PV");

    await expect(
      withTenantOn(testPool, members.workspaceId, (tx) =>
        setOfferNumberFormat(tx, editor, setCommand({ prefix: "XX", expectedRevision: 99 })),
      ),
    ).rejects.toBeInstanceOf(OfferNumberFormatConflictError);
    // Falsche Schema-Version scheitert ebenfalls.
    const wrongVersion = { ...setCommand(), schemaVersion: "falsch.v9" };
    await expect(
      withTenantOn(testPool, members.workspaceId, (tx) =>
        setOfferNumberFormat(tx, editor, wrongVersion as never),
      ),
    ).rejects.toBeInstanceOf(OfferNumberFormatValidationError);
  });

  it("F201-DB-03: Lesen Viewer-ok, Schreiben Editor-only, Workspaces isoliert", async () => {
    const members = await createMembers("F2.1-Rechte");
    const seen = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getOfferNumberFormat(tx, ctxFor(members, "viewer")),
    );
    expect(seen.permissions.canWrite).toBe(false);
    await expect(
      withTenantOn(testPool, members.workspaceId, (tx) =>
        setOfferNumberFormat(tx, ctxFor(members, "viewer"), setCommand()),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    await withTenantOn(testPool, members.workspaceId, (tx) =>
      setOfferNumberFormat(tx, ctxFor(members, "editor"), setCommand({ prefix: "WS" })),
    );
    const other = await createMembers("F2.1-Nachbar");
    const neighbor = await withTenantOn(testPool, other.workspaceId, (tx) =>
      getOfferNumberFormat(tx, ctxFor(other, "editor")),
    );
    expect(neighbor).toMatchObject({ prefix: "ANG", padding: 6, isDefault: true });
  });

  it("F201-DB-04: Serien-CHECK akzeptiert Legacy- und Custom-Formate", async () => {
    const members = await createMembers("F2.1-Serien-Check");
    // Legacy-Zeile (ANG/6) + Custom-Zeile (PV/4) direkt auf Serienebene —
    // der gewitete CHECK ist echte Obermenge.
    await withTenantOn(testPool, members.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into offer_number_series (workspace_id, series_year, prefix, padding, last_sequence)
        values (${members.workspaceId}::uuid, 2026, 'ANG', 6, 0)
      `);
      await tx.execute(sql`
        insert into offer_number_series (workspace_id, series_year, prefix, padding, last_sequence)
        values (${members.workspaceId}::uuid, 2027, 'PV', 4, 0)
      `);
      await expect(
        tx.execute(sql`
          insert into offer_number_series (workspace_id, series_year, prefix, padding, last_sequence)
          values (${members.workspaceId}::uuid, 2028, 'klein', 6, 0)
        `),
      ).rejects.toThrow();
      await expect(
        tx.execute(sql`
          insert into offer_number_series (workspace_id, series_year, prefix, padding, last_sequence)
          values (${members.workspaceId}::uuid, 2029, 'PV', 3, 0)
        `),
      ).rejects.toThrow();
    });
  });
});
