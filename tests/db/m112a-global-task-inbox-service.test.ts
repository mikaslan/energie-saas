import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  getGlobalTaskInboxPage,
  GLOBAL_TASK_INBOX_ORDER,
  GLOBAL_TASK_INBOX_PAGE_LIMIT,
  GLOBAL_TASK_INBOX_PAGE_VERSION,
  GLOBAL_TASK_INBOX_QUERY_VERSION,
  GLOBAL_TASK_INBOX_TIME_ZONE,
  GlobalTaskInboxContractError,
  globalTaskInboxBerlinDayBounds,
  type GlobalTaskInboxPageV1,
  type GlobalTaskInboxQueryV1,
} from "@/modules/tasks";
import { testPool } from "../setup/test-db";

// ═══════════════════════════════════════════════════════════════════════
// M1-12a Service-/DB-Matrix.
//
// Der Insert-Trigger `_m110_guard_project_task` erzwingt `created_at =
// statement_timestamp()` und `created_by = app_actor_id()`. Beide Werte sind
// deshalb NICHT frei setzbar. Daraus folgt die Konstruktion dieser Suite:
//   * Ein bestimmter Ersteller wird über den autorisierten Actor erzeugt.
//   * Identische `created_at`-Werte entstehen ausschließlich über ein
//     gemeinsames INSERT-Statement (gleicher statement_timestamp).
//   * Unterschiedliche `created_at`-Werte entstehen über getrennte Statements.
// `due_at` ist dagegen frei setzbar und trägt die Fälligkeitsfälle.
// ═══════════════════════════════════════════════════════════════════════

type Fixture = {
  workspaceId: string;
  projectId: string;
  projectName: string;
  editorId: string;
  editorMembershipId: string;
  colleagueId: string;
  colleagueMembershipId: string;
  viewerId: string;
  viewerMembershipId: string;
  adminId: string;
  adminMembershipId: string;
  externalId: string;
};

const EMPTY_DOC = { type: "doc", content: [] } as const;

/** Dokument mit Überschrift, Marks und Liste — trägt alle Strukturwörter. */
function structuredRichText(needle: string): unknown {
  return {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Netzanschluss" }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: needle, marks: [{ type: "bold" }] },
          { type: "hardBreak" },
          { type: "text", text: "Zweiter Satz", marks: [{ type: "italic" }] },
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Listenpunkt" }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function query(partial: Partial<Record<keyof GlobalTaskInboxQueryV1, unknown>> = {}): unknown {
  return {
    schemaVersion: GLOBAL_TASK_INBOX_QUERY_VERSION,
    filter: "all",
    state: "open",
    dueBucket: "any",
    query: "",
    timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
    asOf: null,
    cursor: null,
    ...partial,
  };
}

function inbox(
  actorId: string,
  workspaceId: string,
  input: unknown,
): Promise<GlobalTaskInboxPageV1> {
  return withAuthorizedTenantOn(
    testPool,
    actorId,
    workspaceId,
    (tx, ctx) => getGlobalTaskInboxPage(tx, ctx, input),
  );
}

/** Zählt `tx.execute`-Aufrufe, ohne das Verhalten zu verändern. */
function countingTx(tx: TenantTx): { proxy: TenantTx; calls: () => number } {
  let calls = 0;
  const proxy = new Proxy(tx as unknown as Record<PropertyKey, unknown>, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== "execute" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls += 1;
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as unknown as TenantTx;
  return { proxy, calls: () => calls };
}

function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(token: string): {
  v: number;
  binding: Record<string, unknown>;
  position: Record<string, unknown>;
} {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
    v: number;
    binding: Record<string, unknown>;
    position: Record<string, unknown>;
  };
}

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const projectName = `PROJEKTNADEL-${label}`;
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const colleagueId = randomUUID();
  const viewerId = randomUUID();
  const adminId = randomUUID();
  const externalId = randomUUID();
  const editorMembershipId = randomUUID();
  const colleagueMembershipId = randomUUID();
  const viewerMembershipId = randomUUID();
  const adminMembershipId = randomUUID();
  const externalMembershipId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${workspaceId}::uuid, ${`M1-12a ${label}`})
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@m112a.test`}),
        (${colleagueId}::uuid, ${`colleague-${colleagueId}@m112a.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@m112a.test`}),
        (${adminId}::uuid, ${`admin-${adminId}@m112a.test`}),
        (${externalId}::uuid, ${`external-${externalId}@m112a.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
          'editor', '{}'::jsonb),
        (${colleagueMembershipId}::uuid, ${workspaceId}::uuid, ${colleagueId}::uuid,
          'editor', '{}'::jsonb),
        (${viewerMembershipId}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
          'viewer', '{}'::jsonb),
        (${adminMembershipId}::uuid, ${workspaceId}::uuid, ${adminId}::uuid,
          'admin', '{}'::jsonb),
        (${externalMembershipId}::uuid, ${workspaceId}::uuid, ${externalId}::uuid,
          'editor', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, email_primary, email_normalized
      ) values (
        ${contactId}::uuid, ${workspaceId}::uuid, 'KONTAKTNADEL Musterfrau',
        ${`kontaktnadel-${contactId}@m112a.test`},
        ${`kontaktnadel-${contactId}@m112a.test`}
      )
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'M1-12a Site')
    `);
    const project = await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake.id, ${projectName}, 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id
         and intake.board_id = board.id
         and intake.is_intake = true
         and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid
         and board.scope = 'residential'
         and board.is_default = true
         and board.archived_at is null
      returning id
    `);
    if (project.rows.length !== 1) throw new Error("M1-12a project seed failed");
  });

  return {
    workspaceId,
    projectId,
    projectName,
    editorId,
    editorMembershipId,
    colleagueId,
    colleagueMembershipId,
    viewerId,
    viewerMembershipId,
    adminId,
    adminMembershipId,
    externalId,
  };
}

async function insertTask(
  actorId: string,
  workspaceId: string,
  projectId: string,
  task: { title: string; dueAt?: string | null; body?: unknown },
): Promise<string> {
  const taskId = randomUUID();
  await withAuthorizedTenantOn(testPool, actorId, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into project_task (
        id, workspace_id, project_id, title, body_version, body, due_at,
        status, revision, created_by, updated_by
      ) values (
        ${taskId}::uuid, ${workspaceId}::uuid, ${projectId}::uuid,
        ${task.title}, 'task-rich-text.v1',
        ${JSON.stringify(task.body ?? EMPTY_DOC)}::jsonb,
        ${task.dueAt ?? null}::timestamptz,
        'open', 1, ${actorId}::uuid, ${actorId}::uuid
      )
    `);
  });
  return taskId;
}

async function assignTask(
  actorId: string,
  workspaceId: string,
  taskId: string,
  membershipId: string,
): Promise<void> {
  await withAuthorizedTenantOn(testPool, actorId, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into project_task_assignee (id, workspace_id, task_id, membership_id)
      values (
        ${randomUUID()}::uuid, ${workspaceId}::uuid, ${taskId}::uuid,
        ${membershipId}::uuid
      )
    `);
  });
}

async function completeTask(
  actorId: string,
  workspaceId: string,
  taskId: string,
): Promise<void> {
  await withAuthorizedTenantOn(testPool, actorId, workspaceId, async (tx) => {
    await tx.execute(sql`
      update project_task
         set status = 'done', revision = revision + 1,
             updated_by = ${actorId}::uuid
       where workspace_id = ${workspaceId}::uuid and id = ${taskId}::uuid
    `);
  });
}

async function archiveTask(
  actorId: string,
  workspaceId: string,
  taskId: string,
): Promise<void> {
  await withAuthorizedTenantOn(testPool, actorId, workspaceId, async (tx) => {
    await tx.execute(sql`
      update project_task
         set archived_at = pg_catalog.statement_timestamp(),
             revision = revision + 1, updated_by = ${actorId}::uuid
       where workspace_id = ${workspaceId}::uuid and id = ${taskId}::uuid
    `);
  });
}

function titles(page: GlobalTaskInboxPageV1): string[] {
  return page.items.map((item) => item.title);
}

// ───────────────────────────────────────────────────────────────────────
// Gemeinsame Lesefixture
// ───────────────────────────────────────────────────────────────────────

let base: Fixture;
let bounds: { dayStart: string; nextDayStart: string };

beforeAll(async () => {
  base = await seedWorkspace("base");
  bounds = globalTaskInboxBerlinDayBounds(new Date().toISOString());
  const dayStart = new Date(bounds.dayStart).valueOf();
  const nextDayStart = new Date(bounds.nextDayStart).valueOf();
  const overdue = new Date(dayStart - 3_600_000).toISOString();
  const today = new Date(dayStart + 43_200_000).toISOString();
  const upcoming = new Date(nextDayStart + 3_600_000).toISOString();

  const editorOwnAssigned = await insertTask(
    base.editorId,
    base.workspaceId,
    base.projectId,
    { title: "ALPHA eigene zugewiesene Aufgabe", dueAt: today },
  );
  await assignTask(
    base.editorId,
    base.workspaceId,
    editorOwnAssigned,
    base.editorMembershipId,
  );

  const colleagueAssignedToEditor = await insertTask(
    base.colleagueId,
    base.workspaceId,
    base.projectId,
    { title: "BRAVO fremde Aufgabe an mich", dueAt: overdue },
  );
  await assignTask(
    base.editorId,
    base.workspaceId,
    colleagueAssignedToEditor,
    base.editorMembershipId,
  );

  const editorCreatedForColleague = await insertTask(
    base.editorId,
    base.workspaceId,
    base.projectId,
    { title: "CHARLIE von mir erstellt", dueAt: upcoming },
  );
  await assignTask(
    base.editorId,
    base.workspaceId,
    editorCreatedForColleague,
    base.colleagueMembershipId,
  );

  await insertTask(
    base.colleagueId,
    base.workspaceId,
    base.projectId,
    { title: "DELTA ohne Zuweisung und ohne Termin", dueAt: null },
  );

  const doneTask = await insertTask(
    base.editorId,
    base.workspaceId,
    base.projectId,
    { title: "ECHO erledigt", dueAt: today },
  );
  await assignTask(base.editorId, base.workspaceId, doneTask, base.editorMembershipId);
  await completeTask(base.editorId, base.workspaceId, doneTask);

  const archivedTask = await insertTask(
    base.editorId,
    base.workspaceId,
    base.projectId,
    { title: "FOXTROT archiviert", dueAt: today },
  );
  await assignTask(
    base.editorId,
    base.workspaceId,
    archivedTask,
    base.editorMembershipId,
  );
  await archiveTask(base.editorId, base.workspaceId, archivedTask);

  await insertTask(
    base.editorId,
    base.workspaceId,
    base.projectId,
    {
      title: "GOLF unauffälliger Titel",
      dueAt: null,
      body: structuredRichText("BESCHREIBUNGSNADEL Zwoelf"),
    },
  );

  await insertTask(
    base.editorId,
    base.workspaceId,
    base.projectId,
    { title: "HOTEL Mängelliste", dueAt: null },
  );

  await insertTask(
    base.editorId,
    base.workspaceId,
    base.projectId,
    { title: "INDIA Abnahme ﬁnal", dueAt: null },
  );

  const withCounts = await insertTask(
    base.editorId,
    base.workspaceId,
    base.projectId,
    { title: "JULIETT mit Checkliste und Labels", dueAt: null },
  );
  await withAuthorizedTenantOn(
    testPool,
    base.editorId,
    base.workspaceId,
    async (tx) => {
      await tx.execute(sql`
        insert into project_task_checklist_item
          (id, workspace_id, task_id, position, text, is_done)
        values
          (${randomUUID()}::uuid, ${base.workspaceId}::uuid, ${withCounts}::uuid,
            0, 'CHECKLISTENNADEL eins', true),
          (${randomUUID()}::uuid, ${base.workspaceId}::uuid, ${withCounts}::uuid,
            1, 'CHECKLISTENNADEL zwei', false),
          (${randomUUID()}::uuid, ${base.workspaceId}::uuid, ${withCounts}::uuid,
            2, 'CHECKLISTENNADEL drei', false)
      `);
      await tx.execute(sql`
        insert into project_task_label (id, workspace_id, task_id, position, name, color)
        values
          (${randomUUID()}::uuid, ${base.workspaceId}::uuid, ${withCounts}::uuid,
            0, 'LABELNADEL rot', 'rose'),
          (${randomUUID()}::uuid, ${base.workspaceId}::uuid, ${withCounts}::uuid,
            1, 'LABELNADEL blau', 'blue')
      `);
    },
  );

});

// ───────────────────────────────────────────────────────────────────────

describe("M1-12a Inbox — Scope, Status und Fälligkeit", () => {
  it("liefert unter `mine` ausschließlich die aktuelle direkte Assignee-Membership", async () => {
    const page = await inbox(base.editorId, base.workspaceId, query({ filter: "mine" }));
    expect(titles(page).sort()).toEqual([
      "ALPHA eigene zugewiesene Aufgabe",
      "BRAVO fremde Aufgabe an mich",
    ]);
    expect(page.items.every((item) => item.assignedToCurrentActor)).toBe(true);
  });

  it("liefert unter `assigned_by_me` ehrlich die selbst erstellten Aufgaben", async () => {
    const page = await inbox(
      base.editorId,
      base.workspaceId,
      query({ filter: "assigned_by_me" }),
    );
    expect(titles(page)).toContain("CHARLIE von mir erstellt");
    expect(titles(page)).toContain("ALPHA eigene zugewiesene Aufgabe");
    expect(titles(page)).not.toContain("BRAVO fremde Aufgabe an mich");
    expect(titles(page)).not.toContain("DELTA ohne Zuweisung und ohne Termin");
    expect(page.items.every((item) => item.createdByCurrentActor)).toBe(true);
  });

  it("liefert unter `all` jede offene, nicht archivierte Aufgabe des Workspace", async () => {
    const page = await inbox(base.editorId, base.workspaceId, query({ filter: "all" }));
    expect(titles(page)).toContain("DELTA ohne Zuweisung und ohne Termin");
    expect(titles(page)).toContain("BRAVO fremde Aufgabe an mich");
    expect(titles(page)).not.toContain("ECHO erledigt");
    expect(titles(page)).not.toContain("FOXTROT archiviert");
  });

  it("trennt `open` und `done` vollständig", async () => {
    const open = await inbox(base.editorId, base.workspaceId, query({ state: "open" }));
    const done = await inbox(base.editorId, base.workspaceId, query({ state: "done" }));
    expect(titles(open)).not.toContain("ECHO erledigt");
    expect(titles(done)).toEqual(["ECHO erledigt"]);
    expect(done.items.every((item) => item.status === "done")).toBe(true);
  });

  it("bildet alle Fälligkeitseimer entlang der Berliner Tagesgrenze ab", async () => {
    const overdue = await inbox(
      base.editorId,
      base.workspaceId,
      query({ dueBucket: "overdue" }),
    );
    const today = await inbox(
      base.editorId,
      base.workspaceId,
      query({ dueBucket: "today" }),
    );
    const upcoming = await inbox(
      base.editorId,
      base.workspaceId,
      query({ dueBucket: "upcoming" }),
    );
    const noDue = await inbox(
      base.editorId,
      base.workspaceId,
      query({ dueBucket: "no_due" }),
    );

    expect(titles(overdue)).toEqual(["BRAVO fremde Aufgabe an mich"]);
    expect(titles(today)).toEqual(["ALPHA eigene zugewiesene Aufgabe"]);
    expect(titles(upcoming)).toEqual(["CHARLIE von mir erstellt"]);
    expect(titles(noDue)).toContain("DELTA ohne Zuweisung und ohne Termin");
    expect(noDue.items.every((item) => item.dueAt === null)).toBe(true);
  });

  it("ordnet nach `due_at ASC NULLS LAST, created_at DESC, id ASC`", async () => {
    const page = await inbox(base.editorId, base.workspaceId, query());
    const dues = page.items.map((item) => item.dueAt);
    const firstNull = dues.indexOf(null);
    if (firstNull >= 0) {
      expect(dues.slice(firstNull).every((value) => value === null)).toBe(true);
    }
    const dated = dues.filter((value): value is string => value !== null);
    expect([...dated].sort()).toEqual(dated);
    expect(page.order).toBe(GLOBAL_TASK_INBOX_ORDER);
  });
});

describe("M1-12a Inbox — Suche", () => {
  it("findet den Titel als Teilzeichenkette und case-insensitiv", async () => {
    const page = await inbox(
      base.editorId,
      base.workspaceId,
      query({ query: "alpha eigene" }),
    );
    expect(titles(page)).toEqual(["ALPHA eigene zugewiesene Aufgabe"]);
  });

  it("findet ausschließlich echte Textnodes der Beschreibung", async () => {
    const page = await inbox(
      base.editorId,
      base.workspaceId,
      query({ query: "BESCHREIBUNGSNADEL" }),
    );
    expect(titles(page)).toEqual(["GOLF unauffälliger Titel"]);
  });

  it("erzeugt aus Strukturwörtern, Marks und JSON-Schlüsseln nie einen Treffer", async () => {
    for (const needle of [
      "paragraph",
      "heading",
      "bulletList",
      "listItem",
      "hardBreak",
      "bold",
      "italic",
      "attrs",
      "level",
      "task-rich-text",
      "doc",
    ]) {
      const page = await inbox(base.editorId, base.workspaceId, query({ query: needle }));
      expect(
        titles(page),
        `Strukturwort "${needle}" darf keinen Treffer erzeugen`,
      ).not.toContain("GOLF unauffälliger Titel");
    }
  });

  it("sucht nicht im Projektnamen, in Checklisten, Labels oder Kontaktdaten", async () => {
    for (const needle of [
      base.projectName,
      "PROJEKTNADEL",
      "CHECKLISTENNADEL",
      "LABELNADEL",
      "KONTAKTNADEL",
      "m112a.test",
    ]) {
      const page = await inbox(base.editorId, base.workspaceId, query({ query: needle }));
      expect(page.items, `"${needle}" darf keinen Treffer erzeugen`).toEqual([]);
    }
  });

  it("normalisiert auch die gespeicherte Seite NFKC (komponiert findet dekomponiert)", async () => {
    const page = await inbox(
      base.editorId,
      base.workspaceId,
      query({ query: "Mängelliste" }),
    );
    expect(titles(page)).toEqual(["HOTEL Mängelliste"]);
  });

  it("normalisiert auch Kompatibilitätszeichen NFKC (Ligatur findet ASCII)", async () => {
    const page = await inbox(
      base.editorId,
      base.workspaceId,
      query({ query: "final" }),
    );
    expect(titles(page)).toEqual(["INDIA Abnahme ﬁnal"]);
  });
});

describe("M1-12a Inbox — Beschreibungstext wie angezeigt", () => {
  // Eine Markgrenze zerlegt einen Absatz in mehrere Inline-Läufe. Die Anzeige
  // hängt sie ohne Trenner aneinander; die Suche muss dasselbe tun.
  function runs(...parts: Array<{ text: string; bold?: boolean } | "br">): unknown {
    return {
      type: "doc",
      content: [{
        type: "paragraph",
        content: parts.map((part) => part === "br"
          ? { type: "hardBreak" }
          : part.bold
            ? { type: "text", text: part.text, marks: [{ type: "bold" }] }
            : { type: "text", text: part.text }),
      }],
    };
  }

  it("findet eine Phrase über eine Fettungsgrenze hinweg", async () => {
    const fixture = await seedWorkspace("marks");
    await insertTask(fixture.editorId, fixture.workspaceId, fixture.projectId, {
      title: "MARKS Aufgabe eins",
      body: runs({ text: "Netzanschluss " }, { text: "pruefen", bold: true }),
    });

    const found = await inbox(
      fixture.editorId,
      fixture.workspaceId,
      query({ query: "Netzanschluss pruefen" }),
    );
    expect(titles(found)).toEqual(["MARKS Aufgabe eins"]);

    // Die künstlich getrennte Form darf gerade nicht treffen.
    const spaced = await inbox(
      fixture.editorId,
      fixture.workspaceId,
      query({ query: "Netzanschluss  pruefen" }),
    );
    expect(spaced.items).toEqual([]);
  });

  it("findet ein Wort, das mitten in der Fettung geteilt ist", async () => {
    const fixture = await seedWorkspace("midword");
    await insertTask(fixture.editorId, fixture.workspaceId, fixture.projectId, {
      title: "MARKS Aufgabe zwei",
      body: runs(
        { text: "Waerme" },
        { text: "pumpe", bold: true },
        { text: "nangebot" },
      ),
    });

    const found = await inbox(
      fixture.editorId,
      fixture.workspaceId,
      query({ query: "Waermepumpenangebot" }),
    );
    expect(titles(found)).toEqual(["MARKS Aufgabe zwei"]);

    const spaced = await inbox(
      fixture.editorId,
      fixture.workspaceId,
      query({ query: "Waerme pumpe" }),
    );
    expect(spaced.items).toEqual([]);
  });

  it("trennt an Zeilenumbrüchen und an Blockgrenzen", async () => {
    const fixture = await seedWorkspace("blocks");
    await insertTask(fixture.editorId, fixture.workspaceId, fixture.projectId, {
      title: "MARKS Aufgabe drei",
      body: runs({ text: "Alpha" }, "br", { text: "Beta" }),
    });
    await insertTask(fixture.editorId, fixture.workspaceId, fixture.projectId, {
      title: "MARKS Aufgabe vier",
      body: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Gamma" }] },
          { type: "paragraph", content: [{ type: "text", text: "Delta" }] },
        ],
      },
    });

    for (const [needle, expected] of [
      ["Alpha Beta", ["MARKS Aufgabe drei"]],
      ["AlphaBeta", []],
      ["Gamma Delta", ["MARKS Aufgabe vier"]],
      ["GammaDelta", []],
    ] as const) {
      const page = await inbox(
        fixture.editorId,
        fixture.workspaceId,
        query({ query: needle }),
      );
      expect(titles(page), `Suche "${needle}"`).toEqual([...expected]);
    }
  });

  it("findet Text in Überschriften und Listenpunkten", async () => {
    const fixture = await seedWorkspace("nested");
    await insertTask(fixture.editorId, fixture.workspaceId, fixture.projectId, {
      title: "MARKS Aufgabe fuenf",
      body: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 3 },
            content: [
              { type: "text", text: "Ueber" },
              { type: "text", text: "schrift", marks: [{ type: "italic" }] },
            ],
          },
          {
            type: "bulletList",
            content: [{
              type: "listItem",
              content: [{
                type: "paragraph",
                content: [{ type: "text", text: "Listeneintrag" }],
              }],
            }],
          },
        ],
      },
    });

    for (const needle of ["Ueberschrift", "Listeneintrag"]) {
      const page = await inbox(
        fixture.editorId,
        fixture.workspaceId,
        query({ query: needle }),
      );
      expect(titles(page), `Suche "${needle}"`).toEqual(["MARKS Aufgabe fuenf"]);
    }
  });
});

describe("M1-12a Inbox — Sichtbarkeits- und Rollengrenzen", () => {
  it("erlaubt Viewer, Editor und Admin die read-only Sicht", async () => {
    for (const actorId of [base.viewerId, base.editorId, base.adminId]) {
      const page = await inbox(actorId, base.workspaceId, query());
      expect(page.schemaVersion).toBe(GLOBAL_TASK_INBOX_PAGE_VERSION);
      expect(page.items.length).toBeGreaterThan(0);
    }
  });

  it("bleibt für External fail-closed", async () => {
    await expect(
      inbox(base.externalId, base.workspaceId, query()),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("bleibt für eine fehlende Membership fail-closed", async () => {
    await expect(
      inbox(randomUUID(), base.workspaceId, query()),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("bleibt gegen einen Fremdtenant fail-closed", async () => {
    const other = await seedWorkspace("cross");
    await expect(
      inbox(base.editorId, other.workspaceId, query()),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("verbirgt archivierte Aufgaben in jedem Filter", async () => {
    for (const filter of ["mine", "assigned_by_me", "all"] as const) {
      for (const state of ["open", "done"] as const) {
        const page = await inbox(
          base.editorId,
          base.workspaceId,
          query({ filter, state }),
        );
        expect(titles(page)).not.toContain("FOXTROT archiviert");
      }
    }
  });

  it("verbirgt Aufgaben, deren Projektkontakt gelöscht ist", async () => {
    const erasure = await seedWorkspace("erasure");
    const taskId = await insertTask(
      erasure.editorId,
      erasure.workspaceId,
      erasure.projectId,
      { title: "ERASURE Aufgabe" },
    );
    expect(taskId).toBeTruthy();

    const before = await inbox(erasure.editorId, erasure.workspaceId, query());
    expect(titles(before)).toEqual(["ERASURE Aufgabe"]);

    await withTenantOn(testPool, erasure.workspaceId, async (tx) => {
      await tx.execute(sql`
        update contact
           set deleted_at = pg_catalog.statement_timestamp(),
               display_name = 'geloescht', email_primary = null,
               email_normalized = null, phone_raw = null
         where workspace_id = ${erasure.workspaceId}::uuid
      `);
    });

    const after = await inbox(erasure.editorId, erasure.workspaceId, query());
    expect(after.items).toEqual([]);
  });
});

describe("M1-12a Inbox — minimiertes DTO", () => {
  it("exponiert exakt die vertraglich erlaubten Felder", async () => {
    const page = await inbox(
      base.editorId,
      base.workspaceId,
      query({ query: "JULIETT" }),
    );
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(Object.keys(item).sort()).toEqual([
      "assignedToCurrentActor",
      "assigneeCount",
      "counts",
      "createdByCurrentActor",
      "dueAt",
      "id",
      "project",
      "revision",
      "status",
      "title",
    ]);
    expect(Object.keys(item.counts).sort()).toEqual([
      "checklistDone",
      "checklistTotal",
      "labels",
    ]);
    expect(Object.keys(item.project).sort()).toEqual(["id", "name", "outcome"]);
    expect(item.counts).toEqual({ checklistDone: 1, checklistTotal: 3, labels: 2 });
    expect(item.project.outcome).toBe("open");
  });

  it("trägt weder Freitext noch Identitäten in die Serialisierung", async () => {
    const page = await inbox(base.editorId, base.workspaceId, query());
    const serialized = JSON.stringify(page);
    for (const forbidden of [
      "BESCHREIBUNGSNADEL",
      "CHECKLISTENNADEL",
      "LABELNADEL",
      "KONTAKTNADEL",
      "m112a.test",
      base.editorMembershipId,
      base.colleagueMembershipId,
      base.editorId,
      base.colleagueId,
    ]) {
      expect(serialized, `"${forbidden}" darf nicht projiziert werden`)
        .not.toContain(forbidden);
    }
  });

  it("zählt Zuständige, ohne sie zu benennen", async () => {
    const page = await inbox(
      base.editorId,
      base.workspaceId,
      query({ query: "CHARLIE" }),
    );
    expect(page.items[0]?.assigneeCount).toBe(1);
    expect(page.items[0]?.assignedToCurrentActor).toBe(false);
    expect(page.items[0]?.createdByCurrentActor).toBe(true);
  });
});

describe("M1-12a Inbox — Seitenbildung und Cursorbindung", () => {
  async function seedPaginationFixture(): Promise<{
    fixture: Fixture;
    total: number;
  }> {
    const fixture = await seedWorkspace("pagination");
    const total = GLOBAL_TASK_INBOX_PAGE_LIMIT + 1;
    // Ein gemeinsames INSERT-Statement erzwingt identische created_at-Werte
    // und damit den reinen UUID-Tie-Breaker über die gesamte Seite.
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      async (tx) => {
        const values = Array.from({ length: total }, (_, index) => sql`(
          ${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.projectId}::uuid,
          ${`SEITE ${String(index).padStart(3, "0")}`},
          'task-rich-text.v1', ${JSON.stringify(EMPTY_DOC)}::jsonb, null,
          'open', 1, ${fixture.editorId}::uuid, ${fixture.editorId}::uuid
        )`);
        await tx.execute(sql`
          insert into project_task (
            id, workspace_id, project_id, title, body_version, body, due_at,
            status, revision, created_by, updated_by
          ) values ${sql.join(values, sql`, `)}
        `);
      },
    );
    return { fixture, total };
  }

  it("begrenzt auf 50, setzt einen Folgecursor und paginiert duplikatfrei", async () => {
    const { fixture, total } = await seedPaginationFixture();
    const first = await inbox(fixture.editorId, fixture.workspaceId, query());
    expect(first.items).toHaveLength(GLOBAL_TASK_INBOX_PAGE_LIMIT);
    expect(first.pageLimit).toBe(GLOBAL_TASK_INBOX_PAGE_LIMIT);
    expect(first.nextCursor).not.toBeNull();

    const second = await inbox(
      fixture.editorId,
      fixture.workspaceId,
      query({ asOf: first.asOf, cursor: first.nextCursor }),
    );
    expect(second.items).toHaveLength(total - GLOBAL_TASK_INBOX_PAGE_LIMIT);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(total);
  });

  it("bricht bei identischem created_at strikt über die aufsteigende UUID", async () => {
    const { fixture } = await seedPaginationFixture();
    const first = await inbox(fixture.editorId, fixture.workspaceId, query());
    const second = await inbox(
      fixture.editorId,
      fixture.workspaceId,
      query({ asOf: first.asOf, cursor: first.nextCursor }),
    );
    const ids = [...first.items, ...second.items].map((item) => item.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it("hält den asOf-Fence gegen später eingefügte Aufgaben", async () => {
    const { fixture } = await seedPaginationFixture();
    const first = await inbox(fixture.editorId, fixture.workspaceId, query());
    await insertTask(fixture.editorId, fixture.workspaceId, fixture.projectId, {
      title: "SPAETER eingefuegt",
    });
    const second = await inbox(
      fixture.editorId,
      fixture.workspaceId,
      query({ asOf: first.asOf, cursor: first.nextCursor }),
    );
    expect(titles(second)).not.toContain("SPAETER eingefuegt");

    const fresh = await inbox(fixture.editorId, fixture.workspaceId, query());
    expect(fresh.asOf >= first.asOf).toBe(true);
  });

  it("traversiert viele Seiten lückenlos und duplikatfrei", async () => {
    const fixture = await seedWorkspace("sweep");
    const total = 260;
    // Ein einziges Statement erzwingt für alle 260 Aufgaben denselben
    // created_at-Wert. Die gesamte Traversierung hängt damit allein am
    // UUID-Tie-Breaker — der schwerste Fall für einen Keyset-Cursor.
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      async (tx) => {
        const values = Array.from({ length: total }, (_, index) => sql`(
          ${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.projectId}::uuid, ${`SWEEP ${String(index).padStart(4, "0")}`},
          'task-rich-text.v1', ${JSON.stringify(EMPTY_DOC)}::jsonb, null,
          'open', 1, ${fixture.editorId}::uuid, ${fixture.editorId}::uuid
        )`);
        await tx.execute(sql`
          insert into project_task (
            id, workspace_id, project_id, title, body_version, body, due_at,
            status, revision, created_by, updated_by
          ) values ${sql.join(values, sql`, `)}
        `);
      },
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    let asOf: string | null = null;
    let pages = 0;
    do {
      const page: GlobalTaskInboxPageV1 = await inbox(
        fixture.editorId,
        fixture.workspaceId,
        query(cursor === null ? {} : { asOf, cursor }),
      );
      pages += 1;
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      asOf = page.asOf;
      expect(pages, "Traversierung darf nicht endlos laufen").toBeLessThan(20);
    } while (cursor !== null);

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect([...seen].sort()).toEqual(seen);
    expect(pages).toBe(Math.ceil(total / GLOBAL_TASK_INBOX_PAGE_LIMIT));
  });

  it("bindet den Cursor an jeden Filter, die Query und die Zeitzone", async () => {
    const { fixture } = await seedPaginationFixture();
    const first = await inbox(fixture.editorId, fixture.workspaceId, query());
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();

    for (const drift of [
      { filter: "mine" },
      { filter: "assigned_by_me" },
      { state: "done" },
      { dueBucket: "overdue" },
      { query: "SEITE" },
    ]) {
      await expect(
        inbox(
          fixture.editorId,
          fixture.workspaceId,
          query({ asOf: first.asOf, cursor, ...drift }),
        ),
        `Cursordrift ${JSON.stringify(drift)} muss fail-closed sein`,
      ).rejects.toBeInstanceOf(GlobalTaskInboxContractError);
    }
  });

  it("bindet den Cursor an Workspace und Actor", async () => {
    const { fixture } = await seedPaginationFixture();
    const first = await inbox(fixture.editorId, fixture.workspaceId, query());
    await expect(
      inbox(
        fixture.colleagueId,
        fixture.workspaceId,
        query({ asOf: first.asOf, cursor: first.nextCursor }),
      ),
    ).rejects.toBeInstanceOf(GlobalTaskInboxContractError);
  });

  it("lehnt nichtkanonische und manipulierte Cursor kontrolliert ab", async () => {
    const { fixture } = await seedPaginationFixture();
    const first = await inbox(fixture.editorId, fixture.workspaceId, query());
    const cursor = first.nextCursor!;
    const payload = decodeCursor(cursor);

    const tampered = encodeCursor({
      ...payload,
      position: { ...payload.position, taskId: randomUUID() },
    });
    await expect(
      inbox(
        fixture.editorId,
        fixture.workspaceId,
        query({ asOf: first.asOf, cursor: tampered }),
      ),
    ).resolves.toBeTruthy();

    const foreignMembership = encodeCursor({
      ...payload,
      binding: { ...payload.binding, membershipId: randomUUID() },
    });
    await expect(
      inbox(
        fixture.editorId,
        fixture.workspaceId,
        query({ asOf: first.asOf, cursor: foreignMembership }),
      ),
    ).rejects.toBeInstanceOf(GlobalTaskInboxContractError);

    const nonCanonicalBase64 = `${cursor}A`;
    await expect(
      inbox(
        fixture.editorId,
        fixture.workspaceId,
        query({ asOf: first.asOf, cursor: nonCanonicalBase64 }),
      ),
    ).rejects.toBeInstanceOf(GlobalTaskInboxContractError);

    await expect(
      inbox(
        fixture.editorId,
        fixture.workspaceId,
        query({ asOf: first.asOf, cursor: "!!!nicht-base64url!!!" }),
      ),
    ).rejects.toBeInstanceOf(GlobalTaskInboxContractError);
  });

  it("lehnt ein gefälschtes asOf in der Zukunft fail-closed ab", async () => {
    const { fixture } = await seedPaginationFixture();
    const first = await inbox(fixture.editorId, fixture.workspaceId, query());
    const payload = decodeCursor(first.nextCursor!);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const forged = encodeCursor({
      ...payload,
      binding: { ...payload.binding, asOf: future },
    });

    await expect(
      inbox(
        fixture.editorId,
        fixture.workspaceId,
        query({ asOf: future, cursor: forged }),
      ),
    ).rejects.toBeInstanceOf(GlobalTaskInboxContractError);
  });

  it("weist ein Jahr null im Cursor und in asOf kontrolliert ab", async () => {
    // JavaScript akzeptiert das Jahr 0000 kanonisch, PostgreSQL kennt es nicht
    // und bräche jeden ::timestamptz-Cast mit SQLSTATE 22008 ab. Der Wert darf
    // die Datenbank deshalb gar nicht erreichen.
    const { fixture } = await seedPaginationFixture();
    const first = await inbox(fixture.editorId, fixture.workspaceId, query());
    const payload = decodeCursor(first.nextCursor!);
    const yearZero = "0000-01-01T00:00:00.000Z";

    await expect(inbox(
      fixture.editorId,
      fixture.workspaceId,
      query({
        asOf: first.asOf,
        cursor: encodeCursor({
          ...payload,
          position: { ...payload.position, createdAt: yearZero },
        }),
      }),
    )).rejects.toBeInstanceOf(GlobalTaskInboxContractError);

    await expect(inbox(
      fixture.editorId,
      fixture.workspaceId,
      query({
        asOf: yearZero,
        cursor: encodeCursor({
          ...payload,
          binding: { ...payload.binding, asOf: yearZero },
        }),
      }),
    )).rejects.toBeInstanceOf(GlobalTaskInboxContractError);
  });

  it("entwertet den Cursor nach Entzug und Wiederaufnahme derselben Identität", async () => {
    const { fixture } = await seedPaginationFixture();
    const first = await inbox(fixture.editorId, fixture.workspaceId, query());
    const cursor = first.nextCursor;

    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        delete from project_task_assignee
         where workspace_id = ${fixture.workspaceId}::uuid
           and membership_id = ${fixture.editorMembershipId}::uuid
      `);
      await tx.execute(sql`
        delete from membership
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.editorMembershipId}::uuid
      `);
    });

    await expect(
      inbox(
        fixture.editorId,
        fixture.workspaceId,
        query({ asOf: first.asOf, cursor }),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values (
          ${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.editorId}::uuid, 'editor', '{}'::jsonb
        )
      `);
    });

    await expect(
      inbox(
        fixture.editorId,
        fixture.workspaceId,
        query({ asOf: first.asOf, cursor }),
      ),
    ).rejects.toBeInstanceOf(GlobalTaskInboxContractError);

    await expect(
      inbox(fixture.editorId, fixture.workspaceId, query()),
    ).resolves.toBeTruthy();
  });
});

describe("M1-12a Inbox — Ausführungsvertrag", () => {
  it("führt exakt ein `tx.execute` je Serviceaufruf aus", async () => {
    const calls = await withAuthorizedTenantOn(
      testPool,
      base.editorId,
      base.workspaceId,
      async (tx, ctx) => {
        const counted = countingTx(tx);
        await getGlobalTaskInboxPage(counted.proxy, ctx, query());
        return counted.calls();
      },
    );
    expect(calls).toBe(1);
  });

  it("pinnt die SQL-Tagesgrenze exakt auf die Vertragsfunktion", async () => {
    const instants = [
      "2026-01-15T12:00:00.000Z",
      "2026-07-15T12:00:00.000Z",
      "2026-03-29T00:30:00.000Z",
      "2026-03-29T01:30:00.000Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T02:30:00.000Z",
      "2026-12-31T23:30:00.000Z",
    ];
    const candidates = sql.join(
      instants.map((instant) => sql`(${instant}::timestamptz)`),
      sql`, `,
    );
    const rows = await withTenantOn(testPool, base.workspaceId, async (tx) => {
      const result = await tx.execute<{
        as_of: string;
        day_start: string;
        next_day_start: string;
      }>(sql`
        select to_char(candidate.as_of at time zone 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as as_of,
               to_char(
                 (date_trunc('day', candidate.as_of at time zone 'Europe/Berlin')
                   at time zone 'Europe/Berlin') at time zone 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               ) as day_start,
               to_char(
                 ((date_trunc('day', candidate.as_of at time zone 'Europe/Berlin')
                   + interval '1 day') at time zone 'Europe/Berlin') at time zone 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               ) as next_day_start
          from (values ${candidates}) as candidate(as_of)
      `);
      return result.rows;
    });

    expect(rows).toHaveLength(instants.length);
    for (const row of rows) {
      const expected = globalTaskInboxBerlinDayBounds(row.as_of);
      expect(row.day_start, `dayStart für ${row.as_of}`).toBe(expected.dayStart);
      expect(row.next_day_start, `nextDayStart für ${row.as_of}`)
        .toBe(expected.nextDayStart);
    }
  });

  it("beweist, dass der JSONPath ausschließlich Textnode-Inhalte liefert", async () => {
    const rows = await withTenantOn(testPool, base.workspaceId, async (tx) => {
      const result = await tx.execute<{ fragment: string }>(sql`
        select body_fragment.value #>> '{}' as fragment
          from pg_catalog.jsonb_path_query(
            ${JSON.stringify(structuredRichText("BESCHREIBUNGSNADEL Zwoelf"))}::jsonb,
            'strict $.** ? (@.type == "text").text'::pg_catalog.jsonpath
          ) as body_fragment(value)
      `);
      return result.rows.map((row) => row.fragment);
    });

    // Genau die vier echten Textnodes — Überschrift, der gefettete Suchbegriff,
    // der kursive Satz und der Listenpunkt. Kein `doc`, `paragraph`, `heading`,
    // `bulletList`, `listItem`, `hardBreak`, `attrs`, `level`, `bold`, `italic`
    // und kein JSON-Schlüssel erscheint hier.
    expect(rows.sort()).toEqual([
      "BESCHREIBUNGSNADEL Zwoelf",
      "Listenpunkt",
      "Netzanschluss",
      "Zweiter Satz",
    ]);
  });

  it("wirft auf einem leeren Dokument keinen strict-Fehler", async () => {
    const rows = await withTenantOn(testPool, base.workspaceId, async (tx) => {
      const result = await tx.execute(sql`
        select body_fragment.value #>> '{}' as fragment
          from pg_catalog.jsonb_path_query(
            ${JSON.stringify(EMPTY_DOC)}::jsonb,
            'strict $.** ? (@.type == "text").text'::pg_catalog.jsonpath
          ) as body_fragment(value)
      `);
      return result.rows;
    });
    expect(rows).toEqual([]);
  });
});
