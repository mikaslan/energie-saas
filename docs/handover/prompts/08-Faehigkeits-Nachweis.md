# Prompt 8 — Aktiver Fähigkeits-Nachweis (nach dem Bootstrap)

Du hast behauptet, Skills/Plugins/MCPs installiert zu haben. Behauptungen
zählen NICHT. Jede Fähigkeit wird jetzt durch ECHTE AUSFÜHRUNG belegt.
Was du nicht ausführen kannst, markierst du ehrlich als NICHT VERFÜGBAR.

## A. Skills — Verhaltens-Nachweis (je Skill eine Probe ausführen)

1. reonic-parity: Liste die harten Verbote des Clean-Room-Regimes auf
   (komplett, aus dem Skill — nicht aus diesem Prompt).
2. pv-fachwissen: Nenne die zwei deutschen Registrierungspflichten für
   PV-Anlagen (EEG-Anlagenregister / MaStR) und sage je Pflicht, wofür
   sie gilt.
3. software-quality-gates: Nenne die Gate-Kette und die Pflicht-Nachweise
   je Slice.
4. contract-first: Beschreibe das Vorgehen "Vertrag zuerst" — was wird
   womit gepinnt, und wann entsteht ein ADR?
5. database-migrations: Wie bootstrappst du einen Rollenvertrags-Policy-
   Hash? (Antwort: aus der Check-Fehlermeldung übernehmen — NICHT raten.)
6. product-lens: Nenne die Kernfragen, die vor jeder Produktentscheidung
   geprüft werden müssen.
7. playwright-verify + browser-qa (FUNKTIONAL, kein Zitat):
   cd ~/Projects/energie-saas-m1-wave-02
   M1_05_E2E_GREP='F9.2' npm run test:e2e
   → erwartet: "2 passed". Das ist der Beweis, dass Playwright+Chromium
   in DEINER Umgebung wirklich laufen.
8. Anwendungs-Nachweis (Pflicht): Bevor du den ersten Slice baust,
   schreibst du in deinen Slice-Plan explizit, WELCHE Skill-Regeln du
   darin anwendest (je Regel: Skill-Name). Fehlt das, gilt der Skill
   als nicht aktiv genutzt.

## B. MCPs — nur zählen, was du WIRKLICH aufrufen kannst

Für JEDEN MCP, den du als "aktiv" behauptest:
- Führe einen echten Tool-Call aus (z. B. Context7: Doku zu "Next.js"
  abrufen; GitHub-MCP: EIN Issue/PR von github.com/mikaslan/energie-saas
  auflisten).
- Zeige die ersten 2–3 Zeilen der echten Antwort.
- Kein Tool in deiner Laufzeit sichtbar? → "NICHT VERFÜGBAR" eintragen.
  Das ist für dieses Projekt KEIN Blocker (die Pflicht-Tests laufen über
  das Repo), muss aber ehrlich in der Tabelle stehen.

## C. Plugins — gleiche Regel wie B

Jedes behauptete Plugin braucht eine sichtbare Wirkung (Tool/Output),
sonst: "NICHT VERFÜGBAR".

## D. Werkzeug-Schreibtest (beweist, dass du wirklich bauen kannst)

cd ~/Projects/energie-saas-m1-wave-02
git checkout -b verify/<datum-zeit>
touch VERIFY.md && git add VERIFY.md && git commit -m "verify: Toolchain-Schreibtest"
git log --oneline -1    → Commit-Hash in die Tabelle aufnehmen
git checkout codex/m1-wave-02 && git branch -D verify/<datum-zeit>
(KEIN Push dieses Test-Branches.)

## Ausgabeformat (nur das)

Tabelle: Fähigkeit | Nachweis (ausgeführter Befehl + Kurzergebnis) |
Status (AKTIV BELEGT / NICHT VERFÜGBAR / FEHLGESCHLAGEN).

Danach EINE Verdikt-Zeile:
- "ALLE PFLICHT-FÄHIGKEITEN AKTIV BELEGT" (Skills 1–8 + Werkzeugtest +
  E2E grün; MCPs/Plugins dürfen NICHT VERFÜGBAR sein)
- oder "ES FEHLT: <Liste>"

Erst bei grünem Verdikt darfst du mit dem ersten Slice (F2.2) beginnen.
