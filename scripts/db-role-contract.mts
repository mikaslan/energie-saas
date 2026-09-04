import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";

export const STRICT_DB_ROLE_MODE = "strict" as const;
export const TEST_DB_ROLE_MODE = "test-legacy-single" as const;

export type DbRoleMode = typeof STRICT_DB_ROLE_MODE | typeof TEST_DB_ROLE_MODE;

const APP_ROLES = [
  "app_owner",
  "app_migrator",
  "app_runtime",
  "app_system",
  "app_auth",
  "app_worker",
  "app_erasure",
  "app_membership_writer",
  "identity_reconciler",
] as const;

const LOGIN_APP_ROLES = new Set([
  "app_migrator",
  "app_runtime",
  "app_system",
  "app_auth",
  "app_worker",
]);

const LOCAL_SUPERUSER_PROVISIONING_ROLE = "postgres";
const SAFE_ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;

const OFFER_RELEASE_RELATIONS = [
  "offer_recipient",
  "offer_recipient_revision",
  "offer_release_candidate",
  "offer_release_candidate_approval",
  "offer_release_profile",
  "offer_release_profile_activation",
  "offer_release_profile_revision",
] as const;

const OFFER_RELEASE_RUNTIME_SELECT_RELATIONS = [
  "offer_recipient",
  "offer_recipient_revision",
  "offer_release_profile",
  "offer_release_profile_activation",
  "offer_release_profile_revision",
] as const;

const OFFER_RELEASE_WORKER_UPDATE_COLUMNS = [
  "artifact_bytes",
  "artifact_mime_type",
  "artifact_sha256",
  "artifact_size_bytes",
  "artifact_version",
  "attempt_count",
  "error_code",
  "error_retryable",
  "finished_at",
  "lease_expires_at",
  "lease_token",
  "next_attempt_at",
  "started_at",
  "state",
  "updated_at",
] as const;

const OFFER_ISSUANCE_RELATIONS = [
  "offer_issuance",
  "offer_issuance_approval",
  "offer_issuance_withdrawal",
] as const;

const CATALOG_IMPORT_RELATIONS = [
  "catalog_import_dispatch_receipt",
  "catalog_import_job",
  "catalog_import_row",
  "catalog_import_row_result",
] as const;

const PROJECT_TASK_RELATIONS = [
  "project_task",
  "project_task_assignee",
  "project_task_checklist_item",
  "project_task_label",
] as const;

const PROJECT_TASK_RUNTIME_ROUTINES = [
  "public._m110_actor_can_read_tasks(uuid)",
  "public._m110_actor_can_write_tasks(uuid)",
  "public._m110_actor_task_role(uuid)",
  "public._m110_valid_task_rich_text_v1(jsonb)",
] as const;

const PROJECT_TASK_PRIVATE_ROUTINES = [
  "public._m110_erasure_delete_allowed(uuid,uuid)",
  "public._m110_guard_project_task()",
  "public._m110_guard_project_task_child()",
  "public._m110_guard_project_task_positions()",
] as const;

const PROJECT_OUTCOME_RELATIONS = ["project_loss_reason"] as const;
const PROJECT_OUTCOME_RUNTIME_ROUTINES = [
  "public._m111a_actor_can_manage_loss_reasons(uuid)",
  "public._m111a_actor_can_read_loss_reasons(uuid)",
  "public._m111a_actor_role(uuid)",
] as const;
const PROJECT_OUTCOME_PRIVATE_ROUTINES = [
  "public._m111a_erasure_scrub_allowed(uuid,uuid)",
  "public._m111a_guard_loss_reason()",
  "public._m111b_guard_outcome_evidence_insert()",
  "public._m111b_guard_project_outcome()",
  "public._m111b_record_project_outcome()",
] as const;
const PROJECT_OUTCOME_FUNCTION_NAMES = [
  ...PROJECT_OUTCOME_RUNTIME_ROUTINES,
  ...PROJECT_OUTCOME_PRIVATE_ROUTINES,
].map((signature) => signature.slice("public.".length, signature.indexOf("(")));

const CUSTOMER_NOTIFICATION_RELATIONS = [
  "customer_notification",
  "customer_notification_delivery_attempt",
] as const;
const CUSTOMER_NOTIFICATION_RUNTIME_ROUTINES = [
  "public._m111b_project_has_binding_issuance(uuid,uuid)",
  "public._m111b_read_notification_delivery(uuid,uuid)",
] as const;
const CUSTOMER_NOTIFICATION_WORKER_ROUTINES = [
  "public._m111b_customer_notification_dispatch_state(uuid,uuid)",
  "public._m111b_worker_resolve_recipient(uuid,uuid)",
  "public._m111b_worker_deliver(uuid,uuid,integer,text,text)",
  "public._m111b_worker_cancel_erased(uuid,uuid)",
] as const;
const CUSTOMER_NOTIFICATION_PRIVATE_ROUTINES = [
  "public._m111b_guard_offer_freeze()",
  "public._m111b_guard_customer_notification()",
  "public._m111b_guard_delivery_attempt()",
] as const;
const CUSTOMER_NOTIFICATION_FUNCTION_NAMES = [
  ...CUSTOMER_NOTIFICATION_RUNTIME_ROUTINES,
  ...CUSTOMER_NOTIFICATION_WORKER_ROUTINES,
  ...CUSTOMER_NOTIFICATION_PRIVATE_ROUTINES,
].map((signature) => signature.slice("public.".length, signature.indexOf("(")));

const PROJECT_NOTE_RELATIONS = ["project_note"] as const;
const PROJECT_NOTE_RUNTIME_ROUTINES = [
  "public._m113_actor_can_read_notes(uuid)",
  "public._m113_actor_can_write_notes(uuid)",
  "public._m113_actor_note_role(uuid)",
] as const;
const PROJECT_NOTE_PRIVATE_ROUTINES = [
  "public._m113_erasure_delete_allowed(uuid,uuid)",
  "public._m113_guard_project_note()",
] as const;
const PROJECT_NOTE_FUNCTION_NAMES = [
  ...PROJECT_NOTE_RUNTIME_ROUTINES,
  ...PROJECT_NOTE_PRIVATE_ROUTINES,
].map((signature) => signature.slice("public.".length, signature.indexOf("(")));

const PROJECT_APPOINTMENT_RELATIONS = [
  "calendar_category",
  "project_appointment",
  "project_appointment_attendee",
] as const;
const PROJECT_APPOINTMENT_RUNTIME_ROUTINES = [
  "public._m115_actor_appointment_role(uuid)",
  "public._m115_actor_can_read_appointments(uuid)",
  "public._m115_actor_can_write_appointments(uuid)",
] as const;
const PROJECT_APPOINTMENT_PRIVATE_ROUTINES = [
  "public._m115_erasure_delete_allowed(uuid,uuid)",
  "public._m115_guard_project_appointment()",
  "public._m115_guard_project_appointment_attendee()",
] as const;
const PROJECT_APPOINTMENT_FUNCTION_NAMES = [
  ...PROJECT_APPOINTMENT_RUNTIME_ROUTINES,
  ...PROJECT_APPOINTMENT_PRIVATE_ROUTINES,
].map((signature) => signature.slice("public.".length, signature.indexOf("(")));

const SIGNATURE_RELATIONS = [
  "signature_attestation",
  "signature_request",
  "signature_view_log",
] as const;
// RLS-FREIER Token-Locator (Muster erasure_operation_locator): kein tenant-
// RLS, Zugriff ausschließlich über SECURITY-DEFINER-Kapseln.
const SIGNATURE_LOCATOR_RELATION = "signature_token_locator" as const;
const SIGNATURE_RUNTIME_ROUTINES = [
  "public._m204_actor_can_read_signatures(uuid)",
  "public._m204_actor_can_write_signatures(uuid)",
  "public._m204_actor_signature_role(uuid)",
  "public.create_signature_request(uuid,uuid,uuid,integer,bytea)",
  "public.record_signature_view(bytea)",
  "public.resolve_signature_public_view(bytea)",
  "public.revoke_signature_by_customer(bytea)",
  "public.sign_signature_by_token(bytea,text,text,bytea)",
] as const;
const SIGNATURE_PRIVATE_ROUTINES = [
  "public._m204_erasure_scrub_allowed(uuid,uuid)",
  "public._m204_guard_signature_attestation()",
  "public._m204_guard_signature_request()",
  "public._m204_guard_signature_view_log()",
] as const;

const INVOICING_RELATIONS = [
  "workspace_invoicing_settings",
  "workspace_document_number_format",
] as const;
const INVOICING_RUNTIME_ROUTINES = [
  "public._m300_actor_invoicing_role(uuid)",
  "public._m300_actor_can_read_invoicing(uuid)",
  "public._m300_actor_can_write_invoicing(uuid)",
] as const;
const INVOICING_FUNCTION_NAMES = [
  ...INVOICING_RUNTIME_ROUTINES,
].map((signature) => signature.slice("public.".length, signature.indexOf("(")));

const ECONOMICS_RELATIONS = [
  "workspace_economics_settings",
] as const;
const ECONOMICS_RUNTIME_ROUTINES = [
  "public._f406_actor_economics_role(uuid)",
  "public._f406_actor_can_read_economics(uuid)",
  "public._f406_actor_can_write_economics(uuid)",
] as const;
const ECONOMICS_FUNCTION_NAMES = [
  ...ECONOMICS_RUNTIME_ROUTINES,
].map((signature) => signature.slice("public.".length, signature.indexOf("(")));

const LEAD_SOURCE_RELATIONS = [
  "lead_source",
] as const;

const TIME_TRACKING_RELATIONS = [
  "time_event_type",
  "time_entry",
] as const;

const CHECKLIST_RELATIONS = [
  "project_checklist",
] as const;

const CALENDAR_RELATIONS = [
  "calendar",
] as const;

const CHECKLIST_TEMPLATE_RELATIONS = [
  "checklist_template",
] as const;

const COMMERCIAL_DOCUMENT_RELATIONS = [
  "commercial_document",
  "commercial_document_group",
  "commercial_document_line",
  "commercial_document_number_series",
] as const;
const COMMERCIAL_DOCUMENT_RUNTIME_ROUTINES = [
  "public._m301_actor_invoicing_role(uuid)",
  "public._m301_actor_can_read_invoicing(uuid)",
  "public._m301_actor_can_write_invoicing(uuid)",
] as const;
const COMMERCIAL_DOCUMENT_PRIVATE_ROUTINES = [
  "public._m301_guard_issued_immutable()",
] as const;
const COMMERCIAL_DOCUMENT_FUNCTION_NAMES = [
  ...COMMERCIAL_DOCUMENT_RUNTIME_ROUTINES,
  ...COMMERCIAL_DOCUMENT_PRIVATE_ROUTINES,
].map((signature) => signature.slice("public.".length, signature.indexOf("(")));

const CATALOG_IMPORT_PRIVATE_ROUTINES = [
  "public._m108b_authorize_catalog_import_runtime(uuid)",
  "public._m108b_catalog_import_actor_auth_code(uuid,uuid)",
  "public._m108b_catalog_import_error_source_header_bytes(jsonb)",
  "public._m108b_catalog_import_persisted_input_valid(uuid,uuid)",
  "public._m108b_catalog_import_receipt_response(uuid,uuid,uuid,text,text,bigint)",
  "public._m108b_derive_catalog_import_row_payload()",
  "public._m108b_guard_catalog_import_job()",
  "public._m108b_guard_catalog_import_row()",
  "public._m108b_jsonb_date(jsonb)",
  "public._m108b_jsonb_exact_keys(jsonb,text[])",
  "public._m108b_jsonb_integer_between(jsonb,numeric,numeric)",
  "public._m108b_jsonb_sha256(jsonb)",
  "public._m108b_jsonb_trimmed_text(jsonb,integer,integer)",
  "public._m108b_jsonb_uuid(jsonb)",
  "public._m108b_lock_catalog_import_workspace(uuid)",
  "public._m108b_redact_catalog_import_error_array(jsonb)",
  "public._m108b_valid_catalog_import_commercial(jsonb)",
  "public._m108b_valid_catalog_import_error_array(jsonb)",
  "public._m108b_valid_catalog_import_expected(jsonb)",
  "public._m108b_valid_catalog_import_lease_rows(integer[])",
  "public._m108b_valid_catalog_import_mapping(jsonb)",
  "public._m108b_valid_catalog_import_presentation(jsonb)",
  "public._m108b_valid_catalog_import_provenance(jsonb)",
  "public._m108b_valid_catalog_import_revision(jsonb)",
  "public._m108b_valid_catalog_import_row_command(jsonb)",
  "public._m108b_valid_catalog_import_sealed_target(jsonb)",
  "public._m108b_valid_catalog_import_source_command(jsonb)",
  "public._m108b_valid_catalog_import_technical_data(text,jsonb)",
  "public._m108b_validate_catalog_import_dispatch_receipt()",
  "public._m108b_validate_catalog_import_job_input()",
  "public._m108b_validate_catalog_import_redaction()",
  "public._m108b_validate_catalog_import_result_input()",
  "public._m108b_validate_catalog_import_row_input()",
  "public.canonicalize_catalog_json_v1(jsonb)",
] as const;

const CATALOG_IMPORT_RUNTIME_ROUTINES = [
  "public.cancel_catalog_import_v1(uuid,uuid)",
  "public.prepare_catalog_import_v1(uuid,uuid,jsonb)",
  "public.read_catalog_import_rows_v1(uuid,uuid,integer,integer)",
  "public.read_catalog_import_v1(uuid,uuid)",
  "public.read_latest_catalog_import_id_v1(uuid)",
  "public.start_catalog_import_v1(uuid,uuid,text)",
] as const;

const CATALOG_IMPORT_WORKER_ROUTINES = [
  "public.apply_catalog_import_row_v1(uuid,uuid,integer,uuid,bigint)",
  "public.claim_catalog_import_v1(uuid,uuid,uuid,integer)",
  "public.cleanup_catalog_import_snapshots_v1(uuid,integer)",
  "public.complete_catalog_import_batch_v1(uuid,uuid,uuid,bigint)",
  "public._m108b_catalog_import_dispatch_state(uuid,uuid,text)",
  "public.finalize_catalog_import_failure_v1(uuid,uuid,uuid,bigint,text)",
  "public.record_catalog_import_dispatch_failure_v1(uuid,uuid,uuid,text)",
  "public.record_catalog_import_preclaim_failure_v1(uuid,uuid,uuid,text)",
  "public.recover_catalog_imports_v1(uuid,integer)",
] as const;

const CATALOG_IMPORT_PGBOSS_RUNTIME_ROUTINES = [
  "pgboss.enqueue_catalog_import_cleanup_v1(uuid,uuid,uuid)",
  "pgboss.enqueue_catalog_import_v1(uuid,uuid,uuid)",
] as const;

const CATALOG_IMPORT_PGBOSS_WORKER_ROUTINES = [
  "pgboss.list_catalog_import_cleanup_locator_jobs_v1(uuid,integer)",
  "pgboss.list_catalog_import_recovery_locator_jobs_v1(uuid,integer)",
  "pgboss.quarantine_catalog_import_locator_job_v1(uuid)",
] as const;

const CATALOG_IMPORT_PGBOSS_ROUTINES = [
  ...CATALOG_IMPORT_PGBOSS_RUNTIME_ROUTINES,
  ...CATALOG_IMPORT_PGBOSS_WORKER_ROUTINES,
] as const;

const CATALOG_IMPORT_ROUTINES = [
  ...CATALOG_IMPORT_PRIVATE_ROUTINES,
  ...CATALOG_IMPORT_RUNTIME_ROUTINES,
  ...CATALOG_IMPORT_WORKER_ROUTINES,
] as const;

const CATALOG_IMPORT_FUNCTION_NAMES = CATALOG_IMPORT_ROUTINES.map(
  (signature) => signature.slice("public.".length, signature.indexOf("(")),
);

export interface DbRoleProvisioningTopology {
  /** SQL-Admin, der die Zielrollen angelegt und die Fachkanten erteilt hat. */
  provisioningAdminRole: string;
  /** Grantor der von PostgreSQL 18 automatisch angelegten ADMIN-Kanten. */
  bootstrapGrantorRole: string;
  /**
   * Nur nach einem Legacy-Cutover: gehärtete Altrolle, deren unverfügbare
   * identity_reconciler-Bootstrapkante exakt erhalten bleibt.
   */
  retainedLegacyRole?: string;
}

function assertContractRoleName(label: string, value: string): void {
  if (!SAFE_ROLE_NAME.test(value)) {
    throw new Error(`${label} ist kein sicherer PostgreSQL-Rollenname.`);
  }
  if ((APP_ROLES as readonly string[]).includes(value)) {
    throw new Error(`${label} darf keine geschützte App-Zielrolle benennen.`);
  }
}

export function validateDbRoleProvisioningTopology(
  topology: DbRoleProvisioningTopology,
): void {
  assertContractRoleName("provisioningAdminRole", topology.provisioningAdminRole);
  assertContractRoleName("bootstrapGrantorRole", topology.bootstrapGrantorRole);
  if (topology.provisioningAdminRole === topology.bootstrapGrantorRole) {
    throw new Error(
      "Provisioning-Admin und Bootstrap-Grantor müssen im Providervertrag verschieden sein.",
    );
  }
  if (topology.retainedLegacyRole) {
    assertContractRoleName("retainedLegacyRole", topology.retainedLegacyRole);
    if (
      topology.retainedLegacyRole === topology.provisioningAdminRole ||
      topology.retainedLegacyRole === topology.bootstrapGrantorRole
    ) {
      throw new Error("Die retainedLegacyRole muss von Provisioning-Admin/Bootstrap verschieden sein.");
    }
  }
}

export function dbRoleProvisioningTopologyFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DbRoleProvisioningTopology | undefined {
  const provisioningAdminRole = env.DB_ROLE_PROVISIONING_ADMIN;
  const bootstrapGrantorRole = env.DB_ROLE_BOOTSTRAP_GRANTOR;
  const retainedLegacyRole = env.DB_ROLE_RETAINED_LEGACY_ROLE;
  if (!provisioningAdminRole && !bootstrapGrantorRole && !retainedLegacyRole) return undefined;
  if (!provisioningAdminRole || !bootstrapGrantorRole) {
    throw new Error(
      "DB_ROLE_PROVISIONING_ADMIN und DB_ROLE_BOOTSTRAP_GRANTOR müssen gemeinsam gesetzt sein; " +
        "DB_ROLE_RETAINED_LEGACY_ROLE ist nur zusammen mit beiden zulässig.",
    );
  }
  const topology: DbRoleProvisioningTopology = {
    provisioningAdminRole,
    bootstrapGrantorRole,
    ...(retainedLegacyRole ? { retainedLegacyRole } : {}),
  };
  validateDbRoleProvisioningTopology(topology);
  return topology;
}

/** Grantor-genauer Zielvertrag für alle Membership-Kanten der App-Rollen. */
export function expectedDbRoleMembershipSignatures(
  topology?: DbRoleProvisioningTopology,
): string[] {
  if (topology) validateDbRoleProvisioningTopology(topology);
  const provisioningAdmin = topology?.provisioningAdminRole ?? LOCAL_SUPERUSER_PROVISIONING_ROLE;
  const identityOwnerGrantor = topology?.retainedLegacyRole
    ? topology.bootstrapGrantorRole
    : provisioningAdmin;
  const signatures = [
    `app_membership_writer>app_owner@${provisioningAdmin}:false/false/false`,
    `app_membership_writer>app_system@${provisioningAdmin}:false/false/false`,
    `app_owner>app_migrator@${provisioningAdmin}:false/false/true`,
    `app_worker>app_migrator@${provisioningAdmin}:false/false/true`,
    `identity_reconciler>app_owner@${identityOwnerGrantor}:true/false/false`,
  ];
  if (!topology) return signatures.sort();

  for (const roleName of APP_ROLES) {
    // Im Legacy-Cutover existiert identity_reconciler bereits. PostgreSQL hat
    // deshalb keine CREATE-ROLE-Bootstrapkante zum neuen Provisioning-Admin
    // angelegt; ausschließlich die historische Kante zur retained Legacy-
    // Rolle bleibt erhalten. Alle im Cutover frisch angelegten App-Rollen
    // besitzen dagegen weiterhin ihre providerseitige Bootstrapkante.
    if (topology.retainedLegacyRole && roleName === "identity_reconciler") continue;
    signatures.push(
      `${roleName}>${topology.provisioningAdminRole}@${topology.bootstrapGrantorRole}:` +
        "true/false/false",
    );
  }
  for (const ownerRole of ["app_owner", "app_worker"] as const) {
    signatures.push(
      `${ownerRole}>${topology.provisioningAdminRole}@${topology.provisioningAdminRole}:` +
        "false/false/true",
    );
  }
  if (topology.retainedLegacyRole) {
    signatures.push(
      `identity_reconciler>${topology.retainedLegacyRole}@${topology.bootstrapGrantorRole}:` +
        "true/false/false",
    );
  }
  return signatures.sort();
}

const APPLY_DEFAULT_PRIVILEGE_CONTRACT_SQL = `
  alter default privileges for role app_owner
    revoke all on tables from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_erasure, app_membership_writer, identity_reconciler;
  alter default privileges for role app_owner in schema public
    revoke all on tables from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_erasure, app_membership_writer, identity_reconciler;
  alter default privileges for role app_owner
    revoke all on sequences from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_erasure, app_membership_writer, identity_reconciler;
  alter default privileges for role app_owner in schema public
    revoke all on sequences from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_erasure, app_membership_writer, identity_reconciler;
  alter default privileges for role app_owner
    revoke all on functions from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_erasure, app_membership_writer, identity_reconciler;
  alter default privileges for role app_owner in schema public
    revoke all on functions from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_erasure, app_membership_writer, identity_reconciler;
  alter default privileges for role app_owner
    revoke all on types from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_erasure, app_membership_writer, identity_reconciler;
  alter default privileges for role app_owner in schema public
    revoke all on types from public, app_migrator, app_runtime, app_system,
      app_auth, app_worker, app_erasure, app_membership_writer, identity_reconciler;

  grant identity_reconciler to app_owner
    with inherit false, set true granted by current_user;
  set role identity_reconciler;
  alter default privileges
    revoke all on functions from public, app_owner, app_migrator, app_runtime,
      app_system, app_auth, app_worker, app_erasure, app_membership_writer;
  alter default privileges in schema public
    revoke all on functions from public, app_owner, app_migrator, app_runtime,
      app_system, app_auth, app_worker, app_erasure, app_membership_writer;
  set role app_owner;
  grant identity_reconciler to app_owner
    with inherit false, set false granted by current_user;
  revoke identity_reconciler from app_owner granted by app_owner;

  -- app_migrator ist der einzige Principal, der fuer Schemaaenderungen
  -- zwischen den beiden NOLOGIN-/Dienst-Ownern wechseln darf. Die gepinnte
  -- Kante ist NOINHERIT, ohne ADMIN und ausschliesslich SET-only.
  set role app_worker;
  alter default privileges
    revoke execute on functions from public, app_owner, app_migrator,
      app_runtime, app_system, app_auth, app_erasure, app_membership_writer,
      identity_reconciler;
  alter default privileges in schema pgboss
    revoke execute on functions from public, app_owner, app_migrator,
      app_runtime, app_system, app_auth, app_erasure, app_membership_writer,
      identity_reconciler;
  set role app_owner;
`;

// Allowlist statt Default-Grants: Eine neue Tabelle beginnt ohne Runtime-Recht
// und macht den Rollenvertrag rot, bis sie bewusst einem Dienst zugeordnet ist.
// Das Manifest läuft nach JEDER strikten Migration innerhalb einer Transaktion.
const APPLY_ROLE_CONTRACT_SQL = `
  revoke all privileges on all tables in schema public
    from public, app_runtime, app_system, app_auth, app_worker, app_erasure,
      identity_reconciler;
  revoke all privileges on all sequences in schema public
    from public, app_runtime, app_system, app_auth, app_worker, app_erasure,
      identity_reconciler;

  -- Nach einem ALTER OWNER erbt der neue Owner nicht zwingend die zuvor vom
  -- Legacy-Owner widerrufenen Tabellen-ACLs. DDL ist zwar owner-inhaerent,
  -- ein spaeterer FK braucht aber explizit REFERENCES. Der Migrations-Owner
  -- erhaelt deshalb seine vollstaendigen Eigenrechte deterministisch zurueck.
  grant all privileges on all tables in schema public to app_owner;
  grant all privileges on all sequences in schema public to app_owner;

  revoke all on schema public from public, app_runtime, app_system, app_auth,
    app_worker, app_erasure;
  grant usage on schema public to app_runtime, app_system, app_auth, identity_reconciler;

  grant select on
    public.workspace,
    public.membership,
    public.user_identity,
    public.site,
    public.domain_events,
    public.audit_log
  to app_runtime;
  -- PostgreSQL verlangt fuer SELECT ... FOR SHARE neben SELECT auch ein
  -- UPDATE-Recht. Die Autorisierungsgrenze sperrt damit am Commit genau die
  -- Workspace-Zeile gegen Membership-Widerrufe. Nur die bereits durch PK,
  -- RLS und FK-Vertrag unveraenderliche ID-Spalte wird dafuer freigegeben;
  -- Name und Feature-Flags bleiben fuer Runtime strikt nicht mutierbar.
  grant update (id) on public.workspace to app_runtime;
  grant insert, update, delete on public.site to app_runtime;
  grant insert on public.domain_events, public.audit_log to app_runtime;

  grant select, insert, update on public.workspace to app_system;
  grant select, insert, update, delete on public.membership to app_system;
  grant select, insert on public.user_identity to app_system;
  grant select, insert on public.domain_events, public.audit_log to app_system;

  grant select on public.membership to identity_reconciler;
  grant select, insert, update on public.user_identity to identity_reconciler;

  grant select, insert, update, delete on
    public.auth_user,
    public.auth_session,
    public.auth_account,
    public.auth_verification,
    public.auth_rate_limit
  to app_auth;

  revoke execute on function public.forbid_mutation()
    from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
  revoke execute on function public.user_identity_link_auth_only()
    from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
  revoke execute on function public.app_actor_id()
    from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
  revoke execute on function public.guard_membership_statement()
    from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
  revoke execute on function public.guard_membership_dml()
    from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
  grant execute on function public.app_actor_id() to app_runtime, app_system;

  grant identity_reconciler to app_owner
    with inherit false, set true granted by current_user;
  set role identity_reconciler;
  revoke execute on function public.reconcile_user_identity(text, text)
    from public, app_owner, app_runtime, app_system, app_worker, app_erasure;
  grant execute on function public.reconcile_user_identity(text, text) to app_auth;
  alter default privileges in schema public revoke execute on functions from public;
  set role app_owner;
  grant identity_reconciler to app_owner
    with inherit false, set false granted by current_user;
  -- PostgreSQL 18 speichert dieselbe Mitgliedschaft pro Grantor. Der
  -- kurzzeitige Self-Grant von app_owner wäre sonst eine zweite ACL-Zeile
  -- neben dem bootstrap-seitigen ADMIN-Grant. Nach dem Rückwechsel wird nur dieser
  -- temporäre Grantor-Pfad entfernt; ADMIN TRUE/SET FALSE des Bootstrap-
  -- Principals bleibt bestehen und trägt den nächsten Migrationslauf. SET ROLE
  -- app_owner statt RESET ROLE ist dabei tragend: RESET würde auf session_user
  -- (beim lokalen Cutover postgres) springen und einen falschen Grantor erzeugen.
  revoke identity_reconciler from app_owner granted by app_owner;
`;

interface RoleRow extends QueryResultRow {
  rolname: string;
  rolcanlogin: boolean;
  rolinherit: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolconnlimit: number;
  rolvaliduntil: Date | string | null;
  rolconfig: string[] | null;
}

interface EffectiveRoleSettingRow extends QueryResultRow {
  principal: string;
  setting_scope: "global" | "database" | "role" | "role+database";
  settings: string | null;
}

interface StandaloneTypeRow extends QueryResultRow {
  schema_name: string;
  type_kind: string;
  type_name: string;
  owner: string;
  effective_acl: string;
}

interface MembershipRow extends QueryResultRow {
  granted_role: string;
  member_role: string;
  grantor_role: string;
  admin_option: boolean;
  inherit_option: boolean;
  set_option: boolean;
}

interface EffectiveMembershipRow extends QueryResultRow {
  principal: string;
  membership_writer: boolean;
  neon_superuser: boolean;
}

interface AclRow extends QueryResultRow {
  grantee: string;
  grantor: string;
  object_name: string;
  privilege_type: string;
  is_grantable: boolean;
}

function equalRows(actual: string[], expected: string[], label: string): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    throw new Error(
      `${label} weicht vom Rollenvertrag ab.\nErwartet: ${e.join(", ")}\nIst: ${a.join(", ")}`,
    );
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Exakter Katalogvertrag aller App-Rollen. Neben den offensichtlichen
 * Privileg-Attributen sind CONNECTION LIMIT, Passwortablauf und beide
 * PostgreSQL-Setting-Speicher Teil der Trust Boundary: ein search_path- oder
 * row_security-Default darf nicht unbemerkt vor dem App-Code wirksam werden.
 */
export async function verifyAppRoleCatalogContract(
  client: PoolClient,
  label = "App-Rollen-Katalogvertrag",
): Promise<void> {
  const roles = await client.query<RoleRow>(`
    select rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls,
           rolcreatedb, rolcreaterole, rolreplication, rolconnlimit,
           rolvaliduntil, rolconfig
    from pg_catalog.pg_roles
    where rolname = any($1::text[])
    order by rolname
  `, [APP_ROLES]);
  equalRows(
    roles.rows.map((role) => [
      role.rolname,
      String(role.rolcanlogin),
      String(role.rolinherit),
      String(role.rolsuper),
      String(role.rolbypassrls),
      String(role.rolcreatedb),
      String(role.rolcreaterole),
      String(role.rolreplication),
      String(role.rolconnlimit),
      role.rolvaliduntil === null ? "-" : String(role.rolvaliduntil),
      role.rolconfig === null ? "-" : `{${role.rolconfig.join(",")}}`,
    ].join(":")),
    APP_ROLES.map((roleName) => [
      roleName,
      String(LOGIN_APP_ROLES.has(roleName)),
      "false",
      "false",
      "false",
      "false",
      "false",
      "false",
      "-1",
      "-",
      "-",
    ].join(":")),
    `${label}: Rollenattribute`,
  );

  // Vier wirksame pg_db_role_setting-Sichten pro App-Rolle: clusterweit,
  // datenbankweit, rollenweit sowie Rolle+aktuelle Datenbank. setrole=0 ist
  // absichtlich enthalten; ein ALTER DATABASE würde sonst jede Dienstrolle
  // beeinflussen, ohne an deren eigener Katalogzeile sichtbar zu sein.
  const effectiveSettings = await client.query<EffectiveRoleSettingRow>(`
    select role_row.rolname as principal,
           case
             when setting.setrole = 0 and setting.setdatabase = 0 then 'global'
             when setting.setrole = 0 then 'database'
             when setting.setdatabase = 0 then 'role'
             else 'role+database'
           end as setting_scope,
           setting.setconfig::text as settings
    from pg_catalog.pg_roles role_row
    cross join pg_catalog.pg_database database_row
    cross join pg_catalog.pg_db_role_setting setting
    where role_row.rolname = any($1::text[])
      and database_row.datname = pg_catalog.current_database()
      and setting.setrole in (0, role_row.oid)
      and setting.setdatabase in (0, database_row.oid)
    order by role_row.rolname, setting_scope, settings
  `, [APP_ROLES]);
  equalRows(
    effectiveSettings.rows.map(
      (row) => `${row.principal}:${row.setting_scope}:${row.settings ?? "NULL"}`,
    ),
    [],
    `${label}: effektive pg_db_role_setting-Einträge`,
  );
}

/**
 * Nur echte standalone Typen gehören ins Inventar: Tabellen-/View-Rowtypes
 * und automatisch erzeugte Arraytypen sind abgeleitet und werden bereits über
 * ihre Relation geprüft. CREATE TYPE ... AS, Enum, Domain, Range/Multirange,
 * Base- und selbst unvollständige Shell-Typen werden dagegen vollständig samt
 * Owner und effektiver (bei NULL: PostgreSQL-Default-)ACL signiert.
 */
export async function verifyStandaloneTypeContract(
  client: PoolClient,
  label = "Standalone-Typeinventar",
): Promise<void> {
  const types = await client.query<StandaloneTypeRow>(`
    with standalone_types as (
      select type_row.oid,
             schema_row.nspname as schema_name,
             type_row.typtype::text as type_kind,
             type_row.typname as type_name,
             type_row.typowner,
             type_row.typacl,
             owner.rolname as owner
      from pg_catalog.pg_type type_row
      join pg_catalog.pg_namespace schema_row on schema_row.oid = type_row.typnamespace
      join pg_catalog.pg_roles owner on owner.oid = type_row.typowner
      left join pg_catalog.pg_class row_relation on row_relation.oid = type_row.typrelid
      where schema_row.nspname in ('public', 'drizzle')
        and type_row.typelem = 0
        and (type_row.typrelid = 0 or row_relation.relkind = 'c')
    )
    select type_row.schema_name,
           type_row.type_kind,
           type_row.type_name,
           type_row.owner,
           coalesce(
             (
               select pg_catalog.string_agg(
                 coalesce(grantee.rolname, 'PUBLIC') || ':' ||
                   grantor.rolname || ':' || acl.privilege_type || ':' ||
                   acl.is_grantable::text,
                 ',' order by coalesce(grantee.rolname, 'PUBLIC'),
                              acl.privilege_type, grantor.rolname, acl.is_grantable
               )
               from pg_catalog.aclexplode(
                 coalesce(
                   type_row.typacl,
                   pg_catalog.acldefault('T', type_row.typowner)
                 )
               ) acl
               join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
               left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
               where acl.grantee <> type_row.typowner
             ),
             '-'
           ) as effective_acl
    from standalone_types type_row
    order by type_row.schema_name, type_row.type_kind, type_row.type_name
  `);
  equalRows(
    types.rows.map(
      (row) =>
        `${row.schema_name}:${row.type_kind}:${row.type_name}:${row.owner}:${row.effective_acl}`,
    ),
    [],
    label,
  );
}

export async function applyDatabaseAclContract(client: PoolClient): Promise<void> {
  const database = await client.query<{ database_name: string }>(`
    select pg_catalog.current_database() as database_name
  `);
  const databaseName = database.rows[0]?.database_name;
  if (!databaseName) throw new Error("Aktuelle Datenbank konnte nicht aufgelöst werden.");
  const quotedDatabase = quoteIdentifier(databaseName);
  const nonOwnerAppRoles = APP_ROLES
    .filter((roleName) => roleName !== "app_owner")
    .map(quoteIdentifier)
    .join(", ");

  // PUBLIC erhält ausschließlich CONNECT. Direkte App-Rollen-ACLs werden
  // vollständig entfernt; die Loginrollen verbinden effektiv über PUBLIC.
  await client.query(
    `revoke all privileges on database ${quotedDatabase} from public, ${nonOwnerAppRoles}`,
  );
  await client.query(`grant connect on database ${quotedDatabase} to public`);
}

export async function verifyDatabaseAclContract(
  client: PoolClient,
  label = "Datenbank-ACLs",
): Promise<void> {
  const databaseOwner = await client.query<{ owner: string }>(`
    select owner.rolname as owner
    from pg_catalog.pg_database database_row
    join pg_catalog.pg_roles owner on owner.oid = database_row.datdba
    where database_row.datname = pg_catalog.current_database()
  `);
  if (databaseOwner.rows[0]?.owner !== "app_owner") {
    throw new Error(
      `Datenbank-Owner ist nicht app_owner: ${databaseOwner.rows[0]?.owner ?? "?"}`,
    );
  }

  const databaseAcl = await client.query<AclRow>(`
    select coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           pg_catalog.current_database() as object_name,
           acl.privilege_type,
           acl.is_grantable
    from pg_catalog.pg_database database_row
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        database_row.datacl,
        pg_catalog.acldefault('d', database_row.datdba)
      )
    ) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where database_row.datname = pg_catalog.current_database()
      and acl.grantee <> database_row.datdba
    order by grantee, acl.privilege_type, grantor.rolname
  `);
  equalRows(
    databaseAcl.rows.map(
      (row) => `${row.grantee}:${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    ["PUBLIC:CONNECT:app_owner:false"],
    label,
  );
}

async function verifyRetainedLegacyRole(
  client: PoolClient,
  topology?: DbRoleProvisioningTopology,
): Promise<void> {
  if (!topology?.retainedLegacyRole) return;
  const retained = await client.query<{
    rolcanlogin: boolean;
    rolinherit: boolean;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolconnlimit: number;
    role_setting_count: number;
    database_setting_count: number;
  }>(`
    select role_row.rolcanlogin,
           role_row.rolinherit,
           role_row.rolsuper,
           role_row.rolbypassrls,
           role_row.rolcreatedb,
           role_row.rolcreaterole,
           role_row.rolreplication,
           role_row.rolconnlimit,
           coalesce(pg_catalog.cardinality(role_row.rolconfig), 0)::int
             as role_setting_count,
           (
             select count(*)::int
             from pg_catalog.pg_db_role_setting setting
             where setting.setrole = role_row.oid
           ) as database_setting_count
    from pg_catalog.pg_roles role_row
    where role_row.rolname = $1
  `, [topology.retainedLegacyRole]);
  const role = retained.rows[0];
  if (
    !role ||
    role.rolcanlogin ||
    role.rolinherit ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.rolconnlimit !== 0 ||
    role.role_setting_count !== 0 ||
    role.database_setting_count !== 0
  ) {
    throw new Error(
      `${topology.retainedLegacyRole}: quarantänierter Legacy-Rollenvertrag weicht ab.`,
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function executeContractStatements(
  client: PoolClient,
  sql: string,
  label: string,
): Promise<void> {
  const statements = sql
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const [index, statement] of statements.entries()) {
    try {
      await client.query(statement);
    } catch (error) {
      throw new Error(`${label} scheiterte in Schritt ${index + 1}.`, { cause: error });
    }
  }
}

async function hasAtomicPublicRelationSet(
  client: PoolClient,
  relations: readonly string[],
  label: string,
): Promise<boolean> {
  const existing = await client.query<{ relname: string }>(`
    select relation.relname
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relkind in ('r', 'p')
       and relation.relname = any($1::text[])
     order by relation.relname
  `, [relations]);
  if (existing.rows.length === 0) return false;

  const expected = [...relations].sort();
  const actual = existing.rows.map((row) => row.relname);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} sind nur teilweise vorhanden. Erwartet: ${expected.join(", ")}; ` +
        `gefunden: ${actual.join(", ")}`,
    );
  }
  return true;
}

export async function applyRoleContract(client: PoolClient): Promise<void> {
  await applyDatabaseAclContract(client);
  await executeContractStatements(client, APPLY_ROLE_CONTRACT_SQL, "Rollen-ACL-Manifest");

  // Der beaufsichtigte Legacy-Cutover uebernimmt bewusst einen echten
  // 0018-Zustand und wendet die spaeteren Migrationen erst NACH dem
  // Ownership-Wechsel an. Das Basismanifest muss dort ohne Zukunftstabellen
  // funktionieren; sobald eine der atomar gemeinsam eingefuehrten M1-04-
  // Relationen existiert, muessen dagegen alle existieren und erhalten exakt
  // die eng begrenzten Runtime-Rechte.
  const rechnerRelations = [
    "calculator_snapshot",
    "contact",
    "inbound_receipt",
    "project",
    "project_requirement",
  ] as const;
  const existing = await client.query<{ relname: string }>(`
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname = any($1::text[])
    order by c.relname
  `, [rechnerRelations]);
  if (existing.rows.length > 0) {
    if (
      existing.rows.length !== rechnerRelations.length
      || existing.rows.some((row, index) => row.relname !== rechnerRelations[index])
    ) {
      throw new Error("Rollen-ACL-Manifest: M1-04-Relationen sind nur teilweise vorhanden.");
    }
    await client.query(`
      grant select on
        public.contact,
        public.project,
        public.inbound_receipt,
        public.calculator_snapshot,
        public.project_requirement
      to app_runtime;
      grant insert, update on public.contact, public.project to app_runtime;
      grant insert on
        public.inbound_receipt,
        public.calculator_snapshot,
        public.project_requirement
      to app_runtime;
      -- SELECT ... FOR SHARE braucht laut PostgreSQL zusaetzlich ein
      -- UPDATE-Recht auf mindestens einer Spalte. Nur die durch PK/FK-
      -- Bindungen geschuetzte Identitaet wird fuer die Basis-Locks geoeffnet.
      grant update (id) on
        public.inbound_receipt,
        public.project_requirement
      to app_runtime
    `);
  }

  // M1-05 bleibt genauso prefix-tauglich wie M1-04: der beaufsichtigte
  // Legacy-Cutover wendet das Rollenmanifest auch gegen historische Schemas
  // an. Erst wenn beide Kanban-Relationen atomar vorhanden sind, erhalten sie
  // ihre reine Read-ACL. Die Provisioning-Funktion bleibt für alle
  // Runtime-Dienste ohne EXECUTE; der Workspace-Trigger ruft sie intern auf.
  const triageRelations = ["kanban_board", "kanban_column"] as const;
  const triageExisting = await client.query<{ relname: string }>(`
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname = any($1::text[])
    order by c.relname
  `, [triageRelations]);
  if (triageExisting.rows.length === 0) return;
  if (
    triageExisting.rows.length !== triageRelations.length
    || triageExisting.rows.some((row, index) => row.relname !== triageRelations[index])
  ) {
    throw new Error("Rollen-ACL-Manifest: M1-05-Relationen sind nur teilweise vorhanden.");
  }
  await client.query(`
    grant select on public.kanban_board, public.kanban_column to app_runtime;
    revoke execute on function public.provision_default_request_board()
      from public, app_runtime, app_system, app_auth, app_worker, app_erasure
  `);

  const projectAssignmentExisting = await client.query<{ present: boolean }>(`
    select pg_catalog.to_regclass('public.project_assignment') is not null as present
  `);
  if (projectAssignmentExisting.rows[0]?.present) {
    await client.query(`
      revoke all privileges on public.project_assignment
        from public, app_migrator, app_runtime, app_system, app_auth, app_worker,
          app_erasure, app_membership_writer, identity_reconciler;
      grant select, insert, update, delete on public.project_assignment to app_runtime;

      revoke execute on function
        public.app_actor_membership_id(uuid),
        public.app_actor_is_external_only(uuid)
        from public, app_migrator, app_runtime, app_system, app_auth, app_worker,
          app_erasure, app_membership_writer, identity_reconciler;
      grant execute on function
        public.app_actor_membership_id(uuid),
        public.app_actor_is_external_only(uuid)
        to app_runtime
    `);
  }

  const hasProjectTasks = await hasAtomicPublicRelationSet(
    client,
    PROJECT_TASK_RELATIONS,
    "Rollen-ACL-Manifest: M1-10-Projektaufgaben",
  );
  if (hasProjectTasks) {
    await client.query(`
      revoke all privileges on
        public.project_task,
        public.project_task_assignee,
        public.project_task_checklist_item,
        public.project_task_label
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant select, insert, update on public.project_task to app_runtime;
      grant select, insert, update, delete on
        public.project_task_assignee,
        public.project_task_checklist_item,
        public.project_task_label
        to app_runtime;

      revoke execute on function
        ${[...PROJECT_TASK_RUNTIME_ROUTINES, ...PROJECT_TASK_PRIVATE_ROUTINES].join(",\n        ")},
        public.build_inactive_lead_erasure_graph_m203b1(uuid,uuid)
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant execute on function
        ${PROJECT_TASK_RUNTIME_ROUTINES.join(",\n        ")}
        to app_runtime
    `);
  }

  const hasProjectOutcomes = await hasAtomicPublicRelationSet(
    client,
    PROJECT_OUTCOME_RELATIONS,
    "Rollen-ACL-Manifest: M1-11a-Projektergebnis",
  );
  if (hasProjectOutcomes) {
    await client.query(`
      -- Berechnungs-Worker finalisieren ausschliesslich ueber enge Routinen.
      -- Tabellenweites oder spaltenweites Project-SELECT wuerde den internen
      -- Verlustkommentar offenlegen und bleibt deshalb vollstaendig entzogen.
      revoke all privileges on public.project from app_worker;
      revoke all privileges on public.project_loss_reason
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant select, insert, update on public.project_loss_reason to app_runtime;

      revoke execute on function
        ${[
          ...PROJECT_OUTCOME_RUNTIME_ROUTINES,
          ...PROJECT_OUTCOME_PRIVATE_ROUTINES,
        ].join(",\n        ")}
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant execute on function
        ${PROJECT_OUTCOME_RUNTIME_ROUTINES.join(",\n        ")}
        to app_runtime
    `);
  }

  const hasCustomerNotification = await hasAtomicPublicRelationSet(
    client,
    CUSTOMER_NOTIFICATION_RELATIONS,
    "Rollen-ACL-Manifest: M1-11b-Customer-Notification",
  );
  if (hasCustomerNotification) {
    await client.query(`
      -- app_runtime liest customer_notification ausschliesslich ueber die
      -- schmale Lesekapsel (kein SELECT/UPDATE); nur die Outbox-Insert-Zeile
      -- und die zwei Runtime-Kapseln sind freigegeben. Worker nur ueber Kapseln.
      revoke all privileges on public.customer_notification,
        public.customer_notification_delivery_attempt
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant insert on public.customer_notification to app_runtime;

      revoke execute on function
        ${[
          ...CUSTOMER_NOTIFICATION_RUNTIME_ROUTINES,
          ...CUSTOMER_NOTIFICATION_WORKER_ROUTINES,
          ...CUSTOMER_NOTIFICATION_PRIVATE_ROUTINES,
        ].join(",\n        ")}
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant execute on function
        ${CUSTOMER_NOTIFICATION_RUNTIME_ROUTINES.join(",\n        ")}
        to app_runtime;
      grant execute on function
        ${CUSTOMER_NOTIFICATION_WORKER_ROUTINES.join(",\n        ")}
        to app_worker
    `);
  }

  const hasProjectNotes = await hasAtomicPublicRelationSet(
    client,
    PROJECT_NOTE_RELATIONS,
    "Rollen-ACL-Manifest: M1-13-Projektnotizen",
  );
  if (hasProjectNotes) {
    await client.query(`
      revoke all privileges on public.project_note
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant select, insert, update on public.project_note to app_runtime;

      revoke execute on function
        ${[...PROJECT_NOTE_RUNTIME_ROUTINES, ...PROJECT_NOTE_PRIVATE_ROUTINES].join(",\n        ")}
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant execute on function
        ${PROJECT_NOTE_RUNTIME_ROUTINES.join(",\n        ")}
        to app_runtime
    `);
  }

  const hasProjectAppointments = await hasAtomicPublicRelationSet(
    client,
    PROJECT_APPOINTMENT_RELATIONS,
    "Rollen-ACL-Manifest: M1-15-Termine",
  );
  if (hasProjectAppointments) {
    await client.query(`
      revoke all privileges on
        public.calendar_category,
        public.project_appointment,
        public.project_appointment_attendee
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant select on public.calendar_category to app_runtime;
      grant select, insert, update, delete on public.project_appointment to app_runtime;
      grant select, insert, delete on public.project_appointment_attendee to app_runtime;

      revoke execute on function
        ${[
          ...PROJECT_APPOINTMENT_RUNTIME_ROUTINES,
          ...PROJECT_APPOINTMENT_PRIVATE_ROUTINES,
        ].join(",\n        ")}
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant execute on function
        ${PROJECT_APPOINTMENT_RUNTIME_ROUTINES.join(",\n        ")}
        to app_runtime
    `);
  }

  const hasSignatures = await hasAtomicPublicRelationSet(
    client,
    SIGNATURE_RELATIONS,
    "Rollen-ACL-Manifest: M2-04-E-Signatur",
  );
  if (hasSignatures) {
    await client.query(`
      -- Delete läuft ausschließlich über die Erasure-Definer-Grenze;
      -- app_runtime erhält bewusst keine DELETE-Rechte auf die drei
      -- Signature-Relationen.
      revoke all privileges on
        public.signature_request,
        public.signature_attestation,
        public.signature_view_log,
        public.signature_token_locator
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant select, insert, update on public.signature_request to app_runtime;
      grant select, insert on public.signature_attestation to app_runtime;
      grant select, insert on public.signature_view_log to app_runtime;

      revoke execute on function
        ${[...SIGNATURE_RUNTIME_ROUTINES, ...SIGNATURE_PRIVATE_ROUTINES].join(",\n        ")}
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant execute on function
        ${SIGNATURE_RUNTIME_ROUTINES.join(",\n        ")}
        to app_runtime
    `);
  }

  const hasWorkspaceInvoicing = await hasAtomicPublicRelationSet(
    client,
    INVOICING_RELATIONS,
    "Rollen-ACL-Manifest: M3-00-Workspace-Invoicing",
  );
  if (hasWorkspaceInvoicing) {
    await client.query(`
      revoke all privileges on
        public.workspace_invoicing_settings,
        public.workspace_document_number_format
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant select, insert, update on public.workspace_invoicing_settings to app_runtime;
      grant select, insert, update on public.workspace_document_number_format to app_runtime;

      revoke execute on function
        ${INVOICING_RUNTIME_ROUTINES.join(",\n        ")}
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant execute on function
        ${INVOICING_RUNTIME_ROUTINES.join(",\n        ")}
        to app_runtime
    `);
  }

  const hasEconomicsSettings = await hasAtomicPublicRelationSet(
    client,
    ECONOMICS_RELATIONS,
    "Rollen-ACL-Manifest: F4-06-Economics-Defaults",
  );
  if (hasEconomicsSettings) {
    await client.query(`
      revoke all privileges on
        public.workspace_economics_settings
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant select, insert, update on public.workspace_economics_settings to app_runtime;

      revoke execute on function
        ${ECONOMICS_RUNTIME_ROUTINES.join(",\n        ")}
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant execute on function
        ${ECONOMICS_RUNTIME_ROUTINES.join(",\n        ")}
        to app_runtime
    `);
  }

  const hasLeadSources = await hasAtomicPublicRelationSet(
    client,
    LEAD_SOURCE_RELATIONS,
    "Rollen-ACL-Manifest: F1-08-Lead-Sources",
  );
  if (hasLeadSources) {
    await client.query(`
      revoke all privileges on
        public.lead_source
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant select, insert, update on public.lead_source to app_runtime
    `);
  }

  const hasTimeTracking = await hasAtomicPublicRelationSet(
    client,
    TIME_TRACKING_RELATIONS,
    "Rollen-ACL-Manifest: F9-01-Zeiterfassung",
  );
  if (hasTimeTracking) {
    await client.query(`
      revoke all privileges on
        public.time_event_type,
        public.time_entry
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant select, insert, update on public.time_event_type to app_runtime;
      grant select, insert, update on public.time_entry to app_runtime
    `);
  }

  const hasChecklists = await hasAtomicPublicRelationSet(
    client,
    CHECKLIST_RELATIONS,
    "Rollen-ACL-Manifest: F7-02-Checklisten",
  );
  if (hasChecklists) {
    await client.query(`
      revoke all privileges on
        public.project_checklist
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant select, insert, update on public.project_checklist to app_runtime
    `);
  }

  const hasChecklistTemplates = await hasAtomicPublicRelationSet(
    client,
    CHECKLIST_TEMPLATE_RELATIONS,
    "Rollen-ACL-Manifest: F7-03-Checklisten-Vorlagen",
  );
  if (hasChecklistTemplates) {
    await client.query(`
      revoke all privileges on
        public.checklist_template
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant select, insert, update on public.checklist_template to app_runtime
    `);
  }

  const hasCalendars = await hasAtomicPublicRelationSet(
    client,
    CALENDAR_RELATIONS,
    "Rollen-ACL-Manifest: M1-15b-Kalender",
  );
  if (hasCalendars) {
    await client.query(`
      revoke all privileges on
        public.calendar
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant select, insert, update on public.calendar to app_runtime
    `);
  }

  const hasCommercialDocuments = await hasAtomicPublicRelationSet(
    client,
    COMMERCIAL_DOCUMENT_RELATIONS,
    "Rollen-ACL-Manifest: M3-01-Rechnungs-Kern",
  );
  if (hasCommercialDocuments) {
    await client.query(`
      revoke all privileges on
        public.commercial_document,
        public.commercial_document_group,
        public.commercial_document_line,
        public.commercial_document_number_series
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant select, insert, update on public.commercial_document to app_runtime;
      grant select, insert, update on public.commercial_document_group to app_runtime;
      grant select, insert, update on public.commercial_document_line to app_runtime;
      grant select, insert, update on public.commercial_document_number_series to app_runtime;

      revoke execute on function
        ${[...COMMERCIAL_DOCUMENT_RUNTIME_ROUTINES, ...COMMERCIAL_DOCUMENT_PRIVATE_ROUTINES].join(",\n        ")}
        from public, app_migrator, app_runtime, app_system, app_auth,
          app_worker, app_erasure, app_membership_writer, identity_reconciler;
      grant execute on function
        ${COMMERCIAL_DOCUMENT_RUNTIME_ROUTINES.join(",\n        ")}
        to app_runtime
    `);
  }

  const energyRelations = [
    "project_calculation_job",
    "project_calculation_revision",
    "site_energy_profile",
  ] as const;
  const energyExisting = await client.query<{ relname: string }>(`
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname = any($1::text[])
    order by c.relname
  `, [energyRelations]);
  if (energyExisting.rows.length === 0) return;
  if (
    energyExisting.rows.length !== energyRelations.length
    || energyExisting.rows.some((row, index) => row.relname !== energyRelations[index])
  ) {
    throw new Error("Rollen-ACL-Manifest: M1-07-Relationen sind nur teilweise vorhanden.");
  }
  await client.query(`
    grant usage on schema public to app_worker;

    grant select, insert, update on public.site_energy_profile to app_runtime;
    grant select, insert on public.project_calculation_job to app_runtime;
    grant update (id) on public.project_calculation_job to app_runtime;
    grant select on public.project_calculation_revision to app_runtime;
    grant update (id) on public.project_calculation_revision to app_runtime;

    grant select on
      public.workspace,
      public.membership,
      public.site,
      public.calculator_snapshot,
      public.project_requirement,
      public.site_energy_profile,
      public.project_calculation_job,
      public.project_calculation_revision
    to app_worker;
    revoke update on public.project_calculation_job from app_worker;
    grant update (
      state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
      input_sha256, input_snapshot, provider_snapshot,
      error_code, error_retryable, started_at, finished_at
    ) on public.project_calculation_job to app_worker;
    revoke insert on public.project_calculation_revision from app_worker;
    grant insert on public.domain_events, public.audit_log to app_worker;

    revoke execute on function public.guard_site_energy_profile_mutation()
      from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
    revoke execute on function public.guard_project_calculation_job_mutation()
      from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
    revoke execute on function public.guard_project_calculation_revision()
      from public, app_runtime, app_system, app_auth, app_worker, app_erasure
  `);

  const erasureRelations = [
    "contact_legal_hold",
    "erasure_operation_locator",
    "erasure_tombstone",
  ] as const;
  const erasureExisting = await client.query<{ relname: string }>(`
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname = any($1::text[])
    order by c.relname
  `, [erasureRelations]);
  if (erasureExisting.rows.length > 0) {
    if (
      erasureExisting.rows.length !== erasureRelations.length
      || erasureExisting.rows.some((row, index) => row.relname !== erasureRelations[index])
    ) {
      throw new Error("Rollen-ACL-Manifest: M1-07-Erasure-Relationen sind nur teilweise vorhanden.");
    }
    await client.query(`
      revoke all privileges on public.contact_legal_hold,
        public.erasure_operation_locator, public.erasure_tombstone from app_erasure;
      revoke execute on function public.guard_erasure_tombstone_worm()
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
      revoke execute on function public.erase_inactive_lead(uuid, uuid, uuid)
        from public, app_runtime, app_system, app_auth, app_worker;
      revoke execute on function public.replay_erasure_tombstone(uuid)
        from public, app_runtime, app_system, app_auth, app_worker;
      grant usage on schema public to app_erasure;
      grant execute on function public.erase_inactive_lead(uuid, uuid, uuid)
        to app_erasure;
      grant execute on function public.replay_erasure_tombstone(uuid)
        to app_erasure
    `);
  }

  const catalogRelations = [
    "catalog_component",
    "catalog_component_revision",
    "project_catalog_resolution",
    "project_catalog_resolution_line",
  ] as const;
  const catalogExisting = await client.query<{ relname: string }>(`
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname = any($1::text[])
    order by c.relname
  `, [catalogRelations]);
  if (catalogExisting.rows.length > 0) {
    if (
      catalogExisting.rows.length !== catalogRelations.length
      || catalogExisting.rows.some((row, index) => row.relname !== catalogRelations[index])
    ) {
      throw new Error("Rollen-ACL-Manifest: M1-08-Katalogrelationen sind nur teilweise vorhanden.");
    }
    await client.query(`
      grant select, insert, update on public.catalog_component to app_runtime;
      grant select, insert on
        public.catalog_component_revision,
        public.project_catalog_resolution,
        public.project_catalog_resolution_line
      to app_runtime;
      grant update (id) on public.project_catalog_resolution to app_runtime;

      revoke execute on function public.guard_catalog_component_mutation()
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
      revoke execute on function public.guard_catalog_component_revision()
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
      revoke execute on function public.apply_catalog_component_revision()
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
      revoke execute on function public.mark_catalog_component_projects_stale()
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
      revoke execute on function public.validate_project_catalog_resolution_snapshot()
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
      revoke execute on function public.mark_project_catalog_resolution_stale()
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
      revoke execute on function public.lock_project_calculation_finalization(uuid, uuid)
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
      revoke execute on function public.finalize_project_calculation_success(
        uuid, uuid, uuid, integer, uuid, jsonb
      ) from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
      grant execute on function public.lock_project_calculation_finalization(uuid, uuid)
        to app_worker;
      grant execute on function public.finalize_project_calculation_success(
        uuid, uuid, uuid, integer, uuid, jsonb
      ) to app_worker
    `);
  }

  // M2-01 fuehrt den Offer-Graphen und dessen separat committende
  // Mutationszaehler atomar ein. Runtime darf den Graphen lesen und neue
  // Snapshot-Staende anlegen; UPDATE bleibt auf die drei tatsaechlich vom
  // Service mutierten Zaehler-/Pointerspalten und offer.updated_at begrenzt.
  // Identitaets-, Scope- und Zeitfensterspalten bleiben ohne UPDATE-Recht. Die drei
  // Snapshot-Mirror sind append-only. DELETE/TRUNCATE gehoeren fuer keine
  // Offer-Relation zum Runtime-Vertrag.
  const offerRelations = [
    "offer",
    "offer_bom_line",
    "offer_mutation_rate_window",
    "offer_number_series",
    "offer_variant",
    "offer_variant_revision",
    "offer_variant_section",
  ] as const;
  const offerExisting = await client.query<{ relname: string }>(`
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname = any($1::text[])
    order by c.relname
  `, [offerRelations]);
  if (offerExisting.rows.length > 0) {
    if (
      offerExisting.rows.length !== offerRelations.length
      || offerExisting.rows.some((row, index) => row.relname !== offerRelations[index])
    ) {
      throw new Error("Rollen-ACL-Manifest: M2-01-Offerrelationen sind nur teilweise vorhanden.");
    }
    await client.query(`
      grant select, insert on
        public.offer,
        public.offer_bom_line,
        public.offer_mutation_rate_window,
        public.offer_number_series,
        public.offer_variant,
        public.offer_variant_revision,
        public.offer_variant_section
      to app_runtime;
      revoke update on
        public.offer,
        public.offer_mutation_rate_window,
        public.offer_number_series,
        public.offer_variant
      from app_runtime;
      grant update (updated_at) on public.offer to app_runtime;
      grant update (attempts, updated_at)
        on public.offer_mutation_rate_window to app_runtime;
      grant update (last_sequence, updated_at)
        on public.offer_number_series to app_runtime;
      grant update (current_revision, name, description, updated_at)
        on public.offer_variant to app_runtime;
      revoke delete, truncate on
        public.offer,
        public.offer_bom_line,
        public.offer_mutation_rate_window,
        public.offer_number_series,
        public.offer_variant,
        public.offer_variant_revision,
        public.offer_variant_section
      from app_runtime;

      revoke execute on function public.validate_offer_variant_snapshot_mirrors()
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
      revoke execute on function public.canonicalize_offer_json_v1(jsonb)
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
      revoke execute on function public.guard_offer_erasure_mutation()
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
      revoke execute on function public.build_inactive_lead_erasure_graph(uuid, uuid)
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure
    `);
  }

  // M2-02 speichert ausschliesslich erasure-faehige interne PDF-Entwuerfe.
  // Runtime darf anfordern und geschuetzt lesen, aber weder Jobzustand noch
  // Artefaktspalten fortschreiben. Der Worker erhaelt genau die Spalten des
  // Lease-/CAS-Automaten; DELETE und TRUNCATE bleiben fuer beide verboten.
  const offerPdfExisting = await client.query<{ relname: string }>(`
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname = 'offer_pdf_draft'
    order by c.relname
  `);
  if (offerPdfExisting.rows.length > 0) {
    if (
      offerPdfExisting.rows.length !== 1
      || offerPdfExisting.rows[0]?.relname !== "offer_pdf_draft"
    ) {
      throw new Error("Rollen-ACL-Manifest: M2-02-PDF-Relation driftet.");
    }
    await client.query(`
      grant select on public.offer_pdf_draft to app_runtime;
      revoke insert, update, delete, truncate on public.offer_pdf_draft from app_runtime;
      revoke insert (
        id, workspace_id, project_id, offer_id, variant_id,
        variant_revision_id, variant_revision, variant_snapshot_sha256,
        input_version, canonicalization_version, template_version,
        renderer_recipe_version, reservation_key, input_snapshot, input_sha256,
        state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
        error_code, error_retryable, artifact_mime_type, artifact_sha256,
        artifact_size_bytes, artifact_bytes, created_by, created_at, updated_at,
        started_at, finished_at
      ) on public.offer_pdf_draft from app_runtime;
      grant insert (
        id, workspace_id, project_id, offer_id, variant_id,
        variant_revision_id, variant_revision, variant_snapshot_sha256,
        input_version, canonicalization_version, template_version,
        renderer_recipe_version, created_by
      ) on public.offer_pdf_draft to app_runtime;
      grant update (id) on public.offer_pdf_draft to app_runtime;
      grant execute on function public.canonicalize_offer_json_v1(jsonb)
        to app_runtime, app_worker;

      grant select on public.offer_pdf_draft to app_worker;
      revoke update, insert, delete, truncate on public.offer_pdf_draft from app_worker;
      grant update (
        state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
        error_code, error_retryable, artifact_mime_type, artifact_sha256,
        artifact_size_bytes, artifact_bytes, updated_at, started_at, finished_at
      ) on public.offer_pdf_draft to app_worker;

      revoke execute on function public.guard_offer_pdf_draft_mutation()
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
      revoke execute on function public.derive_offer_pdf_draft_input()
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure;
      revoke execute on function
        public.build_inactive_lead_erasure_graph_m201(uuid, uuid)
        from public, app_runtime, app_system, app_auth, app_worker, app_erasure
    `);
  }

  // M2-03a ist eine atomare Siebener-Einheit. Runtime liest versiegelte
  // Revisionen tenantlokal; Candidate/Approval bleiben hinter schmalen
  // SECURITY-DEFINER-Grenzen. Der Worker sieht genau den Candidate mit dem
  // versiegelten, minimierten Renderinput einschließlich der dafür nötigen
  // Empfänger-/Rechnungsdaten, aber keine breiteren Quellen oder Runtime-Logs.
  // Er darf genau den 15-spaltigen Lease-/Artefakt-Automaten fortschreiben.
  const hasOfferRelease = await hasAtomicPublicRelationSet(
    client,
    OFFER_RELEASE_RELATIONS,
    "Rollen-ACL-Manifest: M2-03a-Release-Relationen",
  );
  if (hasOfferRelease) {
    await client.query(`
      revoke all privileges on
        public.offer_recipient,
        public.offer_recipient_revision,
        public.offer_release_candidate,
        public.offer_release_candidate_approval,
        public.offer_release_profile,
        public.offer_release_profile_activation,
        public.offer_release_profile_revision
      from public, app_migrator, app_runtime, app_system, app_auth, app_worker,
        app_erasure, app_membership_writer, identity_reconciler;

      grant select on
        public.offer_recipient,
        public.offer_recipient_revision,
        public.offer_release_profile,
        public.offer_release_profile_activation,
        public.offer_release_profile_revision
      to app_runtime;

      grant select on public.offer_release_candidate to app_worker;
      grant update (
        state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
        error_code, error_retryable, artifact_mime_type, artifact_sha256,
        artifact_size_bytes, artifact_bytes, artifact_version, updated_at,
        started_at, finished_at
      ) on public.offer_release_candidate to app_worker;

      revoke execute on function
        public._m203a_approved_candidate_result(uuid, uuid, boolean),
        public._m203a_guard_offer_release_append_only(),
        public._m203a_guard_offer_release_profile_head(),
        public._m203a_guard_offer_recipient_head(),
        public._m203a_guard_offer_release_candidate(),
        public._m203a_normalize_offer_release_text(text, integer, boolean),
        public._m203a_normalize_offer_release_address(jsonb),
        public._m203a_normalize_offer_release_sender(jsonb),
        public._m203a_normalize_offer_release_legal_document(jsonb),
        public._m203a_normalize_offer_release_legal_documents(jsonb),
        public._m203a_offer_release_instant(timestamptz),
        public._m203a_prepared_candidate_result(uuid, uuid, boolean),
        public._m203a_erasure_delete_allowed(uuid, uuid, text),
        public._m203a_authorize_offer_release(uuid, text),
        public.build_inactive_lead_erasure_graph_m202(uuid, uuid),
        public.revise_offer_release_profile(uuid, integer, text, jsonb, jsonb),
        public.activate_offer_release_profile(uuid, uuid, uuid, integer),
        public.revise_offer_recipient(
          uuid, uuid, integer, text, text, text, jsonb, boolean
        ),
        public.prepare_offer_release_candidate(
          uuid, uuid, uuid, integer, uuid, uuid, uuid, integer, uuid, integer, date
        ),
        public.approve_offer_release_candidate(
          uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, boolean
        ),
        public.read_offer_release_candidate_status(uuid, uuid, uuid),
        public.read_offer_release_candidate_artifact(uuid, uuid, uuid)
      from public, app_migrator, app_runtime, app_system, app_auth, app_worker,
        app_erasure, app_membership_writer, identity_reconciler;

      grant execute on function
        public.revise_offer_release_profile(uuid, integer, text, jsonb, jsonb),
        public.activate_offer_release_profile(uuid, uuid, uuid, integer),
        public.revise_offer_recipient(
          uuid, uuid, integer, text, text, text, jsonb, boolean
        ),
        public.prepare_offer_release_candidate(
          uuid, uuid, uuid, integer, uuid, uuid, uuid, integer, uuid, integer, date
        ),
        public.approve_offer_release_candidate(
          uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, boolean
        ),
        public.read_offer_release_candidate_status(uuid, uuid, uuid),
        public.read_offer_release_candidate_artifact(uuid, uuid, uuid)
      to app_runtime
    `);
  }

  // M2-03b1 ist eine atomare Dreier-Einheit. Die versiegelten Issuance-
  // Relationen bleiben fuer Runtime und Worker vollstaendig unsichtbar;
  // beide Dienste arbeiten ausschliesslich ueber getrennte, gepinnte
  // SECURITY-DEFINER-Grenzen. So kann weder ein Webprozess Renderzustand und
  // Bytes fortschreiben noch ein Worker Freigaben oder Ruecknahmen erzeugen.
  const hasOfferIssuance = await hasAtomicPublicRelationSet(
    client,
    OFFER_ISSUANCE_RELATIONS,
    "Rollen-ACL-Manifest: M2-03b1-Issuance-Relationen",
  );
  if (hasOfferIssuance) {
    await client.query(`
      revoke all privileges on
        public.offer_issuance,
        public.offer_issuance_approval,
        public.offer_issuance_withdrawal
      from public, app_migrator, app_runtime, app_system, app_auth, app_worker,
        app_erasure, app_membership_writer, identity_reconciler;

      revoke execute on function
        public._m203b1_approved_issuance_result(uuid, uuid, uuid, boolean),
        public._m203b1_authorize_offer_issuance(uuid, text),
        public._m203b1_erasure_delete_allowed(uuid, uuid, text),
        public._m203b1_guard_offer_issuance(),
        public._m203b1_guard_offer_issuance_append_only(),
        public._m203b1_guard_offer_issuance_approval(),
        public._m203b1_offer_issuance_dispatch_state(uuid, uuid),
        public._m203b1_offer_issuance_instant(timestamptz),
        public._m203b1_offer_issuance_source_is_current(uuid, uuid),
        public._m203b1_prepared_issuance_result(uuid, uuid, boolean),
        public.approve_offer_issuance(
          uuid, uuid, boolean, boolean, boolean, boolean, boolean
        ),
        public.build_inactive_lead_erasure_graph_m203a(uuid, uuid),
        public.claim_offer_issuance_render(uuid, uuid, uuid, integer),
        public.finalize_offer_issuance_render_failure(
          uuid, uuid, uuid, integer, text, boolean
        ),
        public.finalize_offer_issuance_render_success(
          uuid, uuid, uuid, integer, bytea
        ),
        public.list_offer_issuance_recovery_workspaces(uuid, integer),
        public.prepare_offer_issuance(uuid, uuid, uuid),
        public.read_offer_issuance_artifact(uuid, uuid, uuid),
        public.read_offer_issuance_status(uuid, uuid, uuid),
        public.recover_offer_issuance_renders(uuid, integer),
        public.withdraw_offer_issuance(uuid, uuid, text)
      from public, app_migrator, app_runtime, app_system, app_auth, app_worker,
        app_erasure, app_membership_writer, identity_reconciler;

      grant execute on function
        public.prepare_offer_issuance(uuid, uuid, uuid),
        public.approve_offer_issuance(
          uuid, uuid, boolean, boolean, boolean, boolean, boolean
        ),
        public.withdraw_offer_issuance(uuid, uuid, text),
        public.read_offer_issuance_status(uuid, uuid, uuid),
        public.read_offer_issuance_artifact(uuid, uuid, uuid)
      to app_runtime;

      grant usage on schema public to app_worker;
      grant execute on function
        public.claim_offer_issuance_render(uuid, uuid, uuid, integer),
        public.finalize_offer_issuance_render_success(
          uuid, uuid, uuid, integer, bytea
        ),
        public.finalize_offer_issuance_render_failure(
          uuid, uuid, uuid, integer, text, boolean
        ),
        public.recover_offer_issuance_renders(uuid, integer),
        public.list_offer_issuance_recovery_workspaces(uuid, integer),
        public._m203b1_offer_issuance_dispatch_state(uuid, uuid)
      to app_worker
    `);
  }

  // M1-08b ist eine atomare Vierer-Einheit. Runtime und Worker erhalten
  // keinerlei Tabellenrechte; die Web-App arbeitet ueber sechs und der
  // Worker ueber neun getrennte SECURITY-DEFINER-Gateways.
  const hasCatalogImport = await hasAtomicPublicRelationSet(
    client,
    CATALOG_IMPORT_RELATIONS,
    "Rollen-ACL-Manifest: M1-08b-Import-Relationen",
  );
  if (hasCatalogImport) {
    await client.query(`
      revoke all privileges on
        ${CATALOG_IMPORT_RELATIONS.map(
          (relation) => `public.${relation}`,
        ).join(",\n        ")}
      from public, app_migrator, app_runtime, app_system, app_auth, app_worker,
        app_erasure, app_membership_writer, identity_reconciler;

      revoke execute on function
        ${CATALOG_IMPORT_ROUTINES.join(",\n        ")}
      from public, app_migrator, app_runtime, app_system, app_auth, app_worker,
        app_erasure, app_membership_writer, identity_reconciler;

      grant execute on function
        ${CATALOG_IMPORT_RUNTIME_ROUTINES.join(",\n        ")}
      to app_runtime;

      grant usage on schema public to app_worker;
      grant execute on function
        ${CATALOG_IMPORT_WORKER_ROUTINES.join(",\n        ")}
      to app_worker
    `);
  }

  // pg-boss bleibt vollstaendig worker-owned. Nur der SET-only-Migrator darf
  // fuer das nach jeder Migration wiederholte ACL-Manifest kurz in diesen
  // Owner wechseln; app_owner und app_worker erhalten keine gegenseitige
  // Membership.
  await client.query(`
    set role app_worker;
    revoke all on schema pgboss
      from public, app_owner, app_migrator, app_runtime, app_system, app_auth,
        app_erasure, app_membership_writer, identity_reconciler;
    revoke all privileges on all tables in schema pgboss
      from public, app_owner, app_migrator, app_runtime, app_system, app_auth,
        app_erasure, app_membership_writer, identity_reconciler;
    revoke all privileges on all sequences in schema pgboss
      from public, app_owner, app_migrator, app_runtime, app_system, app_auth,
        app_erasure, app_membership_writer, identity_reconciler;
    revoke execute on all functions in schema pgboss
      from public, app_owner, app_migrator, app_runtime, app_system, app_auth,
        app_erasure, app_membership_writer, identity_reconciler;
    grant usage on schema pgboss to app_runtime;
    grant execute on function pgboss.enqueue_project_calculation(uuid, uuid)
      to app_runtime;
    ${hasOfferRelease ? `
      grant execute on function pgboss.enqueue_offer_release_candidate(uuid, uuid)
        to app_runtime;
    ` : ""}
    ${hasOfferIssuance ? `
      grant execute on function pgboss.enqueue_offer_issuance(uuid, uuid)
        to app_runtime;
    ` : ""}
    ${hasCatalogImport ? `
      grant execute on function
        ${CATALOG_IMPORT_PGBOSS_RUNTIME_ROUTINES.join(",\n        ")}
      to app_runtime;
    ` : ""}
    ${hasCustomerNotification ? `
      grant execute on function pgboss.enqueue_customer_notification(uuid, uuid)
        to app_runtime;
    ` : ""}
    set role app_owner
  `);
  const offerPdfDispatch = await client.query<{ present: boolean }>(`
    select pg_catalog.count(*) = 1 as present
      from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = routine.pronamespace
     where namespace.nspname = 'pgboss'
       and routine.proname = 'enqueue_offer_pdf_draft'
       and pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid'
  `);
  if (offerPdfDispatch.rows[0]?.present) {
    await client.query(`
      set role app_worker;
      grant usage on schema pgboss to app_runtime;
      grant execute on function pgboss.enqueue_offer_pdf_draft(uuid, uuid)
        to app_runtime;
      set role app_owner
    `);
  }
}

export async function applyDefaultPrivilegeContract(client: PoolClient): Promise<void> {
  await executeContractStatements(
    client,
    APPLY_DEFAULT_PRIVILEGE_CONTRACT_SQL,
    "Default-ACL-Manifest",
  );
}

export async function verifyDefaultPrivilegeContract(client: PoolClient): Promise<void> {
  const unexpectedDefaults = await client.query<{
    owner: string;
    schema_name: string;
    object_type: string;
    grantee: string;
    grantor: string;
    privilege_type: string;
    is_grantable: boolean;
  }>(`
    with global_contract(owner_name, object_type) as (
      values
        ('app_owner'::text, 'r'::text),
        ('app_owner'::text, 'S'::text),
        ('app_owner'::text, 'f'::text),
        ('app_owner'::text, 'T'::text),
        ('identity_reconciler'::text, 'f'::text),
        ('app_worker'::text, 'f'::text)
    ),
    schema_contract(owner_name, schema_name, object_type) as (
      values
        ('app_owner'::text, 'public'::text, 'r'::text),
        ('app_owner'::text, 'public'::text, 'S'::text),
        ('app_owner'::text, 'public'::text, 'f'::text),
        ('app_owner'::text, 'public'::text, 'T'::text),
        ('identity_reconciler'::text, 'public'::text, 'f'::text),
        ('app_worker'::text, 'pgboss'::text, 'f'::text)
    ),
    effective_defaults as (
      select owner.oid as owner_oid,
             owner.rolname as owner,
             '*'::text as schema_name,
             contract.object_type,
             acl.*
      from global_contract contract
      join pg_catalog.pg_roles owner on owner.rolname = contract.owner_name
      left join pg_catalog.pg_default_acl d
        on d.defaclrole = owner.oid
       and d.defaclnamespace = 0
       and d.defaclobjtype = contract.object_type::"char"
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          d.defaclacl,
          pg_catalog.acldefault(contract.object_type::"char", owner.oid)
        )
      ) acl

      union all

      select owner.oid as owner_oid,
             owner.rolname as owner,
             contract.schema_name,
             contract.object_type,
             acl.*
      from schema_contract contract
      join pg_catalog.pg_roles owner on owner.rolname = contract.owner_name
      join pg_catalog.pg_namespace n on n.nspname = contract.schema_name
      join pg_catalog.pg_default_acl d
        on d.defaclrole = owner.oid
       and d.defaclnamespace = n.oid
       and d.defaclobjtype = contract.object_type::"char"
      cross join lateral pg_catalog.aclexplode(d.defaclacl) acl
    )
    select defaults.owner,
           defaults.schema_name,
           defaults.object_type,
           coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           defaults.privilege_type,
           defaults.is_grantable
    from effective_defaults defaults
    join pg_catalog.pg_roles grantor on grantor.oid = defaults.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = defaults.grantee
    where defaults.grantee <> defaults.owner_oid
    order by defaults.owner, defaults.schema_name, defaults.object_type,
             grantee, defaults.privilege_type, grantor.rolname
  `);
  equalRows(
    unexpectedDefaults.rows.map((row) =>
      `${row.owner}:${row.schema_name}:${row.object_type}:${row.grantee}:` +
        `${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    [],
    "Default-ACLs",
  );
}

/**
 * Läuft vor Advisory Lock und vor Drizzle. Der spätere Vollvertrag käme zu
 * spät: ein privilegierter Session-Principal könnte bereits während einer
 * Migration RESET ROLE verwenden oder außerhalb von RLS schreiben.
 */
export async function verifyMigrationPrincipalBoundary(
  client: PoolClient,
  topology?: DbRoleProvisioningTopology,
): Promise<void> {
  const identity = await client.query<{
    session_user: string;
    current_user: string;
    session_login: boolean;
    session_inherit: boolean;
    session_super: boolean;
    session_bypassrls: boolean;
    session_createdb: boolean;
    session_createrole: boolean;
    session_replication: boolean;
    current_login: boolean;
    current_inherit: boolean;
    current_super: boolean;
    current_bypassrls: boolean;
    current_createdb: boolean;
    current_createrole: boolean;
    current_replication: boolean;
  }>(`
    select session_user,
           current_user,
           s.rolcanlogin as session_login,
           s.rolinherit as session_inherit,
           s.rolsuper as session_super,
           s.rolbypassrls as session_bypassrls,
           s.rolcreatedb as session_createdb,
           s.rolcreaterole as session_createrole,
           s.rolreplication as session_replication,
           c.rolcanlogin as current_login,
           c.rolinherit as current_inherit,
           c.rolsuper as current_super,
           c.rolbypassrls as current_bypassrls,
           c.rolcreatedb as current_createdb,
           c.rolcreaterole as current_createrole,
           c.rolreplication as current_replication
    from pg_catalog.pg_roles s
    cross join pg_catalog.pg_roles c
    where s.rolname = session_user
      and c.rolname = current_user
  `);
  const role = identity.rows[0];
  if (!role || role.session_user !== "app_migrator" || role.current_user !== "app_owner") {
    throw new Error(
      `Falsche Migrationsrollen: session_user=${role?.session_user ?? "?"}, ` +
        `current_user=${role?.current_user ?? "?"}`,
    );
  }
  if (
    !role.session_login ||
    role.session_inherit ||
    role.session_super ||
    role.session_bypassrls ||
    role.session_createdb ||
    role.session_createrole ||
    role.session_replication
  ) {
    throw new Error("app_migrator besitzt ein verbotenes Rollenattribut vor der Migration.");
  }
  if (
    role.current_login ||
    role.current_inherit ||
    role.current_super ||
    role.current_bypassrls ||
    role.current_createdb ||
    role.current_createrole ||
    role.current_replication
  ) {
    throw new Error("app_owner besitzt ein verbotenes Rollenattribut vor der Migration.");
  }

  await verifyAppRoleCatalogContract(client, "App-Rollenvertrag vor Schemaänderung");

  const reconciler = await client.query<RoleRow>(`
    select rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls,
           rolcreatedb, rolcreaterole, rolreplication
    from pg_catalog.pg_roles
    where rolname = 'identity_reconciler'
  `);
  const reconcilerRole = reconciler.rows[0];
  if (
    !reconcilerRole ||
    reconcilerRole.rolcanlogin ||
    reconcilerRole.rolinherit ||
    reconcilerRole.rolsuper ||
    reconcilerRole.rolbypassrls ||
    reconcilerRole.rolcreatedb ||
    reconcilerRole.rolcreaterole ||
    reconcilerRole.rolreplication
  ) {
    throw new Error(
      "identity_reconciler fehlt oder besitzt vor dem temporären SET ROLE ein verbotenes Attribut.",
    );
  }

  const memberships = await client.query<MembershipRow>(`
    select granted.rolname as granted_role,
           member.rolname as member_role,
           grantor.rolname as grantor_role,
           m.admin_option,
           m.inherit_option,
           m.set_option
    from pg_catalog.pg_auth_members m
    join pg_catalog.pg_roles granted on granted.oid = m.roleid
    join pg_catalog.pg_roles member on member.oid = m.member
    join pg_catalog.pg_roles grantor on grantor.oid = m.grantor
    where granted.rolname = any($1::text[])
       or member.rolname = any($1::text[])
    order by granted.rolname, member.rolname, grantor.rolname
  `, [APP_ROLES]);
  equalRows(
    memberships.rows.map((row) =>
      `${row.granted_role}>${row.member_role}@${row.grantor_role}:` +
        `${row.admin_option}/${row.inherit_option}/${row.set_option}`,
    ),
    expectedDbRoleMembershipSignatures(topology),
    "Migrationsrollen-Mitgliedschaften vor Schemaänderung",
  );
  await verifyRetainedLegacyRole(client, topology);

  const providerMembership = await client.query<{
    migrator_neon_superuser: boolean;
    owner_neon_superuser: boolean;
  }>(`
    select case
             when pg_catalog.to_regrole('neon_superuser') is null then false
             else pg_catalog.pg_has_role('app_migrator', 'neon_superuser', 'MEMBER')
           end as migrator_neon_superuser,
           case
             when pg_catalog.to_regrole('neon_superuser') is null then false
             else pg_catalog.pg_has_role('app_owner', 'neon_superuser', 'MEMBER')
           end as owner_neon_superuser
  `);
  if (
    providerMembership.rows[0]?.migrator_neon_superuser ||
    providerMembership.rows[0]?.owner_neon_superuser
  ) {
    throw new Error("Migrationsrollen dürfen nicht Mitglied von neon_superuser sein.");
  }

  // Ownership ist ebenfalls eine PRE-Drizzle-Bedingung. Andernfalls könnte
  // eine falsch provisionierte Fresh-/Legacy-DB alle Migrationen committen und
  // erst im nachgelagerten ACL-Manifest rot werden.
  await verifyDatabaseAclContract(client, "Datenbank-ACLs vor Schemaänderung");

  const schemaOwners = await client.query<{ nspname: string; owner: string }>(`
    select n.nspname, owner.rolname as owner
    from pg_catalog.pg_namespace n
    join pg_catalog.pg_roles owner on owner.oid = n.nspowner
    where n.nspname in ('public', 'drizzle', 'pgboss')
    order by n.nspname
  `);
  const actualSchemas = new Map(schemaOwners.rows.map((row) => [row.nspname, row.owner]));
  if (
    actualSchemas.get("public") !== "app_owner" ||
    actualSchemas.get("pgboss") !== "app_worker" ||
    (actualSchemas.has("drizzle") && actualSchemas.get("drizzle") !== "app_owner")
  ) {
    throw new Error(
      `Schema-Owner weichen vor der Migration ab: ${JSON.stringify(schemaOwners.rows)}`,
    );
  }
  await verifyStandaloneTypeContract(client, "Standalone-Typeinventar vor Schemaänderung");
}

export async function verifyRoleContract(
  client: PoolClient,
  topology?: DbRoleProvisioningTopology,
): Promise<void> {
  await verifyDefaultPrivilegeContract(client);
  await verifyRetainedLegacyRole(client, topology);
  await verifyAppRoleCatalogContract(client);
  await verifyDatabaseAclContract(client);

  // Der Vollvertrag wird auch gegen beaufsichtigte historische Prefixe
  // ausgefuehrt. M2-02 ist deshalb genau dann Teil des erwarteten Inventars,
  // wenn seine atomare Wurzelrelation bereits existiert. Einzelne verwaiste
  // Funktionen/Trigger/ACLs bleiben trotzdem rot, weil die jeweiligen
  // Kataloginventare weiter exakt verglichen werden.
  const offerPdfPresence = await client.query<{ present: boolean }>(`
    select pg_catalog.to_regclass('public.offer_pdf_draft') is not null as present
  `);
  const hasOfferPdfDraft = offerPdfPresence.rows[0]?.present === true;
  const hasOfferRelease = await hasAtomicPublicRelationSet(
    client,
    OFFER_RELEASE_RELATIONS,
    "Rollenvertrag: M2-03a-Release-Relationen",
  );
  const hasOfferIssuance = await hasAtomicPublicRelationSet(
    client,
    OFFER_ISSUANCE_RELATIONS,
    "Rollenvertrag: M2-03b1-Issuance-Relationen",
  );
  const hasCatalogImport = await hasAtomicPublicRelationSet(
    client,
    CATALOG_IMPORT_RELATIONS,
    "Rollenvertrag: M1-08b-Import-Relationen",
  );
  const projectAssignmentPresence = await client.query<{ present: boolean }>(`
    select pg_catalog.to_regclass('public.project_assignment') is not null as present
  `);
  const hasProjectAssignment = projectAssignmentPresence.rows[0]?.present === true;
  const hasProjectTasks = await hasAtomicPublicRelationSet(
    client,
    PROJECT_TASK_RELATIONS,
    "Rollenvertrag: M1-10-Projektaufgaben",
  );
  const hasProjectOutcomes = await hasAtomicPublicRelationSet(
    client,
    PROJECT_OUTCOME_RELATIONS,
    "Rollenvertrag: M1-11a-Projektergebnis",
  );
  const hasCustomerNotification = await hasAtomicPublicRelationSet(
    client,
    CUSTOMER_NOTIFICATION_RELATIONS,
    "Rollenvertrag: M1-11b-Customer-Notification",
  );
  const hasProjectNotes = await hasAtomicPublicRelationSet(
    client,
    PROJECT_NOTE_RELATIONS,
    "Rollenvertrag: M1-13-Projektnotizen",
  );
  const hasProjectAppointments = await hasAtomicPublicRelationSet(
    client,
    PROJECT_APPOINTMENT_RELATIONS,
    "Rollenvertrag: M1-15-Termine",
  );
  const hasSignatures = await hasAtomicPublicRelationSet(
    client,
    SIGNATURE_RELATIONS,
    "Rollenvertrag: M2-04-E-Signatur",
  );
  const hasWorkspaceInvoicing = await hasAtomicPublicRelationSet(
    client,
    INVOICING_RELATIONS,
    "Rollenvertrag: M3-00-Workspace-Invoicing",
  );
  const hasCommercialDocuments = await hasAtomicPublicRelationSet(
    client,
    COMMERCIAL_DOCUMENT_RELATIONS,
    "Rollenvertrag: M3-01-Rechnungs-Kern",
  );
  const hasEconomicsSettings = await hasAtomicPublicRelationSet(
    client,
    ECONOMICS_RELATIONS,
    "Rollenvertrag: F4-06-Economics-Defaults",
  );
  const hasLeadSources = await hasAtomicPublicRelationSet(
    client,
    LEAD_SOURCE_RELATIONS,
    "Rollenvertrag: F1-08-Lead-Sources",
  );

  const hasTimeTracking = await hasAtomicPublicRelationSet(
    client,
    TIME_TRACKING_RELATIONS,
    "Rollenvertrag: F9-01-Zeiterfassung",
  );

  const hasChecklists = await hasAtomicPublicRelationSet(
    client,
    CHECKLIST_RELATIONS,
    "Rollenvertrag: F7-02-Checklisten",
  );

  const hasChecklistTemplates = await hasAtomicPublicRelationSet(
    client,
    CHECKLIST_TEMPLATE_RELATIONS,
    "Rollenvertrag: F7-03-Checklisten-Vorlagen",
  );

  const hasCalendars = await hasAtomicPublicRelationSet(
    client,
    CALENDAR_RELATIONS,
    "Rollenvertrag: M1-15b-Kalender",
  );

  const memberships = await client.query<MembershipRow>(`
    select granted.rolname as granted_role,
           member.rolname as member_role,
           grantor.rolname as grantor_role,
           m.admin_option,
           m.inherit_option,
           m.set_option
    from pg_catalog.pg_auth_members m
    join pg_catalog.pg_roles granted on granted.oid = m.roleid
    join pg_catalog.pg_roles member on member.oid = m.member
    join pg_catalog.pg_roles grantor on grantor.oid = m.grantor
    -- Eine unbekannte Provider-/Bridge-Rolle an einem der App-Principals ist
    -- ebenfalls Drift. Sonst könnte z. B. marker -> bridge -> runtime die
    -- Principal-Policy transitiv öffnen, obwohl alle bekannten Kanten stimmen.
    where granted.rolname = any($1::text[])
       or member.rolname = any($1::text[])
    order by granted.rolname, member.rolname, grantor.rolname
  `, [APP_ROLES]);
  equalRows(
    memberships.rows.map((row) =>
      `${row.granted_role}>${row.member_role}@${row.grantor_role}:` +
        `${row.admin_option}/${row.inherit_option}/${row.set_option}`,
    ),
    expectedDbRoleMembershipSignatures(topology),
    "Rollenmitgliedschaften",
  );

  const effectiveMemberships = await client.query<EffectiveMembershipRow>(`
    select principal,
           pg_catalog.pg_has_role(
             principal,
             'app_membership_writer',
             'MEMBER'
           ) as membership_writer,
           case
             when pg_catalog.to_regrole('neon_superuser') is null then false
             else pg_catalog.pg_has_role(principal, 'neon_superuser', 'MEMBER')
           end as neon_superuser
    from pg_catalog.unnest($1::text[]) as principal
    order by principal
  `, [[
    "app_owner",
    "app_migrator",
    "app_runtime",
    "app_system",
    "app_auth",
    "app_worker",
    "app_erasure",
    "identity_reconciler",
  ]]);
  equalRows(
    effectiveMemberships.rows
      .filter((row) => row.membership_writer)
      .map((row) => row.principal),
    ["app_migrator", "app_owner", "app_system"],
    "Effektive Membership-Writer-Principals",
  );
  const neonMembers = effectiveMemberships.rows
    .filter((row) => row.neon_superuser)
    .map((row) => row.principal);
  if (neonMembers.length > 0) {
    throw new Error(`Verbotene neon_superuser-Mitgliedschaft: ${neonMembers.join(", ")}`);
  }

  const schemaOwners = await client.query<{ nspname: string; owner: string }>(`
    select n.nspname, r.rolname as owner
    from pg_catalog.pg_namespace n
    join pg_catalog.pg_roles r on r.oid = n.nspowner
    where n.nspname !~ '^pg_'
      and n.nspname <> 'information_schema'
    order by n.nspname
  `);
  equalRows(
    schemaOwners.rows.map((row) => `${row.nspname}:${row.owner}`),
    ["drizzle:app_owner", "pgboss:app_worker", "public:app_owner"],
    "Nicht-System-Schemainventar und Ownership",
  );
  await verifyStandaloneTypeContract(client);

  const relationInventory = await client.query<{ relkind: string; relname: string }>(`
    select c.relkind, c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
    order by c.relkind, c.relname
  `);
  equalRows(
    relationInventory.rows.map((row) => `${row.relkind}:${row.relname}`),
    [
      "r:audit_log",
      "r:auth_account",
      "r:auth_rate_limit",
      "r:auth_session",
      "r:auth_user",
      "r:auth_verification",
      "r:calculator_snapshot",
      ...(hasProjectAppointments ? ["r:calendar_category"] : []),
      "r:catalog_component",
      "r:catalog_component_revision",
      ...(hasCatalogImport ? CATALOG_IMPORT_RELATIONS.map(
        (relation) => `r:${relation}`,
      ) : []),
      "r:contact",
      "r:contact_legal_hold",
      ...(hasCustomerNotification ? CUSTOMER_NOTIFICATION_RELATIONS.map(
        (relation) => `r:${relation}`,
      ) : []),
      "r:domain_events",
      "r:erasure_operation_locator",
      "r:erasure_tombstone",
      "r:inbound_receipt",
      "r:kanban_board",
      "r:kanban_column",
      "r:membership",
      "r:offer",
      "r:offer_bom_line",
      ...(hasOfferIssuance ? OFFER_ISSUANCE_RELATIONS.map(
        (relation) => `r:${relation}`,
      ) : []),
      "r:offer_mutation_rate_window",
      "r:offer_number_series",
      ...(hasOfferPdfDraft ? ["r:offer_pdf_draft"] : []),
      ...(hasOfferRelease ? [
        "r:offer_recipient",
        "r:offer_recipient_revision",
        "r:offer_release_candidate",
        "r:offer_release_candidate_approval",
        "r:offer_release_profile",
        "r:offer_release_profile_activation",
        "r:offer_release_profile_revision",
      ] : []),
      "r:offer_variant",
      "r:offer_variant_revision",
      "r:offer_variant_section",
      "r:project",
      ...(hasProjectAppointments ? [
        "r:project_appointment",
        "r:project_appointment_attendee",
      ] : []),
      ...(hasProjectAssignment ? ["r:project_assignment"] : []),
      ...(hasProjectTasks ? PROJECT_TASK_RELATIONS.map(
        (relation) => `r:${relation}`,
      ) : []),
      ...(hasProjectOutcomes ? PROJECT_OUTCOME_RELATIONS.map(
        (relation) => `r:${relation}`,
      ) : []),
      ...(hasProjectNotes ? PROJECT_NOTE_RELATIONS.map(
        (relation) => `r:${relation}`,
      ) : []),
      "r:project_calculation_job",
      "r:project_calculation_revision",
      "r:project_catalog_resolution",
      "r:project_catalog_resolution_line",
      "r:project_requirement",
      ...(hasSignatures ? [
        "r:signature_attestation",
        "r:signature_request",
        `r:${SIGNATURE_LOCATOR_RELATION}`,
        "r:signature_view_log",
      ] : []),
      "r:site",
      "r:site_energy_profile",
      "r:user_identity",
      "r:workspace",
      ...(hasWorkspaceInvoicing ? [
        "r:workspace_document_number_format",
        "r:workspace_invoicing_settings",
      ] : []),
      ...(hasEconomicsSettings ? ECONOMICS_RELATIONS.map(
        (relation) => `r:${relation}`,
      ) : []),
      ...(hasLeadSources ? LEAD_SOURCE_RELATIONS.map(
        (relation) => `r:${relation}`,
      ) : []),
      ...(hasTimeTracking ? TIME_TRACKING_RELATIONS.map(
        (relation) => `r:${relation}`,
      ) : []),
      ...(hasChecklists ? CHECKLIST_RELATIONS.map(
        (relation) => `r:${relation}`,
      ) : []),
      ...(hasCalendars ? CALENDAR_RELATIONS.map(
        (relation) => `r:${relation}`,
      ) : []),
      ...(hasChecklistTemplates ? CHECKLIST_TEMPLATE_RELATIONS.map(
        (relation) => `r:${relation}`,
      ) : []),
      ...(hasCommercialDocuments ? COMMERCIAL_DOCUMENT_RELATIONS.map(
        (relation) => `r:${relation}`,
      ) : []),
    ],
    "Relationsinventar",
  );

  const wrongTableOwners = await client.query<{ schema_name: string; table_name: string; owner: string }>(`
    select n.nspname as schema_name, c.relname as table_name, r.rolname as owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles r on r.oid = c.relowner
    where n.nspname in ('public', 'drizzle')
      and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
      and r.rolname <> 'app_owner'
    order by n.nspname, c.relname
  `);
  if (wrongTableOwners.rows.length > 0) {
    throw new Error(`Falsche Tabellen-/Sequenz-Owner: ${JSON.stringify(wrongTableOwners.rows)}`);
  }

  const wrongPgbossOwners = await client.query<{
    object_kind: string;
    object_name: string;
    owner: string;
  }>(`
    select 'relation:' || c.relkind::text as object_kind,
           c.relname as object_name,
           owner.rolname as owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles owner on owner.oid = c.relowner
    where n.nspname = 'pgboss'
      and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f', 'i', 'I')
      and owner.rolname <> 'app_worker'

    union all

    select 'function:' || p.prokind::text,
           p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')',
           owner.rolname
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = p.proowner
    where n.nspname = 'pgboss'
      and owner.rolname <> 'app_worker'

    union all

    select 'type:' || t.typtype::text,
           t.typname,
           owner.rolname
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    join pg_catalog.pg_roles owner on owner.oid = t.typowner
    where n.nspname = 'pgboss'
      and owner.rolname <> 'app_worker'

    order by object_kind, object_name
  `);
  if (wrongPgbossOwners.rows.length > 0) {
    throw new Error(`Falsche pg-boss-Objektowner: ${JSON.stringify(wrongPgbossOwners.rows)}`);
  }

  const dispatchFunctionSecurity = await client.query<{
    proname: string;
    args: string;
    result_type: string;
    owner: string;
    language: string;
    prokind: string;
    provolatile: string;
    prosecdef: boolean;
    proleakproof: boolean;
    proisstrict: boolean;
    proparallel: string;
    proconfig: string[] | null;
    prosrc: string;
  }>(`
    select routine.proname,
           pg_catalog.oidvectortypes(routine.proargtypes) as args,
           pg_catalog.pg_get_function_result(routine.oid) as result_type,
           owner.rolname as owner,
           language.lanname as language,
           routine.prokind,
           routine.provolatile,
           routine.prosecdef,
           routine.proleakproof,
           routine.proisstrict,
           routine.proparallel,
           routine.proconfig,
           routine.prosrc
    from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = routine.proowner
    join pg_catalog.pg_language language on language.oid = routine.prolang
    where namespace.nspname = 'pgboss'
      and routine.proname in (
        'enqueue_catalog_import_cleanup_v1',
        'enqueue_catalog_import_v1',
        'enqueue_customer_notification',
        'enqueue_offer_issuance',
        'enqueue_offer_pdf_draft',
        'enqueue_offer_release_candidate',
        'enqueue_project_calculation',
        'list_catalog_import_cleanup_locator_jobs_v1',
        'list_catalog_import_recovery_locator_jobs_v1',
        'quarantine_catalog_import_locator_job_v1'
      )
    order by routine.proname, routine.oid
  `);
  equalRows(
    dispatchFunctionSecurity.rows.map((row) => [
      `${row.proname}(${row.args})`,
      row.result_type,
      row.owner,
      row.language,
      row.prokind,
      row.provolatile,
      String(row.prosecdef),
      String(row.proleakproof),
      String(row.proisstrict),
      row.proparallel,
      row.proconfig?.join("|") ?? "-",
      sha256(row.prosrc),
    ].join(":")),
    [
      ...(hasCatalogImport ? [
        "enqueue_catalog_import_cleanup_v1(uuid, uuid, uuid):void:app_worker:plpgsql:f:v:true:false:false:u:" +
          "search_path=pg_catalog:1889a094a237462030b2cdc8ee8a93b6649ea77d9e73f2916eaf9766e5a352dd",
        "enqueue_catalog_import_v1(uuid, uuid, uuid):void:app_worker:plpgsql:f:v:true:false:false:u:" +
          "search_path=pg_catalog:2fdd7123cea6ea37aa612f5410b9197fbd985135cbdfd46be458bfd3a30d5e2d",
        "list_catalog_import_cleanup_locator_jobs_v1(uuid, integer):TABLE(locator_job_id uuid, workspace_id uuid, import_id uuid, locator_status text):app_worker:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:bafe9dd64d9cd293c158b595ae935ae7c5ef9e0ad4c92a6ece45592be0705353",
        "list_catalog_import_recovery_locator_jobs_v1(uuid, integer):TABLE(locator_job_id uuid, workspace_id uuid, import_id uuid, locator_status text):app_worker:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:492c68f7a243bf3d77a6660e64a6f999d8b1f1ce50f7c24593f08680383ae4ef",
        "quarantine_catalog_import_locator_job_v1(uuid):boolean:app_worker:plpgsql:f:v:false:false:false:u:" +
          "search_path=pg_catalog:9f26d3c0291504d6d1bcbe75c5ddf051fd9c574b9f5db9e8e9307e95d350a5bf",
      ] : []),
      "enqueue_project_calculation(uuid, uuid):void:app_worker:plpgsql:f:v:true:false:false:u:" +
        "search_path=pg_catalog:b4b87f16145bfbe691c2a5ad7db08a212e8254b3545660e0d6b063bb1d5a26f4",
      ...(hasOfferPdfDraft ? [
        "enqueue_offer_pdf_draft(uuid, uuid):void:app_worker:plpgsql:f:v:true:false:false:u:" +
          "search_path=pg_catalog:6c060aa6439626044be7e9e95ed71e4588c71f4d465fd7c2f658e4b556a9107c",
      ] : []),
      ...(hasOfferRelease ? [
        "enqueue_offer_release_candidate(uuid, uuid):void:app_worker:plpgsql:f:v:true:false:false:u:" +
          "search_path=pg_catalog:6119fc9e70a9515038b3951cbe6f1375396c6f8407ad182c262e617accb3664a",
      ] : []),
      ...(hasOfferIssuance ? [
        "enqueue_offer_issuance(uuid, uuid):void:app_worker:plpgsql:f:v:true:false:false:u:" +
          "search_path=pg_catalog:69b7b615d8d91e3ee124499f2cb00847a190bef05f34d05d9a07ef2deb91ff52",
      ] : []),
      ...(hasCustomerNotification ? [
        "enqueue_customer_notification(uuid, uuid):void:app_worker:plpgsql:f:v:true:false:false:u:" +
          "search_path=pg_catalog:15705e053ce84cc9bfc4b2d5dfed00b377fb1d445be718d6e9801358df1adf1c",
      ] : []),
    ],
    "Worker-Dispatch-Sicherheitsvertrag",
  );

  const functionOwners = await client.query<{ proname: string; owner: string }>(`
    select p.proname, r.rolname as owner
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles r on r.oid = p.proowner
    where n.nspname = 'public'
    order by p.proname
  `);
  equalRows(
    functionOwners.rows.map((row) => `${row.proname}:${row.owner}`),
    [
      ...(hasOfferRelease ? [
        "_m203a_approved_candidate_result:app_owner",
        "_m203a_authorize_offer_release:app_owner",
        "_m203a_erasure_delete_allowed:app_owner",
        "_m203a_guard_offer_recipient_head:app_owner",
        "_m203a_guard_offer_release_append_only:app_owner",
        "_m203a_guard_offer_release_candidate:app_owner",
        "_m203a_guard_offer_release_profile_head:app_owner",
        "_m203a_normalize_offer_release_address:app_owner",
        "_m203a_normalize_offer_release_legal_document:app_owner",
        "_m203a_normalize_offer_release_legal_documents:app_owner",
        "_m203a_normalize_offer_release_sender:app_owner",
        "_m203a_normalize_offer_release_text:app_owner",
        "_m203a_offer_release_instant:app_owner",
        "_m203a_prepared_candidate_result:app_owner",
        "activate_offer_release_profile:app_owner",
        "approve_offer_release_candidate:app_owner",
      ] : []),
      ...(hasOfferIssuance ? [
        "_m203b1_approved_issuance_result:app_owner",
        "_m203b1_authorize_offer_issuance:app_owner",
        "_m203b1_erasure_delete_allowed:app_owner",
        "_m203b1_guard_offer_issuance:app_owner",
        "_m203b1_guard_offer_issuance_append_only:app_owner",
        "_m203b1_guard_offer_issuance_approval:app_owner",
        "_m203b1_offer_issuance_dispatch_state:app_owner",
        "_m203b1_offer_issuance_instant:app_owner",
        "_m203b1_offer_issuance_source_is_current:app_owner",
        "_m203b1_prepared_issuance_result:app_owner",
        "approve_offer_issuance:app_owner",
        "build_inactive_lead_erasure_graph_m203a:app_owner",
        "claim_offer_issuance_render:app_owner",
        "finalize_offer_issuance_render_failure:app_owner",
        "finalize_offer_issuance_render_success:app_owner",
        "list_offer_issuance_recovery_workspaces:app_owner",
        "prepare_offer_issuance:app_owner",
        "read_offer_issuance_artifact:app_owner",
        "read_offer_issuance_status:app_owner",
        "recover_offer_issuance_renders:app_owner",
        "withdraw_offer_issuance:app_owner",
      ] : []),
      ...(hasCatalogImport ? CATALOG_IMPORT_FUNCTION_NAMES.map(
        (name) => `${name}:app_owner`,
      ) : []),
      ...(hasProjectTasks ? [
        "_m110_actor_can_read_tasks:app_owner",
        "_m110_actor_can_write_tasks:app_owner",
        "_m110_actor_task_role:app_owner",
        "_m110_erasure_delete_allowed:app_owner",
        "_m110_guard_project_task:app_owner",
        "_m110_guard_project_task_child:app_owner",
        "_m110_guard_project_task_positions:app_owner",
        "_m110_valid_task_rich_text_v1:app_owner",
      ] : []),
      ...(hasProjectOutcomes ? PROJECT_OUTCOME_FUNCTION_NAMES.map(
        (name) => `${name}:app_owner`,
      ) : []),
      ...(hasCustomerNotification ? CUSTOMER_NOTIFICATION_FUNCTION_NAMES.map(
        (name) => `${name}:app_owner`,
      ) : []),
      ...(hasProjectNotes ? PROJECT_NOTE_FUNCTION_NAMES.map(
        (name) => `${name}:app_owner`,
      ) : []),
      ...(hasProjectAppointments ? PROJECT_APPOINTMENT_FUNCTION_NAMES.map(
        (name) => `${name}:app_owner`,
      ) : []),
      ...(hasSignatures ? [
        "_m204_actor_can_read_signatures:app_owner",
        "_m204_actor_can_write_signatures:app_owner",
        "_m204_actor_signature_role:app_owner",
        "_m204_erasure_scrub_allowed:app_owner",
        "_m204_guard_signature_attestation:app_owner",
        "_m204_guard_signature_request:app_owner",
        "_m204_guard_signature_view_log:app_owner",
      ] : []),
      ...(hasWorkspaceInvoicing ? INVOICING_FUNCTION_NAMES.map(
        (name) => `${name}:app_owner`,
      ) : []),
      ...(hasEconomicsSettings ? ECONOMICS_FUNCTION_NAMES.map(
        (name) => `${name}:app_owner`,
      ) : []),
      ...(hasCommercialDocuments ? COMMERCIAL_DOCUMENT_FUNCTION_NAMES.map(
        (name) => `${name}:app_owner`,
      ) : []),
      "apply_catalog_component_revision:app_owner",
      "app_actor_id:app_owner",
      ...(hasProjectAssignment ? [
        "app_actor_is_external_only:app_owner",
        "app_actor_membership_id:app_owner",
      ] : []),
      "build_inactive_lead_erasure_graph:app_owner",
      ...(hasSignatures ? [
        "build_inactive_lead_erasure_graph_m204:app_owner",
      ] : []),
      ...(hasProjectNotes ? [
        "build_inactive_lead_erasure_graph_m113:app_owner",
      ] : []),
      ...(hasProjectAppointments ? [
        "build_inactive_lead_erasure_graph_m115:app_owner",
      ] : []),
      ...(hasProjectTasks ? [
        "build_inactive_lead_erasure_graph_m203b1:app_owner",
      ] : []),
      ...(hasOfferPdfDraft ? [
        "build_inactive_lead_erasure_graph_m201:app_owner",
      ] : []),
      ...(hasOfferRelease ? [
        "build_inactive_lead_erasure_graph_m202:app_owner",
      ] : []),
      "canonicalize_offer_json_v1:app_owner",
      "contact_name_split_v1:app_owner",
      ...(hasOfferPdfDraft ? ["derive_offer_pdf_draft_input:app_owner"] : []),
      "erase_inactive_lead:app_owner",
      "finalize_project_calculation_success:app_owner",
      "forbid_mutation:app_owner",
      "guard_catalog_component_mutation:app_owner",
      "guard_catalog_component_revision:app_owner",
      "guard_erasure_tombstone_worm:app_owner",
      "guard_membership_dml:app_owner",
      "guard_membership_statement:app_owner",
      "guard_offer_erasure_mutation:app_owner",
      ...(hasOfferPdfDraft ? ["guard_offer_pdf_draft_mutation:app_owner"] : []),
      "guard_project_calculation_job_mutation:app_owner",
      "guard_project_calculation_revision:app_owner",
      "guard_site_energy_profile_mutation:app_owner",
      "lock_project_calculation_finalization:app_owner",
      "mark_catalog_component_projects_stale:app_owner",
      "mark_project_catalog_resolution_stale:app_owner",
      "provision_default_request_board:app_owner",
      "reconcile_user_identity:identity_reconciler",
      "replay_erasure_tombstone:app_owner",
      ...(hasSignatures ? [
        "create_signature_request:app_owner",
        "record_signature_view:app_owner",
        "resolve_signature_public_view:app_owner",
        "revoke_signature_by_customer:app_owner",
        "sign_signature_by_token:app_owner",
      ] : []),
      ...(hasOfferRelease ? [
        "prepare_offer_release_candidate:app_owner",
        "read_offer_release_candidate_artifact:app_owner",
        "read_offer_release_candidate_status:app_owner",
        "revise_offer_recipient:app_owner",
        "revise_offer_release_profile:app_owner",
      ] : []),
      "user_identity_link_auth_only:app_owner",
      "validate_offer_variant_snapshot_mirrors:app_owner",
      "validate_project_catalog_resolution_snapshot:app_owner",
    ],
    "Funktions-Ownership",
  );

  const functionSecurity = await client.query<{
    proname: string;
    args: string;
    result_type: string;
    owner: string;
    language: string;
    prokind: string;
    provolatile: string;
    prosecdef: boolean;
    proleakproof: boolean;
    proisstrict: boolean;
    proparallel: string;
    proconfig: string[] | null;
    prosrc: string;
  }>(`
    select p.proname,
           pg_catalog.oidvectortypes(p.proargtypes) as args,
           pg_catalog.pg_get_function_result(p.oid) as result_type,
           owner.rolname as owner,
           language.lanname as language,
           p.prokind,
           p.provolatile,
           p.prosecdef,
           p.proleakproof,
           p.proisstrict,
           p.proparallel,
           p.proconfig,
           p.prosrc
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles owner on owner.oid = p.proowner
    join pg_catalog.pg_language language on language.oid = p.prolang
    where n.nspname = 'public'
    order by p.proname, p.oid
  `);
  equalRows(
    functionSecurity.rows.map((row) => [
      `${row.proname}(${row.args})`,
      row.result_type,
      row.owner,
      row.language,
      row.prokind,
      row.provolatile,
      String(row.prosecdef),
      String(row.proleakproof),
      String(row.proisstrict),
      row.proparallel,
      row.proconfig?.join("|") ?? "-",
      sha256(row.prosrc),
    ].join(":")),
    [
      ...(hasCatalogImport ? [
        "_m108b_authorize_catalog_import_runtime(uuid):uuid:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:340a6059972954e2866e8042e18c5fb6b2ef96f975f61be36519abe221d3e91a",
        "_m108b_catalog_import_actor_auth_code(uuid, uuid):text:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:fae878a570c7daab47dcf89a1e809eaee16f541b3108bac48c39626718289d37",
        "_m108b_catalog_import_error_source_header_bytes(jsonb):integer:app_owner:plpgsql:f:i:false:false:false:u:search_path=pg_catalog:fa8e7c4c14c0dedf97e82badfad5dbc14233744e81cded64f98936c09baa0d8b",
        "_m108b_catalog_import_persisted_input_valid(uuid, uuid):boolean:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:72ec10f41e76e3a8131f72e8e7eaae53f396217331189a69747bb28624b163e9",
        "_m108b_catalog_import_receipt_response(uuid, uuid, uuid, text, text, bigint):jsonb:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:8378ef10a9fc51cbc875d62b1b1549054e0d39920b1bf19362d197c2f10edf6e",
        "_m108b_catalog_import_dispatch_state(uuid, uuid, text):TABLE(domain_state text, lease_generation bigint, failure_count integer, dispatch_start_after timestamp with time zone, dispatch_key text):app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:46387383e26e124fe486c94e504cb4dc46c153d1407f9d3211531c02a2b884f4",
        "_m108b_derive_catalog_import_row_payload():trigger:app_owner:plpgsql:f:v:false:false:false:u:search_path=pg_catalog:96f007825ca64629f445275d87402035e335cd1859abb4a32ba70b8b6b8605d6",
        "_m108b_guard_catalog_import_job():trigger:app_owner:plpgsql:f:v:false:false:false:u:search_path=pg_catalog:452c08005b98e21b5355f68aac12ee3675ad496eb38f80f9ccd13bbab1d6b5a0",
        "_m108b_guard_catalog_import_row():trigger:app_owner:plpgsql:f:v:false:false:false:u:search_path=pg_catalog:c113a5cba8b0e07b22c2ceaf5006f92e25f2c004868ad5e1fdeba98d008b4beb",
        "_m108b_jsonb_date(jsonb):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:c0dafd542cdbc2aa00f6a18868a6b6c34415ab61d364d0ecc2828df3110a9f14",
        "_m108b_jsonb_exact_keys(jsonb, text[]):boolean:app_owner:sql:f:i:false:false:false:s:search_path=pg_catalog:0b00897a5213330e7f76c6f145819b4b81b10b7a6e1dbfb2dd5b72231fa65e82",
        "_m108b_jsonb_integer_between(jsonb, numeric, numeric):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:46f30e288d91f82df1138dd04d350cf76ec33d83966caa162121650f37cdcbdd",
        "_m108b_jsonb_sha256(jsonb):boolean:app_owner:sql:f:i:false:false:false:s:search_path=pg_catalog:0721a151022604ae5e7d2f5a128a13f144cf9b56fdf891ee0641de818429c74d",
        "_m108b_jsonb_trimmed_text(jsonb, integer, integer):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:69fb24e7597b9a0d65b1f358f2e070e2d59e8463f7b75d654d6b097fb8a3d4da",
        "_m108b_jsonb_uuid(jsonb):boolean:app_owner:sql:f:i:false:false:false:s:search_path=pg_catalog:cc64d3a300185bc7fdf959df351e2c17ae13ee33bd9a46192c3c2309a6fad1ae",
        "_m108b_lock_catalog_import_workspace(uuid):void:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:33e85863138115005ffd56f84d5b0ed05376c86433f41bb52e271def42d0339d",
        "_m108b_redact_catalog_import_error_array(jsonb):jsonb:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:981fac512eac9f96e91bac9ca4530b72439e7c03c7b1b13cd74a51428135952a",
        "_m108b_valid_catalog_import_commercial(jsonb):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:6e8bde7f54b7cd4258b43486d95a09375133c1c1dcb2e3473f28ef676b78f947",
        "_m108b_valid_catalog_import_error_array(jsonb):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:ba1f60093e5b557bad5c4378027934bc7e5e1d932abd48d273817e3e3aacaaf1",
        "_m108b_valid_catalog_import_expected(jsonb):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:010a8ccfe08c70cac1265e99be14706489266c15d93230c569b3a25b39aaa50c",
        "_m108b_valid_catalog_import_lease_rows(integer[]):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:9069e06be215cca5674dbee7c487513412239ee3e9ce59b347add16377715f63",
        "_m108b_valid_catalog_import_mapping(jsonb):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:1b5c2499b26013b7a1e571c3319ba3f558f5f86b899f4a58217c6e2ec38003d7",
        "_m108b_valid_catalog_import_presentation(jsonb):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:751196dc350da8e985b5c9d26f78624570cf34344a346300a28620fbfcf3d350",
        "_m108b_valid_catalog_import_provenance(jsonb):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:e5f1a7082f22f654268292420c8520724349bd97e88dc0cfedc79c588d1b6a9f",
        "_m108b_valid_catalog_import_revision(jsonb):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:faee666e10b41bbeb7cf03cb7b12dbda58b1af44be950c01c7239f23026bceea",
        "_m108b_valid_catalog_import_row_command(jsonb):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:042df3ef4dbe2a9e0035418444ff9fe9e6040cfc0b60a64595e913db6f7bc724",
        "_m108b_valid_catalog_import_sealed_target(jsonb):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:d05d209bccbf1839449c4d009b3541c29da17b6870fe910f4111c94585a03449",
        "_m108b_valid_catalog_import_source_command(jsonb):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:e1ff814f28586c950e00e6e6c90ea9e1e178f315d265fb7534f5252719119db3",
        "_m108b_valid_catalog_import_technical_data(text, jsonb):boolean:app_owner:plpgsql:f:i:false:false:false:s:search_path=pg_catalog:4a1971f31dff7b71f41e798d8db025853f51ec941027954f46508af47a9ed403",
        "_m108b_validate_catalog_import_dispatch_receipt():trigger:app_owner:plpgsql:f:v:false:false:false:u:search_path=pg_catalog:f998ec12f08263a2ce7335c87156dd5f971790f773fab6d7e18e95f3a95dfd13",
        "_m108b_validate_catalog_import_job_input():trigger:app_owner:plpgsql:f:v:false:false:false:u:search_path=pg_catalog:348a491a671ee665486900745803dbbb243b6e635f97d6bedc9d30c3c0d0a1cb",
        "_m108b_validate_catalog_import_redaction():trigger:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:6719b65767b1bef4e388444df5b4bd668d2a239c09650552826cfd99bef7f6ae",
        "_m108b_validate_catalog_import_result_input():trigger:app_owner:plpgsql:f:v:false:false:false:u:search_path=pg_catalog:563a2bad01207be23002c1d60b3d965034e2146acd393d7392eb4a97a1d734ae",
        "_m108b_validate_catalog_import_row_input():trigger:app_owner:plpgsql:f:v:false:false:false:u:search_path=pg_catalog:6b0fa4fe3457fa88055e9e668c141e3925adb10f3cd5ea01136c6e7bc8d08dc9",
        "apply_catalog_import_row_v1(uuid, uuid, integer, uuid, bigint):jsonb:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:8c1c68fcff969bcbcf5f545c3d81e7fdac1370d81cd1eb4d266bf4aa5742eab8",
        "cancel_catalog_import_v1(uuid, uuid):jsonb:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:856dd527e6775193192910499f0d0c045f32865237be0691fd292650586bd56e",
        "canonicalize_catalog_json_v1(jsonb):text:app_owner:plpgsql:f:i:false:false:true:s:search_path=pg_catalog:0fd29dc1767fd498b4cf798931f2f192b2b0da1e1f1cbab8f8ce89fcc0ff631a",
        "claim_catalog_import_v1(uuid, uuid, uuid, integer):jsonb:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:a5c2008b89d146d3d3e986ac0a7224339564a7241805621a8fdb3f45d8eeda46",
        "cleanup_catalog_import_snapshots_v1(uuid, integer):TABLE(import_id uuid, redacted_at timestamp with time zone):app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:a5c3045993fa9eaaafd024e44b8c56b7e91e9f48e68789276124b9a1c689e01d",
        "complete_catalog_import_batch_v1(uuid, uuid, uuid, bigint):jsonb:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:9d0c38b9e858ada12590bb4c41ffdda1c73eb5a40af82a76bc41c886c761bc03",
        "finalize_catalog_import_failure_v1(uuid, uuid, uuid, bigint, text):jsonb:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:c6249c195f9bd4a1f424599cc6843c3fd80fb7375a6a454e137412888cdf5029",
        "record_catalog_import_dispatch_failure_v1(uuid, uuid, uuid, text):jsonb:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:bd643665c444020c6486cf587e3bb8a97b8e5ab64f1a2b8d754c6985cfd0ddcb",
        "prepare_catalog_import_v1(uuid, uuid, jsonb):jsonb:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:fbc1c7432901c25a44464d18ee504a3b91a1f9a664138c1b0889358be03d4053",
        "read_catalog_import_rows_v1(uuid, uuid, integer, integer):TABLE(row_number integer, validation_status text, normalized_sku text, operation text, source_command jsonb, error_snapshot jsonb, target_component_id uuid, expected_component_id uuid, expected_revision integer, expected_status text, result_state text, result_component_id uuid, result_revision integer, result_error_code text, result_created_at timestamp with time zone):app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:635b78f861683a8709fc823c67bbccb0c98d2d47bbdc38d683c2e2e1962de4d7",
        "read_catalog_import_v1(uuid, uuid):TABLE(import_id uuid, intent_id uuid, file_name text, file_size_bytes integer, encoding text, delimiter text, mapping_snapshot jsonb, total_count integer, valid_count integer, invalid_count integer, state text, consecutive_failure_count integer, next_attempt_at timestamp with time zone, error_code text, created_by uuid, execution_actor_id uuid, attested_by uuid, attested_at timestamp with time zone, created_at timestamp with time zone, preview_expires_at timestamp with time zone, started_at timestamp with time zone, terminal_at timestamp with time zone, snapshot_cleanup_due_at timestamp with time zone, snapshot_redacted_at timestamp with time zone, created_result_count integer, revised_result_count integer, unchanged_result_count integer, conflict_result_count integer):app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:dcd3e8f124e5aa49ed891e8292a9fc64c0a87f8c067ca5698df3ca4767e5a0e0",
        "read_latest_catalog_import_id_v1(uuid):uuid:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:6709d00cec1b7ea6f99967720c1b0e232515655029816ff93c8f6fae934c690c",
        "record_catalog_import_preclaim_failure_v1(uuid, uuid, uuid, text):jsonb:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:9139c3f04b976547b7dcd688334305024918c7c900962d14f1a3c79ccc476725",
        "recover_catalog_imports_v1(uuid, integer):TABLE(import_id uuid, recovery_action text, dispatch_id uuid):app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:9c21da09b190910bd3aec087b4718a7ecb8844b5e4e2e971a927335e055e0941",
        "start_catalog_import_v1(uuid, uuid, text):jsonb:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:90f3d47bfc0ea23d3bc02545c0939f47ed7e90c6827d3900098805270982d7d1",
      ] : []),
      ...(hasProjectTasks ? [
        "_m110_actor_can_read_tasks(uuid):boolean:app_owner:sql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:784631935ddd82a25e9f9a46d4a24d14c1d424abf1027208a9bd3f16f521fb10",
        "_m110_actor_can_write_tasks(uuid):boolean:app_owner:sql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:5da979a1884752b64d82236417578d6332cb86d16f0b2821f99e74dba7833acc",
        "_m110_actor_task_role(uuid):text:app_owner:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:49f4cddec0ed9fcac5d40487633a7910b5479aeb55e2d47976f431e2e44dc64e",
        "_m110_erasure_delete_allowed(uuid, uuid):boolean:app_owner:plpgsql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "2d578a95578ffed5bd7e23693039bb419d0cffbc05617f61be903642961e3605",
        "_m110_guard_project_task():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
          "search_path=pg_catalog:1e1d9edfe6566822ee3dceed4a14f7158687cba647a12b779dccdb58603ca97f",
        "_m110_guard_project_task_child():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
          "search_path=pg_catalog:82c359b25fc6f07467d09724285682147a92c4bfd8bc0239b24777f7ff1872ff",
        "_m110_guard_project_task_positions():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
          "search_path=pg_catalog:1ea84dfe7c1008dd5095bb937a41345b99f2ed89042dfc56beee427b391986e6",
        "_m110_valid_task_rich_text_v1(jsonb):boolean:app_owner:plpgsql:f:i:" +
          "false:false:true:s:search_path=pg_catalog:" +
          "e4438649b75d0bed79426fce38d31d8889c65927397fd9317d5fcfe1c25f871c",
      ] : []),
      ...(hasProjectOutcomes ? [
        "_m111a_actor_can_manage_loss_reasons(uuid):boolean:app_owner:sql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "1fc4823ad8a20ea1b2d74447fdb3ca538ec7e0c94f93804e1ebd8194143e60df",
        "_m111a_actor_can_read_loss_reasons(uuid):boolean:app_owner:sql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "eb511559978b32dfb6afc2a749bdf997fa1a460adb0bc5e3ca6b138f3b8d35cc",
        "_m111a_actor_role(uuid):text:app_owner:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:" +
          "f09f8a1d579c02c6585e7d74d8c47f379c4574b38331c56fcdf454efa77673e4",
        "_m111a_erasure_scrub_allowed(uuid, uuid):boolean:app_owner:plpgsql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "2fae356dfbade63bfc0fe00685d41a13891ba868941681a00d1c2024e862b16d",
        "_m111a_guard_loss_reason():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
          "search_path=pg_catalog:" +
          "b31b2eaad4c5e1beabb07ea2b2bd1cd2e6a8fff3e88d648e7a729770662ff4da",
        "_m111b_guard_outcome_evidence_insert():trigger:app_owner:plpgsql:f:v:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "e865e7cb5014b44cc05d377f552329ea92c9e385de20021ab84fe8f9acc5f58c",
        "_m111b_guard_project_outcome():trigger:app_owner:plpgsql:f:v:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "ec8b1e0da4c1a21da65b964c38dafbc3e71788663a1d76e1e0af8cdf83393590",
        "_m111b_record_project_outcome():trigger:app_owner:plpgsql:f:v:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "77198d622ee01484e2f9660e44a2be19c96468aec1ba9fae76ff622b60d2249a",
      ] : []),
      ...(hasCustomerNotification ? [
        "_m111b_customer_notification_dispatch_state(uuid, uuid):TABLE(id uuid, attempt_count integer, next_attempt_at timestamp with time zone):app_owner:plpgsql:f:s:true:false:false:u:" +
          "search_path=pg_catalog:aecf8cc0fc7790c6e67b7570a590d2912696588674c3480921abbcfb800e96f3",
        "_m111b_guard_customer_notification():trigger:app_owner:plpgsql:f:v:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "665a1b06f3891baf5b7c11f01ea90b013a3da9f44f94bbcaa62c72ac3fcffd63",
        "_m111b_guard_delivery_attempt():trigger:app_owner:plpgsql:f:v:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "5870c85b721ea15d44af62cfa7d154ba5f7b64dae650718cb8b3607a16b5def8",
        "_m111b_guard_offer_freeze():trigger:app_owner:plpgsql:f:v:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "4edd226e94aa739dd968d2460f2c4813e9b370bc7fabc4f11a1789f593f0d23b",
        "_m111b_project_has_binding_issuance(uuid, uuid):boolean:app_owner:plpgsql:f:s:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "940efd86798ce1072d7ea4a5c2c6e37f17f259f4b8376f1bbe304e01dab99412",
        "_m111b_read_notification_delivery(uuid, uuid):TABLE(status text, attempt_count integer):" +
          "app_owner:plpgsql:f:s:true:false:false:u:search_path=pg_catalog:" +
          "839c8e517398cc75a2f531fa8385d201b3c9889d677d748e1692d5029de792f0",
        "_m111b_worker_cancel_erased(uuid, uuid):void:app_owner:plpgsql:f:v:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "6ef5110ecb0f89e11af56c580e0378a5c4a13704bcd832da3a6ace2437291050",
        "_m111b_worker_deliver(uuid, uuid, integer, text, text):void:app_owner:plpgsql:f:v:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "1ce2a012ab30db04fe8da3beb8d7a2baf5b06101298bfd34ccbbd66441e7d9bb",
        "_m111b_worker_resolve_recipient(uuid, uuid):text:app_owner:plpgsql:f:v:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "b5ce5d43143330224d0e095c20c9a3d8215fd57445299a5bb02b60d849e62d13",
      ] : []),
      ...(hasProjectNotes ? [
        "_m113_actor_can_read_notes(uuid):boolean:app_owner:sql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:7fbee4934dbed119ee3ee98b28cbc940555ee1e834fb35c925c24a38766bb0d8",
        "_m113_actor_can_write_notes(uuid):boolean:app_owner:sql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:7177ba6f0466992d8a9a66c5d10d86fbaa90f67cf7a44fcdeb30f2a8a679b761",
        "_m113_actor_note_role(uuid):text:app_owner:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:259468171b6592384d59edf88981230e6310dd1f0c6c6064d143734d370be3f1",
        "_m113_erasure_delete_allowed(uuid, uuid):boolean:app_owner:plpgsql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "16b80db50109c706578cd61d24db440d69a889a61467952935efde77502cddc0",
        "_m113_guard_project_note():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
          "search_path=pg_catalog:7773c5bbffe07ea7aeab05c175ee45bbcf8f6bf0580a9178be5d4bc063fc1d26",
      ] : []),
      ...(hasProjectAppointments ? [
        "_m115_actor_appointment_role(uuid):text:app_owner:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:259468171b6592384d59edf88981230e6310dd1f0c6c6064d143734d370be3f1",
        "_m115_actor_can_read_appointments(uuid):boolean:app_owner:sql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:522e04036cc964e17b7c6a8cb24b8b16474a0d624f61010c70cf4866868e14fe",
        "_m115_actor_can_write_appointments(uuid):boolean:app_owner:sql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:72490376fe41c89621ec2a6461874308c5c372c2246d402ece28ab2636b28f4a",
        "_m115_erasure_delete_allowed(uuid, uuid):boolean:app_owner:plpgsql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "e679f220100342b2bcdf30f0f983b6ccfd663533475bb2f2831873ae64a27938",
        "_m115_guard_project_appointment():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
          "search_path=pg_catalog:f1a8c76783c6bc8200d567221cf6905dbfe29baaa12a2c2e4603fb608eecfffb",
        "_m115_guard_project_appointment_attendee():trigger:app_owner:plpgsql:f:v:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "ccc3aedc47bc055ad1a35f3c1d05ef4abb5c5651fa88241930881d9304574d75",
      ] : []),
      ...(hasSignatures ? [
        "_m204_actor_can_read_signatures(uuid):boolean:app_owner:sql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:a674590967cad29da90175af59af87f4ca580d2807d4bd6b7672b7ecec3f741d",
        "_m204_actor_can_write_signatures(uuid):boolean:app_owner:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:b4bf47ad539e69e9706013401fe225777f09613d29dd2ffacbfa24307564cfd9",
        "_m204_actor_signature_role(uuid):text:app_owner:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:259468171b6592384d59edf88981230e6310dd1f0c6c6064d143734d370be3f1",
        "_m204_erasure_scrub_allowed(uuid, uuid):boolean:app_owner:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:d2cfff07e81fd845a3079f0e2799c6dd83ad600eea9cc5feb0548eb892b5fc10",
        "_m204_guard_signature_attestation():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
          "search_path=pg_catalog:cc0f2b8a08b9de87cc2a939d951ab16670d91fcf59abd8996a16b06b3c565401",
        "_m204_guard_signature_request():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
          "search_path=pg_catalog:a609b4b52b65669aca6e12b5c0450e3e37a720e85bf4a5eacec99319d32a8a23",
        "_m204_guard_signature_view_log():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
          "search_path=pg_catalog:1b21d12aa2541ff0a4493a544b23657a157125831d3613a2558c674cf8c2940c",
        "create_signature_request(uuid, uuid, uuid, integer, bytea):jsonb:app_owner:plpgsql:f:v:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "51678eab0018ed840fff664306cf9e2ca8876aef350122fc7f0439ed233ba6a2",
        "record_signature_view(bytea):jsonb:app_owner:plpgsql:f:v:true:false:false:u:" +
          "search_path=pg_catalog:2adf77f4d0ec8b21f1dcd3b10c1ba142a70d0716f8327ae2d3a8b892a91e63d9",
        "resolve_signature_public_view(bytea):TABLE(workspace_id uuid, signature_request_id uuid, " +
          "offer_id uuid, issuance_id uuid, status text, expires_at timestamp with time zone, " +
          "content_sha256 bytea, signer_name text, signed_at timestamp with time zone, " +
          "attestation_mode text, document_mime_type text, document_sha256 bytea, " +
          "document_size_bytes integer, document_bytes bytea):app_owner:plpgsql:f:s:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "1fbf9fddde50cb2d2298f1bd713b5c53922bd9e8179564286f9bce2ffc197040",
        "revoke_signature_by_customer(bytea):jsonb:app_owner:plpgsql:f:v:true:false:false:u:" +
          "search_path=pg_catalog:c61869de7b489354884dc81af015d3d47947a7009804fbb48c73e46596cb89b1",
        "sign_signature_by_token(bytea, text, text, bytea):jsonb:app_owner:plpgsql:f:v:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "4fc6f3a5f1fc65cd0ad98f10a6e13eea5d3922826171ffd2dafd6ee0af20b9f2",
      ] : []),
      ...(hasCommercialDocuments ? [
        "_m301_actor_can_read_invoicing(uuid):boolean:app_owner:sql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:2014c5374b59d3f8be0d21590c05b4f45d0c4ee3fcd1340a97cdef588cfa8704",
        "_m301_actor_can_write_invoicing(uuid):boolean:app_owner:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:27e89399412f45b63938cba8ca6442d81456a8039a9ce2f3294781544d2016c7",
        "_m301_actor_invoicing_role(uuid):text:app_owner:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:259468171b6592384d59edf88981230e6310dd1f0c6c6064d143734d370be3f1",
        "_m301_guard_issued_immutable():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
          "search_path=pg_catalog:b3d5ec893a41767ec5afe0be70c21ca81343985f55bce9a29b5beb838cc51f32",
      ] : []),
      ...(hasWorkspaceInvoicing ? [
        "_m300_actor_can_read_invoicing(uuid):boolean:app_owner:sql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:119ffa84bc4ed5b45ce1981706a305b3d959ee5e8ac2eedd81c32e210bb6f101",
        "_m300_actor_can_write_invoicing(uuid):boolean:app_owner:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:de23b1e63c666e2ce9e7340abae43550dc034c2f6e6de79e9951eb41baa292e4",
        "_m300_actor_invoicing_role(uuid):text:app_owner:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:259468171b6592384d59edf88981230e6310dd1f0c6c6064d143734d370be3f1",
      ] : []),
      ...(hasEconomicsSettings ? [
        "_f406_actor_can_read_economics(uuid):boolean:app_owner:sql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:f4fa2e35c359d94c3720355e117e84cd0d8a59e4111c7c04d0fb0dc5afecd19a",
        "_f406_actor_can_write_economics(uuid):boolean:app_owner:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:fa421d51c0479d14c9f8ebbc7674494a3c7b925b27f09e8e98f3de5f722e8583",
        "_f406_actor_economics_role(uuid):text:app_owner:plpgsql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:259468171b6592384d59edf88981230e6310dd1f0c6c6064d143734d370be3f1",
      ] : []),
      "apply_catalog_component_revision():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
        "search_path=pg_catalog:d26213c16cfaba904d4aef47136bf4324b1b3ab089ac822bfe09b8397ce8e456",
      "app_actor_id():uuid:app_owner:sql:f:s:false:false:false:s:search_path=pg_catalog:" +
        "acca23aaae3a91eda3aa424256de1527e1bb61d02fdd4b0d2c0803ecd6a37542",
      ...(hasProjectAssignment ? [
        "app_actor_is_external_only(uuid):boolean:app_owner:plpgsql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "3f10ce69854a1689d5c2369fe7ac291c30f1cc126b6b29fa30ba0f64b636f3be",
        "app_actor_membership_id(uuid):uuid:app_owner:sql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:" +
          "5678c8f36cfd957778128123fd5f1c11805f6b486fd2de31c52c6d09e402e051",
      ] : []),
      ...(hasOfferRelease ? [
        "_m203a_approved_candidate_result(uuid, uuid, boolean):jsonb:app_owner:sql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "f4bea67f3efa0353de3559f38fc9d023c32d4bde8d6aa0a5c3428750cda4b176",
        "_m203a_authorize_offer_release(uuid, text):uuid:app_owner:plpgsql:f:v:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "a4900f40f7dae6f717003686c291aa1f9c9a126b9d7b5cd7ff8580cad0b74944",
        "_m203a_erasure_delete_allowed(uuid, uuid, text):boolean:app_owner:plpgsql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "793c778e1ba0c033c18dcf92249c8f406ea5742b600dd47c2536d19aa0f24959",
        "_m203a_guard_offer_recipient_head():trigger:app_owner:plpgsql:f:v:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "9694954740571073b7fac54ce8e5195ca8a7eded48db74036e4a49ffc5b49063",
        "_m203a_guard_offer_release_append_only():trigger:app_owner:plpgsql:f:v:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "1cadb165afa9c9a70f0f4da06c4af3a40b8190901a977919bcc75eef4f1a821a",
        "_m203a_guard_offer_release_candidate():trigger:app_owner:plpgsql:f:v:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "f1c459a275bb3fbcd5fb965a1c2076dfaa2ee88a730ee5e90518f3c8408ea4d2",
        "_m203a_guard_offer_release_profile_head():trigger:app_owner:plpgsql:f:v:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "624e49972ca7ca7a90a778290450bbed30249f45922e8fa02229981f916e3c04",
        "_m203a_normalize_offer_release_address(jsonb):jsonb:app_owner:plpgsql:f:i:" +
          "false:false:true:u:search_path=pg_catalog:" +
          "7f95f2fe3ab5130d2f2238b6c9b771fb2bf1c206c96f1fec09404e267cf9f999",
        "_m203a_normalize_offer_release_legal_document(jsonb):jsonb:app_owner:plpgsql:" +
          "f:i:false:false:true:u:search_path=pg_catalog:" +
          "aea6a9c220780105e124434a811719268c92afe7349991760e1e8959ccc75fbd",
        "_m203a_normalize_offer_release_legal_documents(jsonb):jsonb:app_owner:plpgsql:" +
          "f:i:false:false:true:u:search_path=pg_catalog:" +
          "507fee6990daf5601106e9f75337e2c59cc51640dc737034c772cc38014714a7",
        "_m203a_normalize_offer_release_sender(jsonb):jsonb:app_owner:plpgsql:f:i:" +
          "false:false:true:u:search_path=pg_catalog:" +
          "9420445688ad876df9f0aa1f2a8ad794b3ca9c382ad3dc3ae19efeb4bf0d34c3",
        "_m203a_normalize_offer_release_text(text, integer, boolean):text:app_owner:" +
          "plpgsql:f:i:false:false:true:u:search_path=pg_catalog:" +
          "683e3621f57fe3f7e2dc9951c0123b1513595af89874190ad5353ef639beb3d1",
        "_m203a_offer_release_instant(timestamp with time zone):text:app_owner:sql:f:i:" +
          "false:false:true:u:search_path=pg_catalog:" +
          "c9db756038f406cd8c23b61d77d75b9ae7694b777c213fdcb885753406d56623",
        "_m203a_prepared_candidate_result(uuid, uuid, boolean):jsonb:app_owner:sql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "aa87cffa051c7b928b0baa11facb82b3d185032f3a75207e65dffc5d5fc754d0",
        "activate_offer_release_profile(uuid, uuid, uuid, integer):jsonb:app_owner:" +
          "plpgsql:f:v:true:false:false:u:search_path=pg_catalog:" +
          "1dc4a602b99a74e4bb713e754b6074325fa92e8bf701fb62b1ecdcde3533cdf5",
        "approve_offer_release_candidate(uuid, uuid, uuid, uuid, boolean, boolean, " +
          "boolean, boolean, boolean):jsonb:app_owner:plpgsql:f:v:true:false:false:u:" +
          "search_path=pg_catalog:" +
          "11177945444d81590685e3fdc8a985b95953ca0e95660e6da3a5b2a257980ebe",
        "prepare_offer_release_candidate(uuid, uuid, uuid, integer, uuid, uuid, uuid, " +
          "integer, uuid, integer, date):jsonb:app_owner:plpgsql:f:v:true:false:false:u:" +
          "search_path=pg_catalog:" +
          "69de2193b95106e22764766e2d97f74b8ec18d00de8e4f9ae4dd0519456df3aa",
        "read_offer_release_candidate_artifact(uuid, uuid, uuid):TABLE(" +
          "workspace_id uuid, id uuid, offer_id uuid, variant_id uuid, " +
          "variant_revision integer, profile_revision integer, recipient_revision integer, " +
          "publication_status text, has_zero_tax_treatment boolean, state text, " +
          "attempt_count integer, next_attempt_at timestamp with time zone, " +
          "created_at timestamp with time zone, started_at timestamp with time zone, " +
          "finished_at timestamp with time zone, error_code text, approval_id uuid, " +
          "approval_version text, approval_command_version text, " +
          "approved_at timestamp with time zone, approval_artifact_version uuid, " +
          "offer_number text, artifact_mime_type text, artifact_sha256_hex text, " +
          "artifact_size_bytes integer, artifact_bytes bytea):app_owner:plpgsql:f:s:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "bfd978794c0641a6c49a91275a025c77144d13bf55aeb6978632ef1fdcfafb4b",
        "read_offer_release_candidate_status(uuid, uuid, uuid):TABLE(" +
          "workspace_id uuid, id uuid, offer_id uuid, variant_id uuid, " +
          "variant_revision integer, profile_revision integer, recipient_revision integer, " +
          "publication_status text, has_zero_tax_treatment boolean, state text, " +
          "attempt_count integer, next_attempt_at timestamp with time zone, " +
          "created_at timestamp with time zone, started_at timestamp with time zone, " +
          "finished_at timestamp with time zone, error_code text, approval_id uuid, " +
          "approval_version text, approval_command_version text, " +
          "approved_at timestamp with time zone, approval_artifact_version uuid):" +
          "app_owner:plpgsql:f:s:true:false:false:u:search_path=pg_catalog:" +
          "bdb5d098f2da904f2c2ecff79c816879d18aef3ae8e044386e1b6299ffb2d656",
        "revise_offer_recipient(uuid, uuid, integer, text, text, text, jsonb, boolean):" +
          "jsonb:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:" +
          "f61b6439229ce5a74fd7ceab69970d5a1e34598cd3936af9c5e8da78911f1edc",
        "revise_offer_release_profile(uuid, integer, text, jsonb, jsonb):jsonb:" +
          "app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:" +
          "b5edeae4163abe3c471798ea0ec3abe9841057c3805d980f9cf5d364d566767e",
      ] : []),
      ...(hasOfferIssuance ? [
        "_m203b1_approved_issuance_result(uuid, uuid, uuid, boolean):jsonb:" +
          "app_owner:plpgsql:f:s:true:false:false:u:search_path=pg_catalog:" +
          "8186543da35674b100dd0977952812f4a5aed2b1d993f9bcd82d03cd88cc17e1",
        "_m203b1_authorize_offer_issuance(uuid, text):uuid:app_owner:plpgsql:f:v:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "59a94b2006a3aa57767307445c53854d6ea9eb1de024adbaef18870c5e87440b",
        "_m203b1_erasure_delete_allowed(uuid, uuid, text):boolean:app_owner:plpgsql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "8c507ffdf43c7652434084f65561c1ac54661f41d44f8d0c9df4d43185ea008e",
        "_m203b1_guard_offer_issuance():trigger:app_owner:plpgsql:f:v:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "6315159470c8119ca12ba20935e9b7c23db8e37e6a9417e4088a2c81a1ad420e",
        "_m203b1_guard_offer_issuance_append_only():trigger:app_owner:plpgsql:f:v:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "ea702975dbacb3aeda2c7de251609d77e5c36aeb02b876e62cac4a7079d85416",
        "_m203b1_guard_offer_issuance_approval():trigger:app_owner:plpgsql:f:v:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "6f91a25355fca5b779de0051c0d5be779e9a2224aac81394917df919551330b0",
        "_m203b1_offer_issuance_dispatch_state(uuid, uuid):TABLE(" +
          "domain_state text, domain_attempt_count integer, " +
          "domain_next_attempt_at timestamp with time zone, " +
          "domain_lease_expires_at timestamp with time zone):app_owner:plpgsql:f:s:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "33ea9a97a929ed9f70745f0639c5b0d0345fe326a1b450f37f94c2aab90c31c4",
        "_m203b1_offer_issuance_instant(timestamp with time zone):text:app_owner:sql:f:i:" +
          "false:false:true:u:search_path=pg_catalog:" +
          "c9db756038f406cd8c23b61d77d75b9ae7694b777c213fdcb885753406d56623",
        "_m203b1_offer_issuance_source_is_current(uuid, uuid):boolean:app_owner:sql:f:s:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "d897c69e2bad4b849321cc265b75f1b9c2c4c6e1a8769bcf5f490067c707cb8c",
        "_m203b1_prepared_issuance_result(uuid, uuid, boolean):jsonb:app_owner:plpgsql:f:s:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "a5c3d19b382fb52fc772aae9f39d641f0c7744fef4cb0f840a351ecdc6efa165",
        "approve_offer_issuance(uuid, uuid, boolean, boolean, boolean, boolean, boolean):" +
          "jsonb:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:" +
          "48115caba8a8a226a70dd426c816880c7bfcf973c6d1f9df1dcda513240e9eb9",
        "build_inactive_lead_erasure_graph_m203a(uuid, uuid):jsonb:app_owner:sql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "bec8a092582ab63adf104b6b809e5e852706d205536f56e8fb2efa5c8a0d95b0",
        "claim_offer_issuance_render(uuid, uuid, uuid, integer):jsonb:app_owner:plpgsql:f:v:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "0d13823c8abacf7ca0a53c291e01aac8f368574f4fe7bcf99be9f20ae09fc2c5",
        "finalize_offer_issuance_render_failure(uuid, uuid, uuid, integer, text, boolean):" +
          "jsonb:app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:" +
          "b20fda32409de3780c3b35da57097937985dc8d5ea08f284fe40cf3aaaf4ff02",
        "finalize_offer_issuance_render_success(uuid, uuid, uuid, integer, bytea):jsonb:" +
          "app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:" +
          "ebebc9baee4a8b47d7bd4f95dba26c890e0694188d3e4e7fdac37bbe5011e132",
        "list_offer_issuance_recovery_workspaces(uuid, integer):TABLE(workspace_id uuid):" +
          "app_owner:plpgsql:f:s:false:false:false:u:search_path=pg_catalog:" +
          "863129aa1b1d8c96a0fa14e54544dc2f749a6644c7526e7b7b3e3e676b2ae002",
        "prepare_offer_issuance(uuid, uuid, uuid):jsonb:app_owner:plpgsql:f:v:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "50c1f8a2e0e731d45baa1a94bc59842e4292e103ef2a71f75bc8c7d913cac951",
        "read_offer_issuance_artifact(uuid, uuid, uuid):TABLE(" +
          "workspace_id uuid, id uuid, offer_id uuid, candidate_id uuid, " +
          "artifact_intent text, has_zero_tax_treatment boolean, state text, " +
          "attempt_count integer, next_attempt_at timestamp with time zone, " +
          "created_at timestamp with time zone, started_at timestamp with time zone, " +
          "finished_at timestamp with time zone, error_code text, approval_count integer, " +
          "viewer_has_approved boolean, can_current_actor_approve boolean, " +
          "derived_state text, withdrawal_id uuid, withdrawal_reason_code text, " +
          "withdrawn_at timestamp with time zone, approval_artifact_version uuid, " +
          "offer_number text, artifact_mime_type text, artifact_sha256_hex text, " +
          "artifact_size_bytes integer, artifact_bytes bytea):app_owner:plpgsql:f:s:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "0685b43d55c3da6bf8f754412d1e9e73c256d0be225b12025f9cf74aff4b9639",
        "read_offer_issuance_status(uuid, uuid, uuid):TABLE(" +
          "workspace_id uuid, id uuid, offer_id uuid, candidate_id uuid, " +
          "artifact_intent text, has_zero_tax_treatment boolean, state text, " +
          "attempt_count integer, next_attempt_at timestamp with time zone, " +
          "created_at timestamp with time zone, started_at timestamp with time zone, " +
          "finished_at timestamp with time zone, error_code text, approval_count integer, " +
          "viewer_has_approved boolean, can_current_actor_approve boolean, " +
          "derived_state text, withdrawal_id uuid, withdrawal_reason_code text, " +
          "withdrawn_at timestamp with time zone, approval_artifact_version uuid):" +
          "app_owner:plpgsql:f:s:true:false:false:u:search_path=pg_catalog:" +
          "0bb12bad41d4a425d71bfcee7152ec900890182184e4b32f40b477e6719330a6",
        "recover_offer_issuance_renders(uuid, integer):TABLE(issuance_id uuid):" +
          "app_owner:plpgsql:f:v:true:false:false:u:search_path=pg_catalog:" +
          "90490093287e7eb6ed285192ac535b3205cb9ae9daea593ef5ac25e3d220e182",
        "withdraw_offer_issuance(uuid, uuid, text):jsonb:app_owner:plpgsql:f:v:" +
          "true:false:false:u:search_path=pg_catalog:" +
          "cc3f1a3b9956eca75e1a770cb4e8d59cc65bf7598b34454266f744ab6ddf9edb",
      ] : []),
      ...(hasProjectNotes ? [
        "build_inactive_lead_erasure_graph_m113(uuid, uuid):jsonb:app_owner:sql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "e10bcf2cfd57ed151270b8c7674eddc1a280733bf4a166402a2327e3f5c389b2",
      ] : []),
      ...(hasProjectAppointments ? [
        "build_inactive_lead_erasure_graph_m115(uuid, uuid):jsonb:app_owner:sql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "721aecb517ece42d09e1101afb397af22491f1798995ceaabf963dd4598870fc",
      ] : []),
      "build_inactive_lead_erasure_graph(uuid, uuid):jsonb:app_owner:sql:f:s:false:false:false:u:" +
        `search_path=pg_catalog:${hasSignatures
          ? "7aa48e1c58337cfa381a3dc5b3dd2a162eae9ae6960741e9d160200a5e636069"
          : hasProjectAppointments
          ? "350a4c4f1de2df81dd39da00cfda75505802ddc72b03212975e2ad1c0302dec6"
          : hasProjectNotes
          ? "721aecb517ece42d09e1101afb397af22491f1798995ceaabf963dd4598870fc"
          : hasProjectTasks
          ? "e10bcf2cfd57ed151270b8c7674eddc1a280733bf4a166402a2327e3f5c389b2"
          : hasOfferIssuance
          ? "16833496d12956cafb41b94341d78ac9baa6fa00a60cc2d2450dbe420cf2621c"
          : hasOfferRelease
            ? "bec8a092582ab63adf104b6b809e5e852706d205536f56e8fb2efa5c8a0d95b0"
          : hasOfferPdfDraft
            ? "b62712671bda4ce750868b044794475938b9d24dd08c1a38b6db1674a4fd0e4d"
            : "ff33afd9579e2d1f43758b9558e7b55f7381942737c3f133c78b8764aa90569c"}`,
      ...(hasOfferPdfDraft ? [
        "build_inactive_lead_erasure_graph_m201(uuid, uuid):jsonb:app_owner:sql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:ff33afd9579e2d1f43758b9558e7b55f7381942737c3f133c78b8764aa90569c",
      ] : []),
      ...(hasOfferRelease ? [
        "build_inactive_lead_erasure_graph_m202(uuid, uuid):jsonb:app_owner:sql:f:s:false:false:false:u:" +
          "search_path=pg_catalog:b62712671bda4ce750868b044794475938b9d24dd08c1a38b6db1674a4fd0e4d",
      ] : []),
      ...(hasProjectTasks ? [
        "build_inactive_lead_erasure_graph_m203b1(uuid, uuid):jsonb:app_owner:sql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "16833496d12956cafb41b94341d78ac9baa6fa00a60cc2d2450dbe420cf2621c",
      ] : []),
      ...(hasSignatures ? [
        "build_inactive_lead_erasure_graph_m204(uuid, uuid):jsonb:app_owner:sql:f:s:" +
          "false:false:false:u:search_path=pg_catalog:" +
          "350a4c4f1de2df81dd39da00cfda75505802ddc72b03212975e2ad1c0302dec6",
      ] : []),
      "canonicalize_offer_json_v1(jsonb):text:app_owner:plpgsql:f:i:false:false:true:s:" +
        "search_path=pg_catalog:0b5cdc7c4aa05552def26bc36f3f64bfc73e18689b646b473db607ad858ca85c",
      "contact_name_split_v1(text):TABLE(first_name text, last_name text):app_owner:sql:f:i:" +
        "false:false:false:u:search_path=pg_catalog:" +
        "0ff6e6a4ca03690a776d797382168024ebf845f3647c4f9a7ecea108ede4fe11",
      ...(hasOfferPdfDraft ? [
        "derive_offer_pdf_draft_input():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
          "search_path=pg_catalog:2ca618a933fba428b34a0860261a28c1e9d5601d2ef058fd8fdaf0b6041414e9",
      ] : []),
      "erase_inactive_lead(uuid, uuid, uuid):uuid:app_owner:plpgsql:f:v:true:false:false:u:" +
        `search_path=pg_catalog:${hasSignatures
          ? "0c4442f592807e72c2cd9b7997bdc48685a57e8415e865fc8cceff4cd85f26a3"
          : hasProjectAppointments
          ? "cec63897e55831166ccb154e07fab02b7b0c381d619597933c3381c74eac70b9"
          : hasCustomerNotification && hasProjectNotes
          ? "742a9a4ef9f8f459268ab3b0e27af875424bf43d361a157fab59ed6930596e3e"
          : hasCustomerNotification
          ? "26656181bde7172aad3ebb717cffe37bb6e874f1a298a703090ed706d750fd4d"
          : hasProjectNotes
          ? "7e6f20126d9b1d9fdf44699b81855d1961c94bee6fbd581e5fa35b3e67d92c0d"
          : hasProjectOutcomes
          ? "859c9563aef9d9d4ccba5b0ee91b578dc35ab431beb2b3a9ee5d216f5eccb088"
          : hasProjectTasks
          ? "c7bbe2311d331eb8ad272b4d8dd48ccfb53d21be2418989703d980c61f3e1562"
          : hasOfferIssuance
          ? "1d865e697787271c715ee6a606f5cc6463456c53ee0c2fb5c906213e5170287c"
          : hasOfferRelease
            ? "c6ad889699c6126642497275b5871cfc56f9b0968b76e341bb2980c984caaaf3"
          : hasOfferPdfDraft
            ? "ba6c9475ce7520ef61c443c9fc0d04dd19af30edb8fb2664fd7889abcc66508a"
            : "bba97fd4f1224ab42768aa952f54e4a933229225f8ab251e16173adf75084fdd"}`,
      "finalize_project_calculation_success(uuid, uuid, uuid, integer, uuid, jsonb):" +
        "TABLE(outcome text, revision_id uuid, revision_number integer):" +
        "app_owner:plpgsql:f:v:true:false:true:u:search_path=pg_catalog:" +
        "d76a793111515819e26d367daa2ecdf5b894447244e2ae002a51ace05b04cdb9",
      "forbid_mutation():trigger:app_owner:plpgsql:f:v:false:false:false:u:-:" +
        "df89b0c65f44ffae87695685fca411fb8ad998cff6768bb8a176024d331910f3",
      "guard_catalog_component_mutation():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
        "search_path=pg_catalog:62abb0e08cabd1d8a53dd4cbb1df078e3018cc45c84264846c21f61f7b91f5b7",
      "guard_catalog_component_revision():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
        "search_path=pg_catalog:febb6a39265ceb1661f5dc21709f4a2912df799c6b4dd06db27b540253b8c88d",
      "guard_erasure_tombstone_worm():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
        `search_path=pg_catalog:${hasSignatures
          ? "cc6f8018143ef868b4d69851d7e1ac5098e42efc6fb7ec6ac741b26a1016fe19"
          : hasProjectAppointments
          ? "66dbe75a59c983c1042a498ef086ccfee0f8a2c48b6cef4c3b9bb2892a687663"
          : hasProjectNotes
          ? "94518798af295e4e491d4ae098b994ce788bc9c836b05cc748e612bf85c29897"
          : hasProjectTasks
          ? "928466ed994915b001addeb9e66dfe6615f0971665f5619a6b3c7babcf74ddcd"
          : hasOfferIssuance
          ? "1f045417e17bf2db3be42eb29f956396e9a80f8ea84e73a670b5cac69776a105"
          : hasOfferRelease
            ? "b15662968b267b85e27785cc35690eb6f3979309a2fcceeae623878f844343f8"
          : hasOfferPdfDraft
            ? "5e8baef20cca95e206f8a2fa05a5ad8ed7f09576856e515d0b5be9c8fe4a4e26"
            : "c65365ec209f2fc279842f5a6a8b21edbae5b327a65b2e969749abb01c68e6be"}`,
      "guard_membership_dml():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
        "search_path=pg_catalog:89cb000d7bca739fe2bd23b737ffc5153b494f9f7eb80790dbeef4e6ab95a057",
      "guard_membership_statement():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
        "search_path=pg_catalog:b5d5db39513acce303c62d10a27f8b3bdc0b7ec12b183ae127e59b181dac89b7",
      "guard_offer_erasure_mutation():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
        "search_path=pg_catalog:db38dd23221bc75af85f494d9374e9eda3b7a2ce0d87f28dabd8e7c71be4c08f",
      ...(hasOfferPdfDraft ? [
        "guard_offer_pdf_draft_mutation():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
          "search_path=pg_catalog:cbb5173ec8e5c27bf927610795c7c9a2e2b5f2cd4824136e0a20d5288f79a19a",
      ] : []),
      "guard_project_calculation_job_mutation():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
        "search_path=pg_catalog:1e9df9a26cc63fd4c3964eee765b561ef7c54811709cbda7b6f2920631649c4e",
      "guard_project_calculation_revision():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
        "search_path=pg_catalog:9ae6f5da4bca2d394e687c50c7be25cc0ebaab763ebaefd9f11cf4d20644a07a",
      "guard_site_energy_profile_mutation():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
        "search_path=pg_catalog:02cefc1ea9fab360ae6dbe31a77095f20a2fd75025ba1e6b41508c32a00d8eab",
      "lock_project_calculation_finalization(uuid, uuid):uuid:app_owner:plpgsql:f:v:true:false:true:u:" +
        "search_path=pg_catalog:8946ebb3b0a89e846a67582608458897717ba76d26292b48e7d78077402a820c",
      "mark_catalog_component_projects_stale():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
        "search_path=pg_catalog:692ce6d2faf94fefeb5e6c4b574c350da93d9032d092ab5a6faf984b95e4ab68",
      "mark_project_catalog_resolution_stale():trigger:app_owner:plpgsql:f:v:true:false:false:u:" +
        "search_path=pg_catalog:7c6bd9b9f83040ae9d697aaa6b81012a7a9101d388f9ef1e107564410de1edd0",
      "provision_default_request_board():trigger:app_owner:plpgsql:f:v:true:false:false:u:" +
        "search_path=pg_catalog:c226d08f9a70eb36bd1eb7ef25e1afcc4fadae383cebef03bcc08b55de663138",
      "reconcile_user_identity(text, text):uuid:identity_reconciler:plpgsql:f:v:true:false:false:u:" +
        "search_path=public, pg_temp:ae576295ddea09162013c29d5828512764cecbe3c39bbcaa0cdd5d45307f2ac3",
      "replay_erasure_tombstone(uuid):uuid:app_owner:plpgsql:f:v:true:false:false:u:" +
        "search_path=pg_catalog:2f95087557c3c9c2fcd866e34aa210f969fb442c44c5b5a9ed4ca40106814ed9",
      "user_identity_link_auth_only():trigger:app_owner:plpgsql:f:v:false:false:false:u:-:" +
        "642035f502409bec26defa74b308e8825d613a5592ae23d228aaabd76115ccfb",
      "validate_offer_variant_snapshot_mirrors():trigger:app_owner:plpgsql:f:v:true:false:false:u:" +
        "search_path=pg_catalog:82345894ee28f1e69e539f84cbd17038a13df57943dc1e9af6f05c755c53c9d6",
      "validate_project_catalog_resolution_snapshot():trigger:app_owner:plpgsql:f:v:false:false:false:u:" +
        "search_path=pg_catalog:4d87e511af3484732de1bdb9717d1a818e3b6632880fc3bd35192b955e444ebb",
    ],
    "Live-Funktions-Sicherheitsvertrag",
  );

  const rlsContract = await client.query<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
    order by c.relname
  `);
  equalRows(
    rlsContract.rows.map((row) =>
      `${row.relname}:${row.relrowsecurity}:${row.relforcerowsecurity}`,
    ),
    [
      "audit_log:true:true",
      "auth_account:false:false",
      "auth_rate_limit:false:false",
      "auth_session:false:false",
      "auth_user:false:false",
      "auth_verification:false:false",
      "calculator_snapshot:true:true",
      ...(hasProjectAppointments ? ["calendar_category:true:true"] : []),
      "catalog_component:true:true",
      "catalog_component_revision:true:true",
      ...(hasCatalogImport ? CATALOG_IMPORT_RELATIONS.map(
        (relation) => `${relation}:true:true`,
      ) : []),
      "contact:true:true",
      "contact_legal_hold:true:true",
      ...(hasCustomerNotification ? CUSTOMER_NOTIFICATION_RELATIONS.map(
        (relation) => `${relation}:true:true`,
      ) : []),
      "domain_events:true:true",
      "erasure_operation_locator:false:false",
      "erasure_tombstone:true:true",
      "inbound_receipt:true:true",
      "kanban_board:true:true",
      "kanban_column:true:true",
      "membership:true:true",
      "offer:true:true",
      "offer_bom_line:true:true",
      ...(hasOfferIssuance ? OFFER_ISSUANCE_RELATIONS.map(
        (relation) => `${relation}:true:true`,
      ) : []),
      "offer_mutation_rate_window:true:true",
      "offer_number_series:true:true",
      ...(hasOfferPdfDraft ? ["offer_pdf_draft:true:true"] : []),
      ...(hasOfferRelease ? OFFER_RELEASE_RELATIONS.map(
        (relation) => `${relation}:true:true`,
      ) : []),
      "offer_variant:true:true",
      "offer_variant_revision:true:true",
      "offer_variant_section:true:true",
      "project:true:true",
      ...(hasProjectAppointments ? [
        "project_appointment:true:true",
        "project_appointment_attendee:true:true",
      ] : []),
      ...(hasProjectAssignment ? ["project_assignment:true:true"] : []),
      ...(hasProjectTasks ? PROJECT_TASK_RELATIONS.map(
        (relation) => `${relation}:true:true`,
      ) : []),
      ...(hasProjectOutcomes ? PROJECT_OUTCOME_RELATIONS.map(
        (relation) => `${relation}:true:true`,
      ) : []),
      ...(hasProjectNotes ? PROJECT_NOTE_RELATIONS.map(
        (relation) => `${relation}:true:true`,
      ) : []),
      "project_calculation_job:true:true",
      "project_calculation_revision:true:true",
      "project_catalog_resolution:true:true",
      "project_catalog_resolution_line:true:true",
      "project_requirement:true:true",
      ...(hasSignatures ? [
        "signature_attestation:true:true",
        "signature_request:true:true",
        `${SIGNATURE_LOCATOR_RELATION}:false:false`,
        "signature_view_log:true:true",
      ] : []),
      "site:true:true",
      "site_energy_profile:true:true",
      "user_identity:true:true",
      "workspace:true:true",
      ...(hasWorkspaceInvoicing ? [
        "workspace_document_number_format:true:true",
        "workspace_invoicing_settings:true:true",
      ] : []),
      ...(hasEconomicsSettings ? ECONOMICS_RELATIONS.map(
        (relation) => `${relation}:true:true`,
      ) : []),
      ...(hasLeadSources ? LEAD_SOURCE_RELATIONS.map(
        (relation) => `${relation}:true:true`,
      ) : []),
      ...(hasTimeTracking ? TIME_TRACKING_RELATIONS.map(
        (relation) => `${relation}:true:true`,
      ) : []),
      ...(hasChecklists ? CHECKLIST_RELATIONS.map(
        (relation) => `${relation}:true:true`,
      ) : []),
      ...(hasCalendars ? CALENDAR_RELATIONS.map(
        (relation) => `${relation}:true:true`,
      ) : []),
      ...(hasChecklistTemplates ? CHECKLIST_TEMPLATE_RELATIONS.map(
        (relation) => `${relation}:true:true`,
      ) : []),
      ...(hasCommercialDocuments ? COMMERCIAL_DOCUMENT_RELATIONS.map(
        (relation) => `${relation}:true:true`,
      ) : []),
    ],
    "Live-RLS/FORCE-Vertrag",
  );

  const policies = await client.query<{
    tablename: string;
    policyname: string;
    permissive: string;
    roles: string;
    cmd: string;
    qual: string;
    with_check: string;
  }>(`
    select tablename,
           policyname,
           permissive,
           roles::text,
           cmd,
           coalesce(qual, '-') as qual,
           coalesce(with_check, '-') as with_check
    from pg_catalog.pg_policies
    where schemaname = 'public'
    order by tablename, policyname
  `);
  equalRows(
    policies.rows.map((row) => {
      const value = [
        row.tablename,
        row.policyname,
        row.permissive,
        row.roles,
        row.cmd,
        row.qual,
        row.with_check,
      ].join("|");
      return `${row.tablename}:${row.policyname}:${sha256(value)}`;
    }),
    [
      "audit_log:tenant_isolation:23ff85358d0c0e94974353f538c267f99f5a3e7219bf9e1cd8769f69744ae417",
      "calculator_snapshot:tenant_isolation:8c816e39dfc3d5d774d0de6f02961882e9ae6679904da2b9007d5ff86becbb72",
      ...(hasProjectAppointments ? [
        "calendar_category:calendar_category_actor_select:944baa976bed1f1a4e20f9ee155478d1eefe7d1977c01e94405ae85ff8d0a31b",
        "calendar_category:tenant_isolation:de0baabe6e6d5890088d293469efb4736bc3531434b961187c90f2c7bda7c8c6",
      ] : []),
      "catalog_component:tenant_isolation:0f52f117c39d494bf05b96f6f8a38b776282a706c0765c9b1a88011be6fc7d9d",
      "catalog_component_revision:tenant_isolation:e2a00cf04ea7089b3abdfd9fc87f71b7d0b3460a0be58bdadbe0f23a61fd3758",
      ...(hasCatalogImport ? [
        "catalog_import_dispatch_receipt:tenant_isolation:3175a1e6d37824a28ffeba853f7f7ff4138e8b424adf5c3d1246623fd4a0643a",
        "catalog_import_job:tenant_isolation:237eac7b292ed88d95145d60479ab11474ba0998129cb064b11b904ccd7be974",
        "catalog_import_row:tenant_isolation:67142c1fd1fbdd23fd6ef9d6f64278ec7e354fd62369c7f662849e6feebfc392",
        "catalog_import_row_result:tenant_isolation:71585a8bbf22b1bd7ed674d7ab4b32b8db698bc34d05f55a1d2a1333a4577d77",
      ] : []),
      "contact:tenant_isolation:e339a6411d39679d749a45535df17ea42132453c4725e42f0d5b310379489e46",
      "contact_legal_hold:tenant_isolation:752e8f298e0a4cc77a31ee680540edf91831654263d7f0dd39bafc42b6d54477",
      ...(hasCustomerNotification ? [
        "customer_notification:tenant_isolation:be27711f3e58ccabc9897a4bca69e260a5f7d3dd060accdd4ecc8f77ad07fc27",
        "customer_notification_delivery_attempt:tenant_isolation:fa9a4eaa0c345815d9d88f1cde298f115aa31e061d59d76f6c9a1eab895533d8",
      ] : []),
      "domain_events:tenant_isolation:f1715696222caf43a2adc220b67b8aebdce61f5ef9659884af1c7263ccab8284",
      "erasure_tombstone:tenant_isolation:70b18b744913ed4f29de03a9d1f20ddbbcee7e89796d40bd650fc3c838e4b0df",
      "inbound_receipt:tenant_isolation:866b6644bba9899118c16bc502e420f0409e632a3cd6b709b3321f6c10c28c1c",
      "kanban_board:tenant_isolation:3fcf596a70932422900934bc4bb607edff72abb165949dcca9afcf372c67768b",
      "kanban_column:tenant_isolation:d11d4b31d67527780056ac587d49089fbd9e39568a0d2c15e55317d1d26ba507",
      "membership:membership_actor_delete:2b0f67a6a2931b84b4610114759e61a867d45e093a85ef8094cbdc2d81b14027",
      "membership:membership_actor_insert:f4f58cb0a649e8bf11dec66a6047da1ad5774ac03fe5acb808297937b3d5dbf6",
      "membership:membership_actor_update:9b7d643976dff08ea22d7a8db439ac1a36450de1a57c256c73035a5c37119902",
      "membership:membership_principal_delete:9e6e5d92622b8d255518733c4b1b8135a9bd99994dec0d73f723de6d963b84fe",
      "membership:membership_principal_insert:cdccab00a484775580d8b083aed280eb2cf90753f6697acae098e9cba54318fc",
      "membership:membership_principal_update:b2374f555501c25048e318fdaa54b7ef1d9b29a66694ef064e6e9ded271c75ca",
      "membership:tenant_isolation:1a5443560d407a656bdeaff6593819d601078d1ebdc58d4d1f8e02e829a587f3",
      "offer:tenant_isolation:82084d0508f20b6dc4e9caadc271b9c75cb472ea40cc76a9e09e6abc6834622e",
      "offer_bom_line:tenant_isolation:60c1c3bbe7810cc51e809426bac328b9fc397b6fcf46e7f55ddb7c9a93b04196",
      ...(hasOfferIssuance ? [
        "offer_issuance:tenant_isolation:46689a333c637b56621333cd538989d36216f397a3869c19738e210e4bf96816",
        "offer_issuance_approval:tenant_isolation:c21880779fda5d16ece58a7ec61314053b5afdd9dcbd927b354a5408f0a6a3a5",
        "offer_issuance_withdrawal:tenant_isolation:9f42d5a884fc1bbc418281b42be54b970cd411baf6ee0c522fc48388af1d3225",
      ] : []),
      "offer_mutation_rate_window:tenant_isolation:4a43a52466e80120f71fb6bc563459046f25148d4c45591d5f5dd581806fb985",
      "offer_number_series:tenant_isolation:3d3d44b85306e0c44c255e5f295a9d4c63c3f4302d8d43503717281c2084f885",
      ...(hasOfferPdfDraft ? [
        "offer_pdf_draft:tenant_isolation:8c45b9d1d607576979fa2581d9c7098d74b8bf317c5c23631e522b3b424fc2c8",
      ] : []),
      ...(hasOfferRelease ? [
        "offer_recipient:tenant_isolation:24ea357d85e375d6a0c1c25db1ca3d7b7f1fcdeff991aebe9095957fb33c508b",
        "offer_recipient_revision:tenant_isolation:384dd30f8cf7b5f61e32e804b8c8739c6dff45c64c4228d5b6e5bb39af5fcd5c",
        "offer_release_candidate:tenant_isolation:bc6806da26ac2665f3603df940eaad561bb6b459417c5b79090bea30e16fc7a1",
        "offer_release_candidate_approval:tenant_isolation:4486efcbcbcb504e625be7aba84ece6135b19728074be97cc9efda2ea77b2656",
        "offer_release_profile:tenant_isolation:e34c664faf840151476a26e0300a038026e6712fa049235622ae905bd925668c",
        "offer_release_profile_activation:tenant_isolation:76263ffd06dc1f508e3a5ec4e3e804cf6a4345692ddf2e6086308001cfd59294",
        "offer_release_profile_revision:tenant_isolation:750a1227a4e4a43cc508d9a35337d2e6d22d43152cfb69066a6bb4f019afacea",
      ] : []),
      "offer_variant:tenant_isolation:7680e41d5dec01e43a1499356bfd50ff62271af486afe8ee80cf13d3f7f0cb41",
      "offer_variant_revision:tenant_isolation:d0bf5b1f1871b07a4364b679486f63ad33dbae0259d94a22e090cfe7b1b6c148",
      "offer_variant_section:tenant_isolation:6cd95ab344fdff675ca080283bf4c0043d3121d14dcc19ce944e7c572becd84f",
      ...(hasProjectAssignment ? [
        "project:project_external_delete_guard:1f5a592a24eca964211cea91e9aec2e657161e4b39cd2fac29557cc86aeb7f93",
        "project:project_external_insert_guard:728f471851bf43960d33861512e1aa494fb66d2136d7faca0d7d6e0cfc5642c2",
        "project:project_external_select_scope:80731c3803b4e9ee2749fe865e1ee9a1f2d221a1bb1d12cce3632956f124b52e",
        "project:project_external_update_guard:0745da945e4fe5f92e7bc24e058eef1e2d7c07b6bacc4b27b92e5e52b3f23e35",
      ] : []),
      "project:tenant_isolation:c5f62af4cbba473885ce886d0eef10a80ab1f5dca746c0cb4b6204dd1050717b",
      ...(hasProjectAppointments ? [
        "project_appointment:project_appointment_actor_delete:a836eac80bd999359f776b0c85751c5d08b22d98cc6ce7007a24fabe16454645",
        "project_appointment:project_appointment_actor_insert:8d6b0f998e0ec34e79158ff950e72c099c4a653a745e83303c6396b025994cdf",
        "project_appointment:project_appointment_actor_select:777eec775dfee475f7cd880229bfc6450073d2949b0eb9a48a02e1d04b51cde0",
        "project_appointment:project_appointment_actor_update:6ecdd4899188a2c5327b2ece1c4691ce59700f7ee7863009315dc537d1eb36e3",
        "project_appointment:tenant_isolation:95839d10d0234f6b2ad472c52373f41f7a88dd14512e5b48e97b6638e1c724b3",
        "project_appointment_attendee:project_appointment_attendee_actor_delete:11682a9736f819872cc4f0976a0d61faf092c253e88b7c19d0a1ca2714c9c608",
        "project_appointment_attendee:project_appointment_attendee_actor_insert:db7a0526905f7d1fe8cf7a7384dc85aae970e48438792dcf033d83a334501db5",
        "project_appointment_attendee:project_appointment_attendee_actor_select:0634803bc8e565a5982b923e3832f7e68141faec8493caa8cb7890eca49c0177",
        "project_appointment_attendee:tenant_isolation:eb5b7292fdf443f6440e7fa03bb9012f0fbbf58ff42ee87714266310a154a85f",
      ] : []),
      ...(hasProjectAssignment ? [
        "project_assignment:project_assignment_actor_delete_guard:a9afa7bb8b30ec16564abdc50e9e98de6e65e399a7cbcbb9cd9d945782de29c7",
        "project_assignment:project_assignment_actor_insert_guard:5e1ce3e84ff33e76a7e584067add6ba82831fb8f551c8688ba76f18d8f413574",
        "project_assignment:project_assignment_actor_select:0323acfe157c9f0ed0e1a51872ad1045ce1ae4207e4494908804fc5554eee361",
        "project_assignment:project_assignment_actor_update_guard:1d87f004a251aef6bbd7abf10ed20ca9ff93700374685cff170eb75a2d2ac3a5",
        "project_assignment:tenant_isolation:42a4f48d761c22abfe96ad7c526f440895bef20615e73fc62cd0f9644db7729f",
      ] : []),
      ...(hasProjectTasks ? [
        "project_task:project_task_actor_delete:05964e9f29a633594feb74590901d9ede21a307d22c98633e1469cdbb98e3ce0",
        "project_task:project_task_actor_insert:43beb600de52d809287947447a70da0a9d9bb5ae0260b63c9136e3f9742eb1ac",
        "project_task:project_task_actor_select:56ff94ce6e92f995bf1d71ffbac9ec0dd81b98896fdfda3f8beffcd5bd0cd561",
        "project_task:project_task_actor_update:b272545f1875bc9ce4f368cba24dd9b07b57fedc6d43083759ec7921c6f5f88f",
        "project_task:tenant_isolation:943f231508e1c930524a5b56c7fa1fe19c7f4bc871e25358a1487926d815a1e9",
        "project_task_assignee:project_task_assignee_actor_delete:67f759088faec85b4b9285a2578a8350db05144faec496498a638b810ddc2787",
        "project_task_assignee:project_task_assignee_actor_insert:2eba5538276054de7a6311df1bb85cef63831925f8fabeb57dcd95a44e79da74",
        "project_task_assignee:project_task_assignee_actor_select:1eb1c0d33f80473e1259a598321ebce956e1b00a238a24f1bc149822d0c21d69",
        "project_task_assignee:project_task_assignee_actor_update:74c0b69f3dee0e99a860425389c1a250f5c1c8bc6f696f202b68260d7055637d",
        "project_task_assignee:tenant_isolation:f542d8e7b7d66cb06347e3eb8ee786e2cdace39c02b806af8d5081826b51ae38",
        "project_task_checklist_item:project_task_checklist_item_actor_delete:6a4ab360afa58e832210571078a838104ff6ecb409cef740e76f8b0f086ad21a",
        "project_task_checklist_item:project_task_checklist_item_actor_insert:79194e2b1a600359f2def75a7d445e6f3d7582281e8b873425dd03f0284af5fc",
        "project_task_checklist_item:project_task_checklist_item_actor_select:4c880d3e4e97060cf9e55f322b02ee7291e304aaa091269078bf1b9deb6bb3ac",
        "project_task_checklist_item:project_task_checklist_item_actor_update:72e352a43987ef63f10e9e434a1be66b076b7465f0a660b5f5def1403db62ca5",
        "project_task_checklist_item:tenant_isolation:ebf621fe86de3a4fe19a29afe1de4cf773112295c949fbc993314f63adbaa48a",
        "project_task_label:project_task_label_actor_delete:a4424de72ab591ffa335d4ca86899be134e1167e88118d4cb9eae774219a0f5e",
        "project_task_label:project_task_label_actor_insert:de4f0d2d097e09a46295e42e4d3cf3cd6bba8a5f64ba50c5873424f46950b8d4",
        "project_task_label:project_task_label_actor_select:62363ee84261021573e824a94b9a730586cfb9b9d197950e838b750c9f8be5dd",
        "project_task_label:project_task_label_actor_update:1b0efd2722df968ae3f430fbd2eb25123a26f97ae6a478a6507e5cd43b84f699",
        "project_task_label:tenant_isolation:2e89081414c7ac7dbbd754458bf8b931b0658f11bdae1ad810c1ed8cd723f962",
      ] : []),
      ...(hasProjectOutcomes ? [
        "project_loss_reason:project_loss_reason_actor_delete:" +
          "f712efba8e38b48ad7dfe33921c5b47a93e396cfec9e68e1d7bd13c79345753f",
        "project_loss_reason:project_loss_reason_actor_insert:" +
          "f5fd05e0f2bb77bdd91b08778bee10376c098b9cc757e7def3453377067dcc2e",
        "project_loss_reason:project_loss_reason_actor_select:" +
          "301cb23eefa067694aa48d3020af7b824ca0b2f09afd1cb9a904b93ec6787f89",
        "project_loss_reason:project_loss_reason_actor_update:" +
          "9df6abebd6999c5e510ce351621f19af78db527c17faaea6820fb28affaa608a",
        "project_loss_reason:tenant_isolation:" +
          "13519652442642e4c8536a8e4f75d98f94ad536c312a95798fbc61471025d7f4",
      ] : []),
      ...(hasProjectNotes ? [
        "project_note:project_note_actor_delete:" +
          "b4d81852cc35d7211bc3d2e4a422f357dad3fdc9a6a066ec4d353785b4b4df10",
        "project_note:project_note_actor_insert:" +
          "ce4c2d74612ee904abd0507cb073414167386ff8ff681780af6f39c29802cd8c",
        "project_note:project_note_actor_select:" +
          "42e477fcef92ccad9641b1a0a685397429f06d95046819dfb0ac2300949549a7",
        "project_note:project_note_actor_update:" +
          "596d2f037a747407acec1a511dd06d76173e821dc084a70be41836f6f8fd0523",
        "project_note:tenant_isolation:" +
          "4b78e950322a127404b38299187851b8afc1499a93cb3fbbb7c6089169604b79",
      ] : []),
      "project_calculation_job:tenant_isolation:46c9a1a09bfdfc88ddf839242f17c560ea614e34d1961a341580c40b4cdabf84",
      "project_calculation_revision:tenant_isolation:84bebd69ee64a8388f406f44da215b86328497c5235e70628a8df0e8c1b56a9d",
      "project_catalog_resolution:tenant_isolation:28a50950efb5f725b0db20a0d82671d5a03a0ec9aa20e93775bd3e88c625a46f",
      "project_catalog_resolution_line:tenant_isolation:e86df4a2dda17e6eea6b929c96636cd1543396e661cdea87df4731ac043e05e2",
      "project_requirement:tenant_isolation:4c2d81a0ad4ae0aa71972c72dc7f7cd57028a0ba50e01420106b350f724de0cb",
      ...(hasSignatures ? [
        "signature_attestation:signature_attestation_actor_delete:" +
          "cb9ed75cf80c1de9be9b3caa4c77a8750c5e80bc501a1595cc7b37ffe2abfc11",
        "signature_attestation:signature_attestation_actor_insert:" +
          "62a769b7cc4b9a4ad20dee2d83d4c344b5429b651e24d3dae433843dda086086",
        "signature_attestation:signature_attestation_actor_select:" +
          "0c24b1409f159c7e92485acc2a16ad6d1b44eaaef093f83025c2d1b4878bb5b4",
        "signature_attestation:tenant_isolation:" +
          "6e7e5e3c95669c907a8e1202de3f84b40d903a79be17df034630b861b8d03cd3",
        "signature_request:signature_request_actor_delete:" +
          "c997b838f47da31f1bfee9bf8d36fc2026bf92f1d853772b8a4fd815f5a48146",
        "signature_request:signature_request_actor_insert:" +
          "fc49e2b5334e260f1004d0c98b451c1feec794ec2793c0f3b01b39e7de19850e",
        "signature_request:signature_request_actor_select:" +
          "9191e047bd8f82c90a93eece11819340b2de0885746d0c09f52e5ee0a6c7cb3a",
        "signature_request:signature_request_actor_update:" +
          "353256787cf83a495ce86d400e9c051189f3fc23c039a3e5c778172b746e1494",
        "signature_request:tenant_isolation:" +
          "7f3e9a0e85069da865842958b0effe85cf35a4adf41da5565a6a68f8ed1119ee",
        "signature_view_log:signature_view_log_actor_delete:" +
          "e26246c5c96ef5e2254c90bb5f4b69beb9aa572601a0f6aab0b8e3b2601b36ee",
        "signature_view_log:signature_view_log_actor_insert:" +
          "0e03c04dae8b560e70f131ce3fc60a48dd881868e5761b4967ac586004b7d595",
        "signature_view_log:signature_view_log_actor_select:" +
          "8f07af921978700fd06399a86363d59783b474192c7e0b9f34f60d04a818b987",
        "signature_view_log:tenant_isolation:" +
          "906376b21c7d7f24c82a966863a10c6679a6553aec1e8d7238ad03ee6e3e9567",
      ] : []),
      "site:tenant_isolation:26181215437698e628cbd47ab08562d51de16bb0172d907c36c75a679a555d3c",
      "site_energy_profile:tenant_isolation:dedfd647c982a06a434aa37f05bbba136aa817eaf84b76a2c360c709e229e609",
      "user_identity:user_identity_insert:ed42cd7d7ab49b586488c84e375edbd0c5679444866111bc9547a6a309424131",
      "user_identity:user_identity_reconcile_select:fa1b9f29b8bb9a694dc41a78d8ad73dc829d2715ff8e8c91c6357f9475b240bd",
      "user_identity:user_identity_reconcile_update:3763319bbd0208f0554077338d247e797d6122f9c56182072e2f3735b65eecd0",
      "user_identity:user_identity_select:824f30ce2ed4729f0ec66928efba45844aef4f048580c636bfd0c260d76bc9f6",
      "workspace:tenant_isolation:efde4221654b51f3f1df5df99ffe938484bd185d6d9057c808d0b2682d7be38f",
      ...(hasCommercialDocuments ? [
        "commercial_document_group:tenant_isolation:" +
          "64aa7c644af44eca10c6e35ba00a58811631bbe8aed95f98cb7eba72ba74cd2e",
        "commercial_document_group:commercial_document_group_actor_select:" +
          "594e186ee11db34804cded2953b270b32278b361bbc91be53a473c052f0c945e",
        "commercial_document_group:commercial_document_group_actor_insert:" +
          "9189bf350c759ca4459361be201fc5cf10eec9a78a5ca60a186fb62eeab61347",
        "commercial_document_group:commercial_document_group_actor_update:" +
          "4be91a2d8049be5492dfee44bae7dbc46bca14df31d93ce1fc7e06339dae98b1",
        "commercial_document_group:commercial_document_group_actor_delete:" +
          "9bb78df5753d4b1d4d1be7dc68c3ca93f27358ae76cf507c022b358ddade578c",
        "commercial_document_number_series:tenant_isolation:" +
          "a8ee73a48c80642e6fd9baaf56ff33d1dc71419168b3d916cb4ae2ce3ba60f3d",
        "commercial_document_number_series:commercial_document_number_series_actor_select:" +
          "671da2bbbd9d45e5dd646c79df5313eb8bdaccaf0b9b3b4022126662df6a9818",
        "commercial_document_number_series:commercial_document_number_series_actor_insert:" +
          "7ba31cc2cbe6152cebd9725d51e4606c7c0fb8d3adc6cb14ef38cd6e79053927",
        "commercial_document_number_series:commercial_document_number_series_actor_update:" +
          "70113b97d0bf353c6f9554263dad64d2ba25347e5e37207a13e96dac374c7cce",
        "commercial_document_number_series:commercial_document_number_series_actor_delete:" +
          "c5a93b8eb938019870e53eac2a176bbbd62174f7c0d760a8b2480a1e69d3b2fa",
        "commercial_document:tenant_isolation:" +
          "3ef22b98b16e02afc38c5a4adf836d017f49b03be72455ce9ab67c5e9332382a",
        "commercial_document:commercial_document_actor_select:" +
          "ab81e68ab2b69cb6c6e41e0f0f78ed7154fb4929c984869814a9bbf650870bff",
        "commercial_document:commercial_document_actor_insert:" +
          "98213183157108bdafd7b9d972071e36f64fc9d7bfbe8a3bd686be302bc49eee",
        "commercial_document:commercial_document_actor_update:" +
          "bcc7d81aa91fe4bc19c4d12363f543b4f1200fe89f5942493adaf2edb72a8e9f",
        "commercial_document:commercial_document_actor_delete:" +
          "15b75560c2530b17b75a665ebcf2c8fdc8beca0fed96e5895ff2b2841d654f76",
        "commercial_document_line:tenant_isolation:" +
          "83792d4e90fffea91dfbb544506f1bf8ad113122043140f9d0e01ebc658cb839",
        "commercial_document_line:commercial_document_line_actor_select:" +
          "b856e932120e4bd21b9349c7aade14e9d908b1f6cf4d566b472308c502adf5c6",
        "commercial_document_line:commercial_document_line_actor_insert:" +
          "44cc6d030562e5f95cb633bc4b99d0b1a403ed5c28fa780606eefe0c93a0f88c",
        "commercial_document_line:commercial_document_line_actor_update:" +
          "bc2952cca8739e571d7a37f09a8976411247c65a460e74b90830de7d6fd46176",
        "commercial_document_line:commercial_document_line_actor_delete:" +
          "900aaadff384ed863a72e8386bafa2f428d4d4e35a251009386b63834e274c7a",
      ] : []),
      ...(hasWorkspaceInvoicing ? [
        "workspace_document_number_format:tenant_isolation:6ba5999f7354596580df93d3463b8bd635c37085bfe034e0881641f6954c7c22",
        "workspace_document_number_format:workspace_document_number_format_actor_delete:c0ea21f9cd1ace066369e22a157ae56eb9ad95afb16498c35aeef08e294f73bf",
        "workspace_document_number_format:workspace_document_number_format_actor_insert:aae876738c2565e2a639f834d45047411ebae85a55d1a483ce86195973109e0e",
        "workspace_document_number_format:workspace_document_number_format_actor_select:5f3d986ad63aa4eaff6ce604591f03bb29693a2cce97ea98c5110bd94b3d4449",
        "workspace_document_number_format:workspace_document_number_format_actor_update:32a94850ca7282bcb98ba18498eeaf0e57e2a92c2a63d2925e2c840ff7e4ee3b",
        "workspace_invoicing_settings:tenant_isolation:96b32506c586669df5208b339830cf49c38c599ea7c4ae58645abcf4cec56249",
        "workspace_invoicing_settings:workspace_invoicing_settings_actor_delete:8a4783f458842d4cd320e4d60c9a893261d70d67c1eceac7441432e7b960b503",
        "workspace_invoicing_settings:workspace_invoicing_settings_actor_insert:b96bb9c40c4e70a358f820c29855e5f4fe762455108ddecbcabd1f52f9eae245",
        "workspace_invoicing_settings:workspace_invoicing_settings_actor_select:c6e745795ecdeb6e9401f3c80b368ca216eb02c43abeaa3c2e83d6ea1d914b8c",
        "workspace_invoicing_settings:workspace_invoicing_settings_actor_update:30bcb5b3762e5713b51a0d054baf9356ea71fde6950fcac9351174c82fc6c215",
        ...(hasEconomicsSettings ? [
          "workspace_economics_settings:tenant_isolation:532da64d43858e29a4972a499dcd4673c65fa376b13acdf0cb36c71be935aab8",
          "workspace_economics_settings:workspace_economics_settings_actor_delete:8ba0561af0a03be9f1f121c375770c57f66abcebddbe7207460e4dbcae1cb50b",
          "workspace_economics_settings:workspace_economics_settings_actor_insert:60f5e6821d3b9748afaf213f6b2e3da5fe095d0e2733273035d84757ee791fdd",
          "workspace_economics_settings:workspace_economics_settings_actor_select:974b3da5aa92a3c7b91b55791ed65b9ff26274846fe8be10b1cb6b1ecb885dee",
          "workspace_economics_settings:workspace_economics_settings_actor_update:3df901b67e8ad033d4d1edd4922dda5c1530464fcfba5410ca739d6eff9d1a4e",
        ] : []),
        ...(hasLeadSources ? [
          "lead_source:tenant_isolation:a9f87b293bf7af190aa1baee3f1ca08c3198ed6accbd6fe1e10482f82817a450",
        ] : []),
        ...(hasTimeTracking ? [
          "time_event_type:tenant_isolation:3e74ed81c41e7311f7725bcc268f1408148780cb500d798998bd9e3c873e45c3",
          "time_entry:tenant_isolation:c3d1d966d152a34ed5e59bafe19e807ee4c780b8994e67054e18ea93209c2bb2",
        ] : []),
        ...(hasChecklists ? [
          "project_checklist:tenant_isolation:711797a558f37e71658c8adc89f6e18dd7355c16581b4c06ab61baffb68b522d",
        ] : []),
        ...(hasCalendars ? [
          "calendar:tenant_isolation:57296ca13f33ffe335cd1cde9f96a0024470521481da054313e6843d9ca6ce25",
        ] : []),
        ...(hasChecklistTemplates ? [
          "checklist_template:tenant_isolation:9d1b4ac837189569dedc6d9b4ab8161b3f2952860e0fb3c9fccacc83d0e7606f",
        ] : []),
      ] : []),
    ],
    "Live-Policyvertrag",
  );

  const triggers = await client.query<{
    relname: string;
    tgname: string;
    tgtype: number;
    tgenabled: string;
    function_schema: string;
    proname: string;
    args: string;
    when_expression: string;
    tgconstraint: string;
  }>(`
    select relation.relname,
           trigger.tgname,
           trigger.tgtype,
           trigger.tgenabled,
           function_schema.nspname as function_schema,
           function.proname,
           pg_catalog.encode(trigger.tgargs, 'hex') as args,
           case
             when trigger.tgqual is null then '-'
             -- pg_get_expr(tgqual, tgrelid) kann OLD/NEW nicht gemeinsam
             -- deparsen (22023). pg_get_triggerdef ist fuer Trigger-WHEN
             -- kanonisch und der Anker entfernt nur die aeussere DDL-Huelle.
             else pg_catalog.regexp_replace(
               pg_catalog.pg_get_triggerdef(trigger.oid, false),
               '^.* WHEN \\((.*)\\) EXECUTE FUNCTION .*$',
               '\\1'
             )
           end as when_expression,
           trigger.tgconstraint::text
    from pg_catalog.pg_trigger trigger
    join pg_catalog.pg_class relation on relation.oid = trigger.tgrelid
    join pg_catalog.pg_namespace relation_schema on relation_schema.oid = relation.relnamespace
    join pg_catalog.pg_proc function on function.oid = trigger.tgfoid
    join pg_catalog.pg_namespace function_schema on function_schema.oid = function.pronamespace
    where relation_schema.nspname = 'public'
      and not trigger.tgisinternal
    order by relation.relname, trigger.tgname
  `);
  equalRows(
    triggers.rows.map((row) => [
      row.relname,
      row.tgname,
      String(row.tgtype),
      row.tgenabled,
      row.function_schema,
      row.proname,
      row.args,
      row.when_expression,
      row.tgconstraint === "0" ? "0" : "constraint",
    ].join(":")),
    [
      "audit_log:audit_log_append_only:27:O:public:forbid_mutation::-:0",
      "audit_log:audit_log_no_truncate:34:O:public:forbid_mutation::-:0",
      ...(hasProjectOutcomes ? [
        "audit_log:audit_log_project_outcome_insert_guard:7:O:public:" +
          "_m111b_guard_outcome_evidence_insert::-:0",
      ] : []),
      "catalog_component:catalog_component_mutation_guard:27:O:public:guard_catalog_component_mutation::-:0",
      "catalog_component:catalog_component_no_truncate:34:O:public:forbid_mutation::-:0",
      "catalog_component:catalog_component_projects_stale:17:O:public:mark_catalog_component_projects_stale::-:0",
      "catalog_component_revision:catalog_component_revision_apply:5:O:public:apply_catalog_component_revision::-:0",
      "catalog_component_revision:catalog_component_revision_immutable:31:O:public:guard_catalog_component_revision::-:0",
      "catalog_component_revision:catalog_component_revision_no_truncate:34:O:public:forbid_mutation::-:0",
      ...(hasCatalogImport ? [
        "catalog_import_dispatch_receipt:catalog_import_dispatch_receipt_immutable:27:O:public:forbid_mutation::-:0",
        "catalog_import_dispatch_receipt:catalog_import_dispatch_receipt_no_truncate:34:O:public:forbid_mutation::-:0",
        "catalog_import_dispatch_receipt:catalog_import_dispatch_receipt_validate_input:7:O:public:_m108b_validate_catalog_import_dispatch_receipt::-:0",
        "catalog_import_job:catalog_import_job_guard:27:O:public:_m108b_guard_catalog_import_job::-:0",
        "catalog_import_job:catalog_import_job_no_truncate:34:O:public:forbid_mutation::-:0",
        "catalog_import_job:catalog_import_job_redaction_complete:21:O:public:_m108b_validate_catalog_import_redaction::-:constraint",
        "catalog_import_job:catalog_import_job_validate_input:7:O:public:_m108b_validate_catalog_import_job_input::-:0",
        "catalog_import_row:catalog_import_row_derive_payload:23:O:public:_m108b_derive_catalog_import_row_payload::-:0",
        "catalog_import_row:catalog_import_row_guard:27:O:public:_m108b_guard_catalog_import_row::-:0",
        "catalog_import_row:catalog_import_row_no_truncate:34:O:public:forbid_mutation::-:0",
        "catalog_import_row:catalog_import_row_redaction_complete:21:O:public:_m108b_validate_catalog_import_redaction::-:constraint",
        "catalog_import_row:catalog_import_row_validate_input:7:O:public:_m108b_validate_catalog_import_row_input::-:0",
        "catalog_import_row_result:catalog_import_row_result_immutable:27:O:public:forbid_mutation::-:0",
        "catalog_import_row_result:catalog_import_row_result_no_truncate:34:O:public:forbid_mutation::-:0",
        "catalog_import_row_result:catalog_import_row_result_validate_input:7:O:public:_m108b_validate_catalog_import_result_input::-:0",
      ] : []),
      "domain_events:domain_events_append_only:27:O:public:forbid_mutation::-:0",
      "domain_events:domain_events_no_truncate:34:O:public:forbid_mutation::-:0",
      ...(hasProjectOutcomes ? [
        "domain_events:domain_events_project_outcome_insert_guard:7:O:public:" +
          "_m111b_guard_outcome_evidence_insert::-:0",
      ] : []),
      "erasure_operation_locator:erasure_operation_locator_append_only:27:O:" +
        "public:guard_erasure_tombstone_worm::-:0",
      "erasure_operation_locator:erasure_operation_locator_no_truncate:34:O:" +
        "public:guard_erasure_tombstone_worm::-:0",
      "erasure_tombstone:erasure_tombstone_append_only:31:O:" +
        "public:guard_erasure_tombstone_worm::-:0",
      "erasure_tombstone:erasure_tombstone_no_truncate:34:O:" +
        "public:guard_erasure_tombstone_worm::-:0",
      "membership:membership_dml_guard:31:O:public:guard_membership_dml::-:0",
      "membership:membership_dml_serialize:30:O:public:guard_membership_statement::-:0",
      "offer_bom_line:offer_bom_line_complete:5:O:public:" +
        "validate_offer_variant_snapshot_mirrors::-:constraint",
      "offer_bom_line:offer_bom_line_immutable:27:O:public:guard_offer_erasure_mutation::-:0",
      "offer_bom_line:offer_bom_line_no_truncate:34:O:public:forbid_mutation::-:0",
      "offer:offer_immutable:27:O:public:guard_offer_erasure_mutation::-:0",
      "offer_mutation_rate_window:offer_mutation_rate_window_update_guard:19:O:" +
        "public:guard_offer_erasure_mutation::-:0",
      "offer_mutation_rate_window:offer_mutation_rate_window_no_truncate:34:O:" +
        "public:forbid_mutation::-:0",
      "offer_number_series:offer_number_series_mutation_guard:27:O:public:" +
        "guard_offer_erasure_mutation::-:0",
      "offer_number_series:offer_number_series_no_truncate:34:O:public:forbid_mutation::-:0",
      ...(hasOfferPdfDraft ? [
        "offer_pdf_draft:offer_pdf_draft_input_derive:7:O:public:" +
          "derive_offer_pdf_draft_input::-:0",
        "offer_pdf_draft:offer_pdf_draft_mutation_guard:27:O:public:" +
          "guard_offer_pdf_draft_mutation::-:0",
        "offer_pdf_draft:offer_pdf_draft_no_truncate:34:O:public:forbid_mutation::-:0",
      ] : []),
      ...(hasOfferRelease ? [
        "offer_recipient:offer_recipient_mutation_guard:27:O:public:" +
          "_m203a_guard_offer_recipient_head::-:0",
        "offer_recipient:offer_recipient_no_truncate:34:O:public:forbid_mutation::-:0",
        "offer_recipient_revision:offer_recipient_revision_immutable:27:O:public:" +
          "_m203a_guard_offer_release_append_only::-:0",
        "offer_recipient_revision:offer_recipient_revision_no_truncate:34:O:public:" +
          "forbid_mutation::-:0",
        "offer_release_candidate:offer_release_candidate_mutation_guard:27:O:public:" +
          "_m203a_guard_offer_release_candidate::-:0",
        "offer_release_candidate:offer_release_candidate_no_truncate:34:O:public:" +
          "forbid_mutation::-:0",
        "offer_release_candidate_approval:offer_release_candidate_approval_immutable:27:O:" +
          "public:_m203a_guard_offer_release_append_only::-:0",
        "offer_release_candidate_approval:offer_release_candidate_approval_no_truncate:34:O:" +
          "public:forbid_mutation::-:0",
        "offer_release_profile:offer_release_profile_mutation_guard:27:O:public:" +
          "_m203a_guard_offer_release_profile_head::-:0",
        "offer_release_profile:offer_release_profile_no_truncate:34:O:public:" +
          "forbid_mutation::-:0",
        "offer_release_profile_activation:offer_release_profile_activation_immutable:27:O:" +
          "public:_m203a_guard_offer_release_append_only::-:0",
        "offer_release_profile_activation:offer_release_profile_activation_no_truncate:34:O:" +
          "public:forbid_mutation::-:0",
        "offer_release_profile_revision:offer_release_profile_revision_immutable:27:O:" +
          "public:_m203a_guard_offer_release_append_only::-:0",
        "offer_release_profile_revision:offer_release_profile_revision_no_truncate:34:O:" +
          "public:forbid_mutation::-:0",
      ] : []),
      ...(hasOfferIssuance ? [
        "offer_issuance:offer_issuance_mutation_guard:31:O:public:" +
          "_m203b1_guard_offer_issuance::-:0",
        "offer_issuance:offer_issuance_no_truncate:34:O:public:forbid_mutation::-:0",
        "offer_issuance_approval:offer_issuance_approval_mutation_guard:31:O:public:" +
          "_m203b1_guard_offer_issuance_approval::-:0",
        "offer_issuance_approval:offer_issuance_approval_no_truncate:34:O:public:" +
          "forbid_mutation::-:0",
        "offer_issuance_withdrawal:offer_issuance_withdrawal_mutation_guard:31:O:public:" +
          "_m203b1_guard_offer_issuance_append_only::-:0",
        "offer_issuance_withdrawal:offer_issuance_withdrawal_no_truncate:34:O:public:" +
          "forbid_mutation::-:0",
      ] : []),
      ...(hasProjectTasks ? [
        "project_task:project_task_mutation_guard:31:O:public:_m110_guard_project_task::-:0",
        "project_task:project_task_no_truncate:34:O:public:forbid_mutation::-:0",
        "project_task_assignee:project_task_assignee_mutation_guard:31:O:public:" +
          "_m110_guard_project_task_child::-:0",
        "project_task_assignee:project_task_assignee_no_truncate:34:O:public:" +
          "forbid_mutation::-:0",
        "project_task_checklist_item:project_task_checklist_mutation_guard:31:O:public:" +
          "_m110_guard_project_task_child::-:0",
        "project_task_checklist_item:project_task_checklist_no_truncate:34:O:public:" +
          "forbid_mutation::-:0",
        "project_task_checklist_item:project_task_checklist_positions_guard:29:O:public:" +
          "_m110_guard_project_task_positions::-:constraint",
        "project_task_label:project_task_label_mutation_guard:31:O:public:" +
          "_m110_guard_project_task_child::-:0",
        "project_task_label:project_task_label_no_truncate:34:O:public:forbid_mutation::-:0",
        "project_task_label:project_task_label_positions_guard:29:O:public:" +
          "_m110_guard_project_task_positions::-:constraint",
      ] : []),
      ...(hasProjectOutcomes ? [
        "project:project_outcome_evidence:17:O:public:_m111b_record_project_outcome::" +
          "(old.outcome IS DISTINCT FROM new.outcome):0",
        "project:project_outcome_insert_guard:7:O:public:_m111b_guard_project_outcome::-:0",
        "project:project_outcome_mutation_guard:19:O:public:_m111b_guard_project_outcome::" +
          "((old.outcome IS DISTINCT FROM new.outcome) OR " +
          "(old.outcome_revision IS DISTINCT FROM new.outcome_revision) OR " +
          "(old.closed_at IS DISTINCT FROM new.closed_at) OR " +
          "(old.loss_reason_id IS DISTINCT FROM new.loss_reason_id) OR " +
          "(old.loss_reason_text IS DISTINCT FROM new.loss_reason_text)):0",
        "project_loss_reason:project_loss_reason_mutation_guard:31:O:public:" +
          "_m111a_guard_loss_reason::-:0",
        "project_loss_reason:project_loss_reason_no_truncate:34:O:public:" +
          "forbid_mutation::-:0",
      ] : []),
      ...(hasCustomerNotification ? [
        "customer_notification:customer_notification_mutation_guard:31:O:public:" +
          "_m111b_guard_customer_notification::-:0",
        "customer_notification:customer_notification_no_truncate:34:O:public:" +
          "forbid_mutation::-:0",
        "customer_notification_delivery_attempt:customer_notification_delivery_attempt_mutation_guard:31:O:public:" +
          "_m111b_guard_delivery_attempt::-:0",
        "customer_notification_delivery_attempt:customer_notification_delivery_attempt_no_truncate:34:O:public:" +
          "forbid_mutation::-:0",
        "offer_release_candidate:offer_release_candidate_cannot_fulfil_freeze:7:O:public:" +
          "_m111b_guard_offer_freeze::-:0",
        "offer_release_candidate_approval:offer_release_candidate_approval_cannot_fulfil_freeze:7:O:public:" +
          "_m111b_guard_offer_freeze::-:0",
        "offer_issuance:offer_issuance_cannot_fulfil_freeze:7:O:public:" +
          "_m111b_guard_offer_freeze::-:0",
        "offer_issuance_approval:offer_issuance_approval_cannot_fulfil_freeze:7:O:public:" +
          "_m111b_guard_offer_freeze::-:0",
      ] : []),
      ...(hasProjectNotes ? [
        "project_note:project_note_mutation_guard:31:O:public:_m113_guard_project_note::-:0",
        "project_note:project_note_no_truncate:34:O:public:forbid_mutation::-:0",
      ] : []),
      ...(hasProjectAppointments ? [
        "calendar_category:calendar_category_no_truncate:34:O:public:forbid_mutation::-:0",
        "project_appointment:project_appointment_mutation_guard:31:O:public:_m115_guard_project_appointment::-:0",
        "project_appointment:project_appointment_no_truncate:34:O:public:forbid_mutation::-:0",
        "project_appointment_attendee:project_appointment_attendee_mutation_guard:31:O:public:_m115_guard_project_appointment_attendee::-:0",
        "project_appointment_attendee:project_appointment_attendee_no_truncate:34:O:public:forbid_mutation::-:0",
      ] : []),
      "offer_variant:offer_variant_current_complete:21:O:public:" +
        "validate_offer_variant_snapshot_mirrors::-:constraint",
      "offer_variant:offer_variant_mutation_guard:27:O:public:guard_offer_erasure_mutation::-:0",
      "offer_variant_revision:offer_variant_revision_complete:5:O:public:" +
        "validate_offer_variant_snapshot_mirrors::-:constraint",
      "offer_variant_revision:offer_variant_revision_immutable:27:O:public:guard_offer_erasure_mutation::-:0",
      "offer_variant_revision:offer_variant_revision_no_truncate:34:O:public:forbid_mutation::-:0",
      "offer_variant_section:offer_variant_section_complete:5:O:public:" +
        "validate_offer_variant_snapshot_mirrors::-:constraint",
      "offer_variant_section:offer_variant_section_immutable:27:O:public:guard_offer_erasure_mutation::-:0",
      "offer_variant_section:offer_variant_section_no_truncate:34:O:public:forbid_mutation::-:0",
      "project_calculation_job:project_calculation_job_mutation_guard:27:O:public:guard_project_calculation_job_mutation::-:0",
      "project_calculation_job:project_calculation_job_no_truncate:34:O:public:forbid_mutation::-:0",
      "project_calculation_revision:project_calculation_revision_immutable:31:O:public:guard_project_calculation_revision::-:0",
      "project_calculation_revision:project_calculation_revision_no_truncate:34:O:public:forbid_mutation::-:0",
      "project_calculation_revision:project_calculation_revision_catalog_stale:5:O:public:mark_project_catalog_resolution_stale::-:0",
      "project_catalog_resolution:project_catalog_resolution_complete:5:O:public:validate_project_catalog_resolution_snapshot::-:constraint",
      "project_catalog_resolution:project_catalog_resolution_immutable:19:O:public:forbid_mutation::-:0",
      "project_catalog_resolution:project_catalog_resolution_no_truncate:34:O:public:forbid_mutation::-:0",
      "project_catalog_resolution_line:project_catalog_resolution_line_complete:5:O:public:validate_project_catalog_resolution_snapshot::-:constraint",
      "project_catalog_resolution_line:project_catalog_resolution_line_immutable:19:O:public:forbid_mutation::-:0",
      "project_catalog_resolution_line:project_catalog_resolution_line_no_truncate:34:O:public:forbid_mutation::-:0",
      "project_requirement:project_requirement_catalog_stale:5:O:public:mark_project_catalog_resolution_stale::-:0",
      ...(hasSignatures ? [
        "signature_attestation:signature_attestation_mutation_guard:31:O:public:" +
          "_m204_guard_signature_attestation::-:0",
        "signature_attestation:signature_attestation_no_truncate:34:O:public:forbid_mutation::-:0",
        "signature_request:signature_request_mutation_guard:31:O:public:" +
          "_m204_guard_signature_request::-:0",
        "signature_request:signature_request_no_truncate:34:O:public:forbid_mutation::-:0",
        "signature_view_log:signature_view_log_mutation_guard:31:O:public:" +
          "_m204_guard_signature_view_log::-:0",
        "signature_view_log:signature_view_log_no_truncate:34:O:public:forbid_mutation::-:0",
      ] : []),
      "site_energy_profile:site_energy_profile_mutation_guard:27:O:public:guard_site_energy_profile_mutation::-:0",
      "site_energy_profile:site_energy_profile_no_truncate:34:O:public:forbid_mutation::-:0",
      "user_identity:user_identity_link_auth_only:19:O:public:user_identity_link_auth_only::-:0",
      "workspace:workspace_default_request_board:5:O:public:provision_default_request_board::-:0",
      ...(hasWorkspaceInvoicing ? [
        "workspace_document_number_format:workspace_document_number_format_no_truncate:34:O:public:forbid_mutation::-:0",
        "workspace_invoicing_settings:workspace_invoicing_settings_no_truncate:34:O:public:forbid_mutation::-:0",
      ] : []),
      ...(hasEconomicsSettings ? [
        "workspace_economics_settings:workspace_economics_settings_no_truncate:34:O:public:forbid_mutation::-:0",
      ] : []),
      ...(hasCommercialDocuments ? [
        "commercial_document:commercial_document_issued_immutable:19:O:public:_m301_guard_issued_immutable::-:0",
        "commercial_document:commercial_document_no_truncate:34:O:public:forbid_mutation::-:0",
        "commercial_document_group:commercial_document_group_no_truncate:34:O:public:forbid_mutation::-:0",
        "commercial_document_line:commercial_document_line_no_truncate:34:O:public:forbid_mutation::-:0",
        "commercial_document_number_series:commercial_document_number_series_no_truncate:34:O:public:forbid_mutation::-:0",
      ] : []),
    ],
    "Live-Triggervertrag",
  );

  // information_schema.role_table_grants blendet ACLs fremder Grantors für
  // den aktuellen Benutzer aus. aclexplode liest dagegen den tatsächlichen
  // Katalog und macht auch Legacy-/Bridge-Grantor-Pfade sichtbar. PUBLIC ist
  // bewusst Teil der Prüfung, weil sein Recht für jeden Dienst effektiv gilt.
  const grants = await client.query<AclRow>(`
    select coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           c.relname as object_name,
           acl.privilege_type,
           acl.is_grantable
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join lateral pg_catalog.aclexplode(c.relacl) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and acl.grantee <> c.relowner
    order by grantee, c.relname, acl.privilege_type, grantor.rolname
  `);
  equalRows(
    grants.rows.map((row) =>
      `${row.grantee}:${row.object_name}:${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    [
      "app_runtime:audit_log:INSERT:app_owner:false",
      "app_runtime:audit_log:SELECT:app_owner:false",
      "app_runtime:calculator_snapshot:INSERT:app_owner:false",
      "app_runtime:calculator_snapshot:SELECT:app_owner:false",
      "app_runtime:catalog_component:INSERT:app_owner:false",
      "app_runtime:catalog_component:SELECT:app_owner:false",
      "app_runtime:catalog_component:UPDATE:app_owner:false",
      "app_runtime:catalog_component_revision:INSERT:app_owner:false",
      "app_runtime:catalog_component_revision:SELECT:app_owner:false",
      "app_runtime:contact:INSERT:app_owner:false",
      "app_runtime:contact:SELECT:app_owner:false",
      "app_runtime:contact:UPDATE:app_owner:false",
      "app_runtime:domain_events:INSERT:app_owner:false",
      "app_runtime:domain_events:SELECT:app_owner:false",
      "app_runtime:inbound_receipt:INSERT:app_owner:false",
      "app_runtime:inbound_receipt:SELECT:app_owner:false",
      "app_runtime:kanban_board:SELECT:app_owner:false",
      "app_runtime:kanban_column:SELECT:app_owner:false",
      "app_runtime:membership:SELECT:app_owner:false",
      "app_runtime:offer:INSERT:app_owner:false",
      "app_runtime:offer:SELECT:app_owner:false",
      "app_runtime:offer_bom_line:INSERT:app_owner:false",
      "app_runtime:offer_bom_line:SELECT:app_owner:false",
      "app_runtime:offer_mutation_rate_window:INSERT:app_owner:false",
      "app_runtime:offer_mutation_rate_window:SELECT:app_owner:false",
      "app_runtime:offer_number_series:INSERT:app_owner:false",
      "app_runtime:offer_number_series:SELECT:app_owner:false",
      ...(hasOfferPdfDraft ? [
        "app_runtime:offer_pdf_draft:SELECT:app_owner:false",
      ] : []),
      ...(hasOfferRelease ? OFFER_RELEASE_RUNTIME_SELECT_RELATIONS.map(
        (relation) => `app_runtime:${relation}:SELECT:app_owner:false`,
      ) : []),
      "app_runtime:offer_variant:INSERT:app_owner:false",
      "app_runtime:offer_variant:SELECT:app_owner:false",
      "app_runtime:offer_variant_revision:INSERT:app_owner:false",
      "app_runtime:offer_variant_revision:SELECT:app_owner:false",
      "app_runtime:offer_variant_section:INSERT:app_owner:false",
      "app_runtime:offer_variant_section:SELECT:app_owner:false",
      "app_runtime:project:INSERT:app_owner:false",
      "app_runtime:project:SELECT:app_owner:false",
      "app_runtime:project:UPDATE:app_owner:false",
      ...(hasProjectAssignment ? [
        "app_runtime:project_assignment:DELETE:app_owner:false",
        "app_runtime:project_assignment:INSERT:app_owner:false",
        "app_runtime:project_assignment:SELECT:app_owner:false",
        "app_runtime:project_assignment:UPDATE:app_owner:false",
      ] : []),
      ...(hasProjectTasks ? [
        "app_runtime:project_task:INSERT:app_owner:false",
        "app_runtime:project_task:SELECT:app_owner:false",
        "app_runtime:project_task:UPDATE:app_owner:false",
        ...PROJECT_TASK_RELATIONS.slice(1).flatMap((relation) => [
          `app_runtime:${relation}:DELETE:app_owner:false`,
          `app_runtime:${relation}:INSERT:app_owner:false`,
          `app_runtime:${relation}:SELECT:app_owner:false`,
          `app_runtime:${relation}:UPDATE:app_owner:false`,
        ]),
      ] : []),
      ...(hasProjectOutcomes ? [
        "app_runtime:project_loss_reason:INSERT:app_owner:false",
        "app_runtime:project_loss_reason:SELECT:app_owner:false",
        "app_runtime:project_loss_reason:UPDATE:app_owner:false",
      ] : []),
      ...(hasCustomerNotification ? [
        "app_runtime:customer_notification:INSERT:app_owner:false",
      ] : []),
      ...(hasProjectNotes ? [
        "app_runtime:project_note:INSERT:app_owner:false",
        "app_runtime:project_note:SELECT:app_owner:false",
        "app_runtime:project_note:UPDATE:app_owner:false",
      ] : []),
      ...(hasProjectAppointments ? [
        "app_runtime:calendar_category:SELECT:app_owner:false",
        "app_runtime:project_appointment:DELETE:app_owner:false",
        "app_runtime:project_appointment:INSERT:app_owner:false",
        "app_runtime:project_appointment:SELECT:app_owner:false",
        "app_runtime:project_appointment:UPDATE:app_owner:false",
        "app_runtime:project_appointment_attendee:DELETE:app_owner:false",
        "app_runtime:project_appointment_attendee:INSERT:app_owner:false",
        "app_runtime:project_appointment_attendee:SELECT:app_owner:false",
      ] : []),
      "app_runtime:project_calculation_job:INSERT:app_owner:false",
      "app_runtime:project_calculation_job:SELECT:app_owner:false",
      "app_runtime:project_calculation_revision:SELECT:app_owner:false",
      "app_runtime:project_catalog_resolution:INSERT:app_owner:false",
      "app_runtime:project_catalog_resolution:SELECT:app_owner:false",
      "app_runtime:project_catalog_resolution_line:INSERT:app_owner:false",
      "app_runtime:project_catalog_resolution_line:SELECT:app_owner:false",
      "app_runtime:project_requirement:INSERT:app_owner:false",
      "app_runtime:project_requirement:SELECT:app_owner:false",
      ...(hasSignatures ? [
        "app_runtime:signature_attestation:INSERT:app_owner:false",
        "app_runtime:signature_attestation:SELECT:app_owner:false",
        "app_runtime:signature_request:INSERT:app_owner:false",
        "app_runtime:signature_request:SELECT:app_owner:false",
        "app_runtime:signature_request:UPDATE:app_owner:false",
        "app_runtime:signature_view_log:INSERT:app_owner:false",
        "app_runtime:signature_view_log:SELECT:app_owner:false",
      ] : []),
      "app_runtime:site:DELETE:app_owner:false",
      "app_runtime:site:INSERT:app_owner:false",
      "app_runtime:site:SELECT:app_owner:false",
      "app_runtime:site:UPDATE:app_owner:false",
      "app_runtime:site_energy_profile:INSERT:app_owner:false",
      "app_runtime:site_energy_profile:SELECT:app_owner:false",
      "app_runtime:site_energy_profile:UPDATE:app_owner:false",
      "app_runtime:user_identity:SELECT:app_owner:false",
      "app_runtime:workspace:SELECT:app_owner:false",
      ...(hasWorkspaceInvoicing ? [
        "app_runtime:workspace_document_number_format:INSERT:app_owner:false",
        "app_runtime:workspace_document_number_format:SELECT:app_owner:false",
        "app_runtime:workspace_document_number_format:UPDATE:app_owner:false",
        "app_runtime:workspace_invoicing_settings:INSERT:app_owner:false",
        "app_runtime:workspace_invoicing_settings:SELECT:app_owner:false",
        "app_runtime:workspace_invoicing_settings:UPDATE:app_owner:false",
      ] : []),
      ...(hasEconomicsSettings ? ECONOMICS_RELATIONS.flatMap((relation) => [
        `app_runtime:${relation}:INSERT:app_owner:false`,
        `app_runtime:${relation}:SELECT:app_owner:false`,
        `app_runtime:${relation}:UPDATE:app_owner:false`,
      ]) : []),
      ...(hasLeadSources ? LEAD_SOURCE_RELATIONS.flatMap((relation) => [
        `app_runtime:${relation}:INSERT:app_owner:false`,
        `app_runtime:${relation}:SELECT:app_owner:false`,
        `app_runtime:${relation}:UPDATE:app_owner:false`,
      ]) : []),
      ...(hasTimeTracking ? TIME_TRACKING_RELATIONS.flatMap((relation) => [
        `app_runtime:${relation}:INSERT:app_owner:false`,
        `app_runtime:${relation}:SELECT:app_owner:false`,
        `app_runtime:${relation}:UPDATE:app_owner:false`,
      ]) : []),
      ...(hasChecklists ? CHECKLIST_RELATIONS.flatMap((relation) => [
        `app_runtime:${relation}:INSERT:app_owner:false`,
        `app_runtime:${relation}:SELECT:app_owner:false`,
        `app_runtime:${relation}:UPDATE:app_owner:false`,
      ]) : []),
      ...(hasCalendars ? CALENDAR_RELATIONS.flatMap((relation) => [
        `app_runtime:${relation}:INSERT:app_owner:false`,
        `app_runtime:${relation}:SELECT:app_owner:false`,
        `app_runtime:${relation}:UPDATE:app_owner:false`,
      ]) : []),
      ...(hasChecklistTemplates ? CHECKLIST_TEMPLATE_RELATIONS.flatMap((relation) => [
        `app_runtime:${relation}:INSERT:app_owner:false`,
        `app_runtime:${relation}:SELECT:app_owner:false`,
        `app_runtime:${relation}:UPDATE:app_owner:false`,
      ]) : []),
      ...(hasCommercialDocuments ? COMMERCIAL_DOCUMENT_RELATIONS.flatMap((relation) => [
        `app_runtime:${relation}:INSERT:app_owner:false`,
        `app_runtime:${relation}:SELECT:app_owner:false`,
        `app_runtime:${relation}:UPDATE:app_owner:false`,
      ]) : []),
      "app_system:audit_log:INSERT:app_owner:false",
      "app_system:audit_log:SELECT:app_owner:false",
      "app_system:domain_events:INSERT:app_owner:false",
      "app_system:domain_events:SELECT:app_owner:false",
      "app_system:membership:DELETE:app_owner:false",
      "app_system:membership:INSERT:app_owner:false",
      "app_system:membership:SELECT:app_owner:false",
      "app_system:membership:UPDATE:app_owner:false",
      "app_system:user_identity:INSERT:app_owner:false",
      "app_system:user_identity:SELECT:app_owner:false",
      "app_system:workspace:INSERT:app_owner:false",
      "app_system:workspace:SELECT:app_owner:false",
      "app_system:workspace:UPDATE:app_owner:false",
      "app_worker:audit_log:INSERT:app_owner:false",
      "app_worker:calculator_snapshot:SELECT:app_owner:false",
      "app_worker:domain_events:INSERT:app_owner:false",
      "app_worker:membership:SELECT:app_owner:false",
      ...(hasOfferPdfDraft ? [
        "app_worker:offer_pdf_draft:SELECT:app_owner:false",
      ] : []),
      ...(hasOfferRelease ? [
        "app_worker:offer_release_candidate:SELECT:app_owner:false",
      ] : []),
      "app_worker:project_calculation_job:SELECT:app_owner:false",
      "app_worker:project_calculation_revision:SELECT:app_owner:false",
      "app_worker:project_requirement:SELECT:app_owner:false",
      "app_worker:site:SELECT:app_owner:false",
      "app_worker:site_energy_profile:SELECT:app_owner:false",
      "app_worker:workspace:SELECT:app_owner:false",
      ...["auth_account", "auth_rate_limit", "auth_session", "auth_user", "auth_verification"].flatMap(
        (table) => ["DELETE", "INSERT", "SELECT", "UPDATE"].map(
          (privilege) => `app_auth:${table}:${privilege}:app_owner:false`,
        ),
      ),
      "identity_reconciler:membership:SELECT:app_owner:false",
      "identity_reconciler:user_identity:INSERT:app_owner:false",
      "identity_reconciler:user_identity:SELECT:app_owner:false",
      "identity_reconciler:user_identity:UPDATE:app_owner:false",
    ],
    "Tabellen-Grants",
  );

  const columnGrants = await client.query<AclRow>(`
    select coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           c.relname || '.' || a.attname as object_name,
           acl.privilege_type,
           acl.is_grantable
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join lateral pg_catalog.aclexplode(a.attacl) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where n.nspname = 'public'
      and a.attnum > 0
      and not a.attisdropped
      and acl.grantee <> c.relowner
    order by grantee, c.relname, a.attname, acl.privilege_type, grantor.rolname
  `);
  equalRows(
    columnGrants.rows.map((row) =>
      `${row.grantee}:${row.object_name}:${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    [
      ...(hasOfferPdfDraft ? [
        "app_runtime:offer_pdf_draft.canonicalization_version:INSERT:app_owner:false",
        "app_runtime:offer_pdf_draft.created_by:INSERT:app_owner:false",
        "app_runtime:offer_pdf_draft.id:INSERT:app_owner:false",
        "app_runtime:offer_pdf_draft.id:UPDATE:app_owner:false",
        "app_runtime:offer_pdf_draft.input_version:INSERT:app_owner:false",
        "app_runtime:offer_pdf_draft.offer_id:INSERT:app_owner:false",
        "app_runtime:offer_pdf_draft.project_id:INSERT:app_owner:false",
        "app_runtime:offer_pdf_draft.renderer_recipe_version:INSERT:app_owner:false",
        "app_runtime:offer_pdf_draft.template_version:INSERT:app_owner:false",
        "app_runtime:offer_pdf_draft.variant_id:INSERT:app_owner:false",
        "app_runtime:offer_pdf_draft.variant_revision:INSERT:app_owner:false",
        "app_runtime:offer_pdf_draft.variant_revision_id:INSERT:app_owner:false",
        "app_runtime:offer_pdf_draft.variant_snapshot_sha256:INSERT:app_owner:false",
        "app_runtime:offer_pdf_draft.workspace_id:INSERT:app_owner:false",
      ] : []),
      "app_runtime:offer.updated_at:UPDATE:app_owner:false",
      "app_runtime:offer_mutation_rate_window.attempts:UPDATE:app_owner:false",
      "app_runtime:offer_mutation_rate_window.updated_at:UPDATE:app_owner:false",
      "app_runtime:offer_number_series.last_sequence:UPDATE:app_owner:false",
      "app_runtime:offer_number_series.updated_at:UPDATE:app_owner:false",
      "app_runtime:offer_variant.current_revision:UPDATE:app_owner:false",
      "app_runtime:offer_variant.description:UPDATE:app_owner:false",
      "app_runtime:offer_variant.name:UPDATE:app_owner:false",
      "app_runtime:offer_variant.updated_at:UPDATE:app_owner:false",
      "app_runtime:inbound_receipt.id:UPDATE:app_owner:false",
      "app_runtime:project_calculation_job.id:UPDATE:app_owner:false",
      "app_runtime:project_calculation_revision.id:UPDATE:app_owner:false",
      "app_runtime:project_catalog_resolution.id:UPDATE:app_owner:false",
      "app_runtime:project_requirement.id:UPDATE:app_owner:false",
      "app_runtime:workspace.id:UPDATE:app_owner:false",
      "app_worker:project_calculation_job.attempt_count:UPDATE:app_owner:false",
      "app_worker:project_calculation_job.error_code:UPDATE:app_owner:false",
      "app_worker:project_calculation_job.error_retryable:UPDATE:app_owner:false",
      "app_worker:project_calculation_job.finished_at:UPDATE:app_owner:false",
      "app_worker:project_calculation_job.input_sha256:UPDATE:app_owner:false",
      "app_worker:project_calculation_job.input_snapshot:UPDATE:app_owner:false",
      "app_worker:project_calculation_job.lease_expires_at:UPDATE:app_owner:false",
      "app_worker:project_calculation_job.lease_token:UPDATE:app_owner:false",
      "app_worker:project_calculation_job.next_attempt_at:UPDATE:app_owner:false",
      "app_worker:project_calculation_job.provider_snapshot:UPDATE:app_owner:false",
      "app_worker:project_calculation_job.started_at:UPDATE:app_owner:false",
      "app_worker:project_calculation_job.state:UPDATE:app_owner:false",
      ...(hasOfferPdfDraft ? [
        "app_worker:offer_pdf_draft.artifact_bytes:UPDATE:app_owner:false",
        "app_worker:offer_pdf_draft.artifact_mime_type:UPDATE:app_owner:false",
        "app_worker:offer_pdf_draft.artifact_sha256:UPDATE:app_owner:false",
        "app_worker:offer_pdf_draft.artifact_size_bytes:UPDATE:app_owner:false",
        "app_worker:offer_pdf_draft.attempt_count:UPDATE:app_owner:false",
        "app_worker:offer_pdf_draft.error_code:UPDATE:app_owner:false",
        "app_worker:offer_pdf_draft.error_retryable:UPDATE:app_owner:false",
        "app_worker:offer_pdf_draft.finished_at:UPDATE:app_owner:false",
        "app_worker:offer_pdf_draft.lease_expires_at:UPDATE:app_owner:false",
        "app_worker:offer_pdf_draft.lease_token:UPDATE:app_owner:false",
        "app_worker:offer_pdf_draft.next_attempt_at:UPDATE:app_owner:false",
        "app_worker:offer_pdf_draft.started_at:UPDATE:app_owner:false",
        "app_worker:offer_pdf_draft.state:UPDATE:app_owner:false",
        "app_worker:offer_pdf_draft.updated_at:UPDATE:app_owner:false",
      ] : []),
      ...(hasOfferRelease ? OFFER_RELEASE_WORKER_UPDATE_COLUMNS.map(
        (column) =>
          `app_worker:offer_release_candidate.${column}:UPDATE:app_owner:false`,
      ) : []),
    ],
    "Spalten-Grants",
  );

  if (hasProjectOutcomes) {
    const workerProjectRead = await client.query<{
      table_select: boolean;
      readable_columns: string[];
    }>(`
      select pg_catalog.has_table_privilege(
               'app_worker', 'public.project', 'SELECT'
             ) as table_select,
             coalesce(
               pg_catalog.array_agg(attribute.attname order by attribute.attnum)
                 filter (
                   where pg_catalog.has_column_privilege(
                     'app_worker', 'public.project', attribute.attname, 'SELECT'
                   )
                 ),
               array[]::name[]
             )::text[] as readable_columns
        from pg_catalog.pg_attribute as attribute
       where attribute.attrelid = 'public.project'::pg_catalog.regclass
         and attribute.attnum > 0
         and not attribute.attisdropped
    `);
    const workerRead = workerProjectRead.rows[0];
    if (workerRead?.table_select || (workerRead?.readable_columns.length ?? 0) > 0) {
      throw new Error(
        `app_worker darf keine Project-Spalte lesen: ${JSON.stringify(workerRead)}`,
      );
    }
  }

  const sequenceGrants = await client.query<AclRow>(`
    select coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           c.relname as object_name,
           acl.privilege_type,
           acl.is_grantable
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join lateral pg_catalog.aclexplode(c.relacl) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where n.nspname = 'public'
      and c.relkind = 'S'
      and acl.grantee <> c.relowner
    order by grantee, c.relname, acl.privilege_type, grantor.rolname
  `);
  equalRows(
    sequenceGrants.rows.map((row) =>
      `${row.grantee}:${row.object_name}:${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    [],
    "Sequenz-Grants",
  );

  const rawFunctionAcl = await client.query<AclRow>(`
    select coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' as object_name,
           acl.privilege_type,
           acl.is_grantable
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where n.nspname = 'public'
      and acl.grantee <> p.proowner
    order by grantee, object_name, acl.privilege_type, grantor.rolname
  `);
  equalRows(
    rawFunctionAcl.rows.map((row) =>
      `${row.grantee}:${row.object_name}:${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    [
      "app_auth:reconcile_user_identity(text, text):EXECUTE:identity_reconciler:false",
      "app_erasure:erase_inactive_lead(uuid, uuid, uuid):EXECUTE:app_owner:false",
      "app_erasure:replay_erasure_tombstone(uuid):EXECUTE:app_owner:false",
      "app_runtime:app_actor_id():EXECUTE:app_owner:false",
      ...(hasCatalogImport ? [
        "app_runtime:cancel_catalog_import_v1(uuid, uuid):EXECUTE:app_owner:false",
        "app_runtime:prepare_catalog_import_v1(uuid, uuid, jsonb):EXECUTE:app_owner:false",
        "app_runtime:read_catalog_import_rows_v1(uuid, uuid, integer, integer):EXECUTE:app_owner:false",
        "app_runtime:read_catalog_import_v1(uuid, uuid):EXECUTE:app_owner:false",
        "app_runtime:read_latest_catalog_import_id_v1(uuid):EXECUTE:app_owner:false",
        "app_runtime:start_catalog_import_v1(uuid, uuid, text):EXECUTE:app_owner:false",
        "app_worker:apply_catalog_import_row_v1(uuid, uuid, integer, uuid, bigint):EXECUTE:app_owner:false",
        "app_worker:claim_catalog_import_v1(uuid, uuid, uuid, integer):EXECUTE:app_owner:false",
        "app_worker:cleanup_catalog_import_snapshots_v1(uuid, integer):EXECUTE:app_owner:false",
        "app_worker:complete_catalog_import_batch_v1(uuid, uuid, uuid, bigint):EXECUTE:app_owner:false",
        "app_worker:_m108b_catalog_import_dispatch_state(uuid, uuid, text):EXECUTE:app_owner:false",
        "app_worker:finalize_catalog_import_failure_v1(uuid, uuid, uuid, bigint, text):EXECUTE:app_owner:false",
        "app_worker:record_catalog_import_dispatch_failure_v1(uuid, uuid, uuid, text):EXECUTE:app_owner:false",
        "app_worker:record_catalog_import_preclaim_failure_v1(uuid, uuid, uuid, text):EXECUTE:app_owner:false",
        "app_worker:recover_catalog_imports_v1(uuid, integer):EXECUTE:app_owner:false",
      ] : []),
      ...(hasProjectAssignment ? [
        "app_runtime:app_actor_is_external_only(uuid):EXECUTE:app_owner:false",
        "app_runtime:app_actor_membership_id(uuid):EXECUTE:app_owner:false",
      ] : []),
      ...(hasProjectTasks ? PROJECT_TASK_RUNTIME_ROUTINES.map((signature) =>
        `app_runtime:${signature.slice("public.".length)}:EXECUTE:app_owner:false`
      ) : []),
      ...(hasProjectOutcomes ? PROJECT_OUTCOME_RUNTIME_ROUTINES.map((signature) =>
        `app_runtime:${signature.slice("public.".length)}:EXECUTE:app_owner:false`
      ) : []),
      ...(hasCustomerNotification ? [
        "app_runtime:_m111b_project_has_binding_issuance(uuid, uuid):EXECUTE:app_owner:false",
        "app_runtime:_m111b_read_notification_delivery(uuid, uuid):EXECUTE:app_owner:false",
        "app_worker:_m111b_customer_notification_dispatch_state(uuid, uuid):EXECUTE:app_owner:false",
        "app_worker:_m111b_worker_cancel_erased(uuid, uuid):EXECUTE:app_owner:false",
        "app_worker:_m111b_worker_deliver(uuid, uuid, integer, text, text):EXECUTE:app_owner:false",
        "app_worker:_m111b_worker_resolve_recipient(uuid, uuid):EXECUTE:app_owner:false",
      ] : []),
      ...(hasProjectNotes ? PROJECT_NOTE_RUNTIME_ROUTINES.map((signature) =>
        `app_runtime:${signature.slice("public.".length)}:EXECUTE:app_owner:false`
      ) : []),
      ...(hasProjectAppointments ? PROJECT_APPOINTMENT_RUNTIME_ROUTINES.map((signature) =>
        `app_runtime:${signature.slice("public.".length)}:EXECUTE:app_owner:false`
      ) : []),
      ...(hasSignatures ? [
        "app_runtime:_m204_actor_can_read_signatures(uuid):EXECUTE:app_owner:false",
        "app_runtime:_m204_actor_can_write_signatures(uuid):EXECUTE:app_owner:false",
        "app_runtime:_m204_actor_signature_role(uuid):EXECUTE:app_owner:false",
        "app_runtime:create_signature_request(uuid, uuid, uuid, integer, bytea):EXECUTE:app_owner:false",
        "app_runtime:record_signature_view(bytea):EXECUTE:app_owner:false",
        "app_runtime:resolve_signature_public_view(bytea):EXECUTE:app_owner:false",
        "app_runtime:revoke_signature_by_customer(bytea):EXECUTE:app_owner:false",
        "app_runtime:sign_signature_by_token(bytea, text, text, bytea):EXECUTE:app_owner:false",
      ] : []),
      ...(hasWorkspaceInvoicing ? INVOICING_RUNTIME_ROUTINES.map((signature) =>
        `app_runtime:${signature.slice("public.".length)}:EXECUTE:app_owner:false`
      ) : []),
      ...(hasEconomicsSettings ? ECONOMICS_RUNTIME_ROUTINES.map((signature) =>
        `app_runtime:${signature.slice("public.".length)}:EXECUTE:app_owner:false`
      ) : []),
      ...(hasCommercialDocuments ? COMMERCIAL_DOCUMENT_RUNTIME_ROUTINES.map((signature) =>
        `app_runtime:${signature.slice("public.".length)}:EXECUTE:app_owner:false`
      ) : []),
      ...(hasOfferIssuance ? [
        "app_runtime:approve_offer_issuance(uuid, uuid, boolean, boolean, boolean, boolean, boolean):EXECUTE:app_owner:false",
        "app_runtime:prepare_offer_issuance(uuid, uuid, uuid):EXECUTE:app_owner:false",
        "app_runtime:read_offer_issuance_artifact(uuid, uuid, uuid):EXECUTE:app_owner:false",
        "app_runtime:read_offer_issuance_status(uuid, uuid, uuid):EXECUTE:app_owner:false",
        "app_runtime:withdraw_offer_issuance(uuid, uuid, text):EXECUTE:app_owner:false",
      ] : []),
      ...(hasOfferPdfDraft ? [
        "app_runtime:canonicalize_offer_json_v1(jsonb):EXECUTE:app_owner:false",
      ] : []),
      ...(hasOfferRelease ? [
        "app_runtime:activate_offer_release_profile(uuid, uuid, uuid, integer):EXECUTE:app_owner:false",
        "app_runtime:approve_offer_release_candidate(uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, boolean):EXECUTE:app_owner:false",
        "app_runtime:prepare_offer_release_candidate(uuid, uuid, uuid, integer, uuid, uuid, uuid, integer, uuid, integer, date):EXECUTE:app_owner:false",
        "app_runtime:read_offer_release_candidate_artifact(uuid, uuid, uuid):EXECUTE:app_owner:false",
        "app_runtime:read_offer_release_candidate_status(uuid, uuid, uuid):EXECUTE:app_owner:false",
        "app_runtime:revise_offer_recipient(uuid, uuid, integer, text, text, text, jsonb, boolean):EXECUTE:app_owner:false",
        "app_runtime:revise_offer_release_profile(uuid, integer, text, jsonb, jsonb):EXECUTE:app_owner:false",
      ] : []),
      "app_system:app_actor_id():EXECUTE:app_owner:false",
      ...(hasOfferPdfDraft ? [
        "app_worker:canonicalize_offer_json_v1(jsonb):EXECUTE:app_owner:false",
      ] : []),
      ...(hasOfferIssuance ? [
        "app_worker:_m203b1_offer_issuance_dispatch_state(uuid, uuid):EXECUTE:app_owner:false",
        "app_worker:claim_offer_issuance_render(uuid, uuid, uuid, integer):EXECUTE:app_owner:false",
        "app_worker:finalize_offer_issuance_render_failure(uuid, uuid, uuid, integer, text, boolean):EXECUTE:app_owner:false",
        "app_worker:finalize_offer_issuance_render_success(uuid, uuid, uuid, integer, bytea):EXECUTE:app_owner:false",
        "app_worker:list_offer_issuance_recovery_workspaces(uuid, integer):EXECUTE:app_owner:false",
        "app_worker:recover_offer_issuance_renders(uuid, integer):EXECUTE:app_owner:false",
      ] : []),
      "app_worker:finalize_project_calculation_success(uuid, uuid, uuid, integer, uuid, jsonb):EXECUTE:app_owner:false",
      "app_worker:lock_project_calculation_finalization(uuid, uuid):EXECUTE:app_owner:false",
    ],
    "Funktions-Grants",
  );

  const rawPgBossFunctionAcl = await client.query<AclRow>(`
    select coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' as object_name,
           acl.privilege_type,
           acl.is_grantable
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where n.nspname = 'pgboss'
      and acl.grantee <> p.proowner
    order by grantee, object_name, acl.privilege_type, grantor.rolname
  `);
  equalRows(
    rawPgBossFunctionAcl.rows.map((row) =>
      `${row.grantee}:${row.object_name}:${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    [
      "app_runtime:enqueue_project_calculation(uuid, uuid):EXECUTE:app_worker:false",
      ...(hasCatalogImport ? [
        "app_runtime:enqueue_catalog_import_cleanup_v1(uuid, uuid, uuid):EXECUTE:app_worker:false",
        "app_runtime:enqueue_catalog_import_v1(uuid, uuid, uuid):EXECUTE:app_worker:false",
      ] : []),
      ...(hasOfferPdfDraft ? [
        "app_runtime:enqueue_offer_pdf_draft(uuid, uuid):EXECUTE:app_worker:false",
      ] : []),
      ...(hasOfferRelease ? [
        "app_runtime:enqueue_offer_release_candidate(uuid, uuid):EXECUTE:app_worker:false",
      ] : []),
      ...(hasOfferIssuance ? [
        "app_runtime:enqueue_offer_issuance(uuid, uuid):EXECUTE:app_worker:false",
      ] : []),
      ...(hasCustomerNotification ? [
        "app_runtime:enqueue_customer_notification(uuid, uuid):EXECUTE:app_worker:false",
      ] : []),
    ],
    "pg-boss-Funktions-Grants",
  );

  const runtimePgBossRelations = await client.query<{ relation_name: string }>(`
    select relation.relname as relation_name
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'pgboss'
      and relation.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
      and (
        pg_catalog.has_table_privilege('app_runtime', relation.oid, 'SELECT')
        or pg_catalog.has_table_privilege('app_runtime', relation.oid, 'INSERT')
        or pg_catalog.has_table_privilege('app_runtime', relation.oid, 'UPDATE')
        or pg_catalog.has_table_privilege('app_runtime', relation.oid, 'DELETE')
        or pg_catalog.has_table_privilege('app_runtime', relation.oid, 'TRUNCATE')
        or pg_catalog.has_table_privilege('app_runtime', relation.oid, 'REFERENCES')
        or pg_catalog.has_table_privilege('app_runtime', relation.oid, 'TRIGGER')
      )
    order by relation.relname
  `);
  equalRows(
    runtimePgBossRelations.rows.map((row) => row.relation_name),
    [],
    "Runtime-pg-boss-Relationsrechte",
  );

  const rawSchemaAcl = await client.query<AclRow>(`
    select coalesce(grantee.rolname, 'PUBLIC') as grantee,
           grantor.rolname as grantor,
           n.nspname as object_name,
           acl.privilege_type,
           acl.is_grantable
    from pg_catalog.pg_namespace n
    cross join lateral pg_catalog.aclexplode(
      coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))
    ) acl
    join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
    left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
    where n.nspname in ('public', 'drizzle', 'pgboss')
      and acl.grantee <> n.nspowner
    order by grantee, n.nspname, acl.privilege_type, grantor.rolname
  `);
  equalRows(
    rawSchemaAcl.rows.map((row) =>
      `${row.grantee}:${row.object_name}:${row.privilege_type}:${row.grantor}:${row.is_grantable}`,
    ),
    [
      "app_auth:public:USAGE:app_owner:false",
      "app_erasure:public:USAGE:app_owner:false",
      "app_runtime:pgboss:USAGE:app_worker:false",
      "app_runtime:public:USAGE:app_owner:false",
      "app_system:public:USAGE:app_owner:false",
      "app_worker:public:USAGE:app_owner:false",
      "identity_reconciler:public:USAGE:app_owner:false",
    ],
    "Schema-Grants",
  );

  const functionAcl = await client.query<{
    runtime_actor: boolean;
    system_actor: boolean;
    auth_reconcile: boolean;
    runtime_reconcile: boolean;
    system_reconcile: boolean;
    worker_reconcile: boolean;
    runtime_provision: boolean;
    system_provision: boolean;
    auth_provision: boolean;
    worker_provision: boolean;
    runtime_enqueue: boolean;
    system_enqueue: boolean;
    auth_enqueue: boolean;
    runtime_pdf_enqueue: boolean | null;
    system_pdf_enqueue: boolean | null;
    auth_pdf_enqueue: boolean | null;
  }>(`
    select
      pg_catalog.has_function_privilege('app_runtime', 'public.app_actor_id()', 'EXECUTE') as runtime_actor,
      pg_catalog.has_function_privilege('app_system', 'public.app_actor_id()', 'EXECUTE') as system_actor,
      pg_catalog.has_function_privilege('app_auth', 'public.reconcile_user_identity(text,text)', 'EXECUTE') as auth_reconcile,
      pg_catalog.has_function_privilege('app_runtime', 'public.reconcile_user_identity(text,text)', 'EXECUTE') as runtime_reconcile,
      pg_catalog.has_function_privilege('app_system', 'public.reconcile_user_identity(text,text)', 'EXECUTE') as system_reconcile,
      pg_catalog.has_function_privilege('app_worker', 'public.reconcile_user_identity(text,text)', 'EXECUTE') as worker_reconcile,
      pg_catalog.has_function_privilege('app_runtime', 'public.provision_default_request_board()', 'EXECUTE') as runtime_provision,
      pg_catalog.has_function_privilege('app_system', 'public.provision_default_request_board()', 'EXECUTE') as system_provision,
      pg_catalog.has_function_privilege('app_auth', 'public.provision_default_request_board()', 'EXECUTE') as auth_provision,
      pg_catalog.has_function_privilege('app_worker', 'public.provision_default_request_board()', 'EXECUTE') as worker_provision,
      (
        select pg_catalog.has_function_privilege('app_runtime', routine.oid, 'EXECUTE')
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
        where namespace.nspname = 'pgboss'
          and routine.proname = 'enqueue_project_calculation'
          and pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid'
      ) as runtime_enqueue,
      (
        select pg_catalog.has_function_privilege('app_system', routine.oid, 'EXECUTE')
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
        where namespace.nspname = 'pgboss'
          and routine.proname = 'enqueue_project_calculation'
          and pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid'
      ) as system_enqueue,
      (
        select pg_catalog.has_function_privilege('app_auth', routine.oid, 'EXECUTE')
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
        where namespace.nspname = 'pgboss'
          and routine.proname = 'enqueue_project_calculation'
          and pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid'
      ) as auth_enqueue,
      (
        select pg_catalog.has_function_privilege('app_runtime', routine.oid, 'EXECUTE')
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
        where namespace.nspname = 'pgboss'
          and routine.proname = 'enqueue_offer_pdf_draft'
          and pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid'
      ) as runtime_pdf_enqueue,
      (
        select pg_catalog.has_function_privilege('app_system', routine.oid, 'EXECUTE')
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
        where namespace.nspname = 'pgboss'
          and routine.proname = 'enqueue_offer_pdf_draft'
          and pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid'
      ) as system_pdf_enqueue,
      (
        select pg_catalog.has_function_privilege('app_auth', routine.oid, 'EXECUTE')
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
        where namespace.nspname = 'pgboss'
          and routine.proname = 'enqueue_offer_pdf_draft'
          and pg_catalog.oidvectortypes(routine.proargtypes) = 'uuid, uuid'
      ) as auth_pdf_enqueue
  `);
  const acl = functionAcl.rows[0];
  if (
    !acl?.runtime_actor || !acl.system_actor || !acl.auth_reconcile ||
    acl.runtime_reconcile || acl.system_reconcile || acl.worker_reconcile
    || acl.runtime_provision || acl.system_provision
    || acl.auth_provision || acl.worker_provision
    || !acl.runtime_enqueue || acl.system_enqueue || acl.auth_enqueue
    || (hasOfferPdfDraft && (
      !acl.runtime_pdf_enqueue || acl.system_pdf_enqueue || acl.auth_pdf_enqueue
    ))
    || (!hasOfferPdfDraft && (
      acl.runtime_pdf_enqueue !== null || acl.system_pdf_enqueue !== null
      || acl.auth_pdf_enqueue !== null
    ))
  ) {
    throw new Error(`Funktions-ACL weicht vom Rollenvertrag ab: ${JSON.stringify(acl)}`);
  }

  if (hasOfferRelease) {
    const releaseFunctionAcl = await client.query<{
      principal: string;
      routine_signature: string;
      may_execute: boolean | null;
    }>(`
      with principals(principal) as (
        values
          ('public'::text),
          ('app_owner'::text),
          ('app_migrator'::text),
          ('app_runtime'::text),
          ('app_system'::text),
          ('app_auth'::text),
          ('app_worker'::text),
          ('app_erasure'::text),
          ('app_membership_writer'::text),
          ('identity_reconciler'::text)
      ),
      routines(schema_name, routine_name, routine_arguments, routine_signature) as (
        values
          ('public'::text, 'activate_offer_release_profile'::text,
            'uuid, uuid, uuid, integer'::text,
            'activate_offer_release_profile(uuid,uuid,uuid,integer)'::text),
          ('public'::text, 'approve_offer_release_candidate'::text,
            'uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean, boolean'::text,
            'approve_offer_release_candidate(uuid,uuid,uuid,uuid,boolean,boolean,boolean,boolean,boolean)'::text),
          ('public'::text, 'prepare_offer_release_candidate'::text,
            'uuid, uuid, uuid, integer, uuid, uuid, uuid, integer, uuid, integer, date'::text,
            'prepare_offer_release_candidate(uuid,uuid,uuid,integer,uuid,uuid,uuid,integer,uuid,integer,date)'::text),
          ('public'::text, 'read_offer_release_candidate_artifact'::text,
            'uuid, uuid, uuid'::text,
            'read_offer_release_candidate_artifact(uuid,uuid,uuid)'::text),
          ('public'::text, 'read_offer_release_candidate_status'::text,
            'uuid, uuid, uuid'::text,
            'read_offer_release_candidate_status(uuid,uuid,uuid)'::text),
          ('public'::text, 'revise_offer_recipient'::text,
            'uuid, uuid, integer, text, text, text, jsonb, boolean'::text,
            'revise_offer_recipient(uuid,uuid,integer,text,text,text,jsonb,boolean)'::text),
          ('public'::text, 'revise_offer_release_profile'::text,
            'uuid, integer, text, jsonb, jsonb'::text,
            'revise_offer_release_profile(uuid,integer,text,jsonb,jsonb)'::text),
          ('pgboss'::text, 'enqueue_offer_release_candidate'::text,
            'uuid, uuid'::text,
            'enqueue_offer_release_candidate(uuid,uuid)'::text)
      )
      select principal.principal,
             routine.schema_name || '.' || routine.routine_signature as routine_signature,
             pg_catalog.has_function_privilege(
               principal.principal,
               function_record.oid,
               'EXECUTE'
             ) as may_execute
        from principals as principal
        cross join routines as routine
        left join pg_catalog.pg_namespace as function_schema
          on function_schema.nspname = routine.schema_name
        left join pg_catalog.pg_proc as function_record
          on function_record.pronamespace = function_schema.oid
         and function_record.proname = routine.routine_name
         and pg_catalog.oidvectortypes(function_record.proargtypes) =
             routine.routine_arguments
       order by principal.principal, routine.schema_name, routine.routine_signature
    `);
    const principals = ["public", ...APP_ROLES] as const;
    const routines = [
      "public.activate_offer_release_profile(uuid,uuid,uuid,integer)",
      "public.approve_offer_release_candidate(uuid,uuid,uuid,uuid,boolean,boolean,boolean,boolean,boolean)",
      "public.prepare_offer_release_candidate(uuid,uuid,uuid,integer,uuid,uuid,uuid,integer,uuid,integer,date)",
      "public.read_offer_release_candidate_artifact(uuid,uuid,uuid)",
      "public.read_offer_release_candidate_status(uuid,uuid,uuid)",
      "public.revise_offer_recipient(uuid,uuid,integer,text,text,text,jsonb,boolean)",
      "public.revise_offer_release_profile(uuid,integer,text,jsonb,jsonb)",
      "pgboss.enqueue_offer_release_candidate(uuid,uuid)",
    ] as const;
    equalRows(
      releaseFunctionAcl.rows.map((row) =>
        `${row.principal}:${row.routine_signature}:${row.may_execute === null ? "NULL" : String(row.may_execute)}`,
      ),
      principals.flatMap((principal) => routines.map((routine) => {
        const isOwner = routine.startsWith("public.")
          ? principal === "app_owner"
          : principal === "app_worker";
        const mayExecute = principal === "app_runtime" || isOwner;
        return `${principal}:${routine}:${String(mayExecute)}`;
      })),
      "M2-03a effektive Funktions-ACLs",
    );
  }

  if (hasOfferIssuance) {
    const issuanceFunctionAcl = await client.query<{
      principal: string;
      routine_signature: string;
      may_execute: boolean | null;
    }>(`
      with principals(principal) as (
        values
          ('public'::text),
          ('app_owner'::text),
          ('app_migrator'::text),
          ('app_runtime'::text),
          ('app_system'::text),
          ('app_auth'::text),
          ('app_worker'::text),
          ('app_erasure'::text),
          ('app_membership_writer'::text),
          ('identity_reconciler'::text)
      ),
      routines(schema_name, routine_name, routine_arguments, routine_signature) as (
        values
          ('public'::text, '_m203b1_offer_issuance_dispatch_state'::text,
            'uuid, uuid'::text,
            '_m203b1_offer_issuance_dispatch_state(uuid,uuid)'::text),
          ('public'::text, 'approve_offer_issuance'::text,
            'uuid, uuid, boolean, boolean, boolean, boolean, boolean'::text,
            'approve_offer_issuance(uuid,uuid,boolean,boolean,boolean,boolean,boolean)'::text),
          ('public'::text, 'claim_offer_issuance_render'::text,
            'uuid, uuid, uuid, integer'::text,
            'claim_offer_issuance_render(uuid,uuid,uuid,integer)'::text),
          ('public'::text, 'finalize_offer_issuance_render_failure'::text,
            'uuid, uuid, uuid, integer, text, boolean'::text,
            'finalize_offer_issuance_render_failure(uuid,uuid,uuid,integer,text,boolean)'::text),
          ('public'::text, 'finalize_offer_issuance_render_success'::text,
            'uuid, uuid, uuid, integer, bytea'::text,
            'finalize_offer_issuance_render_success(uuid,uuid,uuid,integer,bytea)'::text),
          ('public'::text, 'list_offer_issuance_recovery_workspaces'::text,
            'uuid, integer'::text,
            'list_offer_issuance_recovery_workspaces(uuid,integer)'::text),
          ('public'::text, 'prepare_offer_issuance'::text,
            'uuid, uuid, uuid'::text,
            'prepare_offer_issuance(uuid,uuid,uuid)'::text),
          ('public'::text, 'read_offer_issuance_artifact'::text,
            'uuid, uuid, uuid'::text,
            'read_offer_issuance_artifact(uuid,uuid,uuid)'::text),
          ('public'::text, 'read_offer_issuance_status'::text,
            'uuid, uuid, uuid'::text,
            'read_offer_issuance_status(uuid,uuid,uuid)'::text),
          ('public'::text, 'recover_offer_issuance_renders'::text,
            'uuid, integer'::text,
            'recover_offer_issuance_renders(uuid,integer)'::text),
          ('public'::text, 'withdraw_offer_issuance'::text,
            'uuid, uuid, text'::text,
            'withdraw_offer_issuance(uuid,uuid,text)'::text),
          ('pgboss'::text, 'enqueue_offer_issuance'::text,
            'uuid, uuid'::text,
            'enqueue_offer_issuance(uuid,uuid)'::text)
      )
      select principal.principal,
             routine.schema_name || '.' || routine.routine_signature as routine_signature,
             pg_catalog.has_function_privilege(
               principal.principal,
               function_record.oid,
               'EXECUTE'
             ) as may_execute
        from principals as principal
        cross join routines as routine
        left join pg_catalog.pg_namespace as function_schema
          on function_schema.nspname = routine.schema_name
        left join pg_catalog.pg_proc as function_record
          on function_record.pronamespace = function_schema.oid
         and function_record.proname = routine.routine_name
         and pg_catalog.oidvectortypes(function_record.proargtypes) =
             routine.routine_arguments
       order by principal.principal, routine.schema_name, routine.routine_signature
    `);
    const principals = ["public", ...APP_ROLES] as const;
    const runtimeRoutines = [
      "public.approve_offer_issuance(uuid,uuid,boolean,boolean,boolean,boolean,boolean)",
      "public.prepare_offer_issuance(uuid,uuid,uuid)",
      "public.read_offer_issuance_artifact(uuid,uuid,uuid)",
      "public.read_offer_issuance_status(uuid,uuid,uuid)",
      "public.withdraw_offer_issuance(uuid,uuid,text)",
      "pgboss.enqueue_offer_issuance(uuid,uuid)",
    ] as const;
    const workerRoutines = [
      "public._m203b1_offer_issuance_dispatch_state(uuid,uuid)",
      "public.claim_offer_issuance_render(uuid,uuid,uuid,integer)",
      "public.finalize_offer_issuance_render_failure(uuid,uuid,uuid,integer,text,boolean)",
      "public.finalize_offer_issuance_render_success(uuid,uuid,uuid,integer,bytea)",
      "public.list_offer_issuance_recovery_workspaces(uuid,integer)",
      "public.recover_offer_issuance_renders(uuid,integer)",
    ] as const;
    const routines = [...runtimeRoutines, ...workerRoutines];
    equalRows(
      issuanceFunctionAcl.rows.map((row) =>
        `${row.principal}:${row.routine_signature}:` +
          `${row.may_execute === null ? "NULL" : String(row.may_execute)}`,
      ),
      principals.flatMap((principal) => routines.map((routine) => {
        const isOwner = routine.startsWith("public.")
          ? principal === "app_owner"
          : principal === "app_worker";
        const isRuntimeGrant = principal === "app_runtime" &&
          runtimeRoutines.includes(routine as (typeof runtimeRoutines)[number]);
        const isWorkerGrant = principal === "app_worker" &&
          workerRoutines.includes(routine as (typeof workerRoutines)[number]);
        return `${principal}:${routine}:${String(isOwner || isRuntimeGrant || isWorkerGrant)}`;
      })),
      "M2-03b1 effektive Funktions-ACLs",
    );
  }

  if (hasCatalogImport) {
    const principals = ["public", ...APP_ROLES] as const;
    const routines = [
      ...CATALOG_IMPORT_ROUTINES,
      ...CATALOG_IMPORT_PGBOSS_ROUTINES,
    ];
    const catalogImportFunctionAcl = await (async () => {
      await client.query("set role app_worker");
      try {
        return await client.query<{
          principal: string;
          routine_signature: string;
          may_execute: boolean | null;
        }>(`
          with principals(principal) as (
            select * from pg_catalog.unnest($1::text[])
          ),
          routines(routine_signature) as (
            select * from pg_catalog.unnest($2::text[])
          )
          select principal.principal,
                 routine.routine_signature,
                 pg_catalog.has_function_privilege(
                   principal.principal,
                   pg_catalog.to_regprocedure(routine.routine_signature),
                   'EXECUTE'
                 ) as may_execute
            from principals as principal
            cross join routines as routine
           order by principal.principal, routine.routine_signature
        `, [principals, routines]);
      } finally {
        await client.query("set role app_owner");
      }
    })();
    equalRows(
      catalogImportFunctionAcl.rows.map((row) =>
        `${row.principal}:${row.routine_signature}:` +
          `${row.may_execute === null ? "NULL" : String(row.may_execute)}`,
      ),
      principals.flatMap((principal) => routines.map((routine) => {
        const isOwner = routine.startsWith("public.")
          ? principal === "app_owner"
          : principal === "app_worker";
        const isRuntimeGrant = principal === "app_runtime" &&
          (
            CATALOG_IMPORT_RUNTIME_ROUTINES.includes(
              routine as (typeof CATALOG_IMPORT_RUNTIME_ROUTINES)[number],
            ) || CATALOG_IMPORT_PGBOSS_RUNTIME_ROUTINES.includes(
              routine as (typeof CATALOG_IMPORT_PGBOSS_RUNTIME_ROUTINES)[number],
            )
          );
        const isWorkerGrant = principal === "app_worker" &&
          CATALOG_IMPORT_WORKER_ROUTINES.includes(
            routine as (typeof CATALOG_IMPORT_WORKER_ROUTINES)[number],
          );
        return `${principal}:${routine}:` +
          `${String(isOwner || isRuntimeGrant || isWorkerGrant)}`;
      })),
      "M1-08b effektive Funktions-ACLs",
    );
  }

  const schemaAcl = await client.query<{
    runtime_create: boolean;
    system_create: boolean;
    auth_create: boolean;
    worker_public_usage: boolean;
    worker_pgboss_create: boolean;
    runtime_pgboss_usage: boolean;
    runtime_pgboss_create: boolean;
  }>(`
    select
      pg_catalog.has_schema_privilege('app_runtime', 'public', 'CREATE') as runtime_create,
      pg_catalog.has_schema_privilege('app_system', 'public', 'CREATE') as system_create,
      pg_catalog.has_schema_privilege('app_auth', 'public', 'CREATE') as auth_create,
      pg_catalog.has_schema_privilege('app_worker', 'public', 'USAGE') as worker_public_usage,
      pg_catalog.has_schema_privilege('app_worker', 'pgboss', 'CREATE') as worker_pgboss_create,
      pg_catalog.has_schema_privilege('app_runtime', 'pgboss', 'USAGE') as runtime_pgboss_usage,
      pg_catalog.has_schema_privilege('app_runtime', 'pgboss', 'CREATE') as runtime_pgboss_create
  `);
  const schemas = schemaAcl.rows[0];
  if (
    schemas?.runtime_create || schemas?.system_create || schemas?.auth_create ||
    !schemas?.worker_public_usage || !schemas?.worker_pgboss_create ||
    !schemas?.runtime_pgboss_usage || schemas?.runtime_pgboss_create
  ) {
    throw new Error(`Schema-ACL weicht vom Rollenvertrag ab: ${JSON.stringify(schemas)}`);
  }
}
