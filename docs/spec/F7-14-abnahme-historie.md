# F7-14 Abnahme-Historie (Mehrfach-Abnahmen, Katalog F7.5)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12 (DB F714 2/2, E2E F714-E2E-01 1/1, Nachbar-E2E 5/5, DB-Nachbarn 18/18 + Pins 19/19, Tenant-Invarianten 18/18, Vollsuite 216 Files 1405 bestanden/1 übersprungen, tsc/eslint/depcruise/db:generate grün, lokal beobachtet; Push wartet auf CI-Verdikt 34714260525).

Ziel: Jede Abnahme (F7-05) bleibt als eigener Verlaufseintrag erhalten
(F7-05-Spec: „Bewusst offen: … Mehrfach-Abnahmen mit Historie“).
Korrekturen überschreiben weiter den Kopf (`installation.handover_*`,
aktuelle Abnahme), ergänzen aber die append-only Historie — Wer/Wann/
Notiz je Abnahme bleiben lesbar.

## ESTIMATE (reversibel, Referenzfrage offen)

- Tabelle `installation_handover` (Migration 0133): `id`,
  `workspace_id`, `installation_id` (Composite-FK wie F7-12),
  `by_name` (1–160, getrimmt), `note` (null oder 1–500),
  `recorded_by` (Actor-UUID, kein FK — Muster F7-12-`created_by`),
  `recorded_at` (timestamptz, finite). Append-only: kein Update-/
  Delete-Pfad im Service, keine Statusmaschine.
- `recordHandover` schreibt Kopf + Historie in derselben Transaktion
  (Installation-Zeilensperre wie bisher); Historie ohne Kopf gibt es
  nicht. Events/Audit unverändert (`installation.handover_recorded`,
  Payload stabil — Verlauf ist lesende Projektion).
- Lesen: `listInstallationHandovers` (`installation.read`, keine neue
  Permission), aufsteigend nach `recorded_at`/`id`; Felder
  Wer/Notiz/Zeit — keine Actor-IDs (Freitext-Name wie F7-05).
- RLS `tenant_isolation` + FORCE (bytegleiche Policy-Formulierung
  wie 0086), Grants `select, insert` an `app_runtime` (kein Update —
  append-only), Rollen-Pins wie F7-12.
- UI: Verlauf („Abnahme-Verlauf“, Wer/Wann/Notiz je Eintrag) unter
  dem Abnahme-Block der Installation-Section; Formular unverändert.
- Exakte Reonic-Darstellung UNKNOWN; Anzeige ESTIMATE-Layout, nur
  gespeicherte Werte.

## Scopes

1. Migration 0133 (Tabelle + FKs + Index + RLS, Snapshot +
   Journal) + Schema-Datei + Rollenvertrag (ACL-Manifest,
   RLS-/Grant-Pins, Policy-Hash per Probe geerntet).
2. Service: Historien-Insert in `recordHandover`,
   `listInstallationHandovers` (read).
3. Projektseite: Verlauf lesend laden (`installation.read`) und an
   die Installation-Section reichen; Section rendert die Liste.
4. Action-Allowlist: keine neue Action (Anlage läuft über
   `recordHandoverAction`).

## Geschlossene Testmatrix

- `F714-DB-01`: Abnahme → Korrektur → Verlauf hat BEIDE Einträge
  (Reihenfolge, Wer/Notiz), Kopf zeigt Korrektur.
- `F714-DB-02`: Guards (aktiv/nicht-existent/leer fail-closed wie
  F7-05), Fremdtenant sieht keine Historie, Viewer liest Verlauf,
  Viewer-Anlage denied.
- `F714-E2E-01`: Anlegen → Abschließen → Abnahme A → Abnahme B →
  Verlauf mit beiden Einträgen sichtbar.

## Bewusst offen

- Kunden-Gegenzeichnung im Portal (F7-05-Blocker), Löschen/
  Schwärzen einzelner Verlaufseinträge (DSGVO-Folge), Portal-Sicht
  auf den Verlauf.
