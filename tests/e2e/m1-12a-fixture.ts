import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

// ═══════════════════════════════════════════════════════════════════════
// M1-12a Inbox-Fixture.
//
// Der Runner seedet bisher keine Projektaufgaben. Ein fokussierter Lauf
// (M1_05_E2E_GREP=M1-12a) ueberspringt m1-10 und m1-11a vollstaendig, deren
// UI-erzeugte Aufgaben existieren dann gar nicht. Ausserdem braucht die
// Seitenbildung mehr als GLOBAL_TASK_INBOX_PAGE_LIMIT = 50 Treffer; ueber die
// UI waere das nicht in der Testzeit erzeugbar. Diese Fixture legt den
// Bestand deshalb deterministisch direkt in der Datenbank an.
//
// Vertragsgrenzen aus drizzle/0038_m1_10_project_task.sql:
//   * project_task INSERT verlangt revision = 1, status = 'open',
//     created_by = updated_by = app_actor_id() und einen internen
//     Editor/Admin als Actor.
//   * created_at wird vom Trigger auf statement_timestamp() gesetzt.
//   * status = 'done' ist nur per UPDATE erreichbar; completed_at setzt
//     der Trigger selbst.
// ═══════════════════════════════════════════════════════════════════════

export const M1_12A_PROJECT_NAME = "M1-12a Aufgaben-Inbox Projekt";
export const M1_12A_CONTACT_NAME = "Inge M1-12a Inbox";
export const M1_12A_PAGE_TITLE_PREFIX = "M1-12a Inbox Seite";
export const M1_12A_PAGE_TASK_COUNT = 55;
export const M1_12A_BODY_NEEDLE = "NETZANSCHLUSSNADEL";
export const M1_12A_BODY_NEEDLE_TITLE = "M1-12a Traeger ohne Nadel im Titel";
export const M1_12A_OVERDUE_TITLE = "M1-12a Ueberfaellige Aufgabe";
export const M1_12A_TODAY_TITLE = "M1-12a Heute faellige Aufgabe";
export const M1_12A_NO_DUE_TITLE = "M1-12a Aufgabe ohne Faelligkeit";
export const M1_12A_DONE_TITLE = "M1-12a Erledigte Aufgabe";

export function m112aPageTaskTitle(index: number): string {
  return `${M1_12A_PAGE_TITLE_PREFIX} ${String(index).padStart(2, "0")}`;
}

const EMPTY_DOC = JSON.stringify({ type: "doc", content: [] });

function paragraphDoc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

export type M112aInboxSeed = Readonly<{ projectId: string }>;

type M112aSeedInput = Readonly<{
  workspaceId: string;
  editorIdentityId: string;
  viewerIdentityId: string;
}>;

async function inTransaction<T>(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  work: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    await client.query("set local transaction isolation level read committed");
    await client.query(
      `select pg_catalog.set_config('app.workspace_id', $1, true),
              pg_catalog.set_config('app.actor_id', $2, true)`,
      [workspaceId, actorId],
    );
    const value = await work();
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

export async function seedM112aInboxTasks(
  databaseUrl: string,
  input: M112aSeedInput,
): Promise<M112aInboxSeed> {
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();

  try {
    await inTransaction(client, input.workspaceId, "", async () => {
      await client.query(
        `insert into public.contact (
           id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
         ) values ($1::uuid, $2::uuid, $3, 'Fixture', 'Contact', $4, $4)`,
        [
          contactId,
          input.workspaceId,
          M1_12A_CONTACT_NAME,
          `m1-12a-${contactId}@example.test`,
        ],
      );
      await client.query(
        `insert into public.site (id, workspace_id, contact_id, label)
         values ($1::uuid, $2::uuid, $3::uuid, 'M1-12a Site')`,
        [siteId, input.workspaceId, contactId],
      );
      const project = await client.query(
        `insert into public.project (
           id, workspace_id, contact_id, site_id, kanban_board_id,
           kanban_column_id, name, source_key
         )
         select $1::uuid, $2::uuid, $3::uuid, $4::uuid, board.id, intake.id,
                $5, 'manual'
           from public.kanban_board board
           join public.kanban_column intake
             on intake.workspace_id = board.workspace_id
            and intake.board_id = board.id
            and intake.is_intake = true
            and intake.archived_at is null
          where board.workspace_id = $2::uuid
            and board.scope = 'residential'
            and board.is_default = true
            and board.archived_at is null
         returning id`,
        [projectId, input.workspaceId, contactId, siteId, M1_12A_PROJECT_NAME],
      );
      if (project.rowCount !== 1) {
        throw new Error("M1-12a: Inbox-Projekt wurde nicht angelegt.");
      }
    });

    await inTransaction(
      client,
      input.workspaceId,
      input.editorIdentityId,
      async () => {
        const memberships = await client.query<{ id: string; user_id: string }>(
          `select id::text as id, user_id::text as user_id
             from public.membership
            where workspace_id = $1::uuid and user_id = any($2::uuid[])`,
          [
            input.workspaceId,
            [input.editorIdentityId, input.viewerIdentityId],
          ],
        );
        const membershipOf = (userId: string): string => {
          const row = memberships.rows.find((c) => c.user_id === userId);
          if (!row) throw new Error("M1-12a: Mitgliedschaft fehlt im Inbox-Seed.");
          return row.id;
        };
        const editorMembershipId = membershipOf(input.editorIdentityId);
        const viewerMembershipId = membershipOf(input.viewerIdentityId);

        // Ein einziges Statement fuer alle Seitenaufgaben: identisches
        // created_at, aber paarweise verschiedene, aufsteigende Faelligkeiten.
        // Die Ordnung due_at asc ist damit total und die Seitengrenze exakt.
        await client.query(
          `insert into public.project_task (
             id, workspace_id, project_id, title, body_version, body, due_at,
             status, revision, created_by, updated_by
           )
           select gen_random_uuid(), $1::uuid, $2::uuid,
                  $3 || ' ' || pg_catalog.lpad(series.value::text, 2, '0'),
                  'task-rich-text.v1', $4::jsonb,
                  pg_catalog.statement_timestamp()
                    + ((series.value + 10) || ' days')::interval,
                  'open', 1, $5::uuid, $5::uuid
             from pg_catalog.generate_series(1, $6::int) as series(value)`,
          [
            input.workspaceId,
            projectId,
            M1_12A_PAGE_TITLE_PREFIX,
            EMPTY_DOC,
            input.editorIdentityId,
            M1_12A_PAGE_TASK_COUNT,
          ],
        );

        const singles: Array<{ title: string; due: string; body: string }> = [
          {
            title: M1_12A_BODY_NEEDLE_TITLE,
            due: "pg_catalog.statement_timestamp() + interval '3 days'",
            body: paragraphDoc(`Vor Ort pruefen: ${M1_12A_BODY_NEEDLE} freigeben.`),
          },
          {
            title: M1_12A_OVERDUE_TITLE,
            due: "pg_catalog.statement_timestamp() - interval '3 days'",
            body: EMPTY_DOC,
          },
          {
            // „Heute fällig" ist kalendertagsgebunden (Europe/Berlin):
            // day_start <= due_at < next_day_start. Das Fälligkeitsdatum wird
            // relativ zum Laufzeitpunkt auf das ENDE des aktuellen Berlin-Tages
            // gelegt (23:59:59) statt auf eine feste Uhrzeit wie 09:00.
            title: M1_12A_TODAY_TITLE,
            due: `(date_trunc('day',
                    pg_catalog.statement_timestamp() at time zone 'Europe/Berlin')
                  + interval '1 day' - interval '1 second') at time zone 'Europe/Berlin'`,
            body: EMPTY_DOC,
          },
          { title: M1_12A_NO_DUE_TITLE, due: "null::timestamptz", body: EMPTY_DOC },
          {
            title: M1_12A_DONE_TITLE,
            due: "pg_catalog.statement_timestamp() + interval '5 days'",
            body: EMPTY_DOC,
          },
        ];

        const singleIds = new Map<string, string>();
        for (const single of singles) {
          const taskId = randomUUID();
          singleIds.set(single.title, taskId);
          await client.query(
            `insert into public.project_task (
               id, workspace_id, project_id, title, body_version, body, due_at,
               status, revision, created_by, updated_by
             ) values (
               $1::uuid, $2::uuid, $3::uuid, $4, 'task-rich-text.v1', $5::jsonb,
               ${single.due}, 'open', 1, $6::uuid, $6::uuid
             )`,
            [
              taskId,
              input.workspaceId,
              projectId,
              single.title,
              single.body,
              input.editorIdentityId,
            ],
          );
        }

        // Jede Aufgabe des Projekts geht an den Editor: die Standardansicht
        // `mine` zeigt damit genau diesen deterministischen Bestand.
        await client.query(
          `insert into public.project_task_assignee
             (id, workspace_id, task_id, membership_id)
           select gen_random_uuid(), $1::uuid, task_record.id, $2::uuid
             from public.project_task task_record
            where task_record.workspace_id = $1::uuid
              and task_record.project_id = $3::uuid`,
          [input.workspaceId, editorMembershipId, projectId],
        );

        const doneTaskId = singleIds.get(M1_12A_DONE_TITLE);
        if (!doneTaskId) throw new Error("M1-12a: Erledigte Aufgabe fehlt im Seed.");
        await client.query(
          `insert into public.project_task_assignee
             (id, workspace_id, task_id, membership_id)
           values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
          [randomUUID(), input.workspaceId, doneTaskId, viewerMembershipId],
        );
        await client.query(
          `update public.project_task
              set status = 'done', revision = revision + 1, updated_by = $1::uuid
            where workspace_id = $2::uuid and id = $3::uuid`,
          [input.editorIdentityId, input.workspaceId, doneTaskId],
        );
      },
    );
  } finally {
    client.release();
    await pool.end();
  }

  return { projectId };
}
