# ADR 0025 — Kalender-Scopes: `calendar`-Objekt (supersedes ADR 0021 E2)

- Status: VORGESCHLAGEN (im Rahmen der M1-15b-Spec DISCOVERED→SPECIFIED)
- Datum: 2026-09-03
- Betroffene Slice-Spec: `docs/spec/M1-15b-kalender-scopes.md`
- Supersedes: ADR 0021, Entscheidung E2 („kein `calendar`-Objekt in M1-15“)
- Basis: `01b52e9` (M1-12a); additiv auf M1-15 (0043)

## Kontext

ADR 0021 E2 hatte für M1-15 bewusst auf ein `calendar`-Objekt verzichtet
(DECIDED, ACCEPTED_EXCEPTION; Termine + Kategorien zuerst, `UNK-M115-01`).
Die Reonic-REST-API verlangt `Appointment.calendarId` jedoch als Pflichtfeld
mit 4 Scopes (`Team|Tenancy|User|Client`); das Portal zeigt
Unternehmens-/Benutzer-/persönliche Kalender plus Kalenderauswahl. Ohne
Kalender-Objekt bleibt die Kalender-Parität (F1.9) unvollständig.

## Entscheidung

M1-15b führt das `calendar`-Objekt ein und **ersetzt ADR 0021 E2**:

1. Tabelle `calendar` (4 Scopes als `type`-Enum, `color` Hex nullable,
   `userId`/`teamId` nullable, `revision`-CAS nach Hausmuster,
   Archivierung statt Hard-Delete).
2. `project_appointment` erhält `calendar_id` (not null); der M1-15-Kollaps
   wird aufgelöst: `appointment.category_id` entfällt, `calendar.category_id`
   tritt an seine Stelle (API-treue Form).
3. Workspaceweite `/calendar`-Route („Alle/vier Kalender“, Planungsmodus) ist
   Teil von M1-15b (Root O3) — ohne sie sind die Scopes nicht bedienbar.
4. Bestands-Termine werden beim Backfill an den persönlichen Kalender des
   `created_by` gebunden (Auto-Provisionierung zuerst), sonst an den
   Unternehmenskalender — ESTIMATE.

## Konsequenzen

- ADR 0021 bleibt für die **übrigen** M1-15-Entscheidungen gültig; nur E2 wird
  superseded. M1-15 (0043) bleibt als gelieferter Stand unverändert gültig —
  M1-15b erweitert ihn additiv (Migration 0047, nach der M3-Welle).
- `Team`-Scope strukturell vorbereitet (`team_id` nullable), FK folgt mit dem
  Team-Slice (UNK-F1-01); `Client`-Scope bleibt F10-Nichtziel.
- Termine bleiben im DSGVO-Erasure-Graphen; `calendar`/`calendar_category`
  selbst liegen außerhalb (Firmen-/Struktur-Daten, DEC-M115B-07).
