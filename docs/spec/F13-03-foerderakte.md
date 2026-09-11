# F13-03 Förderakte (KfW/BAFA, Katalog F13.2 Slice 1)

Ziel: Fördervorgang je Projekt mit BzA→BnD-Maschine (Katalog F13.2
ohne AI-Picker/Angebotsbindung — Slice 1 ist die Akte). Bauarbeit,
kein Referenzbeleg.

## ESTIMATE (reversibel, Referenzfrage offen)
- Modell: `subsidy_case` 1:1 je Projekt (UNIQUE, v1-Grenze).
  Maschine: `vorbereitung → bza_eingereicht → bza_bewilligt →
  bnd_eingereicht → abgeschlossen`; `korrektur` aus
  bza/bnd_eingereicht mit Wiedereinstieg je Phase (BzA- oder
  BnD-Wiedereinreichung wählbar); `storniert` aus jedem
  nicht-abgeschlossenen Zustand, terminal.
- Programm-Wortschatz (kfw/bafa/sonstige) + manuelle
  BzA-Nummern-Verknüpfung (1–64 Zeichen); Zeiten je Übergang
  (bza_submitted/bza_approved/bnd_submitted/completed).
- Berechtigung: `installation.read`/`installation.write`
  (KEINE neuen Keys, Muster F13-02).

## Scopes
1. Migration 0105 (Tabelle, UNIQUE ws/project, RLS
   tenant_isolation + FORCE, Rollenvertrag wie 0103).
2. Modul `subsidy-cases`: Anlage idempotent (UNIQUE-Race →
   bestehenden liefern), Details, Transition mit Guards.
3. Akte-Sektion: Anlage, Programm/BzA-Formular,
   Folge-Buttons, reine Wertdarstellung.

## Geschlossene Testmatrix
- `F1303-DB-01`: Anlage idempotent, BzA→BnD-Kette bis Abschluss
  mit allen vier Zeitstempeln.
- `F1303-DB-02`: Korrekturrunde mit BnD-Wiedereinstieg,
  verbotener Phasensprung, Storno terminal.
- `F1303-DB-03`: Validation, NotFound ohne Orakel,
  Viewer-denied, Tenant-Isolation.
- `F1303-E2E-01`: Akte → Anlage → Programm/BzA speichern →
  BzA → bewilligt → BnD → abgeschlossen (beobachtbar).

## Bewusst offen
- Portal-Sicht Förderstand + Kunden-Rückmeldung (F10-04-Muster).
- BnD-Beleg-Upload (file-requests-Anbindung).
- Angebotsbindung BzA-Phase (M2-Verknüpfung), AI-Vorschlag,
  Wartungsverträge/Intervalle, Techniker-Disposition,
  SLA-/Reaktionszeit-Regeln (F13-01-Offenpunkte).
