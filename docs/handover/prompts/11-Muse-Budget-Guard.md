# MUSE BUDGET-GUARD — Token-Disziplin (Delta auf 06/09/10, BINDEND)

Kontext: Am 2026-09-05 wurden über die Meta-API ~1,4 Mrd. Input-Token
(~72 €) verbrannt — für 27 Turns. Das ist ~50 Mio. Token pro Turn und
damit 20–50× über dem, was diese Arbeit braucht. Ursache (Befund
Mikail-Seite): Kontext ohne Prompt-Caching + wiederholtes Volllesen
großer Dateien (allein `drizzle/meta/*_snapshot.json` = 18 MB ≈ 10 Mio.
Token je Volldurchgang). Ab sofort gilt:

## 1. LESEN NUR MIT GRENZEN (je Turn maximal ~200 k Token Lesevolumen)

- **NIE** `drizzle/meta/*_snapshot.json` vollständig lesen. Journal
  prüfen nur via `python3 -c "import json; j=json.load(open('drizzle/meta/_journal.json')); print(j['entries'][-3:])"`.
- Große Dateien (> 300 Zeilen) nur gezielt: `sed -n '<von>,<bis>p'` oder
  `git show <ref>:<pfad> | sed -n ...`; niemals `cat`.
- Logs niemals vollständig lesen: `tail -n 40` + `grep -E "FAIL|error"`.
- CI-Ergebnis nur per API mit `per_page=3` und grep auf
  `display_title|status|conclusion` — nie Run-Logs per gh abrufen
  (außer bei konkretem rotem Job: `--log-failed | tail -60`).
- Repo-Struktur NICHT je Turn neu explorieren: `git diff --stat` und
  `git status --short` genügen; Verzeichnislisten nur bei Bedarf.
- Keine Datei zweimal im selben Turn lesen. Zwischenstände in
  Notizen unter `docs/parity/muse-welle-03/` halten statt Dateien
  erneut zu öffnen.

## 2. TURN-BUDGET & PROTOKOLL

- Jeder Turn beginnt mit einer Budget-Zeile im LOOP-LOG:
  `Turn N · geschätzte Lese-Token: <n> · Kernaktionen: <n>`.
- Kommst du in einem Turn über ~30 Tool-Aufrufe oder ~200 k Token
  Lesevolumen: Turn hier beenden (Zustand committen, pushen) und den
  Rest dem nächsten Turn überlassen. Viele kleine Turns sind billiger
  als ein Riesen-Turn, wenn die Plattform ohne Caching abrechnet.
- KEINE parallelen Sub-Agenten/Workers starten (jeder Worker
  vervielfacht die Input-Token). Sequenziell arbeiten.

## 3. Prompts/Dateien schlank halten

- GOAL.md/LOOP-LOG: nur Delta-Zeilen anhängen, nie ganze Dateien
  neu schreiben (das vergrößert auch deine eigenen Reads).
- Spec-Dokumente: Ziel 40–80 Zeilen. Bestehende lange Specs nicht
  erneut lesen, wenn GOAL.md die Essenz trägt.
- Review-Prompts für Kimi/DeepSeek: Bundle auf die DIFFS begrenzen
  (`git diff <basis>..HEAD --stat` + relevante Hunk-Auszüge), nie
  ganze Module.

## 4. Mikails Sicherheitsnetz (Plattform-Seite, kein Prompt)

- Mikail setzt in der Plattform ein hartes Spending-Limit/Tagesbudget.
- Wenn deine Laufzeit einen Prompt-Cache anbietet: aktivieren lassen.
- Wenn mehrere Muse-Sessions/Workers laufen: alle bis auf EINEN stoppen.
