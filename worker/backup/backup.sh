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
