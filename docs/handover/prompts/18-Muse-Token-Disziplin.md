# 18 — MUSE TOKEN-DISZIPLIN (Input-Kosten hart deckeln)

Verbindlich ab Welle 03, Turn 57. Grund: Die Input-Token je Turn sind der
Kostenfaktor — nicht die Arbeit selbst, sondern was je Turn WIEDER in den
Kontext geladen wird.

## 1. Zustandsdateien klein halten (GOAL.md / LOOP-LOG.md)

- **GOAL.md: Stand-Block ERSETZEN, nie anhängen.** Fixe Struktur:
  Ziel (2 Zeilen) / Stand (letzter Slice + Commit + Quote, max 5 Zeilen) /
  ALS NÄCHSTES (exakt 1 Schritt) / Blocker (Stichworte). Gesamt max
  **40 Zeilen**. Der historische Verlauf lebt im LOOP-LOG und in Git.
- **LOOP-LOG.md: append-only, aber beim Lesen NUR `tail -50`.** Nie
  komplett lesen — die Datei wächst je Turn, ein Voll-Read macht den
  Turn-Start mit jedem Loop teurer.

## 2. Datei-Reads hart begrenzt

- Jeder Read mit Limit (max 200 Zeilen) oder gezieltem
  `head`/`tail`-Fenster. Große Dateien nie ganz.
- **VERBOTEN in den Kontext:** `drizzle/meta/*_snapshot.json`
  (660–690 KB je Datei ≈ 150–200k Tokens pro Read!). Snapshot-Arbeit
  nur über Hash-Scripts oder `jq`-Auszüge (max 40 Zeilen Ausgabe).
- **CI-Logs bleiben auf Disk.** In den Kontext kommen nur gefilterte
  Auszüge, z. B.
  `grep -E 'FAIL|Error|AssertionError|Expected|Received' <log> | head -50`.
  Ein `gh run view --log-failed` schreibt nach /tmp und wird NUR so
  gefiltert gelesen.

## 3. Session-Hygiene (wie 16er, verschärft)

- Je `/loop` eine FRISCHE Session; über 10 MB hart neu starten.
- Lange Prompts (06/09/10/14) nur beim Erststart laden, im Loop nie
  erneut.
- Nach jeder CI-Triage-Runde nur DELTAS auswerten, nie die komplette
  Fehlerliste erneut laden.

## 4. Plattform (Mikail-Seite, einmalig — Haupthebel)

- Kontextverdichtung **soft 0.3 / hard 0.5**, Prompt-Caching aktivieren,
  Spending-Limit als Sicherheitsnetz.
- Ohne Verdichtung wird bei jedem Turn die GESAMTE Historie erneut als
  Input berechnet — der Input wächst linear mit jedem Turn, egal wie
  diszipliniert die Reads sind.

## 5. STOPP-Regel statt Verstetigungs-Modus (überschreibt 10er §5)

- Wenn `ALS NÄCHSTES` leer ist UND die eigene Lane CI-grün ist: Zustand
  pushen, 3-Zeilen-Status, **STOP** — keine Full-Gate-Wiederholungen,
  kein „niemals stillstehen". Weiter erst mit dem nächsten `/loop`.
- Der Verstetigungs-Modus (10er §5) ist damit AUSGESETZT (Kostengrund:
  Leerlauf-Turns brennen Input — 519 Turns ≈ 113M Input-Tokens/Tag).
  Mikail kann ihn jederzeit explizit wieder einschalten.
- Log-/Blob-Download-Retries: **max 2 Versuche** je Download, dann
  nächster Schritt oder ein frischer CI-Run als Orakel — keine
  Endlos-Retries (Turn 56b-Muster).
