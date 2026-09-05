---
name: playwright-verify
description: Pflicht-Gate vor „fertig": Web-Oberflächen auf 375/768/1440 px prüfen, Console-Fehler und A11y-Snapshot checken, Screenshots lesen. Lädt bei Website-, UI- oder Frontend-Arbeit, vor jedem Abschluss oder Deployment einer Seite.
---

# Playwright-Verify — Browser-Gate

Nichts gilt als fertig, bevor es im echten Browser geprüft wurde. Nie „sollte gehen".

## Gate (alle Schritte, in dieser Reihenfolge)

1. **Screenshots** — 375 / 768 / 1440 px je relevante Seite (Start, kritischer Flow):
   ```bash
   npx playwright screenshot --viewport-size=375,800 "http://localhost:PORT/…" /tmp/shot-375.png
   ```
   Dann `read_image` und wirklich hinschauen: Layout, Überläufe, Menü, Formulare.
2. **Console-Fehler** — 0 Fehler. Error-Log mitschreiben:
   ```bash
   npx playwright test --reporter=line   # eigene Smoke-Tests bevorzugt
   ```
   Rote Console-Fehler, fehlgeschlagene Requests (4xx/5xx) oder Hydration-Warnungen = nicht fertig.
3. **A11y-Snapshot** — Struktur prüfen (Buttons, Links, Formularlabels):
   ```bash
   npx playwright test tests/a11y.spec.ts   # page.accessibility.snapshot()
   ```
4. **Kritischer Flow** — den einen Weg durchklicken, für den die Seite gebaut ist
   (Kauf, Formular, Login), nicht nur die Startseite.

## Wege zum Browser

| Weg | Wann |
|---|---|
| Bash + Playwright-CLI/Skripte | Standard; token-schonend, reproduzierbar |
| Playwright-MCP (`mcp__playwright__*`) | exploratives Klicken, schnelle Checks |
| Chrome-DevTools-MCP (`mcp__chrome_devtools__*`) | Warum-Fragen: Console, Netzwerk, Performance |
| Screenshot + `read_image` | immer zusätzlich — das Modell muss sehen, was der Mensch sieht |

## Mobile

375 px ist der Engpass: Navigation, Tap-Flächen (min. 44 px), Tabellen, Modale.
Vorher prüfen, ob das Projekt Mobile-First oder Desktop-First ist — und das Gate
dann auf dem schwächeren Gerät ansetzen.

## Befunde

Jeder Befund mit Viewport + URL + Screenshot-Pfad. Fix → Gate erneut, vollständig,
nicht nur den einen Viewport. Erst wenn 1–4 grün sind: „fertig" sagen.
