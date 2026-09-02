# Kimi-K3-Review M1-11b Spec/ADR — unabhängige Zweitstimme

- Datum: 2026-09-02 · Reviewer: Kimi K3 (`moonshotai/kimi-k3` via OpenRouter,
  Kimi Code CLI 0.40.1, Prompt-Modus mit inline Spec+ADR)
- Gegenstand: `docs/spec/M1-11b-cannot-fulfil.md`,
  `docs/adr/0018-cannot-fulfil-transactional-outbox.md`
- Status: an Implementierer-Lane übergeben; Auflösungen werden in der Spec als
  „Review-Befunde M1-11b-R1" dokumentiert.

## Befunde

1. **P0 — Race `mark_cannot_fulfill` ↔ `approve_offer_issuance` serialisiert
   nicht.** Beide Seiten prüfen per SELECT unter READ COMMITTED; im Interleaving
   committen beide → `cannot_fulfill` plus verbindliche Ausstellung. Lösung:
   gemeinsamer Serialisierungspunkt (Freeze-Trigger liest die Project-Zeile
   sperrend, DANN Outcome-Prüfung; `approve_offer_issuance` hält
   Project-First-Lock-Ordnung ein). DB-Test mit echtem Interleaving.
2. **P1 — Zustellung faktisch at-least-once.** Evidenz-Idempotenz verhindert
   keine Doppelmail (Crash zwischen Send und Status-Update; parallele Worker).
   Lösung: pgboss-`singletonKey`/Idempotenzschlüssel aus Notification-ID,
   Resend-Idempotency-Key, record-then-send dokumentiert.
3. **P1 — Zwei Retry-Wahrheiten** (pgboss-Job vs. Outbox-Status) ohne
   Reconciliation; kein Alarm für stuck `queued`. Lösung: Handler wirft
   retriable Fehler (pgboss retried), Evidenz nur je Versuch, Monitoring-Abfrage
   dokumentiert.
4. **P1 — Erasure-TOCTOU-Behauptung nicht haltbar** mit beschriebenem
   Mechanismus (Sperre über SMTP-Call halten widerspricht ADR). Lösung:
   Auflösung+Cancel-Check unmittelbar vor Send, Status-Recheck nach Send —
   oder ehrlich at-least-once mit Storno-Zustandsmaschine dokumentieren.
5. **P1 — Freeze nur auf INSERT** verpasst UPDATE-basierte Aktivierungspfade;
   Signatur-Sperre nur transitiv unbelegt. Lösung: Aktivierungspfade im
   M2-03-Code prüfen; ggf. Trigger auf INSERT OR UPDATE (nur Übergang in aktive
   Zustände); Signatur-Tabelle prüfen und ggf. in Freeze-Menge aufnehmen.
6. **P2 — Storno deckt nur `queued`** → auf alle nicht-terminalen Zustände
   erweitern (auch `failed_retriable`).
7. **P2 — Evidenz ohne Redaktionsregel = PII-Risiko** (Provider-Fehlertexte
   echo-en Empfängeradressen) → nur Enum-Fehlercodes + Metadaten speichern.
8. **P2 — Keine Eindeutigkeit der Outbox je Projekt/Revision** → Partial-Unique:
   höchstens eine aktive Notification je Projekt/Revision.
9. **P2 — Erasure als Undo ist Zweckentfremdung** → fachliches Storno
   `queued`/`failed_retriable` → `cancelled_manual` ergänzen (Outcome bleibt
   terminal); Erasure bleibt Betroffenenrechtspflicht.
10. **P2 — SECURITY-DEFINER-Hygiene unspezifiziert**: `search_path`-Pinning;
    interne Workspace/Projekt-Zusammengehörigkeitsprüfung in
    `_m111b_project_has_binding_issuance`; Worker-Kapseln unter FORCE RLS
    (GUC-Herkunft aus Job-Payload) im Rollenvertrag gepinnt.

## Einordnung

- Befund 1 ist der einzige P0 und eine echte Konstruktionslücke (nicht nur
  fehlender Test).
- Befunde 2–5 berühren ADR-Kernzusagen („atomar, idempotent, evidenziert",
  „kein Absage ohne Mail", TOCTOU „geschlossen") — vor Abnahme als
  Designfragen klären, nicht als Testlücken.
- Die von der Spec selbst geführten UNKNOWNs (Status-Enum, Tabellenmenge,
  Kapselnamen, Zählung 19/20) sind Abnahmevoraussetzungen und verstärken die
  Befunde 5, 6 und 10.
