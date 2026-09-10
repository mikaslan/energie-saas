# F9-05 Zeitfreigabe (Approve/Unapprove je Eintrag)

Ziel: Erfasste (beendete) Zeiteinträge freigeben und damit gegen
Bearbeitung/Archivierung sperren — aus eigenen Daten, ohne neue
Rollen (Bauarbeit, kein Referenzbeleg).

## ESTIMATE (reversibel, Referenzfrage offen)
- Modell: `time_entry.approved_at` + `approved_by` (Membership-FK),
  NULL = offen. Freigabe nur beendeter Einträge (`end_at` gesetzt);
  laufende Stoppuhr nie freigebbar.
- Freigegebene Einträge sind unveränderlich: Update/Archivierung
  verweigern fail-closed (Service-Guard, nicht nur UI); Entsperren
  nur über explizites Unapprove (eigener Audit-/Event-Pfad).
- Freigebender ≠ Erfasser nicht erzwingbar (Solo-Betrieb real) —
  dokumentiert, kein Vier-Augen-Gate in diesem Slice.
- Exakte Reonic-Darstellung UNKNOWN; Anzeige als Status-Label +
  Filter, ESTIMATE-Layout.

## Scopes
1. Migration + `approveTimeEntry/unapproveTimeEntry` (write),
   Guards in Update/Archivierung (fail-closed).
2. Liste: Statusspalte + Filter (offen/freigegeben), Aktionen nur
   mit Schreibrecht; Revisionen bleiben lesbar.
3. Sichtbarkeit: `time.read` (lesen), `time.write` (freigeben);
   keine neue Permission.

## Geschlossene Testmatrix
- `F905-DB-01`: Approve belegt Sperre (Update/Archiv fail-closed),
  Unapprove entsperrt; laufender Eintrag fail-closed.
- `F905-RBAC-01`: Viewer liest Status read-only; Fremdtenant
  sieht nichts.
- `F905-E2E-01`: Eintrag beenden → freigeben → Label + Sperre
  sichtbar.

## Bewusst offen
- Sammel-/Periodenfreigabe, Vier-Augen-Regel, Abrechnungslauf,
  Mobile-/Offline-Verhalten.
