# Gehärtete Backup-Zeitplanung

Diese Dateien sind eine versionierte Host-Vorlage. Sie sind lokal geprüft, aber weder
installiert noch aktiviert. Der feste Pfad `/opt/energie-saas` und der eigene
Non-Login-Benutzer `energie-backup` werden erst durch das autorisierte Host-Provisioning
angelegt; bis dahin bleibt das reale Backup-Gate NO-GO.

## Hostvertrag

1. Repository/Release unter `/opt/energie-saas` root-owned und für
   `energie-backup` nicht beschreibbar installieren.
2. `/run/secrets/energie-saas-backup.env` außerhalb des Repositories mit Owner
   `energie-backup`, Modus 0400/0600 und ausschließlich den Backup-Werten aus
   `.env.example` provisionieren. Keine Shell-Syntax, kein `PATH`, `PS4`, `BASH_ENV`,
   `ENV`, `SHELLOPTS` oder `BASHOPTS` aufnehmen.
3. DB-Passfile und CA an den in dieser Umgebung genannten absoluten Pfaden mit den vom
   Script erzwungenen Owner-/Modusregeln bereitstellen.
4. Unit und Timer root-owned nach `/etc/systemd/system/` kopieren, mit
   `systemd-analyze verify` prüfen und erst nach real grünem DB-/Bucket-/Dead-Man-Gate
   den Timer aktivieren. Die tägliche UTC-Zeit vermeidet DST-Lücken; `Persistent=yes`
   holt einen während eines ausgeschalteten Hosts verpassten Lauf nach.
5. Der Journal-Erfolgsbeleg muss Artefakt- und Manifest-Key, VersionId, SHA-256 und
   Retain-until enthalten. Fehlender Success-Ping oder ein `deadman:fail` bleibt ein
   Betriebsalarm.

`KillMode=control-group` hält bei einem Stop den gesamten systemd-Prozessbaum unter
Kontrolle. Innerhalb des Laufs erzwingt das Script zusätzlich seinen eigenen
TERM/KILL-Timeout und wartet vor dem Cleanup auf den Payload-Prozess. Diese beiden
Grenzen ersetzen nicht den echten Linux-/Provider-Abnahmelauf.

Die beiden `ExecStartPre`-Prüfungen lassen eine fehlende/nicht ausführbare Scriptdatei
oder eine unlesbare Environment-Datei sofort als fehlgeschlagene Unit erscheinen,
statt den Lauf nur aufgrund einer nicht erfüllten systemd-Condition zu überspringen.
