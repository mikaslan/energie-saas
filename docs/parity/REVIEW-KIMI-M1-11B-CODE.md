# Kimi-K3-Code-Review M1-11b — Security/Race-Zweitprüfung

- Datum: 2026-09-02 · Reviewer: Kimi K3 (OpenRouter) · Gegenstand: implementierter
  M1-11b-Slice (Migration 0040, outcome-service, worker, notifications, UI-DTOs)
- Status: an Implementierer-Lane zur Behebung übergeben.

## Kurzfazit

Kein neuer P0. P0-Serialisierung korrekt (Freeze `FOR SHARE` ↔ Transition
`FOR UPDATE` auf derselben Project-Zeile, deadlockfrei). Kimi-Befunde 1–10
weitgehend UMGESETZT (Details unten).

## Neue Befunde

1. **P1 — Retry-Erfolg wird verschluckt.** `0040:724-731` EXISTS-Guard returniert
   ohne Statushebung → nach pgboss-Retry bleibt die Zeile `failed_retriable`,
   obwohl die Mail zugestellt wurde. Fix: im EXISTS-Zweig
   `failed_retriable→delivered` nachziehen oder Retries nur über neue
   Attempt-Nummern.
2. **P1 — Storno wird beim Versand nicht respektiert.** `resolve_recipient`
   (`0040:673-684`) ohne Statusprädikat; Statuscheck erst in `deliver` NACH dem
   Send → `cancelled_manual`-/Erasure-Zeilen können trotzdem versendet werden;
   Rest-TOCTOU zwischen Resolve und Send. Fix: Statusprädikat in
   `resolve_recipient` + Status-Recheck unmittelbar vor `transport.send`.
3. **P2 — Poison-Retry nach Erasure:** `cancelErased` wirft 23514 bei bereits
   stornierter Zeile → pgboss-Retry-Rauschen bis Dead-Letter. Fix: idempotent.
4. **P2 — Kein Outbox-Backoff/Attempt-Deckel:** `next_attempt_at` wird bei
   `failed_retriable` nie fortgeschrieben; keine Obergrenze nach
   `failed_final`.
5. **P2 — `enqueue_customer_notification` ohne Zustellbarkeitsprädikat**
   (`0040:1002-1011`): erzeugt Jobs für nicht-zustellbare Zeilen.
6. **P2 — Same-Status-Guard lässt Evidenzfelder frei** (`0040:190-196`):
   `app_runtime` kann `delivered_at` u. a. ohne Statuswechsel setzen.

## Kimi-Befunde 1–10: Verifikation

1 P0-Race UMGESETZT (Serialisierung belegt; echter Interleaving-Test liegt
  inzwischen als DB-Test vor — Nachweis bei Abnahme). 2 Idempotenz UMGESETZT
  (B-1-Einschränkung). 3 Retry-Wahrheiten TEILWEISE (Monitoring-Abfrage
  nachziehen; B-4). 4 TOCTOU TEILWEISE (B-2). 5 INSERT-only-Freeze UMGESETZT
  (M2-03-Pfad-Verifikation bleibt Abnahmebedingung). 6–8 UMGESETZT.
  9 cancelled_manual TEILWEISE (kein Aufrufpfad; B-2). 10 SD-Hygiene
  UMGESETZT (search_path, interne Bindung, GUC, FORCE RLS, saubere Grants).

## Abnahmeempfehlung

B-1 + B-2 vor Merge beheben; B-3 bis B-6 als Follow-up; Interleaving-Test und
Monitoring-Abfrage als Abnahmenachweise nachziehen.
