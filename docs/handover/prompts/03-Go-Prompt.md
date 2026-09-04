# Prompt 3 — /go-Prompt (Codex-Fortsetzungsauftrag)

/go

Projekt: energie-saas · Aufgabe: Parity Freeze fortsetzen ·
Workflow: selbst (Codex baut, Review per /codex-review + kimi-review) ·
Erlaubt: Code/Branches/Worktrees/Tests (KEIN Deploy, KEINE Reonic-
Mutation, KEIN Push auf main) · Braucht Mikail: F4-Antworten,
Browser-Login-Sweep, Deploy-GOs.

Du übernimmst das Projekt „energie-saas" am Stand `codex/m1-wave-02`
(HEAD `194fb3e`, Worktree `/Users/mikail/Projects/energie-saas-m1-wave-02`).
Lies ZUERST: `05-Handover-Mac-Studio.md`, `01-Laufender-Stand.md` und
`30-Prompts/02-Wissens-Prompt.md` im Vault
(`20-Bereiche/D-Wmee/Rechner/Reonic Clone Final/`), dann
`docs/parity/STATUS.md` im Repo.

## Dein Auftrag (in dieser Reihenfolge)

1. **Verifizieren:** Führe zuerst `30-Prompts/01-Verifikations-Prompt.md`
   aus und melde die Tabelle. Nur bei grün weiterarbeiten.
2. **Nächsten Slice bauen** — Vorschlag: **F2.2 Varianten-Vertiefung**
   (Live-evidenziert aus `docs/parity/reonic-api-live/`: Variante
   `{isPrimary, totalPrice{net,gross,vat}, totalPriceOverride,
   systems{...}, optionalBundles[]}`). Baut auf M2-01 auf:
   - `is_primary` (genau eine primäre Variante je Offer, partieller
     Unique-Index), `total_price_override_net_cents` (F2.4-Deal-Wert),
     `optional_bundles` (jsonb, Slice-A-Form {name, position} als
     ESTIMATE markiert — Live-Bundles waren leer)
   - Gate-Kette DISCOVERED→SPECIFIED→CONTRACTED→RED→IMPLEMENTED→
     REVIEWED→VERIFIED; Spec zuerst, Kimi-Review für Spec UND Code;
     Migration 0055 in eigener Lane off `origin/codex/m1-wave-02`
   - Nachweise: `npm run check` (alle 203 Dateien grün), Build,
     `db:generate` ohne Drift, E2E-Grep für den neuen Slice, Rollenproben,
     m111a-Zähler + permissions-Zähler aktualisieren, Rollenvertrag-Pins
     (Policy-Hash aus Check-Fehlermeldung bootstrappen)
   - Erst gepusht = gesichert: Lane pushen, per Fast-Forward in
     `codex/m1-wave-02` integrieren, dort Gates erneut, pushen.
3. **Nur wenn Mikail die F4-Fragen beantwortet:** F4-Rechenkern starten
   (größter Hebel). Vorher NICHT erfinden — auf Antworten warten.
4. **Fortschritt dokumentieren:** nach jedem VERIFIED-Slice
   `docs/parity/STATUS.md` + Vault `01-Laufender-Stand.md` aktualisieren
   und Mikail berichten (Quote ehrlich: steigt NUR mit VERIFIED-Slices).

## Review-Gate (verbindlich): Kimi K3 prüft JEDE Arbeit von Metamuse Spark 1.3

Der Agent auf diesem Mac Studio heißt **Metamuse Spark 1.3**. JEDE seiner
Code-/Spec-Änderungen wird zusätzlich von **Kimi K3** als unabhängiger
Review-Stimme geprüft (andere Modell-Familie), bevor der Slice als
REVIEWED zählt.

**API-Key für Kimi K3 (OpenRouter, Modell `moonshotai/kimi-k3`, effort high):**

```
OPENROUTER_API_KEY_AUS_DOTENV
```

**⚠️ SECRET — Behandlung (Brain-Regel „Secrets"):**
- Der Key wird NIE committet, nie in Logs/Chat/Telegram gepastet, nie in
  Repo-Dateien geschrieben.
- Erster Schritt auf dem Mac Studio: Key in die gitignorierte lokale
  `.env.local` des Repos eintragen:
  `OPENROUTER_API_KEY=OPENROUTER_API_KEY_AUS_DOTENV`
  (Diese Vault-Datei danach idealerweise bereinigen, falls der Vault
  synchronisiert wird.)
- **Verifizieren (einmalig, read-only):**
  `curl -s -o /dev/null -w "%{http_code}" https://openrouter.ai/api/v1/models -H "Authorization: Bearer OPENROUTER_API_KEY_AUS_DOTENV"`
  → `200` = OpenRouter-Key, direkt nutzbar.
  → `401/403` = vermutlich direkter Moonshot-Key → dann in
  `scripts/kimi-review.mts` Basis-URL auf `https://api.moonshot.ai/v1`
  und Modell auf `kimi-k3` umstellen (erst nach erfolgreichem
  `GET https://api.moonshot.ai/v1/models`-Test).

**Einsatz (bestehendes Skript, keine Neuentwicklung):**
```
cd /Users/mikail/Projects/energie-saas
npx tsx scripts/kimi-review.mts <prompt.md> <bundle.txt> <out.md>
```
- Lauf vor jedem REVIEWED: (1) je SPEC (FREIGABE/NACHBESSERUNG),
  (2) je Code-Bundle (P0/P1/P2/P3-Liste + Verdikt).
- Befunde werden NIE blind übernommen: Metamuse Spark 1.3 prüft jeden
  Fund selbst, schließt ihn nachweisbar (Test/Beleg) und dokumentiert
  die Schließung im Commit-Text.
- Exit 3 (beide Quellen leer) = OpenRouter-Limit/Key-Problem → nicht
  still überspringen, Mikail melden.

## Harte Regeln (nicht verhandelbar)

- Clean-Room: Reonic = funktionale Referenz, WMEE = visuell; kein
  Quellcode-/Text-/Asset-Kopieren. Reonic-API nur read-only (Key in
  `.env.local`, nie loggen/committen).
- Keine erfundenen Zahlen/Preise/Daten — Unbekanntes als ESTIMATE/UNKNOWN
  markieren, Entscheidungen an Mikail.
- Kein Deploy, keine Produktiv-Aktion, keine Reonic-Mutation ohne
  explizite Freigabe; main nie pushen.
- Externe Gates (S3-Object-Lock, Live-PVGIS, Resend, Neon, Hetzner)
  dokumentieren und eskalieren, nie still überspringen.
- Migrationen additiv, RLS strikt, DSGVO-Erasuregraph beachten;
  keine Steuerzeichen in SQL-CHECKs (POSIX-Klasse `[[:cntrl:]]`).
- `npm install` nur als `env -u npm_config_allow_scripts npm install`
  (sonst EALLOWSCRIPTS).

## Ende erst, wenn

Alle F1–F16-Capabilities VERIFIED (0 MISSING, 0 PARTIAL), UNKNOWNs geklärt
oder als DECIDED/ACCEPTED_EXCEPTION mit Mikail abgestimmt, kritische
Journeys in allen Rollen grün, visuelle Freigaben erteilt, alle Register
(CAPABILITY-MATRIX, SOURCE-REGISTER, TEST-EVIDENCE, UNKNOWN-CONFLICT-LOG,
STATUS) aktuell — und Mikail den Parity Freeze bestätigt.
