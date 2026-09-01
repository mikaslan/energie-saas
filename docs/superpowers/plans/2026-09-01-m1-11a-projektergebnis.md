# Implementierungsplan M1-11a — Projektergebnis Won/Lost/Reopen

## Ziel und Basis

Vertikaler Slice auf `bc491d4`, Branch
`codex/m1-11a-project-outcomes`, Migration `0039`. Kein Push und kein
Deployment. Spec und ADR sind die Vertragsquelle; öffentliche Reonic-Seiten
sind nur Clean-Room-Verhaltensbelege.

## Reihenfolge

### 1. Contract- und Permission-Rotphase

- Zod-Verträge für Outcome- und Reason-Commands schreiben.
- Permission-Matrix um `project.outcome.write` erweitern.
- Negativfälle für unknown keys, falsche Version, UUID, Revision, Limits,
  Unicode/Kontrollzeichen und fehlende Bestätigung schreiben.
- Tests müssen vor Implementierung rot sein.

### 2. Schema und Migration 0039

- `project_loss_reason` und Project-Erweiterungen in Drizzle modellieren.
- Generator ausführen und Migration gezielt härten:
  - Upgrade-Preconditions und transparenter Backfill;
  - zusammengesetzte Tenant-FKs und CHECKs;
  - FORCE RLS mit genau einer permissiven Tenant-Policy;
  - restriktive interne Select/Admin-Write-Policies;
  - Trigger für Archive statt Delete, CAS und Outcome-State-Machine;
  - minimale Runtime-ACL, keine Worker-/System-/Erasure-Rechte;
  - Closed- und Activity-Indizes.
- Fresh, Upgrade und wiederholte Generatorprüfung testen.

### 3. Domain-Service

- Reason-Liste/Create/Archive/Reactivate mit Workspace→Reason-Lockordnung.
- Outcome-Context und Closed-Request-Keyset-Readmodel.
- Mark Won/Lost/Reopen mit Project→Reason-Lockordnung und CAS.
- Event/Audit-Allowlist; kein Label oder Kommentar in append-only Daten.
- Service-Tests für Happy path, no partial write, stale revision, illegal phase,
  inactive/foreign reason, tenant isolation und Erasure-Race.

### 4. Server Actions und UI

- Outcome-Actions als untrusted entry points mit bindender Workspace-ID,
  Strict-Zod und Reautorisierung.
- Projekt-Outcome-Panel mit progressiver Form, expliziten Bestätigungen,
  `useActionState`, Pending-/Konflikt-/Fokusvertrag.
- Adminseite `/einstellungen/verlustgruende`.
- Geschlossene Liste `/anfragen/abgeschlossen` mit URL-Filter und Keyset.
- Offenes Board und Detail erhalten klare gegenseitige Navigation.
- Activity-Readmodel um feste Outcome-Eventlabels erweitern.

### 5. Verifikation

- fokussierte Contract-, Permission-, DB-, Service-, Race-, Action-, UI- und
  Privacy-Tests;
- Rollenvertrag und PostgreSQL-18-Negativproben;
- `npm run check`, Dependency-Cruiser, Production-Build, `db:generate` ohne
  Drift;
- Chromium: Reason anlegen → Lead Lost → aus Offen verschwunden → in
  Abgeschlossen sichtbar → Detail/Activity → Reopen → ursprüngliche Spalte;
- zusätzliche Won-, Viewer-, External-Entzug-, Konflikt-, Tastatur-, Axe- und
  320/375-px-Fälle;
- unabhängiger Security-/Tenant-/Race-/UI-Review ohne offene P0–P2.

### 6. Nachweise und Commit

- Capability-, Rollen-, Workflow-, Domain-, Test-, Source- und
  Paritätsregister aktualisieren.
- Vault-Abnahme mit Commit, Befehlen, Resultaten, Hashes, Restgrenzen und
  ehrlicher Prozentzahl ergänzen.
- Secret-/Placeholder-Scan und sauberer Worktree.
- lokaler Commit; kein Push/Deploy.

## Stop-the-line-Regeln

- Unerwarteter bestehender Lost-Datensatz ohne strukturierte Reason stoppt den
  Upgradepfad; keine erfundene Zuordnung.
- Unbekannte private Reonic-Semantik bleibt Unknown und wird nicht geraten.
- Cannot fulfill wird nicht teilweise implementiert.
- Kein Event/Audit enthält Reason-Label oder Kommentar.
- Kein UI-Gate ersetzt Service-, RLS- oder Trigger-Autorisierung.
