import { describe, expect, it } from "vitest";
import {
  GLOBAL_TASK_INBOX_CURSOR_MAX_LENGTH,
  GLOBAL_TASK_INBOX_ORDER,
  GLOBAL_TASK_INBOX_PAGE_LIMIT,
  GLOBAL_TASK_INBOX_PAGE_VERSION,
  GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH,
  GLOBAL_TASK_INBOX_QUERY_VERSION,
  GLOBAL_TASK_INBOX_TIME_ZONE,
  GlobalTaskInboxContractError,
  globalTaskInboxBerlinDayBounds,
  globalTaskInboxCursorMatchesBinding,
  globalTaskInboxCursorPayloadV1Schema,
  globalTaskInboxCursorTokenSchema,
  globalTaskInboxItemV1Schema,
  globalTaskInboxPageV1Schema,
  globalTaskInboxQueryV1Schema,
  parseGlobalTaskInboxCursorPayloadV1,
  parseGlobalTaskInboxPageV1,
  parseGlobalTaskInboxQueryV1,
} from "@/lib/integrations/tasks/inbox-contract";

const WORKSPACE_ID = "a0000000-0000-4000-8000-000000000001";
const TASK_ID = "b0000000-0000-4000-8000-000000000002";
const PROJECT_ID = "c0000000-0000-4000-8000-000000000003";
const ACTOR_ID = "d0000000-0000-4000-8000-000000000004";
const MEMBERSHIP_ID = "e0000000-0000-4000-8000-000000000005";
const AS_OF = "2026-09-01T08:30:00.000Z";

const item = {
  id: TASK_ID,
  revision: 4,
  title: "Netzbetreiber-Rückfrage klären",
  status: "open" as const,
  dueAt: "2026-09-01T21:59:59.000Z",
  counts: { checklistDone: 2, checklistTotal: 3, labels: 1 },
  project: {
    id: PROJECT_ID,
    name: "Anfrage Wärmepumpe",
    outcome: "open" as const,
  },
  assignedToCurrentActor: true,
  createdByCurrentActor: false,
  assigneeCount: 1,
};

const cursorPayload = {
  v: 1 as const,
  binding: {
    workspaceId: WORKSPACE_ID,
    actorId: ACTOR_ID,
    membershipId: MEMBERSHIP_ID,
    filter: "mine" as const,
    state: "open" as const,
    dueBucket: "today" as const,
    query: "Netz",
    timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
    asOf: AS_OF,
    order: GLOBAL_TASK_INBOX_ORDER,
  },
  position: {
    dueAt: item.dueAt,
    createdAt: "2026-08-31T07:00:00.000Z",
    taskId: TASK_ID,
  },
};

describe("M1-12a Global-Task-Inbox Query-Vertrag", () => {
  it("akzeptiert nur die geschlossenen Filtermengen und normalisiert die Suche NFKC", () => {
    expect(parseGlobalTaskInboxQueryV1({
      schemaVersion: GLOBAL_TASK_INBOX_QUERY_VERSION,
      filter: "assigned_by_me",
      state: "done",
      dueBucket: "no_due",
      query: "  Ｎｅｔｚ　ＡＧ  ",
      timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
      asOf: null,
      cursor: null,
    })).toEqual({
      schemaVersion: GLOBAL_TASK_INBOX_QUERY_VERSION,
      filter: "assigned_by_me",
      state: "done",
      dueBucket: "no_due",
      query: "Netz AG",
      timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
      asOf: null,
      cursor: null,
    });

    for (const filter of ["mine", "assigned_by_me", "all"]) {
      expect(globalTaskInboxQueryV1Schema.parse({
        schemaVersion: GLOBAL_TASK_INBOX_QUERY_VERSION,
        filter,
        state: "open",
        dueBucket: "any",
        query: "  ",
        timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
        asOf: null,
        cursor: null,
      }).query).toBeNull();
    }
    for (const dueBucket of ["any", "overdue", "today", "upcoming", "no_due"]) {
      expect(globalTaskInboxQueryV1Schema.parse({
        schemaVersion: GLOBAL_TASK_INBOX_QUERY_VERSION,
        filter: "mine",
        state: "open",
        dueBucket,
        query: "",
        timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
        asOf: null,
        cursor: null,
      }).query).toBeNull();
    }
  });

  it("begrenzt die kanonisierte Suche und lehnt Fremdfelder sowie Steuerzeichen ab", () => {
    const valid = {
      schemaVersion: GLOBAL_TASK_INBOX_QUERY_VERSION,
      filter: "mine",
      state: "open",
      dueBucket: "any",
      query: "Netz",
      timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
      asOf: null,
      cursor: null,
    } as const;
    for (const candidate of [
      { ...valid, filter: "team" },
      { ...valid, state: "archived" },
      { ...valid, dueBucket: "tomorrow" },
      { ...valid, query: "x".repeat(GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH + 1) },
      { ...valid, query: "Zeile\nZwei" },
      { ...valid, timeZone: "UTC" },
      { ...valid, workspaceId: WORKSPACE_ID },
      { ...valid, limit: 500 },
      { ...valid, schemaVersion: "global-task-inbox-query.v2" },
    ]) {
      expect(globalTaskInboxQueryV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("verlangt Cursor und asOf gemeinsam und kontrolliert Parsefehler", () => {
    const continued = {
      schemaVersion: GLOBAL_TASK_INBOX_QUERY_VERSION,
      filter: "mine",
      state: "open",
      dueBucket: "today",
      query: "Netz",
      timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
      asOf: AS_OF,
      cursor: "eyJ2IjoxfQ",
    } as const;
    expect(globalTaskInboxQueryV1Schema.safeParse(continued).success).toBe(true);
    expect(globalTaskInboxQueryV1Schema.safeParse({ ...continued, asOf: null }).success)
      .toBe(false);
    expect(globalTaskInboxQueryV1Schema.safeParse({ ...continued, cursor: null }).success)
      .toBe(false);

    try {
      parseGlobalTaskInboxQueryV1({ ...continued, query: "private\n@example.test" });
      throw new Error("expected controlled contract error");
    } catch (error) {
      expect(error).toBeInstanceOf(GlobalTaskInboxContractError);
      expect(error).toMatchObject({ code: "invalid_global_task_inbox_query" });
      expect(String(error)).not.toContain("private@example.test");
    }
  });
});

describe("M1-12a Global-Task-Inbox Query-Idempotenz", () => {
  // Die Route parst die URL und reicht das ERGEBNIS an den Service, der als
  // Vertrauensgrenze erneut parst. Ist das Schema nicht idempotent, scheitert
  // der zweite Parse an der eigenen Ausgabe des ersten.
  it("akzeptiert die eigene Ausgabe unverändert wieder", () => {
    const once = parseGlobalTaskInboxQueryV1({
      schemaVersion: GLOBAL_TASK_INBOX_QUERY_VERSION,
      filter: "mine",
      state: "open",
      dueBucket: "any",
      query: "",
      timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
      asOf: null,
      cursor: null,
    });
    expect(once.query).toBeNull();
    expect(parseGlobalTaskInboxQueryV1(once)).toEqual(once);
  });

  it("bleibt auch mit gesetzter Suche und vollständiger Folgeseite idempotent", () => {
    const once = parseGlobalTaskInboxQueryV1({
      schemaVersion: GLOBAL_TASK_INBOX_QUERY_VERSION,
      filter: "all",
      state: "done",
      dueBucket: "overdue",
      query: "  Dachfläche  ",
      timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
      asOf: AS_OF,
      cursor: "abc-_123",
    });
    expect(once.query).toBe("Dachfläche");
    expect(parseGlobalTaskInboxQueryV1(once)).toEqual(once);
  });

  it("lehnt einen nicht kanonisierten Querywert weiterhin ab", () => {
    expect(() => parseGlobalTaskInboxQueryV1({
      schemaVersion: GLOBAL_TASK_INBOX_QUERY_VERSION,
      filter: "mine",
      state: "open",
      dueBucket: "any",
      query: 42,
      timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
      asOf: null,
      cursor: null,
    })).toThrow(GlobalTaskInboxContractError);
  });
});

describe("M1-12a Global-Task-Inbox Cursor-Vertrag", () => {
  it("bindet Cursorpayload an Workspace, alle Filter, Query, Zone, asOf und Ordnung", () => {
    expect(parseGlobalTaskInboxCursorPayloadV1(cursorPayload)).toEqual(cursorPayload);
    expect(globalTaskInboxCursorMatchesBinding(cursorPayload, cursorPayload.binding)).toBe(true);

    const bindingMutations = [
      { workspaceId: PROJECT_ID },
      { actorId: PROJECT_ID },
      { membershipId: PROJECT_ID },
      { filter: "all" },
      { state: "done" },
      { dueBucket: "upcoming" },
      { query: "Anders" },
      { timeZone: "UTC" },
      { asOf: "2026-09-01T08:31:00.000Z" },
      { order: "created_at_desc" },
    ];
    for (const mutation of bindingMutations) {
      const expectedBinding = { ...cursorPayload.binding, ...mutation };
      expect(globalTaskInboxCursorMatchesBinding(
        cursorPayload,
        expectedBinding as typeof cursorPayload.binding,
      )).toBe(false);
    }
  });

  it("lehnt nichtkanonische oder unvollständige Cursorpayloads fail-closed ab", () => {
    for (const candidate of [
      { ...cursorPayload, v: 2 },
      { ...cursorPayload, binding: { ...cursorPayload.binding, workspaceId: WORKSPACE_ID.toUpperCase() } },
      { ...cursorPayload, binding: { ...cursorPayload.binding, query: " Netz " } },
      { ...cursorPayload, binding: { ...cursorPayload.binding, asOf: "2026-09-01T10:30:00+02:00" } },
      { ...cursorPayload, binding: { ...cursorPayload.binding, extra: true } },
      { ...cursorPayload, position: { ...cursorPayload.position, taskId: "not-a-uuid" } },
    ]) {
      expect(globalTaskInboxCursorPayloadV1Schema.safeParse(candidate).success).toBe(false);
    }
    expect(() => parseGlobalTaskInboxCursorPayloadV1({ v: 1 })).toThrowError(
      expect.objectContaining({ code: "invalid_global_task_inbox_cursor" }),
    );
  });

  it("begrenzt das opake kanonische Base64url-Token", () => {
    expect(globalTaskInboxCursorTokenSchema.safeParse("eyJ2IjoxfQ").success).toBe(true);
    expect(globalTaskInboxCursorTokenSchema.safeParse("eyJ2IjoxfQ==").success).toBe(false);
    expect(globalTaskInboxCursorTokenSchema.safeParse("../cursor").success).toBe(false);
    expect(globalTaskInboxCursorTokenSchema.safeParse(
      "x".repeat(GLOBAL_TASK_INBOX_CURSOR_MAX_LENGTH + 1),
    ).success).toBe(false);
  });
});

describe("M1-12a Global-Task-Inbox Readmodel-Vertrag", () => {
  it("akzeptiert nur das minimierte Task-/Project-DTO und kompakte Counts", () => {
    expect(globalTaskInboxItemV1Schema.parse({
      ...item,
      id: TASK_ID.toUpperCase(),
      project: { ...item.project, id: PROJECT_ID.toUpperCase() },
    })).toEqual(item);
  });

  it("exponiert exakt das minimierte DTO ohne Actor- oder Membership-IDs", () => {
    const parsed = globalTaskInboxItemV1Schema.parse(item);
    expect(Object.keys(parsed).sort()).toEqual([
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
    expect(Object.keys(parsed.project).sort()).toEqual(["id", "name", "outcome"]);
    expect(Object.keys(parsed.counts).sort()).toEqual([
      "checklistDone",
      "checklistTotal",
      "labels",
    ]);
  });

  it("verbietet Body, Detailtexte, Identitäten, E-Mail und inkonsistente Counts", () => {
    for (const candidate of [
      { ...item, body: { type: "doc", content: [] } },
      { ...item, checklist: [{ text: "Kundin zurückrufen", done: false }] },
      { ...item, labels: [{ name: "VIP", color: "rose" }] },
      { ...item, assignees: [{ email: "private@example.test" }] },
      { ...item, createdByActorId: ACTOR_ID },
      { ...item, assigneeMembershipIds: [MEMBERSHIP_ID] },
      { ...item, createdByEmail: "private@example.test" },
      { ...item, project: { ...item.project, contactName: "Privat" } },
      { ...item, counts: { ...item.counts, checklistDone: 4 } },
      { ...item, assigneeCount: 51 },
    ]) {
      expect(globalTaskInboxItemV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  it("validiert die ganze Seite strikt, auf 50 Einträge und ohne doppelte Tasks", () => {
    const page = {
      schemaVersion: GLOBAL_TASK_INBOX_PAGE_VERSION,
      filter: "mine" as const,
      state: "open" as const,
      dueBucket: "today" as const,
      query: "Netz",
      timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
      asOf: AS_OF,
      order: GLOBAL_TASK_INBOX_ORDER,
      pageLimit: GLOBAL_TASK_INBOX_PAGE_LIMIT,
      items: [item],
      nextCursor: "eyJ2IjoxfQ",
    };
    expect(parseGlobalTaskInboxPageV1(page)).toEqual(page);
    expect(globalTaskInboxPageV1Schema.safeParse({ ...page, items: [item, item] }).success)
      .toBe(false);
    expect(globalTaskInboxPageV1Schema.safeParse({
      ...page,
      items: Array.from({ length: GLOBAL_TASK_INBOX_PAGE_LIMIT + 1 }, (_, index) => ({
        ...item,
        id: `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
    }).success).toBe(false);
    expect(() => parseGlobalTaskInboxPageV1({ ...page, body: "hidden" })).toThrowError(
      expect.objectContaining({ code: "invalid_global_task_inbox_projection" }),
    );
  });
});

describe("M1-12a Europe/Berlin Tagesgrenzen", () => {
  it("pinnt Winter-, Sommerzeit- und beide DST-Wechseltage als halboffene Intervalle", () => {
    expect(globalTaskInboxBerlinDayBounds("2026-01-15T12:00:00.000Z")).toEqual({
      dayStart: "2026-01-14T23:00:00.000Z",
      nextDayStart: "2026-01-15T23:00:00.000Z",
    });
    expect(globalTaskInboxBerlinDayBounds("2026-03-29T12:00:00.000Z")).toEqual({
      dayStart: "2026-03-28T23:00:00.000Z",
      nextDayStart: "2026-03-29T22:00:00.000Z",
    });
    expect(globalTaskInboxBerlinDayBounds("2026-10-25T12:00:00.000Z")).toEqual({
      dayStart: "2026-10-24T22:00:00.000Z",
      nextDayStart: "2026-10-25T23:00:00.000Z",
    });
  });

  it("weist nichtkanonische oder ungültige asOf-Werte kontrolliert ab", () => {
    for (const value of [
      "2026-09-01T10:30:00+02:00",
      "2026-09-01",
      "not-an-instant",
    ]) {
      expect(() => globalTaskInboxBerlinDayBounds(value)).toThrowError(
        expect.objectContaining({ code: "invalid_global_task_inbox_query" }),
      );
    }
  });

  it("pinnt die öffentlichen Grenzen", () => {
    expect(GLOBAL_TASK_INBOX_PAGE_LIMIT).toBe(50);
    expect(GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH).toBe(100);
    expect(GLOBAL_TASK_INBOX_CURSOR_MAX_LENGTH).toBe(1168);
  });

  it("fasst jeden vertraglich erlaubten Cursor in die eigene Tokengrenze", () => {
    // Worst Case: jedes der 100 erlaubten UTF-16-Codeunits ist ein
    // Drei-Byte-BMP-Zeichen. Base64url wächst zusätzlich um 4/3.
    const worstCaseQuery = "あ".repeat(GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH);
    expect(worstCaseQuery).toHaveLength(GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH);
    expect(Buffer.byteLength(worstCaseQuery, "utf8"))
      .toBe(GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH * 3);

    const payload = parseGlobalTaskInboxCursorPayloadV1({
      v: 1,
      binding: {
        workspaceId: WORKSPACE_ID,
        actorId: ACTOR_ID,
        membershipId: MEMBERSHIP_ID,
        filter: "assigned_by_me",
        state: "open",
        dueBucket: "no_due",
        query: worstCaseQuery,
        timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
        asOf: AS_OF,
        order: GLOBAL_TASK_INBOX_ORDER,
      },
      position: { dueAt: AS_OF, createdAt: AS_OF, taskId: TASK_ID },
    });
    const token = Buffer.from(JSON.stringify(payload), "utf8")
      .toString("base64url");
    expect(token.length).toBeLessThanOrEqual(GLOBAL_TASK_INBOX_CURSOR_MAX_LENGTH);
    expect(globalTaskInboxCursorTokenSchema.safeParse(token).success).toBe(true);
    // Die Grenze bleibt eine echte Schranke und nicht beliebig weit offen.
    expect(GLOBAL_TASK_INBOX_CURSOR_MAX_LENGTH - token.length).toBeLessThan(300);
  });
});
