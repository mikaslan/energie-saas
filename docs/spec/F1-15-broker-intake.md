# F1-15 Broker-Intake via REST (F1.2) — Slice-Spec

Lane `codex/muse-fleet-1c-f1`, Migration **0230** (Range 0230–0239).
Journal: 0230 → idx 151, TOTAL 151 → 152.

## DISCOVERED (Belege, nicht Annahmen)

- Katalog F1.2: 6 Broker-APIs (Wattfox, Aroundhome, DAA, Eza,
  Interlead, Bitrix); Dedupe über Broker-Record-ID, cross-broker nur
  kontaktbasiert.
- Repo-Stand: null Broker-Code (`grep broker` leer in lib/modules/app).
  F1.1 schemaseitig gesättigt (Anrede, B2B, 2 E-Mails,
  Erreichbarkeitsfenster, Consent + Policy-Version, UTM).
  F1.5-Spaltentypen M2-blockiert (offer.status kennt nur draft),
  F1.7/F14 SPECIFIED, E-Mail-Anbindung provider-blockiert.
  → F1.2-Broker ist der höchste offene F1-Pfad.
- Wiederverwendbar: Rechner-HMAC-Muster
  (`lib/integrations/rechner/{http,signature,body,contract,errors,types}.ts`,
  `app/api/inbound/rechner/v1/route.ts`, `verifiedRechnerIntakeAction`
  in `lib/action.ts`); Kontakt-Dedupe-Helfer intern in
  `modules/intake/service.ts` (`contactCandidates`, `decideContact`,
  `selectOrAllocateSite`, `advisoryLock`, `enforceRateLimit`,
  `replayOrConflict`, `normalizedRequiredText`, `requestHash`);
  Lead-Source-Auflösung per Name (`resolveLeadSourceForProducer`,
  `project.lead_source_id`, null wenn keine Quelle);
  E2E-Harness mint `IntakeCredential[]` und injiziert
  `RECHNER_INTAKE_KEYS_JSON` (`tests/e2e/run.mts` `nextEnvironment`).
- `inbound_receipt.submission_id` ist UUID — fremde Broker-Record-IDs
  sind Text → eigene Tabelle `inbound_broker_receipt`.
- Barrel-Pin: `tests/build/rechner-intake-module-import.test.ts`
  pinnt `@/modules/intake`-Exporte (Buchung nötig).

## SPECIFIED (Verhalten)

- `POST /api/inbound/broker/v1` (nodejs-Runtime). HMAC wie Rechner,
  eigene Scope-Konstante `broker-intake.write`, eigene Creds
  `BROKER_INTAKE_KEYS_JSON` (`keyId`/`scope`/`secretBase64`/
  `workspaceId`, Secret 32..64 B, Timestamp-Replay-Fenster wie
  Rechner). Fehler: 401 Auth, 409 Conflict (Hash-Drift),
  422 Validation, 429 Rate, kein PII in Logs/Fehlern.
- Payload `broker-intake.v1`: `broker_key` ∈ exakter Allowlist
  `{wattfox, aroundhome, daa, eza, interlead, bitrix}` (sonst 422);
  `broker_record_id` 1..128 (NFKC-Trim, sonst 422); `customer`
  (`displayName` 1..200, `email`, `phoneRaw` nullable);
  `site` (Adress-Subset: `formattedAddress` + optional
  Straße/Nr/PLZ/Ort/Ländercode + Lat/Lng nullable);
  `note` optional ≤ 2000. Kein Consent-Feld in v1 (Folge-Slice);
  Receipt trägt fixen Purpose `broker-lead.v1`.
- Dedupe: `UNIQUE(workspace_id, broker_key, broker_record_id)`.
  Gleicher Record + gleicher Hash → idempotentes Replay (dasselbe
  Receipt, kein 2. Projekt). Gleicher Record + anderer Hash →
  Conflict (fail-closed, kein Overwrite). Cross-Broker/-Record →
  Kontakt-Dedupe (`decideContact`): Treffer → `reviewRequired`-Hinweis,
  kein stilles Mergen.
- Projekt: Intake-Spalte Residential (wie Rechner/Manual),
  `source_key='broker'`, `lead_source_id` per Broker-Name (null wenn
  keine Quelle — ehrlich, keine implizite Anlage),
  `assignment_revision=0` (M109-01 ehrlich unzugewiesen).
  KEIN Auto-Routing (F1-10-Präzedenz: Vorschlag statt Automatik),
  keine neue Permission, keine externen Calls (inbound only;
  synthetischer Broker = Test-Double-Semantik).
- Nebenläufigkeit: Advisory-Lock
  `broker-receipt:v1:{ws}:{broker}:{record}` + Unique-Backstop
  (Race → genau 1 Projekt, kein Teilstand).
- RLS: `tenant_isolation` FOR ALL, enabled + forced. ACL-Spiegel zu
  `inbound_receipt` (select + insert + update(id) an app_runtime).
  Tenant-Fixture + Cross-Write sofort (Lehre aus F1-14).
- E2E: `run.mts` mint einen Broker-Key für den W3-Workspace
  (gleiche Disziplin wie Rechner-Keys), injiziert
  `BROKER_INTAKE_KEYS_JSON` und legt KeyId + Secret in
  `M1_05_E2E_STATE` ab (kein committed Secret); Spec signiert per
  node:crypto, POSTet (201 + Replay-200 + 401-Fälschung), assertiert
  Receipt + Board-Karte + Detail-H1 (Viewports 375/768/1440).
  Kein neuer Axe-Surface (keine neue UI; Board-Coverage existiert) —
  begründet, kein Verzicht.

## CONTRACTED (Dateien + Tests)

- Neu: `drizzle/0230_f1_15_broker_intake.sql` +
  `drizzle/meta/0230_snapshot.json`,
  `lib/db/schema/inbound-broker-receipt.ts`,
  `lib/integrations/broker/{types,errors,body,contract,signature,http}.ts`,
  `app/api/inbound/broker/v1/route.ts`,
  `processBrokerIntake` in `modules/intake/service.ts` (+ Barrel),
  `verifiedBrokerIntakeAction` in `lib/action.ts`,
  `tests/db/f1015-broker-intake.test.ts`,
  `tests/contracts/broker-intake-contract.test.ts`,
  `tests/e2e/f1-15-broker-intake.spec.ts`.
- Geändert: `lib/db/schema/index.ts`, `modules/intake/index.ts`,
  `scripts/db-role-contract.mts` (ACL + Verify + geernteter Hash),
  `tests/setup/tenant-fixtures.ts` (+2 Einträge),
  `tests/e2e/run.mts` (BROKER-Keys + Grep),
  `tests/build/rechner-intake-module-import.test.ts` (Pin +Exporte),
  m111a-Pins (TOTAL 152, Tail 0230@151).
- DB-Tests (Ziel 8): Happy Path (Kontakt+Site+Projekt+Receipt,
  Quelle gesetzt), Quelle fehlt → null, Replay idempotent,
  Hash-Drift → Conflict, Cross-Broker-Kontakt → reviewRequired,
  unbekannter Broker-Key → Validation, Fremdtenant → NotFound,
  Race → genau 1 Projekt.
- Contract-Tests (Ziel 6): Schema-Grenzen (Record-ID, Allowlist,
  E-Mail, Notiz-Cap), Handler-401 (Signatur), Handler-422, Replay
  via `credentialsJson`-Option.
- E2E (Ziel 1): signierter POST → Receipt → Board-Karte sichtbar.
- Gates: `npm run check` EXIT 0 (inkl. Rollen 88 + PG18),
  `db:generate` ohne Drift, Secretscan sauber, keine Schwaechung.
