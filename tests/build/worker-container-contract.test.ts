import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Worker-Containervertrag", () => {
  it("läuft als Non-Root aus einem reproduzierbaren Build-Artefakt", async () => {
    const dockerfile = await readFile("worker/Dockerfile", "utf8");
    expect(dockerfile).toContain(
      "FROM node:22-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS build",
    );
    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).toContain("npx --no-install esbuild");
    expect(dockerfile).toContain(
      "FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac AS runtime",
    );
    expect(dockerfile).toContain("PLAYWRIGHT_BROWSERS_PATH=/ms-playwright");
    expect(dockerfile).toContain("LD_PRELOAD=/usr/local/lib/worker-nodump.so");
    expect(dockerfile).toContain("worker/process-isolation.c");
    expect(dockerfile).toContain("gcc=4:12.2.0-3");
    expect(dockerfile).toContain("libc6-dev=2.36-9+deb12u14");
    expect(dockerfile).toContain("-Wall -Wextra -Werror");
    expect(dockerfile).toContain("-Wl,-z,relro,-z,now");
    expect(dockerfile).toContain("/usr/local/lib/worker-nodump.so");
    expect(dockerfile).toContain("npm ci --omit=dev");
    expect(dockerfile).toContain("USER pwuser");
    expect(dockerfile).toContain('CMD ["node", "dist/worker.cjs"]');
    expect(dockerfile).not.toMatch(/npm i(?:nstall)?\s+tsx/);
    expect(dockerfile).not.toContain("COPY . .\nCMD");
    expect(dockerfile).not.toContain("--no-sandbox");
  });

  it("erhält nur Worker-Konfiguration und schließt alle Env-Dateien aus", async () => {
    const [compose, dockerignore] = await Promise.all([
      readFile("worker/compose.yaml", "utf8"),
      readFile(".dockerignore", "utf8"),
    ]);
    expect(compose).toContain("DB_ROLE_MODE=strict");
    expect(compose).toContain("POSTGRES_URL_WORKER=");
    expect(compose).toContain("POSTGRES_EXPECTED_NEON_TENANT_ID=");
    expect(compose).toContain("POSTGRES_EXPECTED_NEON_TIMELINE_ID=");
    expect(compose).toContain("stop_grace_period: 60s");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain('cap_drop: ["ALL"]');
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("seccomp=./chromium-seccomp.json");
    expect(compose).toContain("network_mode: none");
    expect(compose.match(/platform: linux\/amd64/gu)).toHaveLength(2);
    expect(compose).toContain("WORKER_ISOLATION_SENTINEL=synthetic-container-isolation-probe");
    expect(compose).not.toContain("SYS_ADMIN");
    expect(compose).not.toMatch(/seccomp\s*[:=]\s*unconfined/iu);
    expect(compose).not.toMatch(/POSTGRES_URL=\$\{POSTGRES_URL\}/);
    expect(compose).not.toContain("POSTGRES_URL_SYSTEM");
    expect(dockerignore.split(/\r?\n/)).toContain(".env*");
  });

  it("hält Backup-DB- und Bucket-Secrets aus argv und fremden Subprozessen", async () => {
    const [backup, envExample] = await Promise.all([
      readFile("worker/backup/backup.sh", "utf8"),
      readFile(".env.example", "utf8"),
    ]);

    expect(backup).toContain('PGPASSFILE="$POSTGRES_BACKUP_PASSFILE"');
    expect(backup).toContain("attest_database_target");
    expect(backup).toContain("server_version_num");
    expect(backup).toContain('pg_dump --no-owner --no-privileges');
    expect(backup).not.toContain("POSTGRES_URL_BACKUP");
    expect(backup).not.toContain("PGPASSWORD=");
    expect(backup).toContain("unset PGPASSWORD PGOPTIONS PGSERVICE PGSERVICEFILE");
    expect(backup).toContain('PGSSLROOTCERT="$POSTGRES_BACKUP_SSLROOTCERT"');
    expect(backup).toContain("muss ein direkter, ungepoolter Endpunkt sein");
    expect(backup).toContain("S3_BACKUP_ENDPOINT muss eine pfadlose HTTPS-URL sein");
    expect(backup).toContain('AWS_SECRET_ACCESS_KEY="$BACKUP_AWS_SECRET_ACCESS_KEY"');
    expect(backup).not.toMatch(/^export AWS_/m);
    expect(backup).toContain("set +x");
    expect(backup).toContain('[[ "$#" -eq 0 ]]');
    expect(backup).not.toContain("--run-validated-payload");
    expect(backup).toContain('mkdir "$BACKUP_LOCK_DIR"');
    expect(backup).toContain('--kill-after="${BACKUP_KILL_AFTER_SECONDS}s"');
    expect(backup).not.toContain("rm -rf");
    expect(backup).toContain("get-object-lock-configuration");
    expect(backup).toContain("get-bucket-versioning");
    expect(backup).toContain("get-bucket-lifecycle-configuration");
    expect(backup).toContain("s3api put-object");
    expect(backup).toContain("--checksum-mode ENABLED");
    expect(backup).toContain("get-object-retention");
    expect(backup).toContain("UPLOADED_VERSION_ID");
    expect(backup).toContain('"schema":"energie-saas.backup-manifest.v1"');

    expect(envExample).toContain("POSTGRES_BACKUP_PASSFILE=");
    expect(envExample).toContain("S3_BACKUP_ACCESS_KEY_ID=");
    expect(envExample).toContain("BACKUP_DEAD_MAN_URL=");
    expect(envExample).toContain("S3_BACKUP_EXPECTED_RETENTION_DAYS=30");
    expect(envExample).toContain("belegen keine IAM-Minimalitaet");
    expect(envExample).not.toContain("POSTGRES_BACKUP_PASSWORD=");
    expect(envExample).not.toContain("S3_BUCKET_BACKUP=");
  });

  it("liefert eine fail-closed systemd-Zeitplanung ohne Secrets in ExecStart", async () => {
    const [service, timer, readme] = await Promise.all([
      readFile("worker/backup/systemd/energie-saas-backup.service", "utf8"),
      readFile("worker/backup/systemd/energie-saas-backup.timer", "utf8"),
      readFile("worker/backup/systemd/README.md", "utf8"),
    ]);

    expect(service).toContain("User=energie-backup");
    expect(service).toContain(
      "ExecStartPre=/usr/bin/test -x /opt/energie-saas/worker/backup/backup.sh",
    );
    expect(service).toContain(
      "ExecStartPre=/usr/bin/test -r /run/secrets/energie-saas-backup.env",
    );
    expect(service).not.toContain("ConditionFileIsExecutable");
    expect(service).toContain("EnvironmentFile=/run/secrets/energie-saas-backup.env");
    expect(service).toContain(
      "Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(service).toContain("UnsetEnvironment=BASH_ENV ENV SHELLOPTS BASHOPTS PS4");
    expect(service).toContain(
      "ExecStart=/bin/bash --noprofile --norc /opt/energie-saas/worker/backup/backup.sh",
    );
    expect(service).not.toMatch(/^ExecStart=.*(?:-x|S3_BACKUP_SECRET|POSTGRES_BACKUP_PASS)/m);
    expect(service).toContain("KillMode=control-group");
    expect(service).toContain("SendSIGKILL=yes");
    expect(service).toContain("NoNewPrivileges=yes");
    expect(service).toContain("PrivateTmp=yes");
    expect(service).toContain("ProtectSystem=strict");
    expect(service).toContain("ReadOnlyPaths=/run/secrets/energie-saas-backup.env");
    expect(service).toContain("ReadWritePaths=/run/lock /var/lock");

    expect(timer).toContain("OnCalendar=*-*-* 02:15:00 UTC");
    expect(timer).toContain("Persistent=yes");
    expect(timer).toContain("Unit=energie-saas-backup.service");
    expect(readme).toMatch(/weder\s+installiert noch aktiviert/);
    expect(readme).toContain("systemd-analyze verify");
  });
});
