# F7-08 Workbook: zu installierende Variante + Stückliste (lesend)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12

Ziel: Belegter Katalogpunkt F7.6 („Workbook (Residential):
‚Variant to be installed' (…), Stückliste nach Kategorie, Layout +
Schaltplan read-only"). F7-01-Slice-A vermerkt: „Angebots-Verknüpfung
kommt mit Workbook F7.6". v1 liefert Varianten-Bindung +
Stücklisten-Projektion; kWp/kWh-Rollups, Layout und Schaltplan bleiben
bewusst offen (keine erfundene Physik, kein 3D).

## ESTIMATE (reversibel, Referenzfrage offen)

- Explizite Bindung `setInstallationVariant` (kein Eingriff in den
  versiegelten Signatur-Ablauf): Die UI schlägt die signierte Variante
  vor („Auto-Selektion" als Vorschlag), der Mensch bestätigt per
  Submit. Umbindung nur vor Abschluss (`completed` = eingefroren).
- Projektion aus dem HASH-GEPRÜFTEN Current-Revision-Snapshot
  (wie Angebotsdetail: SHA-Abgleich, korrupt → Integrity-Fehler).
- KEINE Einkaufspreise in der Projektion (Monteur-Sicht; keine
  Preisrechts-Frage). Nur sichtbare Zeilen (`isHidden=false`,
  F6-01-Präzedenz).
- Gruppierung nach Sektions-Kategorie (Modul/Wechselrichter/Speicher/
  Wallbox/Wärmepumpe/Montage/Sonstige), Reihenfolge nach Position.

## Scopes

1. Service `setInstallationVariant` (Scope: Variante gehört zu
   Angebot des Projekts; Event/Audit; KEINE neue Permission —
   `installation.write` wie F13-01-Präzedenz).
2. Service `getInstallationWorkbook` (read-only; `installation.read`;
   null ohne Bindung).
3. Projektseite: Workbook-Sektion (Varianten-Select mit
   Signiert-Vorauswahl, Stückliste je Kategorie, Summen VK).
4. Keine Migration (nur Referenzen), keine neuen Keys.

## Geschlossene Testmatrix

- `F708-DB-01`: Bindung + Umbindung, Projekt-Scope (fremde Variante
  → NotFound), Completed-Freeze (Conflict).
- `F708-DB-02`: Workbook-Projektion (Kategorien/Gruppierung,
  Hidden-Zeilen fehlen, Summen), ohne Bindung null.
- `F708-E2E-01`: Installation → Variante wählen → Workbook mit
  Sektionen sichtbar.

## Bewusst offen

- kWp/kWh-Rollups (brauchen Modul-Techdaten-Join, kein Raten).
- Layout (3D) und Schaltplan-Einbettung (F6-01-Renderer wiederverwenden).
- Echte Auto-Bindung beim Signieren (versiegelter Ablauf).
