# Backup & Disaster Recovery
## Schutzziele
- RPO ≤ 24 h (Fakturierungsdaten: ≤ 1 h sobald Pilotkunde produktiv), RTO ≤ 4 h.
## Mechanik
- Neon: PITR/Branch-Restore (Point-in-time) — Aufbewahrung auf 7 Tage konfigurieren;
  zusätzlich täglicher logischer Dump (`pg_dump`) vom Worker-Host in den Object Storage
  (Bucket `backups/`, 30 Tage Rotation), damit ein Neon-Konto-Verlust nicht alles kostet.
- Object Storage: `immutable/` ist per WORM selbst der Schutz; `backups/` versioniert.
- Secrets: `.env`-Werte liegen zusätzlich im Passwort-Manager (nicht nur auf dem Rechner).
## Restore-Test (Pflicht, wiederkehrend)
- Vor Pilot-Start und danach quartalsweise: Dump in leere DB einspielen, `npm run check`
  gegen die Restore-DB, ein Beleg-PDF per Hash gegen die DB verifizieren. Ergebnis als
  Notiz in docs/runbooks/restore-log.md.
