# Kimi-K3-Review M1-14 Spec/ADR — unabhängige Zweitstimme

- Datum: 2026-09-02 · Reviewer: Kimi K3 (`moonshotai/kimi-k3` via OpenRouter)
- Gegenstand: `docs/spec/M1-14-kontaktdatensatz.md`,
  `docs/adr/0020-kontakt-datenmodell.md` — geprüft GEGEN Ist-Code
  (`lib/db/schema/crm.ts`, `intake.ts`, `drizzle/0027_m1_07_gdpr_erasure.sql`)
- Status: an M1-14-Spec-Agent zur Einarbeitung übergeben.

## Befunde

1. **P0 — ADR Entscheidung 6 kollidiert mit dem `revision`-CHECK → Erasure
   schlägt fehl.** `CHECK (revision between 1 and 2147483647)` vs. Scrub
   „revision auf 0 zurücksetzen" → Constraint-Violation im
   `erase_inactive_lead`-Statement → DSGVO-Pfad blockiert. Empfehlung:
   `revision` NICHT scrubben (keine PII, CAS-Semantik bleibt).
2. **P1 — `first_name`/`last_name` NOT NULL widerspricht NON-GOAL „Intake
   bleibt unverändert".** Der Intake legt Contacts mit nur `display_name` an
   (`intake.ts:129-131`); nach Migration 0042 scheitert der INSERT. Scope
   korrigieren („Intake minimal angepasst") oder Constraints ändern.
3. **P1 — Lock-Reihenfolge Edit vs. Erasure widersprüchlich → Deadlock.**
   Spec §8: Project→Contact; `0027`: Contact→Project (Zeilen 532-564).
   Fix: gemeinsame Ordnung oder derselbe Advisory-Lock.
4. **P2 — Backfill „Split-on-first-space" auf rohem `display_name` unsicher**
   (führender Leerraum → `first_name=''` → CHECK-Verletzung). Regel vor
   Migration deterministisch pinnen.
5. **P2 — DE-only-PLZ-Regex vs. freies `address_country`.** Regex an
   `country IN ('DE', null)` koppeln oder auf Längenprüfung reduzieren.
6. **P2 — Scrub-Listen-Erweiterung zieht Nicht-PII mit** (`is_business`,
   `revision`) — auf echte PII beschränken.
7. **P2 — `display_name`-Ableitung ohne Trigger braucht EINE geteilte
   Normalisierungsfunktion als Vertragsteil** (sonst Drift zwischen Intake-
   Create und `updateContact`).

Bestätigt ohne Befund: flache Kontaktweg-Spalten, Consent + Policy-Version,
revision-CAS-Muster, UTM flach.
