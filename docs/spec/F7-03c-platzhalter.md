# SPEC F7-03c — Platzhalter Kunde+Datum (Anzeige-Substitution)

## Matrix
Katalog F7.2: „Auto-Platzhalter (Kunde, Komponenten, Datum)". Lesart
(Notiz: Vorlagen tragen keinen Freitext — Titel sind abgeleitet —
darum ist Apply-Time-Substitution gegenstandslos; einzig kohaerente
Lesart ist Anzeige-Substitution im Checklisten-Baum):
`{{kunde}}`/`{{datum}}` in Punkt-Titeln/Beschreibungen/Antworten werden
BEIM ANZEIGEN ersetzt; der Tree speichert den Rohtext (editierbar,
Reload-stabil). `{{komponenten}}` DEFERRED mit Begruendung (keine
eindeutige Quelle: Vorlagen-Komponenten vs Angebot vs Workbook —
Produktentscheid noetig).

## Ziel
`{{kunde}}` → Kontakt-Anzeigename des Projekts, `{{datum}}` → heutiger
Tag Europe/Berlin (TT.MM.JJJJ), in Anzeige-Kontexten (Checkbox-Label,
Lesetext, Viewer); Eingabefelder zeigen Rohtext; unbekannte Muster
bleiben unangetastet (kein stilles Fressen).

## Entwurf (reine Funktion + Render-Integration, keine Migration)
- `substituteChecklistPlaceholders(text, { customerName, today })` in
  lib/integrations/checklists/contract.ts (neben Zähler-Funktionen):
  Regex-Ersatz, case-insensitiv (`{{KUNDE}}` gilt), `{{ name }}`
  -Whitespace tolerant, mehrfaches Vorkommen, Leereingabe →
  Leerausgabe. `today` injiziert (testbar; UI liefert Berlin-Datum).
- Manager: Ersetzungs-Kontext (Kundenname via Prop vom Page-Loader?
  Manager kennt Projekt — Kundenname laden: Page liefert `customerName`
  neu mit ODER Service-Helper? Minimal: Page-Prop durchreichen).
  Ersetzen in: Checkbox-/Radio-Label, Viewer-Span, Beschreibungs-/
  Antwort-Lesetext. NICHT in Inputs/Textareas/Selects.
- Keine Permission/DB/Route; Viewer sieht substituiert (gleiche Funktion).

## Vertrag App
- Signatur: `(text: string, values: { customerName: string; today: string }) => string`.
  `today` als TT.MM.JJJJ-String (UI formatiert; keine Datums-Logik im Kern).
- Kundenname-Quelle: Projekt-Kontakt display_name (Server-Prop;
  Fallback "" → Muster bleibt stehen? NEIN: Fallback "Kunde"? Entscheide:
  leerer Name → Muster bleibt sichtbar (ehrlich, kein Phantom-Text)).
- E2E-Vertrag: Titel „Abnahme {{kunde}} {{datum}}" → Anzeige „Abnahme
  <Name> <TT.MM.JJJJ>"; Input zeigt Rohtext; Reload stabil; Viewer ok.

## Sicherheit
- Keine (reine Anzeige-Transformation; keine Persistenz, kein Input).

## Tests (RED zuerst)
- Unit: `tests/unit/checklist-placeholders.test.ts` — Kunde/Datum/
  mehrfach/Whitespace/unbekannt/Leere/kein-Muster/ungerader Klammer.
- E2E: `tests/e2e/f7-03c-checklist-placeholders.spec.ts` — Titel mit
  Mustern anlegen, speichern, Anzeige substituiert, Input roh, Reload,
  Viewer, Axe.
- Nachbarn: 02e (Antworttext-Render) + f7-02 (Zähler/Labels).

## Akzeptanz
- `npm run check` gruen; E2E Chromium gruen; Heartbeat + Push + CI gruen.
