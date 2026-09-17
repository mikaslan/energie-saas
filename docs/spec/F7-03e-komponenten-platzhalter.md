# SPEC F7-03e — Platzhalter {{komponenten}} (Workbook-Stückliste)

## Matrix
Katalog F7.2: „Auto-Platzhalter (Kunde, Komponenten, Datum)". F7-03c
hat Kunde+Datum geliefert und `{{komponenten}}` deferred („keine
eindeutige Quelle: Vorlagen-Komponenten vs Angebot vs Workbook").
Die Quelle ist jetzt entscheidbar: Workbook F7-08 ist implementiert
(`getInstallationWorkbook`, hash-geprüfter Current-Revision-Snapshot,
getestet `f708`). Vorlagen-Komponenten scheiden aus: das sind
UUID-Referenzen von Vorlagen-Positionen (componentId, F7-03d-Semantik),
keine Bauteile — als Anzeigetext sinnlos. Rohes Angebot scheidet aus:
ungebunden (welche Variante/Revision?) und ohne Integritätsprüfung.
Workbook = gebundene Variante, nur sichtbare Zeilen, positions-sortiert,
ohne Einkaufspreise (Monteur-Sicht) — exakt „die zu installierenden
Komponenten". Keine Migration (reine Anzeige-Substitution, 03c-Präzedenz).

## Ziel
`{{komponenten}}` in Punkt-Titeln/Beschreibungen/Antworten wird BEIM
ANZEIGEN durch die flache Workbook-Stückliste ersetzt; der Tree speichert
den Rohtext (editierbar, Reload-stabil). Ohne Bindung, bei leerer Liste,
fehlendem Leserecht oder Integritätsfehler bleibt das Muster stehen
(ehrlich, kein Phantom-Text, kein Page-Crash — 03c-Präzedenz).

## Entwurf (Format-Helper + Render-Integration, keine Migration)
- `formatWorkbookComponentsText(sections: WorkbookSection[]): string` in
  `modules/installations/workbook-service.ts` (nah am Typ, keine neue
  Schicht): pro Zeile `${quantity} ${name}` (`quantity` bereits
  formatiert, z.B. „8 Stück", „12,5 m"), Sektionen+Zeilen in
  Projektions-Reihenfolge (positions-sortiert, F7-08), verbunden mit
  „, ". Keine Preise (F7-08-Präzedenz). Leere Liste → „".
- `substituteChecklistPlaceholders` + Key `komponenten`: Pattern
  erweitert, `values.componentsText` OPTIONAL (Default „" → Muster
  steht; bestehende 03c-Unit-Tests bleiben unverändert grün).
- `checkliste/page.tsx`: Workbook in separater `authorizedQuery`
  (`installation.read`, F7-05b-Präzedenz: PermissionDenied → „");
  null (keine Bindung) → „"; OfferIntegrityError → „" (Fehlerort
  bleibt das Workbook-Panel; Anzeige sprengt nie die Checkliste).
  Prop `componentsText` durchreichen (customerName-Muster).
- Manager: gleiche Anzeige-Kontexte wie 03c (Checkbox-/Radio-Label,
  Viewer-Span, Beschreibungs-/Antwort-Lesetext). NICHT in
  Inputs/Textareas/Selects.

## Vertrag App
- Helper-Beispiel: „8 Stück PV-Modul X, 1 Stück Wechselrichter Y,
  12,5 m Solarkabel".
- `substitute`-Vertrag: `values: { customerName: string; today: string;
  componentsText?: string }`; case-insensitiv, Whitespace-tolerant,
  mehrfach (03c-Semantik); fehlend/leer → Muster steht.
- E2E-Vertrag: Titel „Montage {{komponenten}}" → Anzeige mit
  Stückliste; Input zeigt Rohtext; Reload stabil; Viewer ok; Projekt
  ohne Bindung → Muster steht sichtbar.

## Sicherheit
- Keine neue (reine Anzeige-Transformation; Quelle read-only und
  `installation.read`-gated; der Helper projiziert nur Menge+Name,
  keine Preise, keine IDs an den Client über Bestand hinaus).

## Tests (RED zuerst)
- Unit: `tests/unit/checklist-placeholders-komponenten.test.ts` —
  U-01 Format (Menge+Name, Sektions-/Zeilen-Reihenfolge); U-02
  Einheiten (Stück/meter-Dezimal); U-03 leere Sektionen → „";
  U-04 Substitution gesetzt/mehrfach/Case/Whitespace; U-05 fehlt
  (`undefined`) und leer („") → Muster steht; U-06 unbekannte Muster
  bleiben (Regression); U-07 Leereingabe/kein-Muster. 03c-Suite
  unverändert grün (Rückwärtsbeweis via Optional-Feld).
- E2E: `tests/e2e/f7-03e-checklist-komponenten.spec.ts` — Setup nach
  f7-10-Präzedenz (Projekt + Installation + Variantenbindung): E-01
  Titel mit Muster → Anzeige substituiert; E-02 Input roh; E-03
  Reload stabil; E-04 Viewer sieht substituiert; E-05 Projekt ohne
  Bindung → Muster steht; E-06 Axe.
- Nachbarn: 03c (Platzhalter), F7.2-Engine, f7-10 (Workbook-Setup).
- Kein DB-Test (keine Migration, keine neue Query; F7-08-Suite deckt
  die Projektion bereits ab).

## Akzeptanz
- `npm run check` gruen; E2E Chromium gruen; Heartbeat + Push + CI gruen.
