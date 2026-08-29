import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const backupScript = resolve("worker/backup/backup.sh");
const temporaryRoots: string[] = [];

interface Harness {
  root: string;
  lockDir: string;
  env: NodeJS.ProcessEnv;
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
  await chmod(path, 0o755);
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "energie-backup-test-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  const passfile = join(root, "backup.pgpass");
  const caFile = join(root, "root-ca.pem");
  const lockDir = join(root, "backup.lock");
  await mkdir(bin);
  await writeFile(passfile, "db.example.test:5432:energie:app_backup:db-password-private\n");
  await chmod(passfile, 0o600);
  await writeFile(caFile, "test-ca\n");
  await Promise.all([
    writeFile(join(root, "object-lock-enabled"), "Enabled\n"),
    writeFile(join(root, "retention-mode"), "GOVERNANCE\n"),
    writeFile(join(root, "retention-days"), "30\n"),
    writeFile(join(root, "retention-years"), "None\n"),
    writeFile(join(root, "versioning"), "Enabled\n"),
    writeFile(join(root, "lifecycle-count"), "1\n"),
    writeFile(join(root, "lifecycle-enabled-count"), "1\n"),
    writeFile(join(root, "lifecycle"), "Enabled\n"),
    writeFile(join(root, "lifecycle-prefix"), "pg/\n"),
    writeFile(join(root, "lifecycle-current-days"), "30\n"),
    writeFile(join(root, "lifecycle-noncurrent-days"), "30\n"),
    writeFile(join(root, "lifecycle-transitions"), "0\n"),
    writeFile(join(root, "lifecycle-noncurrent-transitions"), "0\n"),
    writeFile(join(root, "object-retention-mode"), "GOVERNANCE\n"),
    writeFile(join(root, "object-retain-until"), "2026-09-28T04:00:00Z\n"),
    writeFile(
      join(root, "db-target"),
      "app_backup|energie|180000|-|-|7460000000000000000\n",
    ),
  ]);

  const mockPrelude = String.raw`
MOCK_BIN="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
MOCK_ROOT="§{MOCK_BIN}/.."
record() { printf '%s\n' "$1" >> "§{MOCK_ROOT}/events"; }
for argument in "$@"; do
  case "$argument" in
    *backup-secret-private*|*db-password-private*|*deadman-private-token*) exit 91 ;;
  esac
done
`.replaceAll("§", "$");
  const withPrelude = (body: string) => `${mockPrelude}\n${body.replaceAll("§", "$")}`;

  await writeExecutable(
    join(bin, "date"),
    withPrelude(String.raw`
if [[ "§{1-}" == "--version" ]]; then
  printf '%s\n' 'date (GNU coreutils) test'
elif [[ "$*" == "-u +%Y%m%dT%H%M%SZ" ]]; then
  printf '%s\n' '20260829T040000Z'
elif [[ "$*" == "-u +%s" ]]; then
  printf '%s\n' '1787976000'
elif [[ "$*" == *"--date="*"+%s"* ]]; then
  if [[ -f "§{MOCK_ROOT}/bad-retention" ]]; then
    printf '%s\n' '1791000000'
  else
    printf '%s\n' '1790568000'
  fi
else
  exit 94
fi
`),
  );

  await writeExecutable(
    join(bin, "psql"),
    withPrelude(String.raw`
if [[ "§{1-}" == "--version" ]]; then
  printf '%s\n' 'psql (PostgreSQL) 18.0'
  exit 0
fi
[[ -z "§{AWS_SECRET_ACCESS_KEY-}" ]]
[[ -z "§{S3_BACKUP_SECRET_ACCESS_KEY-}" ]]
[[ -z "§{BACKUP_DEAD_MAN_URL-}" ]]
[[ "§{PGUSER-}" == "app_backup" ]]
[[ "§{PGDATABASE-}" == "energie" ]]
[[ "$*" == *"pg_catalog.pg_control_system()"* ]]
record "db:attest"
cat "§{MOCK_ROOT}/db-target"
`),
  );

  await writeExecutable(
    join(bin, "sha256sum"),
    withPrelude(String.raw`
[[ "§{1-}" == "--" ]]
shift
[[ -f "§{1-}" ]]
printf '%s  %s\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' "§1"
if [[ -f "§{MOCK_ROOT}/bad-sha-exit" ]]; then exit 96; fi
`),
  );

  await writeExecutable(
    join(bin, "openssl"),
    withPrelude(String.raw`
if [[ "§{1-}" == "dgst" ]]; then
  printf '%s' 'test-checksum-bytes'
elif [[ "§{1-}" == "base64" ]]; then
  cat >/dev/null
  printf '%s' 'checksum-base64'
else
  exit 95
fi
`),
  );

  await writeExecutable(
    join(bin, "curl"),
    withPrelude(String.raw`
[[ -z "§{AWS_SECRET_ACCESS_KEY-}" ]]
[[ -z "§{S3_BACKUP_SECRET_ACCESS_KEY-}" ]]
[[ -z "§{POSTGRES_BACKUP_PASSFILE-}" ]]
config="$(cat)"
case "$config" in
  *deadman-private-token/start*) record "deadman:start" ;;
  *deadman-private-token/fail*) record "deadman:fail" ;;
  *deadman-private-token*) record "deadman:success" ;;
  *) exit 92 ;;
esac
`),
  );

  await writeExecutable(
    join(bin, "timeout"),
    withPrelude(String.raw`
if [[ "§{1-}" == "--version" ]]; then
  printf '%s\n' 'timeout (GNU coreutils) test'
  exit 0
fi
record "timeout:$*"
if [[ -f "§{MOCK_ROOT}/force-timeout" ]]; then
  exit 124
fi
while [[ "§{1-}" == --* ]]; do shift; done
[[ "§{1-}" == *s ]]
shift
if [[ -f "§{MOCK_ROOT}/signal-mode" ]]; then
  descendant=""
  trap 'record "timeout:term"; kill -TERM "$descendant" 2>/dev/null || true; wait "$descendant" 2>/dev/null || true; exit 143' TERM
  (
    trap 'record "descendant:term"; exit 143' TERM
    while :; do /bin/sleep 1; done
  ) &
  descendant=$!
  printf '%s\n' "$descendant" > "§{MOCK_ROOT}/descendant-pid"
  : > "§{MOCK_ROOT}/signal-ready"
  wait "$descendant"
  exit $?
fi
exec "$@"
`),
  );

  await writeExecutable(
    join(bin, "aws"),
    withPrelude(String.raw`
if [[ "§{1-}" == "--version" ]]; then
  printf '%s\n' 'aws-cli/2.31.0 Python/3.13 test'
  exit 0
fi
[[ "§{AWS_ACCESS_KEY_ID-}" == "backup-access-private" ]]
[[ "§{AWS_SECRET_ACCESS_KEY-}" == "backup-secret-private" ]]
[[ -z "§{S3_BACKUP_SECRET_ACCESS_KEY-}" ]]
[[ -z "§{BACKUP_DEAD_MAN_URL-}" ]]
case "$*" in
  *"s3api put-object"*)
    body=""
    key=""
    metadata=""
    checksum=""
    while [[ "$#" -gt 0 ]]; do
      case "$1" in
        --body) body="$2"; shift 2 ;;
        --key) key="$2"; shift 2 ;;
        --metadata) metadata="$2"; shift 2 ;;
        --checksum-sha256) checksum="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [[ -n "$body" && -s "$body" && -n "$key" ]]
    [[ "$metadata" == sha256=* && "$checksum" == "checksum-base64" ]]
    count=0
    if [[ -f "§{MOCK_ROOT}/put-count" ]]; then count="$(cat "§{MOCK_ROOT}/put-count")"; fi
    count=$((count + 1))
    version="version-$count"
    printf '%s\n' "$count" > "§{MOCK_ROOT}/put-count"
    printf '%s\n' "$version" > "§{MOCK_ROOT}/last-version"
    /usr/bin/wc -c < "$body" | tr -d ' ' > "§{MOCK_ROOT}/last-size"
    printf '%s\n' "§{metadata#sha256=}" > "§{MOCK_ROOT}/last-sha"
    printf '%s\n' "$checksum" > "§{MOCK_ROOT}/last-checksum"
    printf '%s\n' "$key" > "§{MOCK_ROOT}/last-key"
    record "aws:put"
    printf '%s\n' "$version"
    ;;
  *ObjectLockConfiguration.ObjectLockEnabled*)
    record "aws:object-lock"
    cat "§{MOCK_ROOT}/object-lock-enabled"
    ;;
  *DefaultRetention.Mode*)
    record "aws:retention-mode"
    cat "§{MOCK_ROOT}/retention-mode"
    ;;
  *DefaultRetention.Days*)
    record "aws:retention-days"
    cat "§{MOCK_ROOT}/retention-days"
    ;;
  *DefaultRetention.Years*)
    record "aws:retention-years"
    cat "§{MOCK_ROOT}/retention-years"
    ;;
  *get-bucket-versioning*)
    record "aws:versioning"
    cat "§{MOCK_ROOT}/versioning"
    ;;
  *NoncurrentVersionTransitions*)
    record "aws:lifecycle-noncurrent-transitions"
    cat "§{MOCK_ROOT}/lifecycle-noncurrent-transitions"
    ;;
  *Transitions*)
    record "aws:lifecycle-transitions"
    cat "§{MOCK_ROOT}/lifecycle-transitions"
    ;;
  *Expiration.NoncurrentDays*)
    record "aws:lifecycle-noncurrent-days"
    cat "§{MOCK_ROOT}/lifecycle-noncurrent-days"
    ;;
  *Expiration.Days*)
    record "aws:lifecycle-current-days"
    cat "§{MOCK_ROOT}/lifecycle-current-days"
    ;;
  *Filter.Prefix*)
    record "aws:lifecycle-prefix"
    cat "§{MOCK_ROOT}/lifecycle-prefix"
    ;;
  *".Status | [0]"*)
    record "aws:lifecycle-status"
    cat "§{MOCK_ROOT}/lifecycle"
    ;;
  *"length(Rules[?Status=='Enabled'])"*)
    record "aws:lifecycle-enabled-count"
    cat "§{MOCK_ROOT}/lifecycle-enabled-count"
    ;;
  *"length(Rules"*)
    record "aws:lifecycle-count"
    cat "§{MOCK_ROOT}/lifecycle-count"
    ;;
  *"head-object"*"VersionId"*)
    [[ "$*" == *"--version-id $(cat "§{MOCK_ROOT}/last-version")"* ]]
    record "aws:head-version"
    if [[ -f "§{MOCK_ROOT}/bad-version" ]]; then
      printf '%s\n' 'wrong-version'
    else
      cat "§{MOCK_ROOT}/last-version"
    fi
    ;;
  *"head-object"*"ContentLength"*)
    [[ "$*" == *"--version-id $(cat "§{MOCK_ROOT}/last-version")"* ]]
    record "aws:head-size"
    cat "§{MOCK_ROOT}/last-size"
    ;;
  *"head-object"*"Metadata.sha256"*)
    [[ "$*" == *"--version-id $(cat "§{MOCK_ROOT}/last-version")"* ]]
    record "aws:head-sha"
    cat "§{MOCK_ROOT}/last-sha"
    ;;
  *"head-object"*"ChecksumSHA256"*)
    [[ "$*" == *"--checksum-mode ENABLED"* ]]
    [[ "$*" == *"--version-id $(cat "§{MOCK_ROOT}/last-version")"* ]]
    record "aws:head-checksum"
    if [[ -f "§{MOCK_ROOT}/bad-checksum" ]]; then
      printf '%s\n' 'wrong-checksum'
    else
      cat "§{MOCK_ROOT}/last-checksum"
    fi
    ;;
  *"get-object-retention"*"Retention.Mode"*)
    [[ "$*" == *"--version-id $(cat "§{MOCK_ROOT}/last-version")"* ]]
    record "aws:object-retention-mode"
    cat "§{MOCK_ROOT}/object-retention-mode"
    ;;
  *"get-object-retention"*"Retention.RetainUntilDate"*)
    [[ "$*" == *"--version-id $(cat "§{MOCK_ROOT}/last-version")"* ]]
    record "aws:object-retain-until"
    if [[ -f "§{MOCK_ROOT}/bad-retention" ]]; then
      printf '%s\n' '2026-10-03T04:00:00Z'
    else
      cat "§{MOCK_ROOT}/object-retain-until"
    fi
    ;;
  *) exit 93 ;;
esac
`),
  );

  await writeExecutable(
    join(bin, "pg_dump"),
    withPrelude(String.raw`
if [[ "§{1-}" == "--version" ]]; then
  printf '%s\n' 'pg_dump (PostgreSQL) 18.0'
  exit 0
fi
[[ -z "§{AWS_SECRET_ACCESS_KEY-}" ]]
[[ -z "§{S3_BACKUP_SECRET_ACCESS_KEY-}" ]]
[[ -z "§{BACKUP_DEAD_MAN_URL-}" ]]
[[ "§{PGSSLMODE-}" == "verify-full" ]]
record "pipeline:pg_dump"
printf '%s\n' 'logical-dump'
`),
  );
  await writeExecutable(
    join(bin, "zstd"),
    withPrelude(String.raw`
[[ -z "§{AWS_SECRET_ACCESS_KEY-}" ]]
[[ -z "§{S3_BACKUP_SECRET_ACCESS_KEY-}" ]]
record "pipeline:zstd"
cat
`),
  );
  await writeExecutable(
    join(bin, "age"),
    withPrelude(String.raw`
[[ -z "§{AWS_SECRET_ACCESS_KEY-}" ]]
[[ -z "§{S3_BACKUP_SECRET_ACCESS_KEY-}" ]]
output=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then output="$2"; shift 2; else shift; fi
done
[[ -n "$output" ]]
record "pipeline:age"
cat > "$output"
`),
  );

  return {
    root,
    lockDir,
    env: {
      NODE_ENV: "test",
      PATH: `${bin}:/usr/bin:/bin`,
      POSTGRES_BACKUP_PROVIDER: "postgres",
      POSTGRES_BACKUP_HOST: "db.example.test",
      POSTGRES_BACKUP_PORT: "5432",
      POSTGRES_BACKUP_DATABASE: "energie",
      POSTGRES_BACKUP_USER: "app_backup",
      POSTGRES_BACKUP_PASSFILE: passfile,
      POSTGRES_BACKUP_SSLMODE: "verify-full",
      POSTGRES_BACKUP_SSLROOTCERT: caFile,
      POSTGRES_BACKUP_EXPECTED_NEON_TENANT_ID: "",
      POSTGRES_BACKUP_EXPECTED_NEON_TIMELINE_ID: "",
      POSTGRES_BACKUP_EXPECTED_SYSTEM_IDENTIFIER: "7460000000000000000",
      S3_BACKUP_ENDPOINT: "https://s3.example.test",
      S3_BACKUP_REGION: "nbg1",
      S3_BACKUP_BUCKET: "energie-backup-test",
      S3_BACKUP_ACCESS_KEY_ID: "backup-access-private",
      S3_BACKUP_SECRET_ACCESS_KEY: "backup-secret-private",
      S3_BACKUP_EXPECTED_OBJECT_LOCK_MODE: "GOVERNANCE",
      S3_BACKUP_EXPECTED_RETENTION_DAYS: "30",
      S3_BACKUP_LIFECYCLE_READBACK: "required",
      S3_BACKUP_EXPECTED_LIFECYCLE_RULE_ID: "backup-retention",
      S3_BACKUP_EXPECTED_LIFECYCLE_PREFIX: "pg/",
      S3_BACKUP_EXPECTED_LIFECYCLE_CURRENT_DAYS: "30",
      S3_BACKUP_EXPECTED_LIFECYCLE_NONCURRENT_DAYS: "30",
      S3_BACKUP_LIFECYCLE_UNSUPPORTED_EVIDENCE_ID: "",
      AGE_PUBLIC_KEY: `age1${"q".repeat(58)}`,
      BACKUP_LOCK_DIR: lockDir,
      BACKUP_TIMEOUT_SECONDS: "3",
      BACKUP_KILL_AFTER_SECONDS: "1",
      BACKUP_DEAD_MAN_URL: "https://deadman.example.test/deadman-private-token",
    },
  };
}

function runBackup(harness: Harness) {
  return spawnSync("/bin/bash", [backupScript], {
    cwd: resolve("."),
    env: harness.env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

async function readEvents(harness: Harness): Promise<string[]> {
  try {
    return (await readFile(join(harness.root, "events"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
  throw new Error(`Timeout beim Warten auf ${path}`);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Backup-Automations-High-Gate", () => {
  it("attestiert Ziel, Bucket, exakte Objektversionen und Retention", async () => {
    const harness = await createHarness();
    const result = runBackup(harness);
    const events = await readEvents(harness);

    expect(result.status, result.stderr).toBe(0);
    expect(events[0]).toBe("deadman:start");
    expect(events).toContain("aws:object-lock");
    expect(events).toContain("aws:retention-mode");
    expect(events).toContain("aws:retention-days");
    expect(events).toContain("aws:retention-years");
    expect(events).toContain("aws:versioning");
    expect(events).toContain("aws:lifecycle-enabled-count");
    expect(events).toContain("aws:lifecycle-count");
    expect(events).toContain("aws:lifecycle-status");
    expect(events).toContain("aws:lifecycle-prefix");
    expect(events).toContain("aws:lifecycle-current-days");
    expect(events).toContain("aws:lifecycle-noncurrent-days");
    expect(events).toContain("aws:lifecycle-transitions");
    expect(events).toContain("aws:lifecycle-noncurrent-transitions");
    expect(events).toContain("pipeline:pg_dump");
    expect(events).toContain("pipeline:zstd");
    expect(events).toContain("pipeline:age");
    expect(events.filter((event) => event === "db:attest")).toHaveLength(2);
    expect(events.filter((event) => event === "aws:put")).toHaveLength(2);
    expect(events.filter((event) => event === "aws:head-version")).toHaveLength(2);
    expect(events.filter((event) => event === "aws:head-checksum")).toHaveLength(2);
    expect(events.filter((event) => event === "aws:object-retention-mode")).toHaveLength(2);
    expect(events.filter((event) => event === "aws:object-retain-until")).toHaveLength(2);
    for (const attestation of [
      "db:attest",
      "aws:object-lock",
      "aws:retention-mode",
      "aws:retention-days",
      "aws:retention-years",
      "aws:versioning",
      "aws:lifecycle-enabled-count",
      "aws:lifecycle-count",
      "aws:lifecycle-status",
      "aws:lifecycle-prefix",
      "aws:lifecycle-current-days",
      "aws:lifecycle-noncurrent-days",
      "aws:lifecycle-transitions",
      "aws:lifecycle-noncurrent-transitions",
    ]) {
      expect(events.indexOf(attestation)).toBeLessThan(events.indexOf("pipeline:pg_dump"));
    }
    expect(events.at(-1)).toBe("deadman:success");
    expect(result.stdout).toContain("artifact_version=version-1");
    expect(result.stdout).toContain("manifest_version=version-2");
    expect(result.stdout).toContain(
      "artifact_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("backup-secret-private");
    expect(`${result.stdout}${result.stderr}`).not.toContain("db-password-private");
    expect(`${result.stdout}${result.stderr}`).not.toContain("deadman-private-token");
    await expect(stat(harness.lockDir)).rejects.toThrow();
  });

  it("lehnt einen belegten Host-Lock ab und entfernt ihn nicht", async () => {
    const harness = await createHarness();
    await mkdir(harness.lockDir);

    const result = runBackup(harness);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Host-Lock ist bereits belegt");
    expect(await readEvents(harness)).toEqual([]);
    await expect(stat(harness.lockDir)).resolves.toBeDefined();
  });

  it("behandelt den harten Timeout als Fehler und sendet den Fail-Alarm", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.root, "force-timeout"), "1\n");

    const result = runBackup(harness);
    const events = await readEvents(harness);
    const timeoutEvent = events.find((event) => event.startsWith("timeout:"));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("harter Payload-Timeout");
    expect(timeoutEvent).toContain("--signal=TERM");
    expect(timeoutEvent).toContain("--kill-after=1s");
    expect(events).toContain("deadman:start");
    expect(events).toContain("deadman:fail");
    expect(events).not.toContain("deadman:success");
    expect(events).not.toContain("aws:put");
    await expect(stat(harness.lockDir)).rejects.toThrow();
  });

  it("stoppt bei abweichender Default-Retention vor Dump und Upload", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.root, "retention-days"), "7\n");

    const result = runBackup(harness);
    const events = await readEvents(harness);

    expect(result.status).not.toBe(0);
    expect(events).toContain("aws:retention-days");
    expect(events).toContain("deadman:fail");
    expect(events).not.toContain("pipeline:pg_dump");
    expect(events).not.toContain("aws:put");
    expect(events).not.toContain("deadman:success");
  });

  it("stoppt bei einer zweiten aktiven Lifecycle-Regel vor Dump und Upload", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.root, "lifecycle-enabled-count"), "2\n");

    const result = runBackup(harness);
    const events = await readEvents(harness);

    expect(result.status).not.toBe(0);
    expect(events).toContain("aws:lifecycle-enabled-count");
    expect(events).not.toContain("pipeline:pg_dump");
    expect(events).not.toContain("aws:put");
    expect(events).toContain("deadman:fail");
  });

  it("weist einen mehrdeutigen Lifecycle-Readback-Modus vor jedem Lauf zurueck", async () => {
    const harness = await createHarness();
    harness.env.S3_BACKUP_LIFECYCLE_READBACK = "best-effort";

    const result = runBackup(harness);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "S3_BACKUP_LIFECYCLE_READBACK muss required oder provider-unsupported sein",
    );
    expect(await readEvents(harness)).toEqual([]);
  });

  it("bindet Lifecycle-Regel und Objekt-Keys zwingend an denselben Prefix", async () => {
    const harness = await createHarness();
    harness.env.S3_BACKUP_EXPECTED_LIFECYCLE_PREFIX = "archive/";
    await writeFile(join(harness.root, "lifecycle-prefix"), "archive/\n");

    const result = runBackup(harness);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("muss exakt pg/ sein");
    expect(await readEvents(harness)).toEqual([]);
  });

  it("weist den frueheren internen Payload-Schalter ohne Seiteneffekt zurueck", async () => {
    const harness = await createHarness();

    const result = spawnSync("/bin/bash", [backupScript, "--run-validated-payload"], {
      cwd: resolve("."),
      env: harness.env,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("akzeptiert keine Argumente");
    expect(await readEvents(harness)).toEqual([]);
    await expect(stat(harness.lockDir)).rejects.toThrow();
  });

  it("verraet bei versehentlichem bash -x aus bereinigter Startumgebung keine Secrets", async () => {
    const harness = await createHarness();

    const result = spawnSync("/bin/bash", ["-x", backupScript], {
      cwd: resolve("."),
      env: harness.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, result.stderr).toBe(0);
    expect(output).not.toContain("backup-secret-private");
    expect(output).not.toContain("db-password-private");
    expect(output).not.toContain("deadman-private-token");
  });

  it("stoppt bei einem falschen serverseitigen Datenbankziel vor Dump und Upload", async () => {
    const harness = await createHarness();
    await writeFile(
      join(harness.root, "db-target"),
      "app_backup|falsche_db|180000|-|-|7460000000000000000\n",
    );

    const result = runBackup(harness);
    const events = await readEvents(harness);

    expect(result.status).not.toBe(0);
    expect(events).toContain("db:attest");
    expect(events).toContain("deadman:fail");
    expect(events).not.toContain("pipeline:pg_dump");
    expect(events).not.toContain("aws:put");
    expect(events).not.toContain("deadman:success");
  });

  it("stoppt beim falschen physischen PostgreSQL-Cluster vor Dump und Upload", async () => {
    const harness = await createHarness();
    harness.env.POSTGRES_BACKUP_EXPECTED_SYSTEM_IDENTIFIER = "7460000000000000001";

    const result = runBackup(harness);
    const events = await readEvents(harness);

    expect(result.status).not.toBe(0);
    expect(events).toContain("db:attest");
    expect(events).not.toContain("pipeline:pg_dump");
    expect(events).not.toContain("aws:put");
    expect(events).toContain("deadman:fail");
  });

  it("verwirft eine formal gueltige Hash-Ausgabe bei fehlerhaftem sha256sum-Exit", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.root, "bad-sha-exit"), "1\n");

    const result = runBackup(harness);
    const events = await readEvents(harness);

    expect(result.status).not.toBe(0);
    expect(events).toContain("pipeline:pg_dump");
    expect(events).not.toContain("aws:put");
    expect(events).toContain("deadman:fail");
  });

  it.each([
    ["Objektversion", "bad-version"],
    ["Objektchecksumme", "bad-checksum"],
    ["Objektretention", "bad-retention"],
  ])("stoppt bei abweichender exakter %s nach dem Upload", async (_label, marker) => {
    const harness = await createHarness();
    await writeFile(join(harness.root, marker), "1\n");

    const result = runBackup(harness);
    const events = await readEvents(harness);

    expect(result.status).not.toBe(0);
    expect(events).toContain("aws:put");
    expect(events).toContain("deadman:fail");
    expect(events).not.toContain("deadman:success");
  });

  it("wartet bei SIGTERM auf Timeout und dessen Nachfahren, bevor es aufraeumt", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.root, "signal-mode"), "1\n");
    const child = spawn("/bin/bash", [backupScript], {
      cwd: resolve("."),
      env: harness.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    await waitForPath(join(harness.root, "signal-ready"));
    const descendantPid = Number(
      (await readFile(join(harness.root, "descendant-pid"), "utf8")).trim(),
    );
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    expect(child.kill("SIGTERM")).toBe(true);
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise, rejectPromise) => {
        child.once("error", rejectPromise);
        child.once("close", (code, signal) => resolvePromise({ code, signal }));
      },
    );
    const events = await readEvents(harness);

    expect(result.code).not.toBe(0);
    expect(result.signal).toBeNull();
    expect(stderr).not.toContain("backup-secret-private");
    expect(events).toContain("timeout:term");
    expect(events).toContain("descendant:term");
    expect(events).toContain("deadman:fail");
    expect(events.indexOf("timeout:term")).toBeLessThan(events.indexOf("descendant:term"));
    expect(events.indexOf("descendant:term")).toBeLessThan(events.indexOf("deadman:fail"));
    expect(events).not.toContain("aws:put");
    expect(events).not.toContain("deadman:success");
    expect(() => process.kill(descendantPid, 0)).toThrow();
    await expect(stat(harness.lockDir)).rejects.toThrow();
  });
});
