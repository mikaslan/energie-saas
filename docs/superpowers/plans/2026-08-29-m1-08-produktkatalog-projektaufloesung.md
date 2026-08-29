# M1-08 — Umsetzungsplan Produktkatalog und Projektauflösung

## Ziel

Den verifizierten Golden Path ab M1-07 real erweitern:

```text
aktuelle Planungsschätzung
  → eigener revisionsgebundener Workspace-Katalog
  → aktive Produkte mit EK/VK-Provenienz
  → unveränderliche projektbezogene Produktauflösung
  → sichtbarer Current-/Stale-Zustand
```

Offer, Variante, BOM, Steuer, PDF und Signatur bleiben außerhalb dieses
Slices. Reale „Vault“-Daten werden erst nach autoritativer Quelle eingespielt.

## Reihenfolge

1. **Capability und Vertrag**
   - Spec und ADR festschreiben;
   - `catalog-component-revision.v1` und
     `project-catalog-resolution.v1` als strikte Runtime-/JSON-Schemas bauen;
   - Canonicalizer, Hashes und Golden Fixtures pinnen.

2. **RED**
   - alle Komponententypen, geschlossene Objekte, unbekannte Fähigkeiten,
     Preispaare, Quellenrechte und Assetkeys;
   - DB-/RLS-/ACL-/Migrationstests für Identität, Revision und Auflösung;
   - Rollen-, EK-Redaktions-, Race-, Stale-, Rollback- und Erasuretests;
   - Action-/UI-Verträge und Browser-Golden-Path.

3. **Additives Schema und Migration**
   - `catalog_component`, `catalog_component_revision` und
     `project_catalog_resolution` modellieren;
   - Workspace- und Composite-FKs, FORCE RLS, genau eine permissive Policy;
   - append-only/immutable Trigger und enge Runtime-ACL;
   - Tenant-Fixtures, Rollenvertrag, Fresh-/Upgradepfad erweitern.

4. **Katalogmodul**
   - serverseitige SKU-Normalisierung;
   - getrennte Details-/Preisrevisionen mit Optimistic Locking;
   - Aktivieren, Archivieren und Rückkehr zu Draft;
   - öffentliche und EK-berechtigte Readmodelle ohne Client-Redaktionsfehler;
   - PII-/preisfreie Events und Audits.

5. **Projektauflösung**
   - nur aktuelle M1-07-Calculation und Requirement akzeptieren;
   - Produkte sortiert sperren, danach Project sperren;
   - serverseitig vollständige Produktrevisionen und Preise kopieren;
   - Coverage/Warnungen deterministisch ableiten und exakt bestätigen;
   - Snapshot/Hash atomar speichern und Project auf `resolved` setzen;
   - Katalog-/Calculation-Änderungen auf `pending`, Historie unverändert.

6. **Geschützte Oberfläche**
   - `/katalog` mit Empty/List/Read-only/Create;
   - Produktdetail mit Provenienz, Revision, Preis- und Statusaktionen;
   - Projektseite `/produkte` mit Auswahl, Mengen, Coverage und
     Current-/Stale-/Blocked-Zuständen;
   - Projektakte/Board konsistent aktualisieren.

7. **M1-08b Import und Assets**
   - CSV-Contract mit UTF-8/CP1252, Semikolon, deutschem Dezimalformat,
     Zeilenlimit und stabilen Zeilenfehlern;
   - Import ruft dieselben Create-/Revision-Commands auf;
   - echte Assetuploads erst nach provisionierter, tenantgebundener
     Object-Storage-Grenze; bis dahin nur null bzw. geprüfte Testreferenzen.

8. **Abschluss**
   - vollständiger Browserfluss samt Reload und Produktrevision→stale;
   - Viewer, Preisrecht, External, Fremdtenant, 320 px, 200 %, Reduced Motion,
     Axe und Console/Page-Errors;
   - Lint, Typecheck, Dependency-Cruiser, Volltests, DB-Rollen und Build;
   - unabhängige Security-/Tenant-/Snapshot-Reviews, P0–P2 schließen;
   - Spec, Paritätsmatrix und Vault aktualisieren;
   - atomarer lokaler Commit, kein Push oder Deploy.

## Kritische Dateien

- `lib/integrations/catalog/**`
- `contracts/catalog*.schema.json` und Fixtures
- `lib/db/schema/catalog.ts`
- neue Forward-only-Migration ab `drizzle/0030_*`
- `scripts/db-role-contract.mts`, `tests/setup/tenant-fixtures.ts`
- `modules/catalog/**`
- `modules/energy/calculation-service.ts`
- `app/w/[workspaceId]/katalog/**`
- `app/w/[workspaceId]/anfragen/[projectId]/produkte/**`
- Contract-, Unit-, DB-, Migration-, Action- und E2E-Tests

## Stoppschilder

- Kein Produkt-/Preiswert aus dem Rechner-`market_estimate`.
- Kein Reonic-Seed, keine erfundene „Vault“-SKU und kein Asset ohne
  Quellen-/Rechtebeleg.
- Kein EK im nicht berechtigten Clientpayload, Event, Audit oder Log.
- Keine stille Snapshot-Propagation.
- Kein `resolved`, wenn Requirement, Calculation oder Pflichtkategorie nicht
  aktuell und vollständig ist.
- Keine Abschwächung bestehender Tests oder Migrationen.
- Kein Push, Preview, Providerkauf oder Produktionsdeploy ohne Freigabe.
