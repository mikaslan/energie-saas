# M1-07 — Umsetzungsplan Energieprofil und Planungsrechnung

## Ziel

Den verifizierten Golden Path ab M1-06 real erweitern:

```text
Rechner-Lead → hausgenauer bestätigter Standort
  → Rechner-Eingaben prüfen
  → operative Site-Profilrevision speichern und getrennt bestätigen
  → serverseitig reproduzierbare projektbezogene Planungsschätzung
```

Importierter Rechner-Output, Katalogprodukte, Marktpreise, BOM und Angebot
bleiben außerhalb dieses Slices.

## Reihenfolge

1. **Capability und Vertrag**
   - Spec und ADR festschreiben.
   - `planning-calculation.v1` als kanonisches Runtime-/JSON-Schema definieren.
   - Rechnerfeld-Mapping und Golden Fixtures für Neubau/Bestand anlegen.
   - Rechte-/Artefaktgrenze des Rechnerkerns dokumentieren.

2. **RED**
   - Contract-Drift, geschlossene Objekte, unbekannte Felder und Hashing.
   - Profilprojektion ohne Clientresultat/Marktpreis.
   - DB-/RLS-/ACL-/Migrationstests für Profilrevision, Confirmation,
     dauerhaften Queuejob und immutable Resultrevision.
   - Concurrency, Idempotenz, stale Bindings und Rollback.
   - Provider-/Enginevertrag inklusive UTC→Europe/Berlin→Leap-Day,
     PVcalc-Skalierung, Einheiten und Fehlerklassen.
   - Action-/UI-Vertrag und erster Browserfall.

3. **Additives Schema und Migration**
   - operative 1:1-Site-Profilzeile, technische Calculation-Queue und
     projektbezogene immutable Resultrevision modellieren;
   - Fresh- und M1-06-Upgradepfad generieren/testen;
   - RLS/FORCE, Policies, immutable Felder, Statusübergänge und ACL-Manifest;
   - Tenant-Fixtures und Rollenvertrag erweitern.

4. **Profilmodul**
   - Rechner-Snapshot → `site-energy-profile.v1` ohne Resultate,
     Marktpreise, Zielprodukte oder Projektannahmen projizieren;
   - Read-, Save- und getrennten Confirm-Service implementieren;
   - Events/Audits auf IDs, Revisionen und Status begrenzen.

5. **Provider und CalculationPort**
   - PVGIS-v5.3-Adapter mit lokalem deterministischem Vertragsserver;
   - kanonische Serialisierung und SHA-256;
   - versionierten CalculationPort und echten autorisierten Engineadapter
     hinter der dokumentierten Rechner-Artefaktgrenze implementieren;
   - Golden Vectors und Energieinvarianten gegen denselben Vertrag prüfen.

6. **Dauerhafte Orchestrierung**
   - Confirmation und Reservation atomar in einer kurzen Transaktion;
   - Lease/Claim, aktiven-Job-Limit, Actor-/Workspace-Quota, Cooldown,
     Backoff und begrenzte Retries;
   - Provider und primäre Engineausführung außerhalb der DB; die kurze
     Finalisierung darf ausschließlich den hart begrenzten, netzwerkfreien
     modellexakten Integritätsvergleich wiederholen;
   - Input-/Provider-Snapshot einmalig setzen und bei Retry wiederverwenden;
   - frische atomare Finalisierung mit erneuter Revisionsprüfung;
   - idempotenter Auto-Start nach Confirmation und technischer Retry.

7. **Projektakte**
   - zugängliches Profilformular mit sichtbarer Provenienz;
   - getrennte Save-/Confirm-Zustände;
   - aktuelle/stale/failed Planungsschätzung und getrennte Blocker;
   - Viewer read-only, External/Fremdtenant fail-closed.

8. **Abschluss**
   - Browser-Golden-Path samt Reload, stale/retry, Rollen, Mobile und Axe;
   - Lint, Typecheck, Dependency-Cruiser, Volltests, DB-Rollen und Build;
   - zwei unabhängige P0–P3-Reviews, P0–P2 schließen;
   - 24-Monats-Retention, Erasuregraph und Restore-Tombstone-Replay prüfen;
   - Spec/Paritätsmatrix nur nach belegtem Zustand aktualisieren;
   - atomarer lokaler Commit, kein Push oder Deploy.

## Kritische Dateien

- `lib/integrations/calculation/**`
- `contracts/planning-calculation.v1.schema.json`
- `contracts/examples/planning-calculation.v1*.json`
- `lib/db/schema/site.ts` oder neues `lib/db/schema/energy.ts`
- neue Forward-only-Migration unter `drizzle/`
- `scripts/db-role-contract.mts`, `tests/setup/tenant-fixtures.ts`
- neues `modules/energy/**`
- `modules/projects/**`
- `app/w/[workspaceId]/anfragen/[projectId]/**`
- Contract-, Unit-, DB-, Migration-, Action- und E2E-Tests unter `tests/`

## Stoppschilder

- Kein Quellcode-Vendoring aus Rechner V3 ohne dauerhafte Rechtequelle.
- Kein `VERIFIED` mit dauerhaftem Fake-Engineadapter.
- Kein Katalog-/Preis-/Angebotswert aus `market_estimate`.
- Kein Provider-I/O in einer offenen DB-Transaktion.
- Keine Abschwächung bestehender Tests oder Migrationen.

## Abschlussstand 2026-08-29

Der lokale Slice ist `REVIEWED/VERIFIED`. Belegt sind:

- 62 Testdateien mit 620 grünen Repository-Tests;
- 6/6 isolierte Chromium-E2E einschließlich aller sieben Rechenzustände,
  Stale→Reconfirm→Current, Quota, Viewer/Fremdtenant, 320 px,
  200-%-Textzoom, Reduced Motion, Axe und Console/Page-Errors;
- Production-Build, TypeScript, ESLint, Dependency-Cruiser, Worker-CJS-Bundle,
  Generator- und Diff-Checks;
- 75 strikte Rollenprüfungen und 5 PostgreSQL-18-Regressionsprüfungen;
- adversariale Regressionsfälle für kohärent neu gehashte Energieflüsse,
  Kleinlast-Rundung, Quota-Races, Lease-/Retry-Races, Fresh-/Legacy-Migration,
  pg-boss-Bootstrap und DSGVO-Erasuregraph.

Offen außerhalb der lokalen Verifikation bleiben Live-PVGIS, F4-
Referenzvalidierung, echter Staging-/Restore-/Pilotbetrieb und die spätere
Innenaufnahme des Reonic-Portals nach Unternehmensfreigabe.
