# F8-05 Teilrechnungen zum Auftrag (Modi: Prozent / Positionen)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12 (DB F805 3/3, E2E F8-05-E2E-01 1/1, am Code verifiziert vorgefunden + erneut beobachtet).

Ziel: Aus einer Auftragsbestätigung (AB) heraus gestaffelt Teilrechnungen
stellen — beobachtbar als Kette mit Restbetrag. Ergänzt F8-01
(Anzahlung/Schluss) und F8-04b (Voll-Duplikat); F8-02/03/04
(Anrechnung/Split/Gutschrift) bleiben unberührt.

## ESTIMATE (reversibel, Referenzfrage offen)
- Kette: `commercial_document_partial` (AB → Teilrechnung, Modus,
  Prozent, Folgenummer) + `commercial_document_partial_line`
  (verbrauchte AB-Positions-IDs, Modus `lines`). Teilrechnung ist ein
  normales `invoice`-Dokument (gleiche Nummernserie, Titel
  „Teilrechnung {n} zu {AB-Nr}“, Status `draft`).
- Modi:
  - `percent`: EINE Sammellinie mit X % des AB-Netto (ganzzahlig
    gerundet). Nur bei EINHEITLICHEM Steuersatz aller AB-Positionen
    (Mischsätze fail-closed — dokumentierte v1-Grenze).
  - `lines`: ausgewählte GANZE AB-Positionen (1:1-Kopie). Teilmengen
    fail-closed (keine Positions-Splits in v1 — dokumentierte Grenze).
- Caps (Brutto, stornierte Teilrechnungen befreien Budget wieder):
  Σ aktive Teilrechnungen + neu ≤ AB-Brutto. `lines`: Position nur
  einmal über aktive Teilrechnungen verbrauchbar.
- Serialisierung: AB-Zeile `FOR UPDATE` (Folgenummer + Caps ohne
  Race). Kein Revision-CAS auf Dokumenten (Erstanlage).
- Berechtigung: `invoicing.read`/`invoicing.write` (KEINE neuen Keys).
  Events/Audit nur IDs + Modus/Folge (kein PII über Beleg-IDs hinaus).

## Scopes
1. Migration 0102 (Tabellen, RLS tenant_isolation + FORCE, keine
   Grants — Rollenvertrag wie 0094) + `createPartialInvoice` /
   `listPartialInvoices` (Kette, Restbrutto, verbrauchte Positionen).
2. AB-Detail: Teilrechnung-Sektion (Moduswahl, Prozent/Positionen,
   Kettenliste + Rest, nur mit Schreibrecht).
3. Schlussrechnung bleibt F8-01 (Rest = AB − aktive Teilrechnungen
   ist dort ablesbar, keine Automatik).

## Geschlossene Testmatrix
- `F805-DB-01`: percent-Kette (2×30 % + Rest), Cap bei >100 %,
  Mischsatz fail-closed.
- `F805-DB-02`: lines-Modus (Subset, Doppelverbrauch fail-closed,
  Storno gibt frei), Folgenummern.
- `F805-DB-03`: Validation (Modus/Prozent/Zeilen), fremde AB
  fail-closed, Viewer-denied, Race-Serialisierung (zwei Creates,
  genau eine gewinnt bzw. zweite läuft in Cap).
- `F805-E2E-01`: AB → Prozent-Teilrechnung → Kette + Rest sichtbar.

## Bewusst offen
- Positions-Teilmengen, Mischsätze im Prozent-Modus, automatische
  Schlussrechnung aus Rest, Skonto je Teilrechnung, Portal-Sicht.
