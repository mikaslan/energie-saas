kimi version 0.40.1
• The user wants me to review the M1-15 diff against the spec. They've given me the full diff inline. This is a code review task — I should analyze the diff carefully against the 6 review criteria and produce P0/P1/P2 findings with file+line and fixes, ending with a verdict, in German, max 150 lines.

  Note: "Bewerte nur den Diff; keine Dateioperationen." — I should NOT do file operations. I review only the diff provided. So no tool calls needed really. Let me carefully analyze.

  Let me go through the diff systematically.

  ### 1. Security: RLS/roles/grants

  Migration 0043:
  - `calendar_category`: RLS enabled+forced, tenant_isolation policy, RESTRICTIVE actor_select policy. Grants: app_runtime gets SELECT only — read-only as spec'd (DEC-M115-01, O4: read-only, empty). Good.
  - `project_appointment`: app_runtime gets SELECT, INSERT, UPDATE, DELETE. RLS forced. Policies: select restrictive (read role or app_owner-without-actor), insert/update/delete restrictive (write role). Triggers enforce actor.
  - Attendee: SELECT, INSERT, DELETE (no UPDATE — trigger forbids UPDATE). Good.
  - Functions: helper functions `_m115_*` REVOKE ALL FROM PUBLIC, only the three actor-check functions granted EXECUTE to app_runtime; guards and erasure-delete-allowed not executable by app_runtime. Good — "EXECUTE nur auf Kapseln".
  - SECURITY DEFINER: the trigger functions and helpers are SECURITY INVOKER (default; the guard functions don't declare SECURITY DEFINER). The `erase_inactive_lead` upgrade re-creates the function with `SECURITY DEFINER SET search_path = pg_catalog` — matches requirement "SECURITY DEFINER mit search_path=pg_catalog". Good.
  - db-role-contract.mts pins: new relations, routines, policy hashes, grants, triggers pinned. Looks consistent.

  One issue: In `_m115_actor_policies` DO block, policies use `TO app_runtime` or PUBLIC fallback. The restrictive SELECT policies include `(CURRENT_USER = 'app_owner' AND public.app_actor_id() IS NULL)` — owner migration path, consistent with previous migrations presumably (M1-13 pattern). OK.

  Potential issue: the DELETE policy on project_appointment requires `_m115_actor_can_write_appointments` — but erasure delete goes through `erase_inactive_lead` which is SECURITY DEFINER owned by app_owner... wait, RLS with FORCE applies to table owner too. How does erasure bypass? The erasure function presumably sets `app.erasure_operation_id` and the trigger `_m115_guard_project_appointment` DELETE branch allows erasure when `_m115_erasure_delete_allowed` returns true. But the RLS policy: restrictive DELETE policy requires `_m115_actor_can_write_appointments(workspace_id)`. During erasure, is there an actor? The erasure presumably sets app.actor_id? Hmm — in M1-13 notes the same pattern existed, presumably with same policy structure, so erasure DELETE passed RLS somehow. Since M1-13 passed review with the same shape, this is consistent. Actually wait — does erasure run as app_erasure role? The GRANT EXECUTE on erase_inactive_lead to app_erasure. The function is SECURITY DEFINER → executes as app_owner (function owner). RLS FORCE applies to owner too, but app_owner presumably has a bypass policy... The restrictive policy `project_appointment_actor_delete` applies `TO app_runtime` (or PUBLIC if app_runtime doesn't exist). Hmm, if it applies TO PUBLIC when app_runtime missing... In production app_runtime exists, so policies apply only to app_runtime. app_owner then has only the permissive tenant_isolation policy — as table owner with FORCE RLS, permissive policies apply; tenant_isolation is permissive (not restrictive), so app_owner can DELETE if workspace matches. OK, consistent.

  - The `_m115_erasure_delete_allowed` checks `current_setting('app.erasure_operation_id', true)` and tombstone graph. OK.

  Grants in db-role-contract: `grant select, insert, delete on project_appointment_attendee` — no UPDATE, matching trigger. Good.

  One thing to check: `verifyRoleContract` pins function hashes for the new functions — fine, can't verify hashes from diff alone, but the gate (88/88+5/5) passed per the prompt, so they match the applied DB. OK.

  ### 2. Correctness vs Spec

  **Time contract (Berlin wall clock, DST):**
  - Input validated as floating ISO without offset via `isBerlinWallClock`. Converted with `${command.start}::timestamp at time zone 'Europe/Berlin'`. Note: `::timestamp at time zone 'Europe/Berlin'` interprets the timestamp as Berlin wall time and yields timestamptz. Correct.
  - Output: `to_char(start_at at time zone 'Europe/Berlin', 'YYYY-MM-DD"T"HH24:MI:SS.MS')`. Correct round-trip. DST test present.
  - Issue: DST gap/overlap — a wall-clock time in the DST gap (e.g., 2026-03-29T02:30) is accepted by the Zod schema (it only checks calendar validity) and Postgres `at time zone` resolves it silently (typically shifts forward). Also ambiguous times in fall-back (2026-10-25T02:30) pick one side. Spec ADR 0021 E6 says deterministic; "deterministic" is satisfied since Postgres is deterministic, but it may not match user intent. Is this a spec violation? Spec says "DST reproduzierbar" — reproducible. So P2 at most, maybe note. The wallClockMs check for `end > start` uses Date.UTC — comparing wall clock as if UTC. For a range crossing a DST transition this differs from actual instant ordering by an hour. Edge: start=2026-03-29T01:30, end=2026-03-29T03:30 → wall diff 2h, real diff 1h. end>start still holds in both. Could wall-order say end>start while real end<=start? Wall: start 02:59 end 03:00 → wall end>start by 1 min; real: 02:59 doesn't exist; hmm. Or fall-back: start 2026-10-25T02:30, end 2026-10-25T02:45 → wall end > start; real instants both ambiguous, Postgres resolves both to first occurrence (CEST? actually Postgres resolves ambiguous to... I believe it picks the earlier, i.e., CEST interpretation? For `timestamptz` from `timestamp at time zone`, ambiguous times resolve to one of them deterministically). The DB CHECK `end_at > start_at` on real instants would catch inversions — if Postgres resolves the wall-clock gap/overlap such that end<=start, the CHECK raises 23514 → surfaces as unknown error rather than `invalid`. Minor. I'd flag as P2: DST-gap/overlap acceptance silently shifted, and possible unmapped 23514 from window_ck leaking as unknown error instead of `invalid`.

  Actually wait — how are DB check violations mapped in the action layer? The diff for appointment-actions.ts is not shown (only file name listed with no content?). The DIFF headers list appointment-actions.ts, appointment-calendar-section.tsx, appointment-calendar.tsx, appointment-dialog.tsx, appointment-editor-model.ts but no content for those files! Only page.tsx diff is shown among app files. Hmm. The diff sections for those files are empty in the prompt. So I can only review what's shown: page.tsx, migration, schema files, contract, permissions, errors, service, package.json, concurrent-index-contract, tests, db-role-contract, tenant-fixtures, and the spec.

  Interesting — appointment-editor-model.ts is tested (unit test imports from it) but its source isn't in the diff. The test file for the editor model is shown. So UI files' content isn't reviewable — I should note that the review covers the shown diff; UI files were listed but content not included. But the instruction says "Bewerte nur den Diff" — the diff as given. The UI diffs are empty, so I can't assess FullCalendar integration (timeZone prop, Pin usage). Hmm, criterion 5 includes "FullCalendar-Integrität (Pin 6.1.21, timeZone)". From the shown diff I can verify package.json pin: `@fullcalendar/react` downgraded from ^7.0.2 to ^6.1.21 — consistent single line 6.1.21. Good. But note: `^6.1.21` is a caret range, not an exact pin. Spec says "Pin 6.1.21". package-lock would pin it; `^6.1.21` allows 6.x updates <7. Given the conflict was core@7 vs core@6, caret on 6.1.21 can never reach 7, so acceptable. Maybe P2: use exact pin or rely on lockfile. The reviewer instruction says "Pin 6.1.21" — caret satisfies the major line; lockfile pins exact. Fine, minor note.

  **Overlap check (Überlappungs-Prüfung):** Wait — spec criterion 2 mentions "Überlappungs-Prüfung". Does the spec require overlap *prevention* (no two appointments overlapping)? Re-reading spec: M115-04 Read: "serverseitige Range-Query" — overlap filter `start_at < rangeEnd and end_at > rangeStart` is the *range overlap* for listing, which is implemented. The review prompt's "Überlappungs-Prüfung" likely means this range overlap predicate. It's `start_at < rangeEnd AND end_at > rangeStart` — correct half-open overlap. Boundary test: appointment 10:00–11:00, rangeStart 10:30 → end 11:00 > 10:30 ✓ and start 10:00 < rangeEnd ✓ → included. Test expects 1. Good.

  **Hard-Delete:** implemented, test verifies physical row gone, event+audit retained. Good.

  **Attendee-Diff:** Spec §6 says "Attendee-Diff (Insert/Delete der Zuordnungszeilen)". Implementation does delete-all + re-insert (`syncAttendees`). The review prompt itself says "Attendee-Diff (delete-all+re-insert)" — so that's the accepted approach. Consequences: attendee `created_at` churn, and events don't capture attendee changes — payload minimal anyway. Fine.

  But there's a subtle race issue in `syncAttendees`: delete-all + re-insert in same tx under appointment FOR UPDATE lock (for update path, lockAppointment is taken before syncAttendees) — serialized per appointment. OK. For create, appointment just inserted, no concurrency. OK.

  **Revision-CAS:** update uses `expectedRevision` in WHERE and trigger enforces `NEW.revision = OLD.revision + 1` and immutable fields. requireRevision check before update gives nicer error with currentRevision. Good. Delete also CAS. Good.

  One correctness issue in the trigger: `_m115_guard_project_appointment` UPDATE branch: checks immutables including `created_at IS DISTINCT FROM OLD.created_at` — created_at/updated_at set by trigger with statement_timestamp. update sets `updated_at = statement_timestamp()` then trigger overwrites NEW.updated_at := mutation_time (also statement_timestamp) — fine.

  INSERT branch: `NEW.revision <> 1 OR NEW.created_by IS DISTINCT FROM actor_id` — enforces create contract. But note: the guard sets NEW.created_at/updated_at to statement_timestamp. Good.

  **Contact-active check on UPDATE/DELETE:** lockProject in service checks contact deleted_at IS NULL for update/delete too. Trigger only checks on INSERT. Fine (service-level).

  **Category validation on create/update:** command.categoryId is inserted directly; FK enforces existence (composite FK to calendar_category(workspace_id,id)). Nonexistent category → FK violation 23503 → surfaces as unknown error, not `invalid`. Hmm — is that a spec issue? Spec §6 error codes: invalid/not_found/conflict/denied/unauthenticated; unknown errors remain loud per M113/M114. A client-supplied nonexistent categoryId is an invalid input that would surface as a raw 23503 error — "unbekannte Fehler bleiben laut" — acceptable per spec pattern, but arguably should be `invalid` or `not_found`. M1-13 notes pattern likely similar. I'd flag P2: categoryId not validated → FK violation leaks as unknown error instead of invalid/not_found; either validate like attendees (validateAttendeeMemberships → AppointmentNotFoundError) or map 23503.

  Note validateAttendeeMemberships throws AppointmentNotFoundError on invalid membership — spec says errors shouldn't reveal existence; not_found for bogus attendee is fine.

  **listProjectAppointments DTO:** item parse — `start: z.string().min(1)` — fine. categoryName nullable. attendees from jsonb — parse validates shape. members limit 200 — spec DTO max(200). OK.

  **Permissions:** appointment.read viewer+ internalOnly; write editor+ internalOnly. Matches spec §7 matrix. permissions.test updated 24 actions. Good.

  ### page.tsx review

  - `berlinWallClockIso` duplicates the contract's wall-clock formatting using Intl with en-CA — produces "YYYY-MM-DDTHH:MM:SS". Range ±1 year around now. Then passed as rangeStart/rangeEnd strings to listProjectAppointments which casts `'...'::timestamp at time zone 'Europe/Berlin'`. Fine.
  - Hmm: computing "±1 year" via setUTCFullYear on now, then formatting in Berlin time — the range is computed from UTC-shifted date then formatted in Berlin tz. Slight asymmetry but functionally fine for a calendar window.
  - Bug candidate: `Intl.DateTimeFormat` with `hour12: false` can yield hour "24" for midnight in some ICU versions! Known pitfall: with hourCycle h24 (hour12:false → h24), midnight formats as "24:00:00" in some locales/implementations. For "en-CA" with hour12:false, the hour at midnight can be "24" in older Node ICU. If hour=24, the produced string "2026-07-01T24:00:00" — Postgres `::timestamp` actually accepts 24:00:00 and rolls to next day. And the Zod schema isn't applied to rangeStart/rangeEnd (options go straight to SQL cast). So even "24" wouldn't crash (Postgres accepts 24:00:00 → next day 00:00), just shifts window by a day boundary... Actually Postgres does accept '24:00:00' as next-day midnight. Minor. Worth P2: use hourCycle:'h23' to be explicit. Node's default for en-CA with hour12:false — I believe modern V8 gives "24" at midnight for h24? Actually hour12:false maps to h23 or h24 depending on locale's default hour cycle; en-CA default is h12, so hour12:false → h23? Hmm, the spec says hour12:false selects h23 unless locale default is h24. For en-US, hour12:false → h23? Let me recall: Intl "hour12: false" sets hourCycle to h23 if locale hc is h12... Actually per ECMA-402, hour12 false → hc = h23? No: "If hour12 is false, let hc be h23" — hmm, I think setting hour12:false explicitly forces h23 when locale default is h11/h12, and h24 when locale default is h24. en-CA default is h12, so hour12:false → h23 → midnight is "00". So OK in practice. Not a finding then, or a very minor robustness note. I'll skip or fold into a P2 about duplication.

  Actually a cleaner finding for page.tsx: the load result — `if (appointmentRangeResult.range === null) notFound();` — matches other loaders. Denied returns DeniedState for whole page: a viewer... wait appointment.read is viewer-allowed, so denied only for externals. But the whole page would have been denied earlier for externals anyway. OK.

  Note: page loads appointments with `view: "month"` fixed and ±1y range — spec M115-04 view month/week/list is a UI concern handled client-side presumably (files not shown). Fine.

  Also: the appointment load happens AFTER note load and BEFORE rendering; sequential awaits add latency — perf, not review scope really.

  One more page.tsx detail: `loadProjectAppointmentRange` catches only NotAuthenticated/PermissionDenied — matches other loaders. Good.

  ### 3. Erasure

  - ErasureGraphIds extended with `appointmentIds?: string[]` — matches "optional" key in tombstone WORM guard optional_keys. Quellgepinnt: the `erase_inactive_lead` upgrade pins SHA-256 of M1-13 source and 3 exact anchors; replaces replay graph, lock block, delete block. Lock order: notes → tasks → appointments appended AFTER tasks... wait, new_lock appends appointment lock after task lock. What's the canonical lock order in erasure vs runtime mutation path? Runtime mutation: lockProject (project FOR KEY SHARE) then appointment FOR UPDATE. Erasure path: locks notes, tasks, then appointments — all after locking project (presumably earlier in erase function). Consistent ordering: project before appointments in both. Attendee rows deleted via cascade. Good.

  - `build_inactive_lead_erasure_graph` now wraps `_m115` rename and appends appointmentIds when non-empty. Sorted/deduped via jsonb_agg ORDER BY id — note: `ORDER BY appointment_record.id` on uuid — fine, deterministic; duplicates impossible (PK). Tombstone guard requires canonical sorted arrays of unique lowercase uuids — id::text is lowercase. Good.

  - **Eligibility concern (criterion 3): "Appointments NICHT im 24-Monats-Fenster — wie M1-13 notes"**: the erasure graph includes ALL appointments of the contact's projects regardless of time. The prompt says the eligibility decision is that appointments are NOT restricted to a 24-month window, like notes. The graph query has no time filter — includes all appointments. That matches "NICHT im 24-Monats-Fenster". OK — consistent.

  - The old function renamed to `build_inactive_lead_erasure_graph_m115` with REVOKE — pattern consistent with m113 chain. db-role-contract pins updated (m115 hash for the inner, new hash for outer). Test m203b1 updated to expect m115. Consistent.

  - One subtlety: `erase_inactive_lead` recreated via `CREATE OR REPLACE ... SECURITY DEFINER SET search_path = pg_catalog` — but does the recreated function preserve OWNER? CREATE OR REPLACE preserves existing owner (app_owner). Good. Does it preserve existing grants? CREATE OR REPLACE preserves grants. And afterwards the DO block re-grants EXECUTE to app_erasure. OK.

  - Wait — the recreated `erase_inactive_lead`: the format string sets `LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog`. But the original may have had more settings (e.g., `SET row_security`? no such thing). It drops any other config the original had. From the pin in db-role-contract: `erase_inactive_lead(...):uuid:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:...` — the hash 627cbe... expected post-upgrade. Gate passed, so consistent.

  ### 4. Races/Locks

  - Doppel-Insert: create generates randomUUID app-side; no idempotency key — double-submit (user double-click / retry) creates two appointments. Spec doesn't demand idempotency; M1-13 notes presumably same. The review criterion says "Doppel-Insert" — under Races: is there protection? Two concurrent creates both take project FOR KEY SHARE (shared lock, non-blocking between them) → both insert. That's expected behavior (creates aren't mutually exclusive). Double-click at UI level — appointment-actions.ts not shown; can't assess disabled-state. Note as observation? The spec's Race contract M115-09 covers parallel edit/delete, not double-create. I'd mention as P2 maybe: no client-supplied idempotency key; same as notes — acceptable per pattern.

  - Parallel edits: appointment FOR UPDATE + CAS → serialized, loser gets conflict (requireRevision throws after lock, or update returns 0 rows → conflict). Actually requireRevision reads revision under FOR UPDATE — correct: lock first, then check revision, so the loser blocks until winner commits, then sees new revision → conflict. Good.

  - Lock order: project (FOR KEY SHARE) → appointment (FOR UPDATE) → attendees (via deletes/inserts on appointment's rows). Erasure: project FOR UPDATE → ... → notes, tasks, appointments FOR UPDATE in fixed id order. Runtime: project lock compatible with erasure's FOR UPDATE? FOR KEY SHARE conflicts with FOR UPDATE → blocks. Good, documented in comment.

  - Deadlock between runtime paths: two updates on different appointments of same project: both FOR KEY SHARE on project (compatible), then FOR UPDATE on their own appointment — no cycle. Attendee sync deletes/inserts attendee rows; unique index (ws, appt, membership) — two concurrent updates to SAME appointment serialized by appointment FOR UPDATE. Good.

  - The `lockReadableProject` uses `_m115_actor_can_read_appointments` in SQL FOR SHARE — fine.

  - Race test: erasure-simulation holds project FOR UPDATE, sets contact.deleted_at, concurrent insert waits then re-checks → NotFound. The service does lockProject: first `for key share` blocks until erasure commits, then fresh snapshot sees deleted contact → NotFoundError. Test covers. Good.

  Hmm wait — in the test, erasureTx does `for update` on project. The insert's `lockProject` does `for key share` → blocks. After commit, second statement checks contact deleted_at → not found → AppointmentNotFoundError. ✓.

  ### 5. DTO-Minimierung

  - Item DTO excludes workspace_id, created_by, created_at, updated_at, description... wait description IS included (it's user content, fine). categoryName joined. attendees include label=email. Hmm — attendee label is the user's **email** — PII. Spec §4.4: attendees `{membershipId, label}[]`. Label source not specified; using email as label exposes internal users' emails to all internal viewers — same tenant, internalOnly, so within-tenant email visibility. Is that a problem? M1-09/M1-10 assignee labels presumably also email-based (house pattern). Acceptable; but members list exposes ALL internal members' emails (up to 200) to any viewer — same pattern as tasks assignee picker presumably. Note: spec DTO forbids "Fremd-PII außerhalb des eigenen Termins" — members list is workspace-internal, needed for attendee picker. OK.

  - Hmm wait, one real issue: in the attendees subquery, the join filters `membership_record.role in ('viewer','editor','admin')` but does NOT filter `external_only` capability. Trigger prevents external_only attendees at insert, but membership could be changed to external_only later (capability update) — then the attendee would silently disappear from the read projection while the row remains. Minor consistency: members query filters external_only, attendees subquery doesn't. So an attendee whose membership became external_only vanishes from display but still counts in DB. P2-level nit. Actually is it a privacy *feature* (don't show externals)? Externals shouldn't be attendees at all per trigger. Drift case only. P2.

  - Error handling without internals leak: errors are generic classes with static messages; PermissionDeniedError carries action/resource — house pattern. AppointmentConflictError carries currentRevision — spec M115-02 implies conflict signaling; revision number isn't sensitive. OK.

  - FullCalendar integrity: package.json pin fixed to ^6.1.21 across all packages now — single line. The UI files (timeZone="Europe/Berlin" prop etc.) aren't in the diff content — can only note. Actually criterion 5 says check timeZone — can't, content absent. I should state that explicitly but the instruction says review the diff; the file headers are there with no bodies. I'll note that the four UI files were listed without content in the review input, so FullCalendar timeZone/CSR aspects are covered only via package pin + must be re-checked at the human gate. Hmm, but the prompt says Chromium-E2E/Visual are separate human gates. The appointment-calendar.tsx is a client component — its content absent. I'll flag as an informational limitation, not a P-finding... Actually to be safe, make it a P2: "Diff-Scope: UI-Dateien ohne Inhalt — timeZone-Pin am FullCalendar nicht verifizierbar aus diesem Diff" — but it's not a code defect. I'll put it as a Hinweis under P2 or a separate note. Better: a short "Nicht prüfbar" note.

  ### 6. Discipline

  - No Reonic texts: labels are German generic ("Beratungstermin", "Beratung"). appointment_type enum is DECIDED WMEE — documented as ESTIMATE/DECIDED in spec Root decisions (O3 confirmed as ESTIMATE/DECIDED). The contract/types don't carry an ESTIMATE marker comment... Spec O3: "Typ-Werteliste bestätigt als ESTIMATE/DECIDED WMEE". Does the code mark it? lib/db/schema/appointment.ts comment says "DECIDED WMEE"? The comment says categories per ADR 0021 E1; the appointmentTypes just listed. The criterion: "ESTIMATE-Markierung" — for estimated values. The type enum was confirmed by Root as DECIDED — no ESTIMATE marker needed. Contract comment marks timezone decision with ADR ref. OK.

  - No invented data: calendar_category starts empty ✓ (no seed). Fixture data only in tests.

  ### Other findings

  1. **`project_appointment_ws_project_start_idx` unused?** The list query orders by start ASC using range idx; the DESC index is for "kommende Termine" list — spec 4.1 mandates it. Present in both SQL and drizzle. OK.

  2. **Index NULLS FIRST mismatch**: SQL: `start_at DESC NULLS FIRST, id` — start_at is NOT NULL so NULLS FIRST is cosmetic. drizzle: `t.startAt.desc().nullsFirst(), t.id.asc().nullsLast()` — id asc nullsLast is default for asc. db:generate no drift → matches. Fine.

  3. **Trigger `project_appointment_window_ck` all-day rule**: `end_at >= start_at + interval '1 day'` — interval '1 day' on timestamptz is 24h absolute. Zod check uses DAY_MS = 86_400_000 wall-clock ms. Berlin DST: allDay 2026-03-29T00:00 → end 2026-03-30T00:00: wall diff = 24h but real diff 23h (spring forward)! Zod passes (wall 24h ≥ 24h), DB check: end_at >= start_at + 24h → real 23h < 24h → **CHECK violation 23514**! Wait — `start_at + interval '1 day'` on timestamptz: adding interval '1 day' to timestamptz in Postgres — interval arithmetic on timestamptz applies in the session timezone? No — interval '1 day' addition to timestamptz is calendar-aware w.r.t. TimeZone setting? Postgres: `timestamptz + interval` — '1 day' is added as a day in the *session timezone*? Actually interval addition to timestamptz respects the timezone for day/month units: yes! Postgres docs: when adding intervals containing days/months to timestamptz, the day field is applied in the session's TimeZone. So '2026-03-29 00:00 Europe/Berlin' stored as UTC '2026-03-28 23:00Z'; + interval '1 day' with TimeZone=UTC (app presumably runs UTC) → '2026-03-29 23:00Z' = '2026-03-30 01:00 Berlin'. end_at = '2026-03-29 22:00Z' (Berlin 03-30 00:00). Check: end >= start+1day → 03-29 22:00Z >= 03-29 23:00Z → FALSE → violation! Hmm, this depends on session TimeZone of app_runtime connections. If TimeZone=UTC, DST-edge all-day single-day appointments on spring-forward day fail the DB CHECK while passing Zod. That's a real edge-case bug: a ganztägiger Termin on 2026-03-29 (DST switch) would be rejected by the DB with an unmapped 23514.

  Let me double check Postgres semantics: `timestamp with time zone + interval`: "When adding an interval to a timestamptz, the days and months are applied in the timezone specified by the TimeZone setting, and the time fields are absolute." Yes — days are calendar days in session TimeZone. If app sets TimeZone=UTC, then +interval '1 day' = exactly 24h. If TimeZone=Europe/Berlin, +1 day = 23h on that date → check passes. So the behavior depends on connection TimeZone — nondeterministic w.r.t. ops config! The spec's ADR 0021 E6 wanted deterministic DST handling. The robust check would compare wall-clock dates or use start_at at time zone 'Europe/Berlin' + interval. This is a genuine P1: DST-dependent CHECK + silent 23514 mapping. Combined with the Zod/DB semantic mismatch (Zod uses UTC wall ms), an all-day appointment spanning the spring-forward midnight fails in prod. Frequency: one day per year for all-day appointments. Severity: correctness edge → P1 (Spec claims deterministic DST; test covers DST round-trip for times but not all-day across transition).

  Also the reverse: Zod rejects wall<24h even when real ≥24h (fall-back: 2026-10-25 all-day 00:00→26th 00:00: wall 24h passes; fine). The failing direction is spring-forward all-day single-day.

  Fix suggestion: make the DB check DST-safe, e.g. `(end_at at time zone 'Europe/Berlin') >= (start_at at time zone 'Europe/Berlin') + interval '1 day'`, or set the comparison on dates. And/or pin `SET timezone` in migration? Better: rewrite check using wall-clock cast.

  4. **`wallClockMs` vs actual instants for end>start near DST gap** — covered above; DB check on real instants could invert? For non-allDay: start 2026-03-29T02:30 (doesn't exist, Postgres maps to 03:30 CEST), end 2026-03-29T03:00 → wall end>start ✓; real: start→03:30 CEST, end 03:00 CEST → end<start → CHECK violation. So nonexistent wall times in the gap can produce 23514 instead of `invalid`. Same P1 bucket: DST-gap validation missing at contract level. Or P2. I'd fold into one finding: Zeitvertrag deckt DST-Lücke/Mehrdeutigkeit nicht ab → 23514 statt invalid + all-day 1-day edge. Severity P1 because Spec E6 promises "DST reproduzierbar/deterministisch" and these produce raw DB errors.

  Hmm, "reproduzierbar" just means same result each time — Postgres resolution is deterministic. The bigger issue is error mapping (23514 → unknown/loud error vs invalid) and all-day check rejection. I'll make it P1 with the all-day rejection as the concrete case.

  5. **`syncAttendees` N+1 inserts** — one insert per attendee (max 100) — perf nit, P2? Not worth. Skip.

  6. **`attendee` count check in trigger `>= 100`** — counts existing rows before insert; delete-all+re-insert pattern means count accurate under appointment lock... but the trigger's count doesn't lock; concurrent inserts to same appointment serialized by FOR SHARE on appointment in attendee trigger. FOR SHARE on appointment blocks concurrent FOR SHARE? No — FOR SHARE is shared; two concurrent attendee inserts both hold FOR SHARE, both count 99, both insert → 101. But can attendee inserts happen concurrently for same appointment? syncAttendees is serialized by appointment FOR UPDATE in update path. Direct SQL by app_runtime is possible (it has INSERT grant) — runtime only goes through service. The 100-cap is defense-in-depth; Zod enforces ≤100 per command. Under service serialization the trigger count is exact. OK, not a finding.

  7. **Attendee trigger FOR SHARE on appointment vs erasure DELETE**: erasure deletes appointments; attendee guard on DELETE checks erasure allowed. Cascade delete from appointment fires attendee DELETE triggers — with erasure_operation_id set → allowed. ✓. But wait: cascade DELETE of attendees happens via FK ON DELETE CASCADE — triggers still fire (row triggers fire on cascaded deletes). The guard's DELETE branch: erasure check first → OK. ✓. And app_owner doing erasure: RLS — attendee DELETE policy requires write-role... restrictive policy applies TO app_runtime only; app_owner runs under tenant_isolation permissive only. ✓ (assuming erasure sets app.workspace_id — yes it must for tenant policy).

  8. **`_m115_actor_appointment_role` returns role without checking membership revoked/deleted?** It selects from membership by workspace+user LIMIT 1 — no `revoked_at` filter? Does membership table have revoked status? M1-09 pattern — the same check as _m113 presumably. The role contract pins hash; consistent with M1-13. If M1-13 didn't filter revocation, this matches house pattern. Can't verify membership schema from diff; skip.

  9. **`members` query limit 200 vs schema max(200)** — limit 200, parse max 200 ✓. But if workspace has >200 internal members, picker silently truncates — same as spec'd cap. Fine.

  10. **`listProjectAppointments` exposes attendee emails to viewers** — covered, house pattern.

  11. **Test file m115 service test:** `expect(range?.members).toHaveLength(2)` — editor+viewer; external excluded ✓.

  12. **m111a test change**: journal idx 43/tag updated — but wait, `TOTAL_MIGRATION_COUNT = 43` with comment "idx 42 reserviert für M1-14 parallel" — journal entries at(-1) idx 43? If total count is 43, idx runs 0..42 → last idx 42. But m111a test expects `entries.at(-1)` idx 43 with tag 0043. Hmm: TOTAL_MIGRATION_COUNT = 43 and idx 0..42 means 0043 is idx 42. But the other test expects idx 43?! Let me re-read.

  tests/db/m111a-project-outcome-migration-upgrade.test.ts: `TOTAL_MIGRATION_COUNT = 43;` comment: "M1-15 (0043) folgt auf M1-13 (0041); idx 42 ist für M1-14 parallel reserviert, der Gesamtbestand zaehlt 43 Migrationen." Hmm — "idx 42 reserviert für M1-14"... but M1-14 was supposed to be 0042 per spec §0.1 (0042=M1-14). So idx 42 = tag 0042_m1_14? But the comment in the diff says "idx 42 ist für M1-14 parallel reserviert, der Gesamtbestand zaehlt 43 Migrationen" — if idx 42 = 0042 (M1-14), then idx 43 = 0043 (M1-15), total = 44 migrations (0..43). Contradiction: TOTAL_MIGRATION_COUNT=43 vs m111a test expecting last idx 43.

  Unless 0042 doesn't exist yet (M1-14 parallel lane not merged) — then the journal has entries 0..41 + 0043 as idx 42?? But m111a test expects idx: 43! Hmm wait — actually re-read: the m111a test expects `entries.at(-1)` to match idx 43, tag 0043_m1_15. For idx 43 to exist, there must be 44 entries (0..43) — meaning 0042 IS in the journal (M1-14 merged). Then TOTAL_MIGRATION_COUNT should be 44, but the upgrade test says 43 with comment "idx 42 reserviert für M1-14" — that comment reads like 0042 isn't there. These two tests look mutually inconsistent... but the prompt states 180/180 green. If TOTAL_MIGRATION_COUNT is used to assert journal length, and the journal has 44 entries, the test would fail. Since the gate is green, maybe TOTAL_MIGRATION_COUNT=43 counts something else (e.g., migrations after a base) or the m111a upgrade test asserts count differently. From the diff alone I can't resolve; but the internal inconsistency of comments/expectations (idx 43 last entry vs total 43) is suspicious. Wait, maybe: TOTAL_MIGRATION_COUNT counts 0..41 (=42 migrations) + 0043 → 43 total when 0042 absent, and last idx would be 42 tagged 0043. But m111a test expects idx 43! Conflict again. Hmm.

  Unless drizzle journal idx doesn't renumber: drizzle's `_journal.json` entries carry `idx` assigned at generation; if 0042 was generated and later removed, 0043 keeps idx 43 while total entries = 43. Then both assertions hold: 43 entries, last has idx 43 (idx 42 missing). The comment "idx 42 ist für M1-14 parallel reserviert" supports exactly this: idx 42 is a gap reserved for M1-14. Clever and consistent. OK — no finding; the comment explains it. Good.

  13. **concurrent-index-contract**: `ensureAppointmentActivityIndex` drops the M111A index if predicate lacks appointments and recreates with appointment types. It uses CREATE INDEX CONCURRENTLY with the same name after DROP CONCURRENTLY — inside a transaction? CREATE INDEX CONCURRENTLY can't run in a transaction block — presumably the runner handles (existing pattern). It also drops M110 task index — "Der verifizierte breitere Ersatz erlaubt..." consistent with prior note behavior. One concern: `predicateHasAppointments` regex tests state?.predicate — if index missing entirely, `state?.predicate ?? ""` → false → but guarded by `state &&` → if !state, skips drop, goes to create — but if the index doesn't exist and 0043 applied, creates M115 index. But if M111A index never existed and M115 migration... fine.

  Subtle: `M115_PROJECT_ACTIVITY_INDEX_SQL` recreates index named `M111A_PROJECT_ACTIVITY_INDEX` (same name, wider predicate) — intentional name reuse. OK.

  14. **events.ts check constraint** — extended with three appointment event types. But wait: does `emitEvent` validate event types against this DB check? domain_events check includes new types ✓.

  15. **Permissions matrix test**: 24 actions ✓.

  16. **tenant-invariants**: three tables added to ACTOR_SCOPED_TABLES ✓.

  17. **tenant-fixtures crossWriteOverrides**: disables triggers to insert cross-tenant garbage — used for RLS negative tests. Disabling triggers requires table owner or superuser — test runs as owner presumably. House pattern. OK.

  18. **fixtureProjectAppointmentGraph**: sets app.actor_id — ok.

  19. **page.tsx DeniedState for appointment read denied**: For externals, earlier project-level checks would already deny. But a role matrix edge: appointment.read internalOnly viewer+; anyone who can see the project page but not appointments? `project.read` for externals vs appointment.read internal — external assigned to project can view project page (assigned external) but appointment.read is internalOnly → denied → **whole page replaced by DeniedState "Termine sind für dich nicht freigegeben."**! That's a real UX/logic bug: an external assignee viewing the project (via assigned-external-request-view) gets the entire page denied because the appointment section can't load. The page has external-facing views (AssignedExternalRequestView). If externals can legitimately load this page, the appointment load must degrade to "section hidden", not whole-page DeniedState. Let me check: page.tsx shows imports AssignedExternalRequestView — the page does serve externals in some mode. If an external reaches ProjectTriagePage... hmm, actually maybe externals get redirected to a different page before this component. Can't verify from diff. But the DeniedState-per-whole-page for a *section* read failure is at minimum questionable: spec §3.1 says Denied state without existence leak; but blocking the entire project page because a section is denied is over-broad IF any legitimate viewer of the page lacks appointment.read. Roles: viewer/editor/admin all have appointment.read. External: do they reach this page? There's `redirectToProjectLogin` and DeniedState already used for project detail load; if externals are excluded from ProjectTriagePage entirely upstream, fine. The presence of AssignedExternalRequestView suggests external actors get a different view within this same route. If that view is a different component branch before appointment load, ok. The appointment load happens after note load, presumably in the internal branch. Given the flow shown, appointment load happens unconditionally in ProjectTriagePage — if ProjectTriagePage is only for internals, fine. Since M1-13 notes do the same (notePageResult denied → DeniedState), this matches the established pattern. Not a finding; pattern-consistent.

  20. **berlinWallClockIso hour "24"** — discussed; en-CA hour12:false → h23 per UTS? Risk minimal; skip or P3. I'll include as tiny P2 note? Max 150 lines... I'll fold it into a P2 about duplicating the wall-clock formatter instead of reusing the contract util. Actually the contract has isBerlinWallClock but no formatter export. The page could pass UTC instants and let SQL compute Berlin window bounds... Minor. Skip to save lines? Criterion 2 asks about Zeitvertrag — worth one P2 bullet: hourCycle not pinned → use `hourCycle: "h23"` to rule out "24:00" formatting. Cheap and concrete. Include as P2.

  21. **Spec says contract path `lib/integrations/appointments/contract.ts` and module `modules/appointments/`** — implementation uses `lib/integrations/calendar/contract.ts` and `modules/calendar/`. Spec §6 names differ, but spec §10 says Readmodel über `modules/appointments/`. Deviation from spec naming — cosmetic; ADR 0021 may say calendar. The spec literally names `modules/appointments/`. Implementation chose `modules/calendar/`. Is that a spec violation? The Spec is the contract... but naming of module dir is low-stakes; spec §6: "Vertrag lib/integrations/appointments/contract.ts ... Service modules/appointments/". Diff deviates. P2 discipline/spec-conformance note.

  22. **Spec M115-04 view types**: range V1 includes view enum month/week/list ✓.

  23. **`categoryId` validation** — covered in #FK finding (P2).

  24. **Spec §8: Payload minimal — no title/description/location/time in payload** ✓ evidence = {projectId, appointmentId, revision} ✓.

  25. **Spec §8: activity index additiv erweitert in Migration 0043** — hmm! The concurrent-index-contract handles index evolution out-of-band (concurrent, can't be in migration tx). The M1-13 index flow: was the index created via script rather than migration? The events.ts check is in migration. The partial index `domain_events_project_activity_idx` — M111A_PROJECT_ACTIVITY_INDEX name suggests it's managed by the script (concurrent). Spec says "muss in Migration 0043 additiv ... erweitert (neu erzeugt) werden" — implementation does it via concurrent-index-contract script instead (because CREATE INDEX CONCURRENTLY can't run in drizzle migration tx). That's a justified deviation matching prior M1-13 pattern. Fine.

  26. **Erasure test**: "Erasure-Graph und Migration tragen appointmentIds (quellgepinnt)" — string-matching test, plus the DB race test. Spec M115-ERASURE-01/02 wants actual erase deleting appointments — is there a test actually executing erase_inactive_lead with appointments? The shown test only string-matches migration content and checks the race. No end-to-end erasure execution test visible in the diff for appointments (maybe in another erasure test file updated? Not shown). The erasure-hash tests (m203b1) updated. An actual erase-with-appointments DB test may exist in files not diffed... The diff shows no test executing erase_inactive_lead against a graph with appointmentIds. That's a coverage gap vs spec Testmatrix "Erasure: erase_inactive_lead löscht Termine (kaskadierend Teilnehmer)". P1? The gate is green and tombstone guard + graph function tested indirectly... The test "verhindert frische Inserts nach Kontakterasure" simulates contact deletion but doesn't run erase_inactive_lead. Given spec explicitly lists the erasure execution case, missing test = P1 (Spec-Testlücke) or P2. I'd say P2-P1... The erase path for appointments is new SQL (DELETE block) — untested execution risks silent failure. I'll rate P1: fehlender Ausführungstest der Erasure-Löschung.

  Hmm wait — maybe existing erasure DB tests (tests/db for M1-13) were extended in files not shown? The diff shows only m111a/m203b1/tenant-invariants test updates. No erasure-execution test diff. Flag it.

  27. **Audit count in test = 3** — create+update+delete each write audit ✓.

  28. **`emitAppointmentEvidence` on denied attempts**: no event/audit on denial ✓ (thrown before emit).

  29. **`AppointmentConflictError.currentRevision` exposed via action?** appointment-actions.ts not shown — mapping unknown. Error codes enum exists. OK.

  30. **Trigger `project_appointment` UPDATE: `NEW.revision IS DISTINCT FROM OLD.revision + 1`** — but what if someone sets revision = OLD.revision + 1 directly bypassing CAS (e.g., app_runtime raw update with revision+1 but stale)? CAS in service WHERE clause protects. Trigger allows any revision = old+1. Fine.

  31. **The guard INSERT: `created_by IS DISTINCT FROM actor_id`** — actor from app_actor_id(); service passes ctx.actor ✓.

  32. **RLS policy SELECT OR-clause `CURRENT_USER = 'app_owner' AND app_actor_id() IS NULL`** — migrator/owner path; consistent.

  33. **calendar_category RESTRICTIVE select requires read-role; app_owner-without-actor allowed** ✓.

  34. **Grant: app_runtime gets DELETE on project_appointment** — needed for hard delete ✓. Erasure runs as app_owner via SECURITY DEFINER erase_inactive_lead? erase is SECURITY DEFINER owned by app_owner — executes as app_owner, deletes as owner. But FORCE RLS applies to owner — tenant_isolation permissive policy must pass: requires app.workspace_id set. erase function presumably sets it (M1-07). Existing pattern. OK.

  35. **Zod v4 usage**: `z.uuid()`, `z.string().min(1)`, discriminatedUnion — matches repo (green gate).

  36. **`appointmentInstantSchema` allows fractional seconds up to 3 digits; output `.MS` 3 digits ✓; round-trip: input "10:00:00" → output "10:00:00.000" ✓ test.**

  37. **Duplicate formatter**: page.tsx formats range bounds; options not schema-validated before SQL cast — a malformed rangeStart would raise PG error. Since it's server-computed, fine.

  38. **Spec §4.4: DTO `start` ISO Europe/Berlin-normalized** ✓.

  39. **Missing `NOT NULL`/default on category `order`** ✓ default 0.

  40. **`calendar_category` name check uses normalize()** — requires PG13+ ✓ PG18.

  41. **P2: appointment_dialog/actions not shown** — note only.

  42. **Spec §3.1 Loading/Empty etc.** — UI, not in diff.

  43. **db-role-contract: `r:calendar_category` placed in read list; grants list has select only** ✓. Pins include policy hashes for 9 policies ✓ triggers ✓ grants ✓ EXECUTE pins: runtime routines granted, private revoked ✓.

  44. One more possible issue: **`_m115_guard_project_appointment` DELETE branch for erasure**: checks `_m115_erasure_delete_allowed(OLD.workspace_id, OLD.id)` — tombstone graph contains appointmentIds — ✓. But attendee guard DELETE checks erasure by appointment_id ✓. Cascade order fine.

  45. **`erase` upgrade: `new_replay_graph` includes appointmentIds in replay document** — replay validation mirrors graph. ✓.

  46. **Hash-pin discipline**: the migration pins the M1-13 source hash `891d...`; db-role-contract expects post-upgrade hash `627c...` when hasProjectAppointments ✓ chain consistent.

  47. **Concurrency in concurrent-index-contract**: `ensureM110ProjectTaskActivityIndex` now routes to appointment index when 0043 applied — name retained `M110_...` function but fine.

  48. **events.ts: check constraint edit** — drizzle regenerates constraint? Changing check on domain_events requires migration — is that in 0043? The migration 0043 content shown does NOT include altering domain_events check constraint! events.ts diff adds the three event types to the check, but 0043 SQL shown doesn't contain `ALTER TABLE domain_events ... CHECK`. Hmm — maybe the check constraint change lands in a separate part of 0043 not shown? The shown 0043 SQL is complete-ish (starts with CREATE TABLEs...). The domain_events check update is missing from the shown migration. If missing, emitEvent with project.appointment_created would violate the DB check constraint at runtime! But the service test inserts events and passes (180/180 green against real PG) → so the constraint must allow it. Maybe the domain_events check in DB is generated from schema via db:generate — "db:generate ohne Drift" means schema matches migrations; if events.ts changed, generate would produce drift unless 0043 contains the ALTER. The shown 0043 doesn't include it... unless the check isn't enforced as named constraint in DB (drizzle check on domain_events — the constraint exists since events listed in schema with check()). Actually maybe the 0043 file has more content beyond what's pasted? The paste looks complete (ends with erasure ACL DO block). Hmm, but tests pass with event insert — the test "editiert und löscht..." counts domain_events with appointment_deleted = 1 → insert succeeded → constraint allows it. So either DB constraint was altered (maybe migrations 0044+? no) or the check constraint on domain_events doesn't exist as DB object (maybe the check is only in drizzle schema and was never enforced?). "db:generate ohne Drift" would then complain... unless drizzle doesn't diff check constraints? Drizzle Kit does track checks. Puzzling, but the gate passed — maybe 0043's full file includes the ALTER but was elided in the prompt paste? I can't verify. Since gate green + runtime test inserts events successfully, the constraint evidently allows the new types. Not a finding; maybe note as "im gezeigten 0043-Auszug kein domain_events-Check-ALTER sichtbar — vermutlich im nicht gezeigten Teil/oder Gate deckt es". Actually the prompt says "db:generate ohne Drift" — trust it. Skip? I'll add a one-line Hinweis.

  Hmm, wait — actually maybe there IS more to 0043 not pasted (the paste shows the full file though, starting "=== NEU ===" to next "=== NEU: lib/db/schema/appointment.ts ==="). Between them the migration ends with the erasure ACL. No domain_events ALTER. But the diff for events.ts IS shown. For zero drift, some migration must contain the updated check... Possibly 0043 was generated and the prompt paste truncated middle portions? The paste seems continuous. Since the integration test actually inserts project.appointment_deleted into domain_events and passes, the live DB accepts it — so the ALTER must exist somewhere (maybe in 0043 as generated, omitted in prompt). I'll mention as a verification note (P2/Hinweis): domain_events-Check-Erweiterung nicht im gezeigten Migrations-Auszug sichtbar; da Event-Inserts im Test grün, offenbar vorhanden — sicherstellen, dass sie in 0043 enthalten ist.

  Hmm, careful: drizzle `check()` constraints — does db:generate diff them? Yes it does (check constraints are part of snapshots). OK one-line note.

  49. **Test uses raw insert into project via kanban join** — fine.

  50. **`validateAttendeeMemberships` uses `in (${uuidList(expected)})`** — sql.join of parameterized u

---
> Hinweis Root: Kimi-Ausgabe abgeschnitten (CLI-Stream eingefroren); Befunde vollständig geerntet und an den Implementierer zur Schließung übergeben (2026-09-03).
