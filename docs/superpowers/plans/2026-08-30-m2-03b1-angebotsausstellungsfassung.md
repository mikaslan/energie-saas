# M2-03b1 Implementation Plan: Angebots-Ausstellungsfassung

**Goal:** Aus einem bytegebunden freigegebenen M2-03a-Candidate eine neue,
finale Angebots-PDF erzeugen und nach zwei exakten Freigaben ehrlich bei
`approved_for_archive_not_issued` enden.

**Architecture:** Der bestehende Modular-Monolith erhaelt einen eigenen
Issuance-Contract, drei append-only Tenanttabellen, einen ID-only pg-boss-
Renderworker, einen duennen Tenant-Service und ein internes Offer-Panel. Der
Slice besitzt absichtlich keinen Storageadapter und keinen `issued`-Pfad.

**Tech Stack:** Next.js 16.3.3 App Router, React 19 Server Actions,
TypeScript strict, PostgreSQL 18/Drizzle, pg-boss 12, Playwright/Chromium 1.62.1,
Vitest.

## Vorbedingungen und feste Entscheidungen

- Basiscommit `62b75bd` ist sauber und M2-03a technisch verifiziert.
- ADR 0012 und Spec M2-03b1 sind der Implementierungsvertrag.
- Gate 1 und Gate 2 sind durch den Nutzer fuer lokale technische Arbeit
  vorab freigegeben; externe Anbieteraktionen bleiben nicht autorisiert.
- Zwei verschiedene Approver sind Pflicht; mindestens einer ist nicht der
  Candidate-Approver.
- Candidate-Bytes werden nie wiederverwendet; das neue PDF enthaelt keinen
  temporaeren Entwurfsstatus.

## Task 1: Contract und Golden Tests

**Files:**

- Create: `lib/integrations/offers/issuance-contract.ts`
- Create: `tests/contracts/m203b1-offer-issuance-contract.test.ts`

1. RED: strikte Request-/Dispatch-/Input-/Approval-/Withdrawal-Schemas und
   Golden-Hash-Faelle schreiben.
2. GREEN: versionierte Konstanten, canonical builder/validator und
   datensparsame Commands implementieren.
3. REFACTOR: Candidate-Input nur durch validierte Transformation verwenden;
   keine PII in Dispatch/Statusvertraegen.

## Task 2: Finale Template-Bytes

**Files:**

- Create: `lib/integrations/offers/issuance-template.ts`
- Create: `tests/unit/m203b1-offer-issuance-template.test.ts`

1. RED: Escaping, Summen, Mehrseite, keine Remote-Ressourcen und Abwesenheit
   aller Candidate-/Draft-Kennzeichnungen testen.
2. GREEN: reines HTML-Template aus dem Issuance-Input implementieren.
3. REFACTOR: gemeinsame sichere Formatierung nur dann extrahieren, wenn sie
   keine Release-/Issuance-Abhaengigkeitsrichtung verletzt.

## Task 3: Schema und Migration 0035

**Files:**

- Create: `lib/db/schema/offer-issuance.ts`
- Modify: `lib/db/schema/index.ts`
- Create: `drizzle/0035_m2_03b1_offer_issuance.sql`
- Modify: `drizzle/meta/_journal.json`
- Add/modify: passende Schema-, Migration-, Rollen- und Tenanttests

1. RED: fresh/upgrade, RLS/FKs, Append-only, Rollenrechte und Concurrency-
   Invarianten formulieren.
2. GREEN: `offer_issuance`, `offer_issuance_approval`,
   `offer_issuance_withdrawal` und engste SECURITY-DEFINER-Funktionen bauen.
3. GREEN: Runtime-/Worker-GRANTs exakt und ohne Archive-/Storage-Rechte setzen.
4. REFACTOR: generische Tenant-Suite und Erasuregraph erweitern.

## Task 4: Service, Permissions und Audit/Event

**Files:**

- Create: `modules/offers/issuance-service.ts`
- Modify: `modules/offers/index.ts`
- Modify: `lib/permissions.ts`
- Create: Service-/RBAC-/Privacy-Tests

1. RED: Request/Replay, Status, Byte-Read, zwei Approvals, Drift, Withdrawal,
   Cross-Tenant und External testen.
2. GREEN: `TenantTx + ServiceCtx`, duenne DB-Funktionen und sichere
   Domain-Events/Audits implementieren.
3. REFACTOR: Fehler nach aussen oracle-frei und Inhalte in Logs/Audit vermeiden.

## Task 5: ID-only Renderworker

**Files:**

- Create: `worker/offer-issuance.ts`
- Create: `worker/offer-issuance-database.ts`
- Create: `worker/offer-issuance-renderer.ts`
- Modify: `worker/index.ts`, `scripts/pgboss-bootstrap.mts`, Worker-Runbook und
  Containervertrag
- Create: Worker-/Renderer-/Database-Tests

1. RED: ID-only Payload, Queuevertrag, Claim/CAS, Retry, Recovery,
   Nichtdeterminismus und Secret-Abwesenheit testen.
2. GREEN: vorhandene isolierte Chromium-Grenze fuer den neuen Jobtyp nutzen.
3. GREEN: atomare Artifact-Finalisierung mit SHA/MIME/Laenge.
4. REFACTOR: gemeinsame Workermechanik nur bei erhaltener Least Privilege.

## Task 6: Server Actions, UI und private Route

**Files:**

- Create: `app/w/[workspaceId]/angebote/issuance-actions.ts`
- Create: `app/w/[workspaceId]/angebote/issuance-action-state.ts`
- Create: `app/w/[workspaceId]/angebote/[offerId]/offer-issuance-panel.tsx`
- Create: private PDF-Route unter der Offer-/Issuance-Hierarchie
- Modify: Angebotsdetailseite/-View
- Create: Action-, UI-, Route- und Build-Contract-Tests

1. RED: strict FormData, Duplicate-Fields, Reauth, private Header und
   verbindliche Microcopy testen.
2. GREEN: duenne Actions und zugaengliches Panel mit 0/2, 1/2, 2/2,
   Failure- und Withdrawal-Zustaenden bauen.
3. GREEN: Download bei jedem GET erneut hashen und autorisieren.
4. REFACTOR: keine optimistische Darstellung von Freigabe oder Ausstellung.

## Task 7: Browser-, Container- und Gesamtverifikation

1. Browser-E2E mit zwei echten Testmemberships: Candidate -> Issuance ->
   Workerfinalisierung -> erste -> zweite Freigabe -> Download; eigener
   Withdrawal- und Race-Fall.
2. Accessibility fuer Tastatur, Labels, Live-Region, Error Summary und
   200/400-%-Reflow.
3. Gepinnter `linux/amd64`-Container: zwei deterministische Render, A4,
   Seitenstatus und Hashgleichheit.
4. Vollgates: ESLint, Typecheck, Dependency-Cruiser, alle Vitest-/DB-Rollen-
   und Chromiumtests, Production Build.
5. Unabhaengige Security-, Regression-, Navigation- und lokale
   Claude-Code-Opus-Max-Reviews; alle P0-P2 schliessen.

## Task 8: Evidence, Parity-Dokumente und Vault

1. Spec/ADR von `PENDING` auf den tatsaechlich belegten Stand setzen.
2. `CAPABILITY-MATRIX`, `STATUS`, `TEST-EVIDENCE`, `DOMAIN-MODEL`,
   `WORKFLOW-STATE-MACHINES`, `ROLE-PERMISSION-MATRIX`, `SOURCE-REGISTER` und
   `UNKNOWN-CONFLICT-LOG` aktualisieren.
3. M2-03b2 weiter ehrlich `BLOCKED` dokumentieren.
4. Vault `Reonic Clone Final` mit Arbeitsstand, Artefaktregister und Commit
   aktualisieren.
5. Sauberen lokalen Commit erstellen; kein Push, Merge oder Deploy.
