# Tooling-Mission — Abschlussbericht (Phase E)

Stand: 2026-08-27 · Branch `tooling` (Worktree `~/Downloads/Projects/energie-saas/tooling-wt`)
· `npm run check` grün (15 Testdateien, 101 Tests).

## Was installiert wurde (Commits auf `tooling`)

| Commit | Inhalt |
|---|---|
| `6dd627e` | Phase A: Bedarfslandkarte + Missionsauftrag |
| `808300f` | Phase C: Entscheidungsdoku + **ADR 0002 entschieden** (Hetzner Object Storage, Test-Gate) |
| `2f1c99f` | UI-Interaktion: pragmatic-drag-and-drop, TanStack Table v9 + react-virtual, RHF + zod v4 + resolvers + drizzle-zod, Uppy (S3-presigned), papaparse |
| `8fc912d` | UI-Anzeige: Tiptap (+Mention), Recharts 3 (Sankey), react-pdf, MapLibre + @vis.gl/react-maplibre, FullCalendar Core v7 |
| `0fe54c1` | Dokumente: signature_pad, node-zugferd (nur XML-Erzeugung), Playwright |
| `f589da1` | Gerüste: Sentry hinter Env-Flag (App `instrumentation*.ts` + Worker), Dead-Man-Heartbeat (`startHeartbeat` + 3 Unit-Tests), `worker/backup/backup.sh`, Anthropic-SDK, `.env.example` erweitert |

Nicht installiert (bewusst, mit Begründung in `entscheidungen.md`): Konva (M6),
hplib (M6-Sidecar), Tesseract (P2), Ghostscript/Mustang/KoSIT (M3-Worker/CI-Bausteine
— erst mit echten Rechnungs-Fixtures sinnvoll), DWD-TRY-Parser (nicht nötig).

## Was gekauft/registriert werden muss

→ `docs/tooling/einkaufsliste.md` (20 Positionen, P1 = #1–13).
Dev-Phase ≈ 14 € netto/M + Anthropic-Nutzung; ab Pilot zusätzlich ≈ 60–75 €/M.

## Codex-Review (gesichtet, alle 6 Punkte übernommen)

Review der Code-Gerüste via Codex CLI (gpt-5.6-sol xhigh, 27.08.): 6 Befunde,
alle stichhaltig, alle gefixt (Commit nach f589da1): (1) compose.yaml reichte
SENTRY_DSN/HEALTHCHECKS_PING_URL nicht in den Container, (2) backup.sh mappte
S3_*- nicht auf AWS_*-Variablen der CLI, (3) Heartbeat startete vor
pg-boss-Registrierung (attestiert jetzt „arbeitsfähig"), (4) Ticks konnten
überlappen + stop() stoppte laufende Ticks nicht (jetzt rekursives Scheduling,
stopped-Guard, 10-s-Fetch-Timeout), (5) Nicht-2xx-Pings galten als Zustellung
(jetzt geloggt), (6) behandelte fatale Worker-Fehler erreichten Sentry nicht
(jetzt captureException + flush). Tests decken #3–#5 ab (104 grün).

## Offene Koordination (wichtig)

1. **CI-Push blockiert:** gh-Token hat keinen `workflow`-Scope → `m0-fundament`
   und `tooling` können nicht gepusht werden (Einkaufsliste #1, 2 Minuten).
   `main` ist bereits auf https://github.com/mikaslan/energie-saas (privat).
2. **Parallele M0-Session:** `m0-fundament` wird gerade von der Session
   `build-reonic-clone-saas` finalisiert (m0-wt gehört exklusiv ihr). Abgesprochen:
   Nach deren Merge nach `main` wird **`tooling` auf `main` rebased**, bevor
   weitere Pakete draufkommen (Konfliktpotenzial: package.json, ci.yml,
   worker/index.ts — dort trifft mein Env-Flag-Block auf deren
   POSTGRES_URL_WORKER-Block; beides behalten).
3. **K3-Gegenprobe entfiel:** OpenRouter-Guthaben leer (PLAN.md Betriebsnotiz).
   Die ADR-0002-Fakten wurden stattdessen durch einen unabhängigen
   Faktencheck-Agenten gegen Primärquellen verifiziert.

## Nach Erhalt der Zugangsdaten (Reihenfolge)

1. **`.env.local` füllen** — Vorlage `.env.example` ist aktuell (neue Blöcke am Ende).
2. **Vercel-Envs setzen** (sobald Vercel-Projekt existiert/Pro):
   ```bash
   for V in SENTRY_DSN NEXT_PUBLIC_SENTRY_DSN ANTHROPIC_API_KEY \
            NEXT_PUBLIC_STADIA_MAPS_API_KEY GEOAPIFY_API_KEY RESEND_API_KEY; do
     vercel env add "$V" production
   done
   ```
3. **Storage-Buckets anlegen** (Object-Lock NUR bei Anlage möglich!):
   ```bash
   export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… EP=https://nbg1.your-objectstorage.com
   aws s3api create-bucket --bucket energie-saas-archiv --endpoint-url $EP \
     --object-lock-enabled-for-bucket
   aws s3api create-bucket --bucket energie-saas-backup --endpoint-url $EP \
     --object-lock-enabled-for-bucket
   aws s3api put-object-lock-configuration --bucket energie-saas-backup --endpoint-url $EP \
     --object-lock-configuration 'ObjectLockEnabled=Enabled,Rule={DefaultRetention={Mode=GOVERNANCE,Days=30}}'
   # Archiv: COMPLIANCE-Default-Retention ERST nach dem 1-Tages-Testlauf setzen (ADR 0002 §3)!
   ```
4. **ADR-0002-Test-Gate ausführen** (If-None-Match; Ergebnis im ADR nachtragen):
   ```bash
   echo a > /tmp/t.txt
   aws s3api put-object --bucket energie-saas-archiv --key worm-test --body /tmp/t.txt --endpoint-url $EP
   aws s3api put-object --bucket energie-saas-archiv --key worm-test --body /tmp/t.txt \
     --if-none-match '*' --endpoint-url $EP && echo "KEIN 412 — Fallback-Semantik aktiv (ADR §1)" \
     || echo "412 erhalten — Conditional Writes funktionieren"
   ```
5. **Verifikation je Dienst:**
   - Sentry: `SENTRY_DSN=… npx tsx -e "import('@sentry/node').then(async S=>{S.init({dsn:process.env.SENTRY_DSN});S.captureMessage('tooling-smoke');await S.flush(5000)})"` → Event in Frankfurt-Org sichtbar.
   - healthchecks.io: Worker mit `HEALTHCHECKS_PING_URL` starten → Check wird grün; Worker stoppen → nach Grace-Period Alarm.
   - Anthropic: `ANTHROPIC_API_KEY=… npx tsx -e "import('@anthropic-ai/sdk').then(async m=>{const c=new m.default();const r=await c.messages.create({model:'claude-haiku-4-5',max_tokens:16,messages:[{role:'user',content:'ping'}]});console.log(r.content)})"`
   - Geoapify/Stadia: eine Geocode-/Tile-Anfrage mit Key (curl) — 200 erwartet.
   - Resend: Test-Mail über die verifizierte Domain (`resend.emails.send`).
   - CI: `gh run list --branch tooling` nach dem ersten Push (Workflow bootstrapt
     die non-superuser-Rolle selbst; zusätzliche Env-Vars braucht er laut
     ci.yml-Review nicht).
6. **Hetzner-Worker-Deploy** (nach Serverkauf): Docker + Compose installieren,
   Repo auslesen, `docker compose -f worker/compose.yaml up --build -d`;
   Backup-Cron nach `worker/backup/backup.sh`-Kopfkommentar einrichten
   (Host-Pakete: postgresql-client, zstd, age, awscli).

## Offene Spikes vor Modul-Start (aus der Recherche, je ≤1 Tag)

- **M2/M3:** Chrome-PDF → Ghostscript → veraPDF/Mustang-Validierung mit echtem
  Template durchspielen, erst dann ZUGFeRD-Pfad einfrieren; node-zugferd-Release-
  Stand prüfen (Beta, Bus-Faktor 1). AGPL-Frage Ghostscript einmal juristisch
  bestätigen lassen oder dokumentiert akzeptieren.
- **M4:** Recharts-Sankey-Spike für den PV-Energiefluss (Fallback @visx/sankey).
- **M5:** FullCalendar-Premium-v7-Status prüfen (Stand heute nur RC).
- **Kleinkram:** `npm approve-scripts` für @sentry/cli erst nötig, wenn
  Source-Map-Upload kommt; TanStack-Table-v9-API beachten (v8-Tutorials inkompatibel).

## Die 3 wichtigsten offenen Entscheidungen

1. **Keine** — alle P1-Felder sind entschieden. Bedingt offen bleibt nur das
   ADR-0002-Test-Gate (If-None-Match bei Hetzner): ändert nichts an der Wahl,
   nur ggf. an der Härte der S3-seitigen Doppel-Upload-Absicherung.
2. **XRechnung-Profil** (B2G): node-zugferd-Eigenbau-Zusatzfelder vs.
   Mustang-Route — Entscheidung erst nötig, wenn ein Pilotkunde öffentliche
   Auftraggeber beliefert (M3).
3. **Excel-(xlsx)-Import** M1: nur CSV (papaparse) ist gesetzt; falls die
   M1-Spec Excel verlangt → exceljs prüfen.
