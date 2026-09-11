# F8-04b AB als Rechnung übernehmen (Duplicate into type, Katalog F8.4)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-11

## Ziel und Abgrenzung

Modulkatalog F8.4 verlangt die Belegerstellung „aus AB (‚Duplicate
into type')". Dieser Slice übernimmt eine Auftragsbestätigung als
Rechnungs-Entwurf: gleiche Gruppe/Projekt/Kontakt, gleiche Positionen
in Reihenfolge, Summen über die Zeilenanlage neu gerechnet.
Skonto/Konditionen werden bewusst NICHT kopiert (Empfänger setzt sie
an der Rechnung neu). Fälligkeit: heute + 14 Tage Europe/Berlin
(ESTIMATE, reversibel — Entwurf bleibt editierbar). Varianten-Import
aus signiertem Angebot bleibt ein getrennter Slice.

## Evidenz

- Modulkatalog `docs/blaupause/01-modulkatalog.md`: F8.4.
- Bestehende Pfade: `createDocument`, `createDocumentLine`,
  `getDocumentDetail` (keine neue Permission: `invoicing.write`).

## Datenmodell (keine Migration)

Kein neues Feld: Herkunft steht in Event
(`commercial_document.duplicated`) + Audit
(`invoicing.document.duplicate` mit Quell-/Ziel-ID und Zeilenzahl).
Rechnungsname: `Rechnung zu <AB-Nummer oder -Name>`.

## Validierung (fail-closed)

- Quelle unbekannt → NotFound; Quelle kein AB → Validation (nur
  `order_confirmation`, kein stiller Typwechsel).
- Quelle storniert → Conflict (keine Übernahme aus `voided`).
- Quell-Status sonst beliebig (Entwurf/laufend) — Ziel immer neuer
  Entwurf, Quelle bleibt unverändert.

## Anzeige

AB-Detailseite (schreibberechtigt, nicht storniert): Panel „Als
Rechnung übernehmen" → Erfolgsmeldung mit Link auf den neuen
Rechnungs-Entwurf.

## Akzeptanz

- DB: Positionen/Reihenfolge/Werte, Summen, Gruppe, Fälligkeit +14,
  kein Skonto; Nicht-AB → Validation, storniert → Conflict,
  Viewer → denied.
- E2E: AB (Entwurf, 2 Positionen) → übernehmen → Rechnung mit
  Positionen und Summen (Netto 9.500,00 € / Brutto 11.305,00 €).
- Gates: tests grün, typecheck/lint/depcruise grün.
