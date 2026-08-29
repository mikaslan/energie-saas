#!/bin/bash
# Nightly logical database backup. The executable contract is intentionally
# fail-closed: exact PG18 target -> encrypted artifact -> exact immutable S3
# version -> immutable manifest. Restore evidence remains a separate gate.

# Disable ordinary accidental tracing before the first environment dereference.
# The trusted scheduler must additionally clear BASH_ENV/ENV/SHELLOPTS/BASHOPTS,
# set a non-secret PS4 and never add -x; startup hooks run before this file can act.
set +x
unset BASH_ENV ENV
PS4='+ '
set -euo pipefail
umask 077

readonly BACKUP_TEMP_PREFIX="/tmp/energie-saas-backup."
readonly BACKUP_OBJECT_PREFIX="pg/"
readonly BACKUP_SINGLE_PUT_MAX_BYTES=5368709120
readonly BACKUP_RETENTION_SKEW_SECONDS=300

die() {
  echo "[backup] $1" >&2
  exit 1
}

require_value() {
  local name="$1"
  local value="${!name-}"
  [[ -n "$value" ]] || die "${name} fehlt"
  [[ "$value" != *[[:cntrl:]]* ]] ||
    die "${name} enthaelt unzulaessige Steuerzeichen"
}

require_integer() {
  local name="$1"
  local minimum="$2"
  local maximum="$3"
  local value="${!name-}"
  require_value "$name"
  [[ "$value" =~ ^[0-9]+$ ]] || die "${name} muss eine ganze Zahl sein"
  # Bound the digit count before Bash arithmetic to prevent signed overflow.
  (( ${#value} <= ${#maximum} )) ||
    die "${name} liegt ausserhalb des erlaubten Bereichs ${minimum}-${maximum}"
  (( 10#$value >= minimum && 10#$value <= maximum )) ||
    die "${name} liegt ausserhalb des erlaubten Bereichs ${minimum}-${maximum}"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "erforderliches Programm fehlt: $1"
}

validate_absolute_path() {
  local name="$1"
  local value="${!name-}"
  require_value "$name"
  [[ "$value" == /* && "$value" != "/" ]] ||
    die "${name} muss ein absoluter Dateipfad sein"
  [[ "$value" =~ ^/[A-Za-z0-9._/-]+$ ]] ||
    die "${name} enthaelt unzulaessige Zeichen"
  [[ "$value" != *"//"* && "$value" != *"/../"* && "$value" != */.. &&
    "$value" != *"/./"* && "$value" != */. ]] ||
    die "${name} ist nicht normalisiert"
}

read_file_mode() {
  local path="$1"
  if stat -c '%a' "$path" >/dev/null 2>&1; then
    stat -c '%a' "$path"
  else
    stat -f '%Lp' "$path"
  fi
}

read_file_owner() {
  local path="$1"
  if stat -c '%u' "$path" >/dev/null 2>&1; then
    stat -c '%u' "$path"
  else
    stat -f '%u' "$path"
  fi
}

read_file_size() {
  local path="$1"
  if stat -c '%s' "$path" >/dev/null 2>&1; then
    stat -c '%s' "$path"
  else
    stat -f '%z' "$path"
  fi
}

validate_pgpass_mapping() {
  local expected_prefix
  local line=""
  local line_count=0
  local password_part=""
  expected_prefix="${POSTGRES_BACKUP_HOST}:${POSTGRES_BACKUP_PORT}:"
  expected_prefix+="${POSTGRES_BACKUP_DATABASE}:${POSTGRES_BACKUP_USER}:"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_count=$((line_count + 1))
    [[ "$line" == "$expected_prefix"* ]] ||
      die "POSTGRES_BACKUP_PASSFILE ist nicht exakt an Host/Port/DB/User gebunden"
    password_part="${line#"$expected_prefix"}"
    [[ -n "$password_part" ]] || die "POSTGRES_BACKUP_PASSFILE enthaelt kein Passwort"
  done < "$POSTGRES_BACKUP_PASSFILE"
  [[ "$line_count" -eq 1 ]] ||
    die "POSTGRES_BACKUP_PASSFILE muss exakt einen Ziel-Eintrag enthalten"
}

validate_environment() {
  local name
  for name in \
    POSTGRES_BACKUP_PROVIDER \
    POSTGRES_BACKUP_HOST \
    POSTGRES_BACKUP_PORT \
    POSTGRES_BACKUP_DATABASE \
    POSTGRES_BACKUP_USER \
    POSTGRES_BACKUP_PASSFILE \
    POSTGRES_BACKUP_SSLMODE \
    POSTGRES_BACKUP_SSLROOTCERT \
    S3_BACKUP_ENDPOINT \
    S3_BACKUP_REGION \
    S3_BACKUP_BUCKET \
    S3_BACKUP_ACCESS_KEY_ID \
    S3_BACKUP_SECRET_ACCESS_KEY \
    S3_BACKUP_EXPECTED_OBJECT_LOCK_MODE \
    S3_BACKUP_EXPECTED_RETENTION_DAYS \
    S3_BACKUP_LIFECYCLE_READBACK \
    AGE_PUBLIC_KEY \
    BACKUP_LOCK_DIR \
    BACKUP_TIMEOUT_SECONDS \
    BACKUP_KILL_AFTER_SECONDS \
    BACKUP_DEAD_MAN_URL; do
    require_value "$name"
  done

  require_integer POSTGRES_BACKUP_PORT 1 65535
  require_integer S3_BACKUP_EXPECTED_RETENTION_DAYS 1 36500
  require_integer BACKUP_TIMEOUT_SECONDS 1 86400
  require_integer BACKUP_KILL_AFTER_SECONDS 1 300

  case "$POSTGRES_BACKUP_PROVIDER" in
    neon)
      require_value POSTGRES_BACKUP_EXPECTED_NEON_TENANT_ID
      require_value POSTGRES_BACKUP_EXPECTED_NEON_TIMELINE_ID
      [[ -z "${POSTGRES_BACKUP_EXPECTED_SYSTEM_IDENTIFIER-}" ]] ||
        die "Neon-Vertrag verwendet Tenant/Timeline statt postgres-System-Identifier"
      [[ "$POSTGRES_BACKUP_EXPECTED_NEON_TENANT_ID" =~ ^[0-9a-f]{32}$ ]] ||
        die "POSTGRES_BACKUP_EXPECTED_NEON_TENANT_ID muss 32 lowercase Hexzeichen haben"
      [[ "$POSTGRES_BACKUP_EXPECTED_NEON_TIMELINE_ID" =~ ^[0-9a-f]{32}$ ]] ||
        die "POSTGRES_BACKUP_EXPECTED_NEON_TIMELINE_ID muss 32 lowercase Hexzeichen haben"
      ;;
    postgres)
      [[ -z "${POSTGRES_BACKUP_EXPECTED_NEON_TENANT_ID-}" &&
        -z "${POSTGRES_BACKUP_EXPECTED_NEON_TIMELINE_ID-}" ]] ||
        die "Lokaler postgres-Vertrag darf keine Neon-Identitaet behaupten"
      require_value POSTGRES_BACKUP_EXPECTED_SYSTEM_IDENTIFIER
      [[ "$POSTGRES_BACKUP_EXPECTED_SYSTEM_IDENTIFIER" =~ ^[1-9][0-9]{9,19}$ ]] ||
        die "POSTGRES_BACKUP_EXPECTED_SYSTEM_IDENTIFIER ist ungueltig"
      ;;
    *) die "POSTGRES_BACKUP_PROVIDER muss neon oder postgres sein" ;;
  esac

  [[ "$POSTGRES_BACKUP_SSLMODE" == "verify-full" ]] ||
    die "POSTGRES_BACKUP_SSLMODE muss verify-full sein"
  [[ "$POSTGRES_BACKUP_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}[A-Za-z0-9]$ ]] ||
    die "POSTGRES_BACKUP_HOST ist ungueltig"
  [[ "$POSTGRES_BACKUP_HOST" != *-[Pp][Oo][Oo][Ll][Ee][Rr]* ]] ||
    die "POSTGRES_BACKUP_HOST muss ein direkter, ungepoolter Endpunkt sein"
  [[ "$POSTGRES_BACKUP_DATABASE" =~ ^[A-Za-z_][A-Za-z0-9_.-]{0,62}$ ]] ||
    die "POSTGRES_BACKUP_DATABASE ist ungueltig"
  [[ "$POSTGRES_BACKUP_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]{0,62}$ ]] ||
    die "POSTGRES_BACKUP_USER ist ungueltig"

  validate_absolute_path POSTGRES_BACKUP_PASSFILE
  validate_absolute_path POSTGRES_BACKUP_SSLROOTCERT
  validate_absolute_path BACKUP_LOCK_DIR
  [[ -f "$POSTGRES_BACKUP_PASSFILE" && ! -L "$POSTGRES_BACKUP_PASSFILE" ]] ||
    die "POSTGRES_BACKUP_PASSFILE muss eine regulaere, nicht verlinkte Datei sein"
  [[ -f "$POSTGRES_BACKUP_SSLROOTCERT" && ! -L "$POSTGRES_BACKUP_SSLROOTCERT" ]] ||
    die "POSTGRES_BACKUP_SSLROOTCERT muss eine regulaere, nicht verlinkte CA-Datei sein"

  local current_uid passfile_mode passfile_owner ca_mode ca_owner
  current_uid="$(id -u)"
  passfile_mode="$(read_file_mode "$POSTGRES_BACKUP_PASSFILE")"
  passfile_owner="$(read_file_owner "$POSTGRES_BACKUP_PASSFILE")"
  [[ "$passfile_mode" == "600" || "$passfile_mode" == "400" ]] ||
    die "POSTGRES_BACKUP_PASSFILE muss Modus 0600 oder 0400 haben"
  [[ "$passfile_owner" == "$current_uid" ]] ||
    die "POSTGRES_BACKUP_PASSFILE muss dem Cron-Benutzer gehoeren"
  validate_pgpass_mapping

  ca_mode="$(read_file_mode "$POSTGRES_BACKUP_SSLROOTCERT")"
  ca_owner="$(read_file_owner "$POSTGRES_BACKUP_SSLROOTCERT")"
  [[ "$ca_mode" =~ ^[0-7]{3,4}$ ]] || die "CA-Dateimodus ist nicht attestierbar"
  (( (8#$ca_mode & 8#022) == 0 )) ||
    die "POSTGRES_BACKUP_SSLROOTCERT darf nicht gruppen-/weltbeschreibbar sein"
  [[ "$ca_owner" == "0" || "$ca_owner" == "$current_uid" ]] ||
    die "POSTGRES_BACKUP_SSLROOTCERT muss root oder dem Cron-Benutzer gehoeren"

  [[ "$S3_BACKUP_ENDPOINT" =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]{0,252}[A-Za-z0-9]$ ]] ||
    die "S3_BACKUP_ENDPOINT muss eine pfadlose HTTPS-URL sein"
  [[ "$S3_BACKUP_REGION" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] ||
    die "S3_BACKUP_REGION ist ungueltig"
  [[ "$S3_BACKUP_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ &&
    "$S3_BACKUP_BUCKET" != *".."* && "$S3_BACKUP_BUCKET" != *".-"* &&
    "$S3_BACKUP_BUCKET" != *"-."* ]] || die "S3_BACKUP_BUCKET ist ungueltig"
  [[ "$S3_BACKUP_EXPECTED_OBJECT_LOCK_MODE" == "GOVERNANCE" ||
    "$S3_BACKUP_EXPECTED_OBJECT_LOCK_MODE" == "COMPLIANCE" ]] ||
    die "S3_BACKUP_EXPECTED_OBJECT_LOCK_MODE muss GOVERNANCE oder COMPLIANCE sein"
  [[ "$AGE_PUBLIC_KEY" =~ ^age1[0-9a-z]{58}$ ]] || die "AGE_PUBLIC_KEY ist ungueltig"
  [[ "$BACKUP_DEAD_MAN_URL" =~ ^https://[A-Za-z0-9][A-Za-z0-9.-]{0,252}/[A-Za-z0-9._~%:/+-]+$ &&
    "$BACKUP_DEAD_MAN_URL" != */ ]] ||
    die "BACKUP_DEAD_MAN_URL muss eine HTTPS-Ping-URL sein"

  case "$S3_BACKUP_LIFECYCLE_READBACK" in
    required)
      for name in \
        S3_BACKUP_EXPECTED_LIFECYCLE_RULE_ID \
        S3_BACKUP_EXPECTED_LIFECYCLE_PREFIX \
        S3_BACKUP_EXPECTED_LIFECYCLE_CURRENT_DAYS \
        S3_BACKUP_EXPECTED_LIFECYCLE_NONCURRENT_DAYS; do
        require_value "$name"
      done
      require_integer S3_BACKUP_EXPECTED_LIFECYCLE_CURRENT_DAYS 1 36500
      require_integer S3_BACKUP_EXPECTED_LIFECYCLE_NONCURRENT_DAYS 1 36500
      [[ "$S3_BACKUP_EXPECTED_LIFECYCLE_RULE_ID" =~ ^[A-Za-z0-9._-]{1,255}$ ]] ||
        die "S3_BACKUP_EXPECTED_LIFECYCLE_RULE_ID ist ungueltig"
      [[ "$S3_BACKUP_EXPECTED_LIFECYCLE_PREFIX" =~ ^[A-Za-z0-9._/-]+/$ &&
        "$S3_BACKUP_EXPECTED_LIFECYCLE_PREFIX" != /* &&
        "$S3_BACKUP_EXPECTED_LIFECYCLE_PREFIX" != *".."* &&
        "$S3_BACKUP_EXPECTED_LIFECYCLE_PREFIX" != *"//"* ]] ||
        die "S3_BACKUP_EXPECTED_LIFECYCLE_PREFIX ist ungueltig"
      [[ "$S3_BACKUP_EXPECTED_LIFECYCLE_PREFIX" == "$BACKUP_OBJECT_PREFIX" ]] ||
        die "S3_BACKUP_EXPECTED_LIFECYCLE_PREFIX muss exakt ${BACKUP_OBJECT_PREFIX} sein"
      [[ -z "${S3_BACKUP_LIFECYCLE_UNSUPPORTED_EVIDENCE_ID-}" ]] ||
        die "Lifecycle-Evidence-ID muss im required-Modus leer sein"
      ;;
    provider-unsupported)
      require_value S3_BACKUP_LIFECYCLE_UNSUPPORTED_EVIDENCE_ID
      [[ "$S3_BACKUP_LIFECYCLE_UNSUPPORTED_EVIDENCE_ID" =~ ^[A-Za-z0-9._:-]{8,255}$ ]] ||
        die "Lifecycle-Evidence-ID ist ungueltig"
      for name in \
        S3_BACKUP_EXPECTED_LIFECYCLE_RULE_ID \
        S3_BACKUP_EXPECTED_LIFECYCLE_PREFIX \
        S3_BACKUP_EXPECTED_LIFECYCLE_CURRENT_DAYS \
        S3_BACKUP_EXPECTED_LIFECYCLE_NONCURRENT_DAYS; do
        [[ -z "${!name-}" ]] || die "${name} muss bei provider-unsupported leer sein"
      done
      ;;
    *) die "S3_BACKUP_LIFECYCLE_READBACK muss required oder provider-unsupported sein" ;;
  esac

  for name in psql pg_dump zstd age aws curl timeout stat id date mktemp mkdir rmdir rm \
    sha256sum openssl /bin/bash env; do
    require_command "$name"
  done
  local psql_version pg_dump_version aws_version
  date --version >/dev/null 2>&1 || die "GNU coreutils date ist erforderlich"
  timeout --version >/dev/null 2>&1 || die "GNU coreutils timeout ist erforderlich"
  psql_version="$(env -i PATH="$PATH" psql --version 2>/dev/null)" ||
    die "psql-Version ist nicht attestierbar"
  pg_dump_version="$(env -i PATH="$PATH" pg_dump --version 2>/dev/null)" ||
    die "pg_dump-Version ist nicht attestierbar"
  aws_version="$(env -i PATH="$PATH" aws --version 2>&1)" ||
    die "AWS-CLI-Version ist nicht attestierbar"
  [[ "$psql_version" =~ ^psql\ \(PostgreSQL\)\ 18\. ]] ||
    die "PostgreSQL-18-Client psql ist erforderlich"
  [[ "$pg_dump_version" =~ ^pg_dump\ \(PostgreSQL\)\ 18\. ]] ||
    die "PostgreSQL-18-Client pg_dump ist erforderlich"
  [[ "$aws_version" =~ ^aws-cli/2\. ]] || die "AWS CLI v2 ist erforderlich"
}

send_dead_man() {
  local event="$1"
  local url
  case "$event" in
    start) url="${BACKUP_DEAD_MAN_URL}/start" ;;
    success) url="$BACKUP_DEAD_MAN_URL" ;;
    fail) url="${BACKUP_DEAD_MAN_URL}/fail" ;;
    *) return 2 ;;
  esac
  printf 'url = "%s"\n' "$url" |
    env -i PATH="$PATH" curl --config - --request POST --fail --silent \
      --max-time 10 --output /dev/null
}

postgres_command() {
  env -i \
    PATH="$PATH" \
    PGHOST="$POSTGRES_BACKUP_HOST" \
    PGPORT="$POSTGRES_BACKUP_PORT" \
    PGDATABASE="$POSTGRES_BACKUP_DATABASE" \
    PGUSER="$POSTGRES_BACKUP_USER" \
    PGPASSFILE="$POSTGRES_BACKUP_PASSFILE" \
    PGSSLMODE="$POSTGRES_BACKUP_SSLMODE" \
    PGSSLROOTCERT="$POSTGRES_BACKUP_SSLROOTCERT" \
    PGCONNECT_TIMEOUT=10 \
    PGAPPNAME=energie-saas-backup \
    "$@"
}

attest_database_target() {
  local actual expected_tenant expected_timeline expected_system_identifier target_query
  if [[ "$POSTGRES_BACKUP_PROVIDER" == "postgres" ]]; then
    target_query="select current_user, current_database(), current_setting('server_version_num'),
            '-', '-', (pg_catalog.pg_control_system()).system_identifier::text"
  else
    target_query="select current_user, current_database(), current_setting('server_version_num'),
            coalesce(current_setting('neon.tenant_id', true), '-'),
            coalesce(current_setting('neon.timeline_id', true), '-'), '-'"
  fi
  actual="$(postgres_command psql -X --no-psqlrc --set=ON_ERROR_STOP=1 \
    --tuples-only --no-align --field-separator='|' --command "$target_query")" ||
    die "serverseitige Backup-Zielattestierung ist fehlgeschlagen"
  expected_tenant="-"
  expected_timeline="-"
  expected_system_identifier="${POSTGRES_BACKUP_EXPECTED_SYSTEM_IDENTIFIER--}"
  if [[ "$POSTGRES_BACKUP_PROVIDER" == "neon" ]]; then
    expected_tenant="$POSTGRES_BACKUP_EXPECTED_NEON_TENANT_ID"
    expected_timeline="$POSTGRES_BACKUP_EXPECTED_NEON_TIMELINE_ID"
    expected_system_identifier="-"
  fi
  IFS='|' read -r BACKUP_ATTESTED_USER BACKUP_ATTESTED_DATABASE \
    BACKUP_ATTESTED_SERVER_VERSION BACKUP_ATTESTED_TENANT BACKUP_ATTESTED_TIMELINE \
    BACKUP_ATTESTED_SYSTEM_IDENTIFIER <<< "$actual"
  [[ "$BACKUP_ATTESTED_USER" == "$POSTGRES_BACKUP_USER" &&
    "$BACKUP_ATTESTED_DATABASE" == "$POSTGRES_BACKUP_DATABASE" &&
    "$BACKUP_ATTESTED_SERVER_VERSION" =~ ^18[0-9]{4}$ &&
    "$BACKUP_ATTESTED_TENANT" == "$expected_tenant" &&
    "$BACKUP_ATTESTED_TIMELINE" == "$expected_timeline" &&
    "$BACKUP_ATTESTED_SYSTEM_IDENTIFIER" == "$expected_system_identifier" ]] ||
    die "Backup-Ziel ist nicht exakt der erwartete PG18-Principal/Branch"
  export BACKUP_ATTESTED_USER BACKUP_ATTESTED_DATABASE BACKUP_ATTESTED_SERVER_VERSION
  export BACKUP_ATTESTED_TENANT BACKUP_ATTESTED_TIMELINE
  export BACKUP_ATTESTED_SYSTEM_IDENTIFIER
}

aws_readback() {
  env -i \
    PATH="$PATH" \
    AWS_ACCESS_KEY_ID="$BACKUP_AWS_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$BACKUP_AWS_SECRET_ACCESS_KEY" \
    AWS_REGION="$S3_BACKUP_REGION" \
    AWS_DEFAULT_REGION="$S3_BACKUP_REGION" \
    AWS_EC2_METADATA_DISABLED=true \
    AWS_PAGER= \
    aws "$@" --endpoint-url "$S3_BACKUP_ENDPOINT"
}

assert_s3_value() {
  local label="$1" expected="$2"
  shift 2
  local actual
  actual="$(aws_readback "$@" 2>/dev/null)" || die "${label}-Readback ist fehlgeschlagen"
  [[ "$actual" == "$expected" ]] || die "${label} weicht vom erwarteten Vertrag ab"
}

attest_bucket_contract() {
  assert_s3_value "Object Lock" "Enabled" s3api get-object-lock-configuration \
    --bucket "$S3_BACKUP_BUCKET" \
    --query 'ObjectLockConfiguration.ObjectLockEnabled' --output text
  assert_s3_value "Default-Retention-Modus" "$S3_BACKUP_EXPECTED_OBJECT_LOCK_MODE" \
    s3api get-object-lock-configuration --bucket "$S3_BACKUP_BUCKET" \
    --query 'ObjectLockConfiguration.Rule.DefaultRetention.Mode' --output text
  assert_s3_value "Default-Retention-Tage" "$S3_BACKUP_EXPECTED_RETENTION_DAYS" \
    s3api get-object-lock-configuration --bucket "$S3_BACKUP_BUCKET" \
    --query 'ObjectLockConfiguration.Rule.DefaultRetention.Days' --output text
  assert_s3_value "Default-Retention-Jahre" "None" \
    s3api get-object-lock-configuration --bucket "$S3_BACKUP_BUCKET" \
    --query 'ObjectLockConfiguration.Rule.DefaultRetention.Years' --output text
  assert_s3_value "Bucket-Versioning" "Enabled" s3api get-bucket-versioning \
    --bucket "$S3_BACKUP_BUCKET" --query 'Status' --output text

  if [[ "$S3_BACKUP_LIFECYCLE_READBACK" == "required" ]]; then
    local selector="Rules[?ID=='${S3_BACKUP_EXPECTED_LIFECYCLE_RULE_ID}']"
    assert_s3_value "aktive Lifecycle-Regelanzahl" "1" \
      s3api get-bucket-lifecycle-configuration --bucket "$S3_BACKUP_BUCKET" \
      --query "length(Rules[?Status=='Enabled'])" --output text
    assert_s3_value "Lifecycle-Regelanzahl" "1" \
      s3api get-bucket-lifecycle-configuration --bucket "$S3_BACKUP_BUCKET" \
      --query "length(${selector})" --output text
    assert_s3_value "Lifecycle-Status" "Enabled" \
      s3api get-bucket-lifecycle-configuration --bucket "$S3_BACKUP_BUCKET" \
      --query "${selector}.Status | [0]" --output text
    assert_s3_value "Lifecycle-Prefix" "$S3_BACKUP_EXPECTED_LIFECYCLE_PREFIX" \
      s3api get-bucket-lifecycle-configuration --bucket "$S3_BACKUP_BUCKET" \
      --query "${selector}.Filter.Prefix | [0]" --output text
    assert_s3_value "Lifecycle-Expiration" "$S3_BACKUP_EXPECTED_LIFECYCLE_CURRENT_DAYS" \
      s3api get-bucket-lifecycle-configuration --bucket "$S3_BACKUP_BUCKET" \
      --query "${selector}.Expiration.Days | [0]" --output text
    assert_s3_value "Lifecycle-Noncurrent-Expiration" \
      "$S3_BACKUP_EXPECTED_LIFECYCLE_NONCURRENT_DAYS" \
      s3api get-bucket-lifecycle-configuration --bucket "$S3_BACKUP_BUCKET" \
      --query "${selector}.NoncurrentVersionExpiration.NoncurrentDays | [0]" --output text
    assert_s3_value "Lifecycle-Transitions" "0" \
      s3api get-bucket-lifecycle-configuration --bucket "$S3_BACKUP_BUCKET" \
      --query "length(${selector}.Transitions[])" --output text
    assert_s3_value "Lifecycle-Noncurrent-Transitions" "0" \
      s3api get-bucket-lifecycle-configuration --bucket "$S3_BACKUP_BUCKET" \
      --query "length(${selector}.NoncurrentVersionTransitions[])" --output text
  fi
}

sha256_file() {
  local output=""
  output="$(env -i PATH="$PATH" sha256sum -- "$1")" ||
    die "SHA256-Berechnung ist fehlgeschlagen"
  [[ "$output" != *$'\n'* &&
    "$output" =~ ^([0-9a-f]{64})[[:space:]][[:space:]](.+)$ &&
    "${BASH_REMATCH[2]}" == "$1" ]] ||
    die "SHA256-Ausgabe ist nicht exakt an das Artefakt gebunden"
  printf '%s\n' "${BASH_REMATCH[1]}"
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  printf '%s' "$value"
}

upload_and_attest() {
  local file="$1" key="$2" expected_sha="$3" content_type="$4"
  local size checksum_b64 started_epoch finished_epoch version_id actual retain_until
  local retain_epoch minimum_epoch maximum_epoch
  size="$(read_file_size "$file")"
  [[ "$key" == "$BACKUP_OBJECT_PREFIX"* && "$key" != "$BACKUP_OBJECT_PREFIX" ]] ||
    die "Backup-Objektschluessel liegt nicht unter ${BACKUP_OBJECT_PREFIX}"
  [[ "$size" =~ ^[0-9]+$ && "$size" -gt 0 && "$size" -le "$BACKUP_SINGLE_PUT_MAX_BYTES" ]] ||
    die "Backup-Objekt ist leer oder ueberschreitet das 5-GiB-Single-Put-Limit"
  checksum_b64="$(openssl dgst -sha256 -binary "$file" | openssl base64 -A)"
  [[ -n "$checksum_b64" ]] || die "SHA256-Checksumme konnte nicht kodiert werden"

  attest_bucket_contract
  started_epoch="$(date -u +%s)"
  version_id="$(aws_readback s3api put-object \
    --bucket "$S3_BACKUP_BUCKET" --key "$key" --body "$file" \
    --content-type "$content_type" --metadata "sha256=${expected_sha}" \
    --checksum-algorithm SHA256 --checksum-sha256 "$checksum_b64" \
    --query 'VersionId' --output text 2>/dev/null)" || die "S3-PutObject ist fehlgeschlagen"
  finished_epoch="$(date -u +%s)"
  [[ -n "$version_id" && "$version_id" != "None" && "$version_id" != "null" &&
    "$version_id" != *[[:cntrl:]]* ]] || die "Upload lieferte keine exakte VersionId"

  actual="$(aws_readback s3api head-object --bucket "$S3_BACKUP_BUCKET" --key "$key" \
    --version-id "$version_id" --query 'VersionId' --output text 2>/dev/null)" ||
    die "VersionId-Postreadback ist fehlgeschlagen"
  [[ "$actual" == "$version_id" ]] || die "Postreadback verweist auf eine andere VersionId"
  assert_s3_value "Objektgroesse" "$size" s3api head-object \
    --bucket "$S3_BACKUP_BUCKET" --key "$key" --version-id "$version_id" \
    --query 'ContentLength' --output text
  assert_s3_value "Objekt-SHA256-Metadatum" "$expected_sha" s3api head-object \
    --bucket "$S3_BACKUP_BUCKET" --key "$key" --version-id "$version_id" \
    --query 'Metadata.sha256' --output text
  assert_s3_value "Objekt-SHA256-Checksumme" "$checksum_b64" s3api head-object \
    --bucket "$S3_BACKUP_BUCKET" --key "$key" --version-id "$version_id" \
    --checksum-mode ENABLED --query 'ChecksumSHA256' --output text
  assert_s3_value "Objekt-Retention-Modus" "$S3_BACKUP_EXPECTED_OBJECT_LOCK_MODE" \
    s3api get-object-retention --bucket "$S3_BACKUP_BUCKET" --key "$key" \
    --version-id "$version_id" --query 'Retention.Mode' --output text
  retain_until="$(aws_readback s3api get-object-retention --bucket "$S3_BACKUP_BUCKET" \
    --key "$key" --version-id "$version_id" --query 'Retention.RetainUntilDate' \
    --output text 2>/dev/null)" || die "RetainUntilDate-Postreadback ist fehlgeschlagen"
  [[ "$retain_until" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+]00:00)$ ]] ||
    die "RetainUntilDate ist nicht kanonisch"
  retain_epoch="$(date -u --date="$retain_until" +%s 2>/dev/null)" ||
    die "RetainUntilDate ist nicht parsebar"
  minimum_epoch=$((started_epoch + 10#$S3_BACKUP_EXPECTED_RETENTION_DAYS * 86400 - BACKUP_RETENTION_SKEW_SECONDS))
  maximum_epoch=$((finished_epoch + 10#$S3_BACKUP_EXPECTED_RETENTION_DAYS * 86400 + BACKUP_RETENTION_SKEW_SECONDS))
  (( retain_epoch >= minimum_epoch && retain_epoch <= maximum_epoch )) ||
    die "Exakte Objekt-Retention liegt ausserhalb des erwarteten Tagesvertrags"

  UPLOADED_VERSION_ID="$version_id"
  UPLOADED_RETAIN_UNTIL="$retain_until"
}

validate_internal_paths() {
  [[ "$BACKUP_INTERNAL_TMP" =~ ^/tmp/energie-saas-backup\.[A-Za-z0-9]+$ &&
    "$BACKUP_INTERNAL_TMP" == "$BACKUP_TEMP_PREFIX"* &&
    -d "$BACKUP_INTERNAL_TMP" && ! -L "$BACKUP_INTERNAL_TMP" ]] ||
    die "interner Temp-Pfad verletzt die Backup-Invariante"
  [[ "$(read_file_owner "$BACKUP_INTERNAL_TMP")" == "$(id -u)" &&
    "$(read_file_mode "$BACKUP_INTERNAL_TMP")" == "700" ]] ||
    die "interner Temp-Pfad besitzt falschen Owner/Modus"
  [[ -f "$BACKUP_INTERNAL_MARKER" && ! -L "$BACKUP_INTERNAL_MARKER" &&
    "$BACKUP_INTERNAL_MARKER" == "$BACKUP_INTERNAL_TMP/.owned-by-backup" ]] ||
    die "interne One-use-Markierung fehlt"
  [[ "$BACKUP_INTERNAL_STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] ||
    die "interner Zeitstempel ist ungueltig"
  [[ "$BACKUP_INTERNAL_OUTPUT" == "$BACKUP_INTERNAL_TMP/pg-${BACKUP_INTERNAL_STAMP}.sql.zst.age" &&
    "$BACKUP_INTERNAL_MANIFEST" == "$BACKUP_INTERNAL_TMP/pg-${BACKUP_INTERNAL_STAMP}.manifest.json" ]] ||
    die "interne Ausgabepfade sind nicht exakt gebunden"
  [[ ! -e "$BACKUP_INTERNAL_OUTPUT" && ! -e "$BACKUP_INTERNAL_MANIFEST" ]] ||
    die "interne Ausgabedatei existiert bereits"
  rm -f -- "$BACKUP_INTERNAL_MARKER"
}

run_validated_payload() {
  set +x
  validate_internal_paths
  BACKUP_AWS_ACCESS_KEY_ID="$S3_BACKUP_ACCESS_KEY_ID"
  BACKUP_AWS_SECRET_ACCESS_KEY="$S3_BACKUP_SECRET_ACCESS_KEY"
  unset S3_BACKUP_ACCESS_KEY_ID S3_BACKUP_SECRET_ACCESS_KEY BACKUP_DEAD_MAN_URL
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
  unset AWS_DEFAULT_PROFILE AWS_CONFIG_FILE AWS_SHARED_CREDENTIALS_FILE
  unset AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE AWS_ENDPOINT_URL AWS_ENDPOINT_URL_S3
  unset PGPASSWORD PGOPTIONS PGSERVICE PGSERVICEFILE PGREQUIRESSL PGHOSTADDR
  unset PGSSLCERT PGSSLKEY PGSSLCRL PGSSLCRLDIR PGSSLROOTCERT PGCHANNELBINDING
  unset PGTARGETSESSIONATTRS BASH_ENV ENV

  attest_database_target
  attest_bucket_contract
  postgres_command pg_dump --no-owner --no-privileges |
    env -i PATH="$PATH" zstd -q -T0 |
    env -i PATH="$PATH" age -r "$AGE_PUBLIC_KEY" -o "$BACKUP_INTERNAL_OUTPUT"
  [[ -s "$BACKUP_INTERNAL_OUTPUT" ]] || die "verschluesseltes Backup-Artefakt ist leer"
  attest_database_target

  local artifact_sha artifact_size artifact_key manifest_key manifest_sha
  local artifact_version artifact_retain manifest_version manifest_retain
  artifact_sha="$(sha256_file "$BACKUP_INTERNAL_OUTPUT")"
  [[ "$artifact_sha" =~ ^[0-9a-f]{64}$ ]] || die "Artefakt-SHA256 ist ungueltig"
  artifact_size="$(read_file_size "$BACKUP_INTERNAL_OUTPUT")"
  artifact_key="${BACKUP_OBJECT_PREFIX}${BACKUP_INTERNAL_STAMP}-${artifact_sha}.sql.zst.age"
  upload_and_attest "$BACKUP_INTERNAL_OUTPUT" "$artifact_key" "$artifact_sha" \
    "application/octet-stream"
  artifact_version="$UPLOADED_VERSION_ID"
  artifact_retain="$UPLOADED_RETAIN_UNTIL"

  printf '{\n' > "$BACKUP_INTERNAL_MANIFEST"
  printf '  "schema":"energie-saas.backup-manifest.v1",\n' >> "$BACKUP_INTERNAL_MANIFEST"
  printf '  "createdAt":"%s",\n' "$(json_escape "$BACKUP_INTERNAL_STAMP")" >> "$BACKUP_INTERNAL_MANIFEST"
  printf '  "provider":"%s",\n' "$(json_escape "$POSTGRES_BACKUP_PROVIDER")" >> "$BACKUP_INTERNAL_MANIFEST"
  printf '  "database":"%s",\n' "$(json_escape "$BACKUP_ATTESTED_DATABASE")" >> "$BACKUP_INTERNAL_MANIFEST"
  printf '  "principal":"%s",\n' "$(json_escape "$BACKUP_ATTESTED_USER")" >> "$BACKUP_INTERNAL_MANIFEST"
  printf '  "serverVersionNum":"%s",\n' "$BACKUP_ATTESTED_SERVER_VERSION" >> "$BACKUP_INTERNAL_MANIFEST"
  printf '  "systemIdentifier":"%s",\n' \
    "$(json_escape "$BACKUP_ATTESTED_SYSTEM_IDENTIFIER")" >> "$BACKUP_INTERNAL_MANIFEST"
  printf '  "neonTenantId":"%s",\n' "$(json_escape "$BACKUP_ATTESTED_TENANT")" >> "$BACKUP_INTERNAL_MANIFEST"
  printf '  "neonTimelineId":"%s",\n' "$(json_escape "$BACKUP_ATTESTED_TIMELINE")" >> "$BACKUP_INTERNAL_MANIFEST"
  printf '  "artifact":{"key":"%s","versionId":"%s","sha256":"%s","bytes":%s,' \
    "$(json_escape "$artifact_key")" "$(json_escape "$artifact_version")" "$artifact_sha" "$artifact_size" \
    >> "$BACKUP_INTERNAL_MANIFEST"
  printf '"retentionMode":"%s","retainUntil":"%s"}\n' \
    "$S3_BACKUP_EXPECTED_OBJECT_LOCK_MODE" "$(json_escape "$artifact_retain")" \
    >> "$BACKUP_INTERNAL_MANIFEST"
  printf '}\n' >> "$BACKUP_INTERNAL_MANIFEST"
  manifest_sha="$(sha256_file "$BACKUP_INTERNAL_MANIFEST")"
  [[ "$manifest_sha" =~ ^[0-9a-f]{64}$ ]] || die "Manifest-SHA256 ist ungueltig"
  manifest_key="${BACKUP_OBJECT_PREFIX}${BACKUP_INTERNAL_STAMP}-${artifact_sha}.manifest.json"
  upload_and_attest "$BACKUP_INTERNAL_MANIFEST" "$manifest_key" "$manifest_sha" \
    "application/json"
  manifest_version="$UPLOADED_VERSION_ID"
  manifest_retain="$UPLOADED_RETAIN_UNTIL"
  printf '[backup] evidence: artifact_key=%s artifact_version=%s artifact_sha256=%s ' \
    "$artifact_key" "$artifact_version" "$artifact_sha"
  printf 'artifact_retain_until=%s manifest_key=%s manifest_version=%s ' \
    "$artifact_retain" "$manifest_key" "$manifest_version"
  printf 'manifest_sha256=%s manifest_retain_until=%s\n' \
    "$manifest_sha" "$manifest_retain"
}

[[ "$#" -eq 0 ]] || die "dieses Script akzeptiert keine Argumente"
validate_environment

LOCK_ACQUIRED=0
DEAD_MAN_STARTED=0
BACKUP_SUCCEEDED=0
BACKUP_TMP=""
BACKUP_INTERNAL_OUTPUT=""
BACKUP_INTERNAL_MANIFEST=""
BACKUP_INTERNAL_MARKER=""
PAYLOAD_PID=""

safe_cleanup_tmp() {
  [[ -n "$BACKUP_TMP" ]] || return 0
  if [[ ! "$BACKUP_TMP" =~ ^/tmp/energie-saas-backup\.[A-Za-z0-9]+$ ||
    "$BACKUP_TMP" != "$BACKUP_TEMP_PREFIX"* || ! -d "$BACKUP_TMP" || -L "$BACKUP_TMP" ||
    "$(read_file_owner "$BACKUP_TMP")" != "$(id -u)" ]]; then
    echo "[backup] Temp-Invariante verletzt; keine rekursive Loeschung ausgefuehrt" >&2
    return 1
  fi
  rm -f -- "$BACKUP_INTERNAL_OUTPUT" "$BACKUP_INTERNAL_MANIFEST" "$BACKUP_INTERNAL_MARKER"
  rmdir "$BACKUP_TMP"
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [[ -n "$PAYLOAD_PID" ]] && kill -0 "$PAYLOAD_PID" 2>/dev/null; then
    kill -TERM "$PAYLOAD_PID" 2>/dev/null
    wait "$PAYLOAD_PID" 2>/dev/null
  fi
  PAYLOAD_PID=""
  if [[ "$DEAD_MAN_STARTED" -eq 1 && "$BACKUP_SUCCEEDED" -eq 0 ]]; then
    send_dead_man fail || echo "[backup] Failure-Alarm konnte nicht zugestellt werden" >&2
  fi
  safe_cleanup_tmp || status=1
  if [[ "$LOCK_ACQUIRED" -eq 1 ]]; then
    rmdir "$BACKUP_LOCK_DIR" || {
      echo "[backup] eigener Host-Lock konnte nicht entfernt werden" >&2
      status=1
    }
  fi
  exit "$status"
}

forward_signal() {
  local signal="$1" code="$2"
  trap - HUP INT TERM
  if [[ -n "$PAYLOAD_PID" ]] && kill -0 "$PAYLOAD_PID" 2>/dev/null; then
    kill -"$signal" "$PAYLOAD_PID" 2>/dev/null || true
    wait "$PAYLOAD_PID" 2>/dev/null || true
    PAYLOAD_PID=""
  fi
  exit "$code"
}

if ! mkdir "$BACKUP_LOCK_DIR" 2>/dev/null; then
  die "Host-Lock ist bereits belegt; konkurrierender oder ungeklart abgebrochener Lauf"
fi
LOCK_ACQUIRED=1
trap cleanup EXIT
trap 'forward_signal HUP 129' HUP
trap 'forward_signal INT 130' INT
trap 'forward_signal TERM 143' TERM

BACKUP_TMP="$(mktemp -d "${BACKUP_TEMP_PREFIX}XXXXXXXX")"
readonly BACKUP_TMP
BACKUP_INTERNAL_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_INTERNAL_OUTPUT="$BACKUP_TMP/pg-${BACKUP_INTERNAL_STAMP}.sql.zst.age"
BACKUP_INTERNAL_MANIFEST="$BACKUP_TMP/pg-${BACKUP_INTERNAL_STAMP}.manifest.json"
BACKUP_INTERNAL_MARKER="$BACKUP_TMP/.owned-by-backup"
printf '%s\n' "$$" > "$BACKUP_INTERNAL_MARKER"
export BACKUP_INTERNAL_TMP="$BACKUP_TMP" BACKUP_INTERNAL_STAMP BACKUP_INTERNAL_OUTPUT
export BACKUP_INTERNAL_MANIFEST BACKUP_INTERNAL_MARKER BACKUP_TEMP_PREFIX
export BACKUP_OBJECT_PREFIX BACKUP_SINGLE_PUT_MAX_BYTES BACKUP_RETENTION_SKEW_SECONDS

DEAD_MAN_STARTED=1
send_dead_man start || die "Backup-Dead-Man-Start konnte nicht zugestellt werden"

export -f die read_file_mode read_file_owner read_file_size postgres_command
export -f attest_database_target aws_readback assert_s3_value attest_bucket_contract
export -f sha256_file json_escape upload_and_attest validate_internal_paths run_validated_payload

BASH_ENV= ENV= timeout \
  --signal=TERM \
  --kill-after="${BACKUP_KILL_AFTER_SECONDS}s" \
  "${BACKUP_TIMEOUT_SECONDS}s" \
  /bin/bash --noprofile --norc -c 'set +x; set -euo pipefail; run_validated_payload' &
PAYLOAD_PID=$!
set +e
wait "$PAYLOAD_PID"
PAYLOAD_STATUS=$?
set -e
PAYLOAD_PID=""

if [[ "$PAYLOAD_STATUS" -eq 124 || "$PAYLOAD_STATUS" -eq 137 ]]; then
  die "harter Payload-Timeout wurde erreicht"
fi
[[ "$PAYLOAD_STATUS" -eq 0 ]] ||
  die "Backup-Pipeline, Ziel- oder Objekt-Attestierung ist fehlgeschlagen"

send_dead_man success || die "Backup-Dead-Man-Success konnte nicht zugestellt werden"
BACKUP_SUCCEEDED=1
echo "[backup] ok: ${BACKUP_INTERNAL_STAMP}; exakte Objektversionen attestiert"
