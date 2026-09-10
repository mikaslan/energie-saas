# F1-11 Manuelle Anfrage-Erfassung (Telefon/Messe-Lead)

Ziel: Anfragen entstehen nicht nur per Rechner-Intake — Editoren erfassen
Kontakt + Standort + Projekt manuell auf der Intake-Spalte des gewählten
Bereichs (Wohnbau/Gewerbe).

## Umfang

1. Service `createManualLead(tx, ctx, command)` (`project.write`, bestehend):
   Kontakt (Name Pflicht; E-Mail ODER Telefon Pflicht — Kontakt-CHECK
   verlangt einen Weg), Standort (Legacy-Modus mit Follow-up, kein
   erfundener Pin), Projekt (`phase=request`, `outcome=open`,
   `source_key='manual'`, Intake-Spalte des Scope-Boards, optionale
   `lead_source_id` nur bei existierender Quelle), optionale Projektnotiz
   (erfordert `note.write`, kein stilles Verschlucken).
2. Dedupe-Hinweis statt -Blockade: Treffer auf normalisierte E-Mail oder
   E164-Nummer nutzt den bestehenden Kontakt und setzt
   `dedupe_review_required` (Familienanschlüsse bleiben anlegbar).
3. Scope fail-closed (F15-01-Muster): unbekannter Bereich und fehlende
   Intake-Lane brechen ab, kein stiller Wohnbau-Fallback.
4. UI: Formular auf `/anfragen` im aktuellen Bereich (Quelle als Dropdown
   aktiver Quellen), Erfolgsmeldung mit Link auf die neue Projektakte.

## ESTIMATE (reversibel)

- Keine Adressvalidierung/Geocodierung (Follow-up-Pfad M1-06 übernimmt),
  keine Marketing-Consents (Default false wie Intake).
