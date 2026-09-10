# F7-05 Abnahme (Handover nach Abschluss)

Ziel: Abgeschlossene Installation intern abnehmen (Wer/Wann/Bemerkung)
— aus eigenen Daten, ohne E-Signatur (öffentlicher Signaturpfad
extern blockiert, Q-ARCHIV-OBJECT-LOCK-REFERENZ).

## ESTIMATE (reversibel, Referenzfrage offen)
- Modell: Spalten `installation.handover_at`, `handover_by_name`
  (1–160 Zeichen, getrimmt), `handover_note` (optional, ≤500,
  Kommentarregeln wie Zeitkommentare: getrimmt, keine Controls).
  NULL = nicht abgenommen.
- Nur Status `completed` abnehmbar; aktive/laufende nie. Abnahme ist
  terminal lesbar, aber korrigierbar via erneuter Abnahme
  (Update mit neuem Zeitstempel, auditiert) — kein Un-Handover.
- Kein Kundenportal-Anteil in diesem Slice (öffentlicher Pfad
  blockiert); Gegenüber-Name ist Freitext, keine Identitätsbehauptung.
- Exakte Reonic-Darstellung UNKNOWN; Anzeige in der
  Installation-Section, ESTIMATE-Layout.

## Scopes
1. Migration + `recordHandover` (installation.write), fail-closed
   (Status, Name, Notenregeln, NotFound ohne Orakel).
2. Section: Abnahme-Block (Wer/Wann/Notiz) + Formular nur bei
   `completed` mit Schreibrecht.
3. Sichtbarkeit: `installation.read` (lesen); keine neue Permission.

## Geschlossene Testmatrix
- `F705-DB-01`: Abnahme belegt Felder; aktiv/nicht-existent/
  leerer Name fail-closed.
- `F705-RBAC-01`: Viewer liest Abnahme read-only; Fremdtenant
  sieht nichts.
- `F705-E2E-01`: Anlegen → Abschließen → Abnehmen → Block mit
  Name sichtbar.

## Bewusst offen
- Kunden-Gegenzeichnung im Portal (Blocker siehe oben),
  Disposition/Terminplanung, Mehrfach-Abnahmen mit Historie.
