# F1-18 Generische REST-Lead-Aufnahme (T3) — Slice-Spec

Lane `codex/muse-fleet-1c-f1`. Migration **0231**. Quelle: Schwarm-Spec S3 (reviewed).

## DISCOVERED

- Spiegel-Vorlage F1-15 (Broker): HMAC-Integration (6 Dateien), Route,
  `verified*Action`, `processBrokerIntake`, Receipt-Tabelle 0230.
- `grep rest-intake` leer → grüne Wiese. Contract-SHA-Pin-Muster besteht.

## SPECIFIED

- `POST /api/inbound/rest/v1`: HMAC wie Broker, Scope `rest-intake.write`,
  Creds `REST_INTAKE_KEYS_JSON`, Header `x-rest-*`, Status 201/200/4xx/429/503/500.
- Payload `rest-intake.v1`: Broker-Schema minus `brokerKey`, plus
  `clientRecordId` 1..128 (NFKC-trim), optionales `sourceName` 1..100
  (NUR F1.8-Auflösung, KEIN Dedupe-Merkmal), `geocodeSource ∈ {rest,…}`.
- **Dedupe-Domäne: `UNIQUE(workspace_id, client_record_id)` OHNE keyId**
  (Rotation darf keine Duplikate erzeugen; Präzedenz Rechner/Broker).
  Vertrag: Record-IDs pro Workspace über Creds eindeutig (Präfixe);
  Kollision → 409, nie still. Rate-Limit pro (ws,keyId), 120/10 min.
- Projekt: residential Intake-Lane, `source_key='rest'`, lead_source aus
  `sourceName` (null ehrlich), KEIN Auto-Routing, keine neue Permission.
  Events `project.requested_from_rest`, Audit `rest.intake.write`.

## CONTRACTED

- NEU: 0231 + Snapshot, `inbound-rest-receipt.ts`, `lib/integrations/rest/*`
  (6), Contracts (Schema+OpenAPI+Example), Route, `processRestIntake`,
  `verifiedRestIntakeAction`, `f1018` DB + Contract + E2E-Spec.
- EDIT: Schema-/Intake-Barrel, `db-role-contract.mts` (ACL+Hash),
  Fixtures (+2), `run.mts` (Keys+Grep), `.env.example`, m111a-Pins (TOTAL 153).
- DB-Tests (9, inkl. Rotation-Replay!), Contract (6), E2E (1, 201/200/401+Board).
