# F13-07 BnD-Beleg-Upload (Katalog F13.2-Folge)

Ziel: Die Förderakte fordert BnD-Belege als Datei-Anfragen an
(F10-04-Pfad): anfordern → Portal-Upload → erledigt → in der Akte als
„Beleg erhalten" sichtbar → BnD einreichen. Erste echte Verknüpfung
Förderakte × Datei-Anfragen. Bauarbeit, kein Referenzbeleg.

## ESTIMATE (reversibel, Referenzfrage offen)

- Verknüpfung `file_request.subsidy_case_id` (nullable FK auf
  `subsidy_case(workspace_id, id)` — Mandantbindung auf DB-Ebene;
  Projektgleichheit prüft der Service (Akte gehört zum Projekt),
  sonst uniform NotFound. DB-CHECK für Projektgleichheit
  zurückgestellt (eigener Trigger wäre neues Sperr-Maschinenwerk).
- Beleg-Block in der Akte nur in `bza_bewilligt`/`bnd_eingereicht`
  (vor/nach BnD-Versand; Nachreichung bleibt möglich). Keine harte
  BnD-Sperre ohne Beleg (Katalog fordert keine Pflichtbelege —
  ehrliche Anzeige statt erfundener Pflicht).
- Anfrage-Titel trägt den Kontext („BnD-Beleg: …", Freitext mit
  Vorgabe); Portal-Projektion unverändert (Titel reicht, kein
  Schema-Umbau am anonymen Pfad).
- Berechtigung: KEINE neuen Keys (`project.write` für Anfrage wie
  F10-04, `installation.write` für Akte wie F13-03).

## Scopes

1. Migration 0108 (Spalte + Composite-FK + Index, Schema- und
   Journal-Pins nachgezogen; keine Resolver-/Grant-Änderung).
2. `file-requests`: optionale `subsidyCaseId` in Create (Same-Project-
   Prüfung), DTO-Feld, List-Filter; `lib/file-request.ts` nachgezogen.
3. Aktensektion: Beleg-Formular (Titel mit Vorgabe) + Beleg-Liste mit
   Stand („Beleg erhalten" bei erledigt); Server-Action mit
   `project.write`.
4. Keine Portal-Änderung (Upload-Pfad F10-04 unverändert).

## Geschlossene Testmatrix

- `F1307-DB-01`: Anfrage mit Akte → verknüpft; fremde Akte →
  NotFound; List-Filter liefert nur Akten-Belege.
- `F1307-DB-02`: Verknüpfter Beleg durchläuft Upload → erledigt;
  Akte listet ihn als erhalten (Projektion + Liste).
- `F1307-E2E-01`: Akte bis BzA bewilligt → Beleg anfordern →
  Dateianfragen-Sektion zeigt ihn → Portal-Upload → Akte zeigt
  „Beleg erhalten".

## Bewusst offen (mit Begründung)

- Angebotsbindung BzA-Phase: braucht M2-Angebots-Semantik (welcher
  Status qualifiziert? was bei mehreren Angeboten?) — M2-Lane ist
  aktiv (eigene Fehler/Flakes); keine Deutung fremder Domain aus
  F13 heraus. Eigene Frage bei Bedarf, kein stiller Umbau.
- BnD-Pflichtbelege, Belegtypen-Katalog, AI-Vorschlag (Rest F13.2).
