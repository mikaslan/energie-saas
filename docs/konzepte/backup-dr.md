# Backup & Disaster Recovery

Status: **BLOCKED für Pilot/Produktion**. PITR und der verschlüsselte Dump sind
lokal gehärtete Bausteine, aber noch kein praktisch bewiesener M1-03-Restorevertrag.

## Schutzziele

- RPO ≤ 24 h (Fakturierungsdaten: ≤ 1 h sobald Pilotkunde produktiv), RTO ≤ 4 h.

## Mechanik

- Neon: PITR/Branch-Restore (Point-in-time) — Aufbewahrung auf 7 Tage konfigurieren;
  zusätzlich täglicher logischer Dump (`pg_dump`) vom Worker-Host in den Object Storage
  (dedizierter Backup-Bucket, Prefix `pg/`, 30 Tage), damit ein Neon-Konto-Verlust
  nicht alles kostet.
- Der Dump liest ausschließlich die Backup-Host-Werte `POSTGRES_BACKUP_HOST`,
  `POSTGRES_BACKUP_PORT`, `POSTGRES_BACKUP_DATABASE`, `POSTGRES_BACKUP_USER`,
  `POSTGRES_BACKUP_SSLMODE=verify-full` und eine vorprovisionierte
  `POSTGRES_BACKUP_PASSFILE` (0400/0600) sowie eine explizite
  `POSTGRES_BACKUP_SSLROOTCERT`-CA-Datei. Das Passfile-Format ist
  `host:port:database:user:password` und muss genau einen passend gebundenen Eintrag
  enthalten. Es gibt keine DB-URL und kein DB-Passwort in argv oder Environment;
  ambient libpq-Overrides werden vor `psql`/`pg_dump` entfernt. Vor und nach dem Dump
  attestiert der Lauf serverseitig Principal, Datenbank, PostgreSQL 18 und bei Neon die
  erwartete Tenant-/Timeline-ID. Beim generischen PostgreSQL-Ziel bindet er stattdessen
  die erwartete clusterweite `pg_control_system().system_identifier`; falls PUBLIC-
  EXECUTE dort gehärtet entzogen wurde, erhält der Backup-Principal nur das gezielte
  Funktions-EXECUTE. FORCE RLS verhindert mit einer normalen Limited Role einen
  vollständigen Dump; vor Pilotstart ist daher entweder ein ausschließlich auf dem
  Backup-Host verwahrter, providerseitig freigegebener Backup-Principal oder ein
  vollständig getesteter Neon-Export/PITR-Pfad festzulegen. Das privilegierte
  Credential erreicht weder Web noch Worker-Container.
- Der Backup-Bucket besitzt einen eigenen minimalen Schlüsselsatz
  (`S3_BACKUP_ENDPOINT`, `S3_BACKUP_REGION`, `S3_BACKUP_BUCKET`,
  `S3_BACKUP_ACCESS_KEY_ID`, `S3_BACKUP_SECRET_ACCESS_KEY`). Es gibt keinen Fallback
  auf Archiv-/App-Credentials; der Key darf weder Governance-Bypass noch Zugriff auf
  den Archiv-Bucket erhalten und liegt nur auf dem Backup-Host.
- Vor jeder Speicherung werden Object Lock, Default-Retention, Versioning und exakt
  eine aktive Lifecycle-Regel mit Prefix sowie Ablauf für aktuelle/nichtaktuelle
  Versionen gelesen. Jeder Dump und sein JSON-Manifest werden als höchstens 5 GiB
  großes Single-Put-Objekt gespeichert; danach werden die exakte `VersionId`, Größe,
  SHA-256-Metadaten, providerseitige SHA-256-Checksumme und versionsgebundene Retention
  zurückgelesen. Das Manifest bindet Datenbank-/Branch-Ziel und die exakte
  Artefaktversion. Der Erfolgsbeleg nennt beide Keys, Versionen, Hashes und
  Retain-until-Zeitpunkte.
- Ein hostlokaler atomarer `mkdir`-Lock, harter Payload-Timeout mit TERM/KILL-Grenze,
  vollständiges Warten auf den Prozessbaum, restriktives Temp-Verzeichnis und ein
  eigener Start/Success/Fail-Dead-Man-Vertrag sind lokal automatisiert geprüft.
- Secrets: `.env`-Werte liegen zusätzlich im Passwort-Manager (nicht nur auf dem Rechner).
- Host-Vertrag: Linux/Bash, PostgreSQL-18-Client (`psql`, `pg_dump`), `zstd`, `age`,
  AWS CLI v2 mit flexiblen Checksum-Readbacks, `curl`, `openssl` und GNU coreutils
  (`date`, `timeout`, `sha256sum`).
- Der Scheduler ist Teil der Vertrauensgrenze: Die versionierte
  [systemd-Vorlage](../../worker/backup/systemd/README.md) ist lokal vertraglich
  geprüft, aber noch nicht auf einem Host installiert oder aktiviert. Sie lädt die
  0400/0600-Umgebung außerhalb von argv, setzt einen festen `PATH` und
  nicht geheimen `PS4`, entfernt `BASH_ENV`, `ENV`, `SHELLOPTS` und `BASHOPTS` und
  startet `/bin/bash --noprofile --norc worker/backup/backup.sh` niemals mit `-x`.
  Ein beliebiger Direktaufruf mit vorab manipuliertem Bash-Startup ist nicht
  unterstützt, weil solcher Code vor der ersten Scriptzeile läuft. Der lokale
  `bash -x`-Test belegt nur die bereinigte Startumgebung.

## Was weiterhin ein echtes Pilot-Gate ist

- autorisierten direkten Neon-Zielendpunkt und Backup-Principal einschließlich
  vollständiger FORCE-RLS-Lesefähigkeit real provisionieren;
- Bucket-Key mit minimaler Policy real negativ prüfen: kein Archivzugriff, kein
  Delete/Overwrite bestehender Versionen und kein Governance-Bypass;
- Object-Lock-/Lifecycle-/Checksum-Vertrag gegen den ausgewählten S3-Anbieter ausführen;
- mindestens einen echten verschlüsselten Lauf samt extern gespeichertem Erfolgsbeleg
  und anschließend beide Restore-Drills abnehmen.

Ein Provider, der keinen exakten Lifecycle-Readback unterstützt, kann mit einer
Evidence-ID dokumentiert werden, bleibt für den Pilot aber **NO-GO**. Lokale Mocks
beweisen weder Provider-IAM noch WORM-Verhalten.

## Warum der logische Dump allein nicht reicht

`worker/backup/backup.sh` verwendet bewusst `--no-owner --no-privileges`, damit ein
Dump weder alte Provider-Owner noch delegierte ACLs ungeprüft wieder einführt.
`pg_dump` exportiert außerdem keine clusterweiten Rollen. Damit fehlen im Artefakt aber
gerade die von M1-03 geschützten Rollen, grantor-genauen Membership-Kanten, Owner und
ACLs. Ein Restore unter nur einem Admin würde insbesondere `public`/`drizzle` und
`pgboss` dem falschen Owner geben.

Vor Pilot braucht es deshalb zusätzlich einen versionierten, ausführbaren Vertrag für:

1. PG18-Zielrollen und Provider-Topologie ohne Passwörter im Repo/argv,
2. getrennte Wiederherstellung von `public`/`drizzle → app_owner` und
   `pgboss → app_worker`,
3. anschließendes read-only Ziel-Attest für Rollen, Memberships, Datenbank-/Schema-/
   Objektowner, ACLs, RLS/Policies/Trigger, Migrationshashes und Service-Principals,
4. Bestandsstichproben für Tenant-Zeilen, Journal, Dateien/PDF-Hashes und einen
   wartenden pg-boss-Job.

`npm run check` allein beweist das nicht: Die lokale Rollenprobe bootet ihre eigene
flüchtige Datenbank und attestiert nicht automatisch das restaurierte Ziel.

## Restore-Test (Pflicht, wiederkehrend)

- Vor Pilot-Start und danach quartalsweise: isoliertes PG18-/Neon-Ziel aus einem
  festgehaltenen PITR-Punkt und separat aus dem verschlüsselten Dump wiederherstellen.
- Rollen-/Provider-Topologie vorprovisionieren, Schemas unter ihren Zielownern
  restaurieren und den unverändernden Ziel-Attest ausführen.
- Mindestens zwei Workspaces samt tenant-isolierten Zeilenzahlen, eine feste
  Kontakt-/Standortstichprobe, Migrationsjournal und einen wartenden pg-boss-Job gegen
  das gehashte, versionierte und WORM-geschützte Manifest vergleichen; ein Beleg-PDF
  per Hash prüfen. Das Manifest ist nicht kryptografisch signiert.
- RPO und RTO messen; absichtlich falschen Owner, fehlende Membership, falschen
  Neon-Branch und unvollständigen Dump jeweils rot nachweisen.
- Ergebnis mit Datum, Quellartefakt-Hash, Zielidentität, Zeiten und Reviewer in
  `docs/runbooks/restore-log.md` protokollieren. Die Vorlage existiert; mindestens ein
  vollständiger Eintrag und der ausführbare Rollen-/Restorevertrag fehlen weiterhin.
  Bis dahin bleibt das Gate BLOCKED.
