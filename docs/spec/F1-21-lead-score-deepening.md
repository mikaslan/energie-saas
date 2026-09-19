# F1-21 Lead-Score-Vertiefung (T6) — Slice-Spec

Lane `codex/muse-fleet-1c-f1`. Migration **0234**. Quelle: Schwarm-Spec S6 (reviewed).

## DISCOVERED

- Ist: 9-Signal-Regelscore sync beim Board-Read (ESTIMATE), Bänder
  hot≥70/warm≥40, Score-Presets `?score=` + `?wiedervorlage=` existieren.
- Worker-Muster pg-boss v12 (exclusive Queues, ID-only, Definer-Kapseln).
- Intent-Quellen vorhanden: `portal_view_log`, `project_appointment`,
  `signature_view_log`, `file_request_upload`.

## SPECIFIED

- Intent als 10. Signal (Gewicht 10 ESTIMATE): EXISTS über 4 Quellen
  (kundeninitiiert, kein Tracking); Summe→Clamp `min(100,·)`, Bänder fix.
- 3 Presets (fail-closed, kombinierbar): `?intent=aktiv`,
  `?ansprache=bereit` (hot/warm+E-Mail+Telefon), `?luecke=profil`.
- Async-Worker `lead.score.recompute.v1` (exclusive, singletonKey projectId,
  ID-only-Payload, Auslöser aus Service-Schicht, Definer-Kapseln,
  Staleness: pending/älter/TTL-15-min → Badge „wird aktualisiert" + Refresh,
  Cold-Start sync-Fallback, Recovery-Sweep). Ampel unverändert.

## CONTRACTED

- NEU: 0234 (Spalten value/band/signals/computed_at/status + Index +
  2 Kapseln, KEIN Backfill in Migration), `worker/lead-score*.ts`,
  Unit-/DB-/E2E-Tests (Intent-OR, Clamp, Kapsel-Idempotenz, stale-Regel,
  Extern-null, Preset-Links, Worker-Bounded-Wait).
- EDIT: `lead-score.ts`, `boards/service.ts`, `anfragen/page.tsx`,
  `worker/index.ts`, `project.ts`, Runbook.
