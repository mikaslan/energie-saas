# F16-13 Katalog-Zeilen in Paket-Vorlagen

## Status dieser Spec

Ex post festgeschrieben (implementiert Vorderbau 41, lokal verifiziert:
DB F1613 5/5, E2E F16-13 1/1 Binden/Einsetzen/Drift/Stale/Rebind, Regression
F16-11 4/4 + F16-12 1/1, Nachbarn 54/54). Beschreibt den gebauten Stand,
kein Vorab-Entwurf — Abweichungen zwischen Spec und Code gehen zugunsten
des Codes, bis Codex sie im Endaudit auflöst.

## ESTIMATE (reversibel)

- Optionale Bindung je Paket-Zeile an Katalogkomponente (Id + Revision).
- Fälschungsschutz: Preise/Einheit stammen beim Speichern UND Einsetzen aus
  der gebundenen Live-Revision (`resolveBoundLines` stempelt
  `unit/salesUnitNetCents/purchaseUnitNetCents`); Client-Werte zählen nicht.
- Keine Migration (Bindung in `package_lines`-jsonb), keine neue Permission
  (`catalog.read` ab Viewer für die Prüfung).

## Vertrag

- Drift (Revision ungleich), Archiv, Fehlen oder preislose Komponente →
  `PackageTemplateStaleError` mit Zeilennamen, beim Speichern wie Einsetzen
  fail-closed. Keine stillen Preiswechsel über artfremde Edits.
- Manuelle Preis-/Einheitsedits lösen die Bindung.
- Manager: Picker mit gebundener Revision, Rebind; Disabled-Synthetic-Option
  gegen React-Warnung bei verwaister Auswahl.

## Katalogbezug

Bindungsquelle ist die E2E-SKU `E2E-M201-MODULE-1-W3-F1613`
(Fallstrick: generische Modul-SKU kollidiert im Vollverbund).
Revisionsstände sind seit M1-08c zusätzlich im Produktdetail einsehbar
(Revisionsverlauf).

## Tests

- DB `tests/db/f1613-katalog-zeilen.test.ts` (5/5).
- E2E `tests/e2e/f16-13-katalog-zeilen.spec.ts` (1/1).
- Regression: F16-11-E2E 4/4, F16-12-E2E 1/1.

## Bewusst offen

- Nichts mehr offen auf diesem Pfad. Energiehaus-Flag separat blockiert
  (Q-F12-FUNNEL-REFERENZ); echte Produkte brauchen reale Daten.
