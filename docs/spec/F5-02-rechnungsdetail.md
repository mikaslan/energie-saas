# F5-02 Rechnungsdetail (read-only)

Ziel: Belegliste → Detailseite je Dokument (alle Typen ausser
Konfigurationsseiten), rein lesend aus eigenen Daten. Kein PDF, kein
Druck-Layout (eigene rechtliche Dokumentflaeche, kein Referenzbeleg).

## ESTIMATE (reversibel, Referenzfrage offen)
- Route `rechnungen/[type]/[documentId]` hinter der bestehenden
  Typ-Allowlist; unbekannter Typ wie Liste → 404 ohne Orakel.
- Abschnitte: Kopf (Nummer/Name/Status/Zahlstatus), Betraege
  (netto/Steuer/brutto, bezahlt/offen), Skonto (F5-01c-Format,
  ehrlich leer ohne Kondition), Positionen (Positionsliste,
  ehrlich leer ohne Zeilen), Storno (Grund/Zeitpunkt nur bei
  stornierten Belegen).
- Exakte Reonic-Darstellung UNKNOWN (kein Referenzbeleg);
  Layout als ESTIMATE markieren — nur gespeicherte Werte,
  keine abgeleiteten Kennzahlen.

## Scopes
1. `getDocumentDetail` (fail-closed: ungueltige UUID, Typ-Mismatch
   und Fremd-Workspace → NotFound ohne Typ-Orakel; Zeilen nur zum
   eigenen Dokument, positionsgeordnet).
2. Detailseite + Ruecklink zur Liste; Listennummer verlinkt.
3. Sichtbarkeit: `invoicing.read` (Listenkonvention); keine neue
   Permission, keine Schreibaktion auf der Seite.

## Geschlossene Testmatrix
- `F502-DB-01`: Detail mit Zeilen/Skonto/Storno belegt Felder;
  Typ-Mismatch und ungueltige ID fail-closed.
- `F502-RBAC-01`: ohne `invoicing.read` denied (Listenkonvention).
- `F502-E2E-01`: Entwurf anlegen → Detail oeffnen →
  Name/Status/Positionen-Leerzustand sichtbar.
