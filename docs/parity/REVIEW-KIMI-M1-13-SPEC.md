# Kimi-K3-Review M1-13 Spec/ADR — unabhängige Zweitstimme

- Datum: 2026-09-02 · Reviewer: Kimi K3 (`moonshotai/kimi-k3` via OpenRouter,
  Kimi Code CLI 0.40.1, Prompt-Modus mit inline Spec+ADR)
- Gegenstand: `docs/spec/M1-13-projektnotizen.md`,
  `docs/adr/0019-projektnotizen.md`
- Status: an M1-13-Implementierer-Lane übergeben; Auflösungen in der Spec als
  „Review-Befunde M1-13-R1" dokumentieren.

## Befunde

1. **P1 — `note-text.v1` ohne Link-/HTML-Hygiene (Stored-XSS-Vektor).**
   Subset umfasst Links, aber keine serverseitige Scheme-Whitelist
   (http/https/mailto) und kein Verwerfen von Raw-HTML im Markdown. Vertrag
   muss Scheme-/HTML-Regeln explizit machen (Ablehnung serverseitig).
2. **P1 — CAS-Revision nicht für alle Mutationen definiert.** `set_note_pinned`
   und `delete_note` ohne Revisionssprung → `revision` taugt nicht als
   vollständiger Ordnungsanker. Empfehlung: JEDE Mutation `revision+1`.
3. **P1 — §5-Selbstwiderspruch; Mutations-WHERE fehlt.** Alle Mutationen
   brauchen `WHERE deleted_at IS NULL` mit `not_found`-Semantik; sonst
   Mutationen gegen Tombstones möglich.
4. **P2 — Doppelhaltung `{markdown, plain}` nur durch Disziplin synchron.**
   Optionen: `plain` bei Read ableiten oder Re-Derivation im Gate erzwingen.
5. **P2 — Spekulativer Deleted-Index ist YAGNI** (Restore ist Non-Goal);
   Index streichen.
6. **P2 — Erweiterung des Partial-Activity-Index braucht Migrationsprozedur**
   (Swap außerhalb der Tx bzw. neuer Indexname + alter Drop), sonst blockiert
   die Erweiterung auf befüllter `domain_events`-Tabelle in Produktion.

## Einordnung

Kein P0. Die Spec-Grundlagen (Parent-Modell, DECIDED-Edit/Delete als
ACCEPTED_EXCEPTION, Erasure-Pfad, Event/Audit-Mechanik) wurden ausdrücklich
bestätigt. Befunde 1–3 sind Vertragslücken, die vor CONTRACTED geschlossen
werden müssen; 4–6 sind Implementierungs-Disziplin.
