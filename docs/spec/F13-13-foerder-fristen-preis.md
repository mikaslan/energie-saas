# F13-13 Förder-Fristen-Preis (Katalog F13.2-Rest, ohne Erfülltes)

Status: **SPECIFIED (RED, Tests geskippt)** · Lane:
`codex/muse-fleet-3c-f13` · Stand 2026-09-19 (Spec + RED-Test
`tests/unit/f1313-foerder.red.test.ts`, `describe.skip` bis zur
Implementierung)

Ziel: Katalog F13.2 („KfW/BAFA-Förderservice, 210 €/Projekt: BzA
~3 AT → BnD ~5 AT, manuelle BzA-Nummern-Verknüpfung,
Korrekturrunden inklusive, AI Asset Picker Typenschild-Foto,
Portal-Aktivierung") schließen, soweit noch offen. Bereits ERFÜLLT —
nicht neu gespect: manuelle BzA-Nummern-Verknüpfung + Korrekturrunden
(F13-03), Portal-Aktivierung als Versand-Nebeneffekt (F13-05),
Programm-Vorschlag als Heuristik (F13-08). Bauarbeit, kein
Referenzbeleg.

Grundlage: BzA/BnD-Maschine F13-03 (`vorbereitung → bza_eingereicht →
bza_bewilligt → bnd_eingereicht → abgeschlossen`, `korrektur` mit
Wiedereinstieg, `storniert` terminal) mit Zeitstempel je Übergang
(bza_submitted/bza_approved/bnd_submitted/completed). Angebotsbindung
bleibt offen (F13-03:41, Q-F13-ANGEBOTSBINDUNG-M2).

## §1 Preis (210 €/Projekt, Stammdatum + Snapshot)

- Workspace-Stammdatum „Förderservice-Preis", änderbar, Default
  210,00 € (Cent-Arithmetik, Muster F16.3).
- Betragssnapshot an der Akte bei Anlage (`ensureSubsidyCase`):
  spätere Stammdaten-Änderungen ändern bestehende Akten nicht.
- KEINE Auto-F8-Rechnung: der Snapshot ist reine Wertdarstellung in
  der Akte; Abrechnung bleibt manueller F8-Pfad.

## §2 AT-Fristen (Fälligkeit + Überfällig, keine Automatik)

- Fälligkeitsdatum je Phase ab Versand-Übergang: BzA-Versand + 3 AT,
  BnD-Versand + 5 AT (Katalog-Näherung ~3/~5, keine Behördenzusage).
- AT = Arbeitstage Mo–Fr Europe/Berlin ohne Feiertage; Feiertags-
  quelle legt die Implementierung fest (Bund oder Sitzland — offen).
- Überfällig-Badge in der Akte, sobald heute > Fälligkeitsdatum und
  die Phase noch offen ist (reine Anzeige aus Versand-Zeitstempeln).
- KEINE Eskalations-Automatik: kein Event, kein Task, keine Mail —
  nur das Badge.

## §3 Phasen-Hinweise (weich, keine Sperren)

- BzA-vor-Annahme-Badge: weicher Hinweis, solange die Akte vor
  `bza_bewilligt` steht („BzA noch nicht bewilligt — Annahme prüfen").
- KEINE Transitionssperren: die Maschine F13-03 bleibt unverändert,
  bis Q-F13-ANGEBOTSBINDUNG-M2 beantwortet ist (`offer.status` kennt
  nur `draft`, keine Deutung fremder Domain aus F13 heraus).

## §4 Typenschild-Foto-Slot (ohne KI-Auswertung)

- Upload-Slot „Typenschild-Foto" an der Akte (Datei-Anfrage-Muster
  F13-07: anfordern → Portal-Upload → „Beleg erhalten").
- KEINE KI-Auswertung im Slice: echte Vision läuft über das
  Provider-Gate F14; kein Regex-/Heuristik-Provisorium auf dem Foto.

## §5 Mail-Übergänge (nur Referenz)

- E-Mail je Übergang ist querer Slice nach Provider-Entscheidung
  (F13.2-Muster „E-Mail je Übergang"); hier nur referenziert, kein
  eigener Versand in F13-13.

## §6 ROT-Beleg (RED-Test vor dem Skip, 2026-09-19)

`npx vitest run tests/unit/f1313-foerder.red.test.ts` → 4 failed (4):

```text
× F1313-U-01: Preis-Snapshot an Akte? Default 210 €
  AssertionError: expected undefined to be 21000 // Object.is equality
× F1313-U-02: Fälligkeitsdatum BzA+3AT?
  AssertionError: expected 'undefined' to be 'function' // Object.is equality
× F1313-U-03: Überfällig-Badge?
  AssertionError: expected 'undefined' to be 'function' // Object.is equality
× F1313-U-04: Typenschild-Slot?
  AssertionError: expected undefined to be 'typenschild-foto' // Object.is equality
```

## Geschlossene Testmatrix (Follow-up)

- `F1313-U-01…04`: RED-Tests oben (Preis-Default, AT-Rechnung,
  Überfällig-Prädikat, Slot-Konstante) — Skip entfernen.
- `F1313-DB-01`: Stammdatum ändern → neue Akte snapshottet neu,
  alte Akte behält alten Betrag; keine F8-Zeile entsteht.
- `F1313-DB-02`: Versand setzt Fälligkeit (BzA +3 AT, BnD +5 AT;
  Wochenenden/Feiertage übersprungen); Überfällig-Badge nur bei
  offener Phase.
- `F1313-E2E-01`: Akte → BzA einreichen → Fälligkeit + Badge
  sichtbar → Typenschild anfordern → Portal-Upload → „Beleg
  erhalten"; keine Transitionssperre vor Bewilligung.

## Bewusst offen

- Feiertagsquelle für AT (Bund vs. Sitzland des Workspace).
- Angebotsbindung BzA-Phase (Q-F13-ANGEBOTSBINDUNG-M2, M2-Semantik).
- Vision-Auswertung des Typenschilds (Provider-Gate F14).
- Mail je Übergang (querer Slice nach Provider-Entscheidung).
