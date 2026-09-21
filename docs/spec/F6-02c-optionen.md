# F6-02c Slice-Optionen (Entscheidungsvorlage, SPEC-ONLY — kein Bau)

Stand: F6-01 (Auto-Gen) + F6-02a (Formular-Modus) + F6-02b (Ensure)
grün und integriert. Katalog (`01-modulkatalog.md` Z.83-85): F6.2 =
Konfigurieren (Formular, DONE) + freier Editor (Bibliothek DONE,
Drag OFFEN); F6.3 = Vorlagen, Ask AI, JPG/PDF-Export,
Angebots-PDF-Einbettung, Checklist-Element. Range: 0302 bleibt frei,
ab 0303 frei. Aufwand in Wellen + CI-Zyklen (S/M/L).

## Option A — Freier Editor: Drag-Positionierung + ID-Anzeige (F6.2-Rest)

- Inhalt: Overlay-Elemente per Drag auf dem 640×300-Raster
  verschieben (Lib `@atlaskit/pragmatic-drag-and-drop` + a11y im
  Repo vorhanden); vergebene `ovl-*`-IDs + Connector-Ziele sichtbar
  (schließt Review-P1-2 aus 5H); Klick-Connect optional.
- Aufwand: M (1–2 Wellen, E2E-Schwerpunkt: Drag-Steps, A11y,
  Touch-Fallback).
- Range/Migration: KEINE (Positionen = existierende x/y in 0301).
- Risiko: mittel (Pointer-/A11y-Matrix, kein Server-Anteil).
- Liefert: F6.2 geschlossen (zweiter Modus).

## Option B — Overlay-Vorlagen workspace-weit (F6.3-Start)

- Inhalt: Overlay-Sets als Vorlage speichern/importieren/anwenden
  (z. B. „Wallbox-Nachrüstung", „Speicher-Block"); Muster im Repo
  vorhanden (`offer-template`, `checklist-template` u. a.).
- Aufwand: M (1–2 Wellen: 0303-Tabelle + RLS + Service + UI-Liste).
- Range/Migration: 0303 `schematic_overlay_templates` (Tabelle + RLS
  `tenant_isolation` + SIU-Grants, Muster 0301; 0302 bleibt frei).
- Risiko: niedrig-mittel (Standard-CRUD + Import-Merge gegen
  `editor-overlay.v1`).
- Liefert: F6.3-Anfang, wiederverwendbar für Checkliste-Slice.

## Option C — JPG/PNG-Export browser-nativ (F6.3-Export)

- Inhalt: Gerendertes (gemergtes) SVG per Canvas zu PNG/JPG
  rastern + Blob-Download (kein neues Dependency nötig, kein
  Server-Roundtrip — Muster SVG-Export F6-02); Angebots-PDF-
  Einbettung optional als C2.
- Aufwand: S (1 Welle, E2E-Download-Belege).
- Range/Migration: KEINE.
- Risiko: niedrig (reine Client-Umwandlung; Canvas-Font-Rendering
  als bekannte Unschärfe dokumentieren).
- Liefert: F6.3-Export ohne Norm-Anspruch (ESTIMATE bleibt).

## Explizit NICHT vorgeschlagen

- Consuel/Normstempel: weiter 0 Treffer im Repo (re-verifiziert
  2026-09-21) — Norm-BLOCKED, kein Slice möglich.
- Ask AI (Freitext-Bearbeitung): Beta-Risiko (Halluzinations-Guard,
  Freigabe-Flow) — eigener Slice mit Leitstand-Design, nicht als
  Beifang.
- Angebots-PDF-Einbettung + Checklist-Element: Folgeslices nach
  Export-/Vorlagen-Entscheid (C2/B2).

## Empfehlung (Lane 5)

A → B → C: erst F6.2 schließen (A löst zugleich P1-2), dann F6.3
mit Vorlagen eröffnen (einzige Option mit Migration → 0303 früh
reservieren), Export (C) klein und jederzeit einschiebbar.
Gegen-Vorschlag willkommen — alle drei sind unabhängig voneinander
baubar, keine teilt Dateien mit laufender Arbeit.
