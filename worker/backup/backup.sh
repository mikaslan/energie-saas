#!/usr/bin/env bash
# Nächtlicher logischer DB-Dump nach docs/konzepte/backup-dr.md:
# pg_dump → zstd → age (clientseitige Verschlüsselung — Hetzner Object Storage
# bietet nur SSE-C, siehe ADR 0002) → Upload in den separaten Backup-Bucket
# (Versioning + Object-Lock-Retention 30 Tage Governance).
#
# Gerüst aus der Tooling-Mission: läuft erst, wenn die Env-Vars gesetzt sind
# (docs/tooling/einkaufsliste.md). Aufruf per Host-Cron auf dem Worker, z. B.:
#   17 2 * * * cd /opt/energie-saas && ./worker/backup/backup.sh >> /var/log/pg-backup.log 2>&1
# Benötigte Pakete auf dem Host: postgresql-client, zstd, age, awscli.
#
# Restore-Test (Pflicht, quartalsweise): docs/konzepte/backup-dr.md.
set -euo pipefail

: "${POSTGRES_URL:?POSTGRES_URL fehlt}"
: "${S3_ENDPOINT:?S3_ENDPOINT fehlt}"
: "${S3_BUCKET_BACKUP:?S3_BUCKET_BACKUP fehlt}"
: "${AGE_PUBLIC_KEY:?AGE_PUBLIC_KEY fehlt (age-keygen; PRIVATEN Schlüssel nur im Passwort-Manager!)}"

: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID fehlt}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY fehlt}"

# Die AWS CLI liest NUR AWS_*-Variablen (Codex-Review #2) — die repo-eigenen
# S3_*-Namen hier explizit mappen, damit der Cron-Host ohne ~/.aws auskommt.
export AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET_ACCESS_KEY"
export AWS_REGION="${S3_REGION:-nbg1}"
export AWS_EC2_METADATA_DISABLED=true

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/pg-${STAMP}.sql.zst.age"

# --no-owner/--no-privileges: Restore-Ziel (leere DB, andere Rollen) soll ohne
# die Neon-spezifischen Rollen funktionieren.
pg_dump "$POSTGRES_URL" --no-owner --no-privileges \
  | zstd -q -T0 \
  | age -r "$AGE_PUBLIC_KEY" -o "$OUT"

aws s3 cp "$OUT" "s3://${S3_BUCKET_BACKUP}/pg/pg-${STAMP}.sql.zst.age" \
  --endpoint-url "$S3_ENDPOINT" --only-show-errors

echo "[backup] ok: pg-${STAMP}.sql.zst.age ($(du -h "$OUT" | cut -f1))"
