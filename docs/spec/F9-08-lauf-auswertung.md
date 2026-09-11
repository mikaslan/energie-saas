# F9-08 — Lauf-Auswertung (Aufschlüsselung je Abrechnungslauf)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-11
Nachweis: DB F0908 4/4, E2E F9-08-E2E-01 1/1 lokal beobachtet;
keine Migration (Lesepfad), keine neuen Permissions.

## Ziel und Abgrenzung

F9-07 friert je Lauf nur Anzahl + Bruttosumme ein; wer was beigetragen
hat, bleibt unsichtbar (STATUS F9-offen: „Auswertung"). Dieser Slice macht
den Pfad durchgängig: geschlossener Lauf → Zeilen je Person
(Einträge + Minuten, Labels wie Auslastung) → Anzeige im Lauf.
Reiner Lesepfad über bestehende Tabellen, keine Migration, keine neuen
Permissions (`time.read`). Keine neue Lane-Freigabe nötig (Gesamtauftrag
2026-09-10).

## Datenmodell

Keines (keine Migration): `getBillingRunBreakdown` liest
`billing_run_entry ⨝ time_entry` je Lauf. Unbekannte Läufe (fremder
Workspace via RLS) → NotFound.

## Validierung (fail-closed)

- Summe der Zeilen (Einträge/Minuten) muss exakt dem eingefrorenen
  Snapshot (`entry_count`/`total_minutes`) entsprechen — sonst
  Integritätsfehler statt stiller Anzeige (der Snapshot ist per F9-07
  unveränderlich, die Zeilen sind seine Herleitung).
- Offene Läufe liefern leere Zeilen (keine vorweggenommene Auswertung).

## Berechnung

Je `user_id`: `entryCount`, `totalWorkingMinutes`; Label aus
Mitglieds-Optionen (Fallback „Unbekannt" wie Auslastung). Sortierung:
Minuten absteigend, user_id aufsteigend (Auslastungs-Muster).

## Anzeige

Keine neuen Blöcke: je geschlossenem Lauf ein `<details>`-Bereich
„Aufschlüsselung je Person" mit Zeilen
„{Label} — {N} Einträge — {H} Std. {M} Min.".

## Akzeptanz

- DB F0908 4/4 (Zeilen je Person, Snapshot-Kohärenz, leerer/offener Lauf,
  fremder Lauf → NotFound).
- E2E F9-08-E2E-01 (Lauf schließen → Aufschlüsselung sichtbar).
- Gates: typecheck/lint/depcruise grün, betroffene Suiten lokal.

## Bewusst offen

- Aufschlüsselung je Tätigkeitsart (kein belegter Katalogbedarf).
- Lauf-übergreifende Reports/Exporte (F9-04-CSV bleibt Eintragsebene).
- Idle-Details, Mobile-/Offline-Verhalten.
