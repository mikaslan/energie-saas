# F10.2 Slice B — Signatur-Status im Kundenportal (read-only)

Status: **IMPLEMENTED (lokal verifiziert 2026-09-04: lint 0 Errors, typecheck, depcruise, generate ohne Drift, Parser-Unit 2/2 via Temp-Config, E2E --list; DB-/E2E-Ausführung pending CI/Maschine — Billing-Block Q6)**

Lane: `codex/muse-welle-03-e2e` off `origin/codex/m1-wave-02`.
Vorgänger: F10.2-A Termine-Tab. Katalog: F10.2 „Angebot (E-Signatur +
Widerruf)" — dieser Slice projiziert den Status lesend; Schreiben
(signieren/widerrufen) bleibt eigener Slice.

## Angewendete Skill-Regeln
- reonic-parity: TDD RED→IMPLEMENTED, keine erfundenen Felder.
- contract-first: View-Schema + Resolve-Parser zusammen erweitern.
- database-migrations: Funktions-Migration handgeschrieben (Nummer
  GLOBAL prüfen: 0062 ist frei); db:generate bleibt „no changes"
  (Funktionen stehen nicht im Drizzle-Schema); Funktions-Pin aus dem
  Migrationstext berechnen (Skript, kein Abtippen; Methode am
  0059-Pin mit MATCH beweisen).

## Privacy-DECIDED (Datenminimalismus, öffentlich ohne Login)
- Projiziert werden je Dokument: `signatureStatus` (`none` ohne
  `signature_request`-Zeile, sonst Statuswortlaut der Zeile) und
  `signedAt` (ISO oder null). NIEMALS: `signer_name`, Token(-Hash),
  Widerrufsgrund, interne Bearbeiter-UUIDs.
- Status wird wörtlich projiziert, keine Übergänge erfunden (kein
  Pending-nach-Expiry-Rechnen im Portal).
- Version bleibt `portal-public-view.v1` (gleiche Deployment-Einheit:
  Migration + Parser shippen zusammen; kein alter Producer existiert).

## Scope
1. Migration `0062_f10_portal_signature_status`: `CREATE OR REPLACE
   resolve_portal_public_view` — Vollkopie des 0059-Bodys +
   `signatureStatus`/`signedAt` je Dokument (LEFT JOIN
   `signature_request` über workspace+issuance). Journal von Hand
   (Muster 0061-Eintrag).
2. Rollenvertrag: Funktions-Pin `resolve_portal_public_view(bytea)`
   — nur Hash ersetzen (Rest identisch kopieren), Hash per Skript aus
   dem Migrationstext (prosrc = Body zwischen den `$$`-Markern).
3. Contract: `signatureStatus` + `signedAt` in `portalDocumentSchema`
   und Resolve-Parser (strict, required — kein alter Producer).
4. UI `/p/[token]`: Statuszeile je Dokument (Übersicht, Dokumente-
   Bereich unverändert an Ort und Stelle — F10.1-E2E bleibt grün):
   none → „Signatur: nicht angefragt", pending → „Signatur:
   ausstehend", signed → „Signiert am <Berlin-Datum>", expired →
   „Signatur: abgelaufen", withdrawn → „Signatur: zurückgezogen",
   revoked_by_customer → „Signatur: vom Kunden widerrufen".
5. Tests: (a) Vitest-DB `f1003-portal-signature-status`: Issuance +
   Request pending → pending/null; signed → signed/Datum; ohne
   Request → none/null; `signer_name` nirgends im JSON;
   (b) E2E-Fallback (dokumentiert): neues f102-Lead nur mit Invite
   ohne Dokumente → Leerzustand + kein „Signatur:"-Text;
   Positivfall per DB-Test (Issuance-Seed per UI zu schwer).

## Nicht-Ziele
- Kein Signieren/Widerrufen im Portal (eigener Slice).
- Kein neuer Tab, keine Verschiebung des Dokumente-Bereichs.
- Keine Sichtbarkeits-Flags, keine anderen Dokumentfelder.

## Akzeptanz
- `npm run check` grün, `db:generate` ohne Drift, E2E-Spec grün (CI),
  Reviews Exit-3 (Selbstreview + Gates).
- Funktions-Pin stimmt beim ersten CI-Lauf (Skript-Herleitung, kein
  Rateversuch).
- Withdrawn/expired/deformiert → identischer 404-Endzustand (kein
  Orakel — bestehende Tests bleiben grün).
