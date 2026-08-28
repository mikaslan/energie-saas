# Ist-Bericht 03 — Tooling-Branch und Betriebsfähigkeit

Stand: 2026-08-28. Reine Lese-Analyse des Repos `/Users/mikail/Projects/energie-saas`
auf Branch `tooling`. Es wurde kein Produktivcode geändert; geschrieben wurde
ausschließlich unterhalb `docs/ist-bericht/`.

Ausgangslage laut Auftrag (heute verifiziert, nicht erneut ausgeführt):
`npm run typecheck`, `npm run lint`, `npm run depcruise` (43 Module, 58
Abhängigkeiten, 0 Grenzverletzungen) und `npm test` (15 Dateien, 110 Tests
gegen echtes Postgres mit angewendeten Migrationen) sind grün.

Zusätzlich in dieser Analyse selbst ausgeführt und damit belegt:
`npm run build` (zweimal, siehe Abschnitt 4) und `python3 -m py_compile
scripts/hetzner-provision.py`.

---

## 1. Git-Lage

### Was auf dem Branch liegt

Lokaler Branch `tooling` steht auf `e8327c0`, `origin/tooling` auf `4cf2d3c`,
`main` auf `8911a83`. Der lokale Branch ist gegenüber dem Remote **um einen
Commit zurück** und könnte per Fast-Forward nachgezogen werden — könnte, wenn
das Arbeitsverzeichnis sauber wäre; dazu unten mehr.

Dreizehn Commits liegen auf `tooling` und nicht auf `main` (neueste zuerst;
`4cf2d3c` existiert nur remote):

```
4cf2d3c docs: Hetzner-Server gekauft und grundinstalliert (Einkaufsliste #2)   [nur origin]
e8327c0 feat: CAX21-Fallback für EU-weit ausverkaufte CX-Reihe
49863cf fix: Provisionierungsskript auf System-Python 3.9 lauffähig machen
3c6c0a6 feat: idempotentes Hetzner-Provisionierungsskript für den Worker-Host
31eac11 docs(tooling): STATUS-Nachtrag — CI auf main+tooling verifiziert gruen
556b3a2 ci: actions/checkout und setup-node auf v7
032e416 fix(tooling): alle 6 Codex-Review-Befunde umgesetzt
3b64628 docs(tooling): Einkaufsliste (Phase D) + Abschlussbericht STATUS (Phase E)
16a42fa feat(tooling): Monitoring/KI-Gerüst — Sentry, Dead-Man-Heartbeat, Backup, Anthropic-SDK
18df8ab chore(tooling): Dokumente — signature_pad, node-zugferd, Playwright
a2f7f86 chore(tooling): UI-Anzeige — Tiptap, Recharts 3, react-pdf, MapLibre, FullCalendar
6e1e283 chore(tooling): UI-Interaktion — pragmatic-dnd, TanStack Table, RHF+zod4, Uppy, papaparse
498d76e docs(tooling): Entscheidungen Phase C + ADR 0002 entschieden
25822a8 docs(tooling): Bedarfslandkarte (Phase A) + Missionsauftrag
```

Der Diffstat `main...tooling` nennt 18 Dateien, +7134/−505 Zeilen. Das klingt
nach viel, ist es aber nicht: 6412 Zeilen entfallen allein auf
`package-lock.json`. Der tatsächliche Handarbeitsanteil liegt bei rund 700
Zeilen, davon der weit überwiegende Teil Dokumentation (`docs/tooling/*` mit
644 Zeilen, `docs/adr/0002` mit 76). An echtem Code kommen hinzu:
`worker/health.ts` (58 Zeilen), `worker/backup/backup.sh` (44),
`instrumentation*.ts` (36), Änderungen an `worker/index.ts` (33),
`scripts/hetzner-provision.py` (136) und `tests/unit/heartbeat.test.ts` (120).

Das ist eine ehrliche Einordnung des Branches: **`tooling` ist zu etwa 80 %
eine Beschaffungs- und Dokumentationsmission und zu 20 % Code.** Der Code, der
dazugekommen ist, ist von guter Qualität (siehe Abschnitt 2).

### Was uncommitted ist — hier steckt ein echtes Problem

`git status` meldet drei geänderte und zwei unversionierte Pfade:

- geändert: `.env.example`, `docs/tooling/einkaufsliste.md`,
  `scripts/hetzner-provision.py`
- unversioniert: `research/`, `scripts/lagebericht.sh`
  (letzteres war im Auftrag nicht erwähnt, existiert aber)

Die drei Änderungen sind **nicht gleichwertig**. Vergleicht man das
Arbeitsverzeichnis nicht gegen den lokalen HEAD, sondern gegen `origin/tooling`,
kippt das Bild bei einer der drei Dateien:

1. **`.env.example` — gewollte Ergänzung, gehört committet.** Fügt `HCLOUD_TOKEN`
   mit einem sinnvollen Kommentar hinzu („nur lokal genutzt von
   `scripts/hetzner-provision.py`, gehoert NICHT in Vercel-/Runtime-Envs").
   Diese Zeile existiert weder auf `main` noch auf `origin/tooling`.

2. **`scripts/hetzner-provision.py` — gewollte Härtung, gehört committet.**
   Der Token wird von umschließenden Anführungszeichen befreit, und ein leerer
   Token führt zu einem klaren Abbruch statt zu einem HTTP 401 gegen die
   Hetzner-API. Ebenfalls nirgends committet.

3. **`docs/tooling/einkaufsliste.md` — veraltet, würde Dokumentation
   zurückdrehen.** Der Remote-Commit `4cf2d3c` („Hetzner-Server gekauft und
   grundinstalliert") hat die Einkaufsliste heute Vormittag auf den Stand
   „Position 2 erledigt, CX33 läuft unter 2.28.70.140" gebracht. Die
   uncommittete lokale Fassung stammt aus der Zeit *davor* (aus der
   CX-Ausverkaufs-Episode) und schreibt „CAX21 (CX33 ausverkauft), Prio P1
   sofort, Kostenrahmen 16 €/Monat" sowie eine Anleitung „du lieferst nur den
   Token". Wer diesen Arbeitsstand blind committet, löscht die Information,
   dass der Server bereits gekauft und installiert ist, und stellt einen
   falschen Kostenrahmen wieder her (CAX21 10,49 € statt tatsächlich CX33
   8,49 €).

Die praktische Konsequenz: **`git pull --ff-only` bricht in diesem Zustand ab**,
weil `4cf2d3c` genau die Datei anfasst, die lokal modifiziert ist. Der Zustand
muss von Hand aufgelöst werden. Richtig ist: die lokale Fassung der
Einkaufsliste verwerfen (`git checkout -- docs/tooling/einkaufsliste.md`),
dann `git pull --ff-only`, dann `.env.example` und
`scripts/hetzner-provision.py` als eigenen Commit sichern.

### Der Worker-Host existiert bereits und kostet bereits Geld

Der Remote-Commit dokumentiert Tatsachen, die es lokal noch nicht gibt:
Server-ID 163858990, CX33, Ubuntu 24.04.4, Standort nbg1, IPv4 `2.28.70.140`,
Hetzner-Firewall `worker-fw` mit ausschließlich 22/tcp eingehend, Docker 29.1.3
und Compose 2.40.3 installiert. Der Host läuft, aber es läuft **kein Container**
darauf — das `docker compose up` wartet auf die Datenbank- und Monitoring-Envs.

### Weitere Beobachtungen zur Git-Hygiene

- **`docs/tooling/STATUS.md` verweist auf Commit-Hashes, die es nicht gibt.**
  Die Tabelle „Was installiert wurde" nennt `6dd627e`, `808300f`, `2f1c99f`,
  `8fc912d`, `0fe54c1`, `f589da1`. Nach dem im selben Dokument beschriebenen
  Rebase auf `main` heißen dieselben Commits `25822a8`, `498d76e`, `6e1e283`,
  `a2f7f86`, `18df8ab`, `16a42fa`. Kein Schaden, aber die Doku ist an dieser
  Stelle nicht mehr nachvollziehbar und sollte beim Merge korrigiert werden.
- **`scripts/lagebericht.sh` ist unversioniert und enthält eine hart
  eincodierte private E-Mail-Adresse** als Default-Empfänger. Das Skript
  verschickt per AppleScript über Mail.app Statusberichte. Es ist ein reines
  Arbeitswerkzeug der Maschine, kein Projektartefakt. Es gehört entweder mit
  Adresse aus einer Env-Variablen ins Repo oder gar nicht — im jetzigen Zustand
  ist es ein Kandidat dafür, versehentlich mit `git add -A` inklusive Adresse
  ins Repo zu rutschen.

### Ist der Branch merge-reif?

Inhaltlich ja, mechanisch nein. Die Commits sind sauber, die CI ist laut
`STATUS.md` auf `tooling` grün gelaufen (Run 33063929631), die vier lokalen
Gates sind heute grün. Was dem Merge im Weg steht, ist nicht der Branch,
sondern der Arbeitsplatz: ein zurückhängender lokaler Branch, drei nicht
committete Dateien (davon eine, die Dokumentation zurückdrehen würde), zwei
unversionierte Pfade ohne Entscheidung — und, davon unabhängig, ein kaputter
Produktionsbuild (Abschnitt 4), der auf `main` genauso kaputt ist und den die
CI nicht bemerkt.

---

## 2. Worker-Host: was dort läuft und wie er bereitgestellt wird

### Der Host

Ein einzelner Hetzner-Cloud-Server in Nürnberg, Name `energie-saas-worker`,
Ubuntu 24.04, eingehend nur SSH. Er ist bewusst als *nicht kritischer* Pfad
konzipiert: laut `docs/runbooks/worker.md` verzögert ein Worker-Ausfall nur
Jobs (PDF, Simulation) und blockiert das Portal nie. Diese Trennung ist im
Code konsequent durchgehalten — das Portal läuft auf Vercel und spricht die
Datenbank direkt an, der Worker ist ein eigener Prozess mit eigener
Verbindung.

### Was dort tatsächlich läuft — und was nicht

Der Auftrag nennt vier erwartete Bestandteile. Der ehrliche Stand:

| Erwartet | Stand heute |
|---|---|
| pg-boss | **vorhanden und funktionsfähig.** `worker/index.ts` startet pg-boss v12, legt die Queue `health.echo` an und registriert einen Worker darauf. Ein Roundtrip-Test (`tests/db/worker-queue.test.ts`) läuft grün gegen echtes Postgres. |
| Chrome-PDF | **existiert nicht.** In `worker/index.ts` steht dazu ein Kommentar: „M2 registriert hier pdf.render (Playwright/Chrome)". Playwright ist als Abhängigkeit installiert, aber nirgends importiert; im Docker-Image werden keine Browser-Binaries installiert, und `node:22-slim` bringt die Chrome-Systembibliotheken nicht mit. PDF-Erzeugung ist heute nicht möglich. |
| pvlib-Sidecar | **existiert nicht.** Ebenfalls nur ein Kommentar („M4 simulation.run (pvlib-Sidecar)"). Es gibt keinen Python-Container, keinen Sidecar-Dienst in `compose.yaml`, keine Anbindung. |
| E-Rechnungs-Serialisierung | **existiert nicht.** `node-zugferd` ist installiert, wird nirgends importiert. Kein Serialisierungscode, kein Validator, keine Fixtures. |

Faktisch läuft auf dem Worker heute also **pg-boss plus ein Health-Endpunkt**.
Das ist genau das, was der Plan für M0 vorsieht — es ist kein verstecktes
Versäumnis, aber es ist wichtig, es nicht mit dem Zielbild zu verwechseln.
Der Worker-Host ist ein bezahlter, leerer Platzhalter, bis M2 anfängt.

Positiv hervorzuheben: `worker/health.ts` ist ungewöhnlich sorgfältig. Die
Health-Probe misst pro Request den aktuellen DB-Zustand statt „ist mal
gestartet", und die Timeouts liegen als Verbindungsoptionen des Pools
(`connectionTimeoutMillis`, `statement_timeout`, `query_timeout`,
`idle_in_transaction_session_timeout`) statt als `SET LOCAL` oder
`Promise.race` — beides sind Muster, die in der Praxis genau nicht abbrechen.
Der Dead-Man-Heartbeat plant seine Ticks rekursiv statt per `setInterval`,
pingt nur nach erfolgreicher Probe und wertet Nicht-2xx-Antworten korrekt als
Nicht-Zustellung. Das ist Betriebsqualität, nicht Gerüst.

### Das Provisionierungsskript

`scripts/hetzner-provision.py` ist **kein Entwurf, sondern lauffähiger Code,
der nachweislich gelaufen ist** — der Server, den er bestellt hat, existiert.
`python3 -m py_compile` unter dem System-Python 3.9.6 dieser Maschine läuft
durch; das ist auch der Zweck des Commits `49863cf`. Das Skript benutzt nur
die Standardbibliothek (`urllib`), braucht also keine Installation.

Zur Idempotenz — hier ist Präzision wichtig, weil das Skript sich selbst
„idempotent" nennt:

- **Zutreffend:** Alle drei Ressourcen (SSH-Key, Firewall, Server) werden über
  ihren Namen gesucht, bevor etwas angelegt wird. Ein zweiter Lauf bestellt
  garantiert keinen zweiten Server. Es gibt keinen Löschpfad. Das ist die
  wichtige Eigenschaft, und sie stimmt.
- **Nicht zutreffend im strengen Sinn:** Das Skript ist *create-if-absent*,
  nicht *konvergierend*. Existiert die Firewall bereits mit anderen Regeln,
  wird sie nicht korrigiert. Existiert der Server bereits, wird nicht geprüft,
  ob die Firewall überhaupt an ihm hängt — die Zuordnung passiert nur bei der
  Server-Erstellung. Existiert der SSH-Key-Name in Hetzner bereits mit einem
  fremden öffentlichen Schlüssel, wird dieser verwendet, und man kommt nicht
  auf die Maschine.
- **Der Fallback greift nur über Servertypen, nicht über Standorte.** Der
  Kommentar spricht davon, dass die CX-Reihe „in allen sechs Rechenzentren"
  ausverkauft war; das Skript probiert aber ausschließlich `nbg1` und dort die
  Typen `cx33` und `cax21`. Bei einem erneuten Ausverkauf hilft es nicht.
- **Die eigentliche Grundinstallation ist nicht im Skript.** Docker und
  Compose wurden laut `STATUS.md` von Hand nachinstalliert. Es gibt kein
  `user_data`/cloud-init, kein Ansible, kein Setup-Skript. Der Host ist damit
  **nicht aus Code reproduzierbar**: geht er verloren, muss jemand die
  Docker-Installation aus einer Prosa-Zeile in `STATUS.md` rekonstruieren.
  Für einen Host, der später PDF-Rendering und einen Python-Sidecar tragen
  soll, ist das die relevanteste offene Betriebsschuld.

Kleinere Punkte: `TOKEN = read_token()` läuft auf Modulebene, das Skript
bricht also schon beim Import ab, wenn `.env.local` fehlt; die Firewall
erlaubt SSH aus dem gesamten Internet (`0.0.0.0/0`, `::/0`), was mit
Key-Only-Login vertretbar, aber nicht das Minimum ist.

### Container-Setup

`worker/Dockerfile` und `worker/compose.yaml` sind knapp und im Kern richtig
(Health-Port ist auf `127.0.0.1:8080` gebunden, `restart: always`, Healthcheck
vorhanden, `.dockerignore` schließt das Host-`node_modules` korrekt aus). Drei
Dinge fallen negativ auf:

1. **`RUN npm ci --omit=dev && npm i tsx`** — `tsx` ist eine devDependency und
   wird deshalb nach dem `--omit=dev` ungepinnt nachinstalliert. Damit ist der
   Image-Build nicht reproduzierbar, und jeder Build zieht die zu diesem
   Zeitpunkt aktuelle `tsx`-Version samt Transitiven. Bei einem Paket, das den
   gesamten Anwendungscode transformiert, ist das auch eine
   Lieferketten-Angriffsfläche. Sauber wäre eine gepinnte Version oder ein
   Build-Schritt statt Laufzeit-Transpilation.
2. **Kein `USER`** — der Container läuft als root.
3. **`POSTGRES_URL_WORKER` wird nicht durchgereicht.** `worker/index.ts`
   bevorzugt ausdrücklich `POSTGRES_URL_WORKER` (die Naht für die
   Rollentrennung nach ADR 0003), aber `compose.yaml` gibt nur `POSTGRES_URL`
   weiter. Die vorbereitete Trennung ist im Deployment also nicht erreichbar,
   ohne die Compose-Datei anzufassen. Ebenso ist nirgends dokumentiert, aus
   welcher Datei Compose die Variablen ziehen soll — es gibt keine
   `env_file:`-Angabe und keinen Hinweis auf eine `worker/.env`.

Ein echter `docker compose up --build` hat laut Runbook noch nie stattgefunden
(„Docker/Compose konnte auf dieser Maschine nicht ausgeführt werden"). Der
Worker-Deploy ist damit **ungetestet**, obwohl der Host bereit steht. Auf
diesem Rechner ist inzwischen ein `docker` vorhanden; der Test wäre also
nachholbar.

---

## 3. CI

Es gibt genau einen Workflow: `.github/workflows/ci.yml`, ein Job `check`.

### Was läuft

Der Trigger ist `on: [push, pull_request]` — ohne Branch-Filter. Die CI läuft
also **auf allen Branches**, nicht nur auf `main`. Das ist richtig so.

Der Job startet einen Postgres-17-Service, legt eine Nicht-Superuser-Rolle
`app_ci` (`nosuperuser nobypassrls createrole`) samt eigener Datenbank an und
setzt zusätzlich eine getrennte Superuser-Verbindung auf dieselbe Datenbank
für die wenigen Aussagen, die unter RLS strukturell nicht prüfbar sind. Diese
Konstruktion ist der Kern der Tenant-Zusage und in den Kommentaren korrekt
begründet: Ein Superuser umgeht RLS bedingungslos, auch mit `FORCE ROW LEVEL
SECURITY`, und würde sämtliche Isolationstests wirkungslos machen. Wer an der
CI schraubt, sollte diese Kommentare lesen, bevor er den Verbindungsstring
vereinfacht.

Danach laufen zwei Gates:

- **Schema-Drift-Gate:** `npm run db:generate`, anschließend
  `git diff --exit-code drizzle/ lib/db/schema/`. Eine Schemaänderung ohne
  zugehörige Migration bricht den Build ab. Das ist ein starkes Gate und
  genau die richtige Stelle — ohne es wäre eine neue Tabelle für die
  Tenant-Invarianten unsichtbar und würde grün durchmergen.
- **`npm run check`** = `lint` → `typecheck` → `depcruise` → `test`.

Damit sind abgedeckt: ESLint, `tsc --noEmit`, die Modulgrenzen aus
`.dependency-cruiser.cjs` (sieben Verbotsregeln, darunter „`lib/db/client.ts`
nur über `lib/db/tenant.ts`" und „`app/` kennt `lib/db` nicht" — technisch
erzwungene Architektur, wie in PLAN.md verlangt) und die 110 Tests,
einschließlich der generischen Tenant-Isolations-Suite
(`tests/db/tenant-invariants.test.ts`) und der RLS-Tests.

### Was fehlt

Gegen `docs/PLAN.md` gehalten, fehlen drei ausdrücklich zugesagte Gates:

1. **KoSIT-Validator** (PLAN.md Zeile 66 und 139: „XRechnung/ZUGFeRD gegen
   KoSIT im CI", in der Bedarfslandkarte als „Golden-File-Gate für jede
   erzeugte Rechnung"). Existiert nicht. Das ist für M3 terminiert und in
   `entscheidungen.md` bewusst zurückgestellt („erst mit echten
   Rechnungs-Fixtures sinnvoll") — die Zurückstellung ist vertretbar, sie
   sollte nur nicht in Vergessenheit geraten.
2. **Playwright-E2E-Flows** (PLAN.md Zeile 140: „~6 Playwright-E2E-Flows").
   Existieren nicht: kein Test, kein CI-Job, keine Browser-Installation.
   Playwright liegt als Produktionsabhängigkeit im `package.json`, wird aber
   nirgends verwendet.
3. **Kein Build-Gate.** Die CI führt `npm run build` nicht aus. Das ist keine
   Formalie: der Produktionsbuild ist **heute kaputt** (Abschnitt 4), und
   genau deshalb ist es niemandem aufgefallen.

Darüber hinaus fehlen Gates, die der Plan nicht ausdrücklich fordert, die aber
für ein Mehrmandanten-SaaS mit Rechnungsdaten naheliegen: kein
Secret-Scanning, kein `npm audit`/Dependency-Review (bei 48
Produktionsabhängigkeiten und 1184 Paketen im Lockfile relevant), kein
CodeQL, keine Coverage-Schwelle (`@vitest/coverage-v8` ist installiert, wird
aber von keinem Skript aufgerufen), kein Build des Worker-Images.

Zwei handwerkliche Kleinigkeiten: Dem Workflow fehlen `concurrency` (jeder
Push auf einen Branch lässt ältere Läufe weiterlaufen) und `timeout-minutes`.

### Eine Versionsschieflage, die niemand bemerkt hat

Die CI testet gegen **Postgres 17**. Die lokalen Tests booten
`embedded-postgres@18.4.0-beta.17`, also **Postgres 18 Beta**. Lokal und in der
CI läuft die Testsuite damit gegen zwei verschiedene Hauptversionen, eine
davon Beta. Solange nur Standard-SQL im Spiel ist, fällt das nicht auf; sobald
eine Migration oder eine RLS-Policy versionsabhängiges Verhalten trifft,
divergieren lokale und CI-Ergebnisse, und man sucht an der falschen Stelle.
Dazu passt eine zweite Schieflage: die CI nutzt Node 22, das Worker-Image
`node:22-slim`, die Entwicklungsmaschine hier läuft auf **Node 24.20.0**,
während `@types/node` auf `^20` gepinnt ist. Drei Node-Versionen, drei
Verhaltensweisen.

---

## 4. Betriebsfähigkeit

### Der Produktionsbuild ist kaputt

Das ist der wichtigste Befund dieses Berichts. `npm run build` im aktuellen
Repo-Zustand bricht ab:

```
Error: Failed to collect configuration for /api/auth/[...all]
  [cause]: Error: POSTGRES_URL_AUTH/POSTGRES_URL ist nicht gesetzt
      at lib/db/auth-client.ts:33:19
      at lib/auth.ts:40:28
```

Ursache: `lib/auth.ts` ruft `getAuthDb()` **auf Modulebene** auf (Zeile 40,
innerhalb von `betterAuth({ database: drizzleAdapter(getAuthDb(), …) })`). Die
Lazy-Konstruktion in `lib/db/auth-client.ts` hilft hier nicht, weil der
Aufrufer selbst nicht lazy ist. Beim „Collecting page data" wertet Next das
Routenmodul aus, der Konstruktor läuft, `requireUrl()` wirft.

Zur Einordnung habe ich denselben Build mit einem beliebigen Dummy-Wert
wiederholt (`POSTGRES_URL=postgres://u:p@127.0.0.1:5432/dummy`) — dann läuft er
durch (drei Routen: `/`, `/_not-found`, `/api/auth/[...all]`). Der Fehler ist
also kein Codefehler im engeren Sinn, sondern eine **Build-Zeit-Abhängigkeit
von einer Laufzeit-Variablen**: Der Build braucht `POSTGRES_URL` gesetzt, obwohl
er die Datenbank nie anspricht. Auf Vercel funktioniert das, solange die
Variable auch im Build-Kontext (nicht nur zur Laufzeit) gesetzt ist; es ist ein
klassischer Stolperstein beim ersten Deploy, und niemand würde die
Fehlermeldung sofort richtig deuten.

Zwei Folgerungen: Erstens sollte `betterAuth` hinter einen Lazy-Getter
wandern, damit der Build keine DB-URL braucht. Zweitens gehört `npm run build`
in die CI — dieser Fehler existiert vermutlich seit M0 und ist bis heute
niemandem aufgefallen, weil das einzige Gate ihn nicht abdeckt.

Nebenbefund aus demselben Lauf: better-auth protokolliert
`BetterAuthError: You are using the default secret. Please set
BETTER_AUTH_SECRET`. Der Build läuft trotzdem durch. Ein Deploy mit
Default-Secret wäre eine ernste Sicherheitslücke (Session-Tokens ließen sich
fälschen), und nichts im Repo verhindert ihn.

### Läuft die App lokal?

Teilweise, und deutlich weniger, als der Zustand des Repos suggeriert.

`npm run dev` startet und liefert eine Seite — aber `app/page.tsx` und
`app/layout.tsx` sind **der unveränderte `create-next-app`-Scaffold**,
inklusive Next.js-Logo, „To get started, edit the page.tsx file" und
`<title>Create Next App</title>`. Es gibt genau drei Routen, davon zwei
generische. Es existiert **keine einzige Produkt-Oberfläche**: kein Login-UI,
kein Dashboard, keine Liste, kein Formular. Wer „läuft die App?" fragt und
eine grüne Startseite sieht, sieht das Next.js-Beispiel.

Die Fachlogik dahinter ist real vorhanden — `lib/` (Auth, Tenant-Kontext,
Permissions, State-Machine, Storage, Events, Audit) und ein Modul
`modules/sites/` mit `index.ts` und `service.ts`. Sie ist nur an keine
Oberfläche angeschlossen und über keine Route erreichbar. `/api/auth/[...all]`
ist die einzige echte Route, und die wirft ohne Datenbank beim ersten Zugriff.

### Was zum Betrieb fehlt

`.env.local` existiert und enthält 18 Schlüssel — aber **nur zwei davon haben
einen Wert**: `BETTER_AUTH_URL` und `S3_REGION`. Alles andere ist leer,
einschließlich `POSTGRES_URL`, `BETTER_AUTH_SECRET`, `RESEND_API_KEY`, sämtlicher
S3-Zugangsdaten, `SENTRY_DSN`, `HEALTHCHECKS_PING_URL`, `ANTHROPIC_API_KEY` und
`HCLOUD_TOKEN` (der Hetzner-Token wurde nach der Bestellung offenbar wieder
entfernt — das ist gute Hygiene, es bedeutet nur, dass ein erneuter Lauf des
Provisionierungsskripts eine neue Token-Übergabe braucht).

Auf dieser Maschine gibt es kein lokales Postgres und kein `psql`. Die
Testsuite braucht beides nicht, weil `tests/setup/embedded-postgres.ts` eine
eigene Instanz auf einem freien Port hochfährt und nach dem Lauf wieder
entfernt. Für den *Betrieb* der App ist das aber nicht nutzbar: Der Dev-Server
hat keine Datenbank.

Damit lautet die ehrliche Antwort auf „ist `npm run dev` realistisch
startbar": Der Prozess startet und zeigt den Scaffold. Sobald irgendetwas
Fachliches passieren soll, fehlt eine erreichbare Postgres-Instanz mit
angewendeten Migrationen — und die gibt es lokal nicht. Vor M1 braucht das
Projekt eine dokumentierte lokale Entwicklungsdatenbank (Docker-Compose mit
Postgres plus `npm run db:migrate` oder eine Neon-Branch-URL) und eine gefüllte
`.env.local`. Das ist kein großer Aufwand, aber es ist heute nicht vorhanden
und in keinem Runbook beschrieben.

Die Testinfrastruktur selbst ist im Übrigen bemerkenswert gut abgesichert:
`tests/setup/global-setup.ts` verweigert den Start, wenn der Datenbankname
nicht „test" enthält oder wenn `POSTGRES_URL_TEST` auf dasselbe Ziel wie
`POSTGRES_URL` zeigt, und setzt `POSTGRES_URL_MIGRATE` explizit mit, damit eine
von außen gesetzte Variable die Testmigration nicht auf eine Produktions-DB
umlenken kann. Das ist die Art von Schranke, die man normalerweise erst nach
einem Unfall einbaut.

---

## 5. Abhängigkeiten: was benutzt wird und was auf Vorrat liegt

`package.json` listet **48 Produktionsabhängigkeiten** und 18
Entwicklungsabhängigkeiten. Das Lockfile umfasst 1184 Pakete, `node_modules`
belegt 1,2 GB.

Von den 48 Produktionsabhängigkeiten werden **13 tatsächlich importiert**:

`next`, `react`, `react-dom`, `pg`, `pg-boss`, `drizzle-orm`, `better-auth`,
`@better-auth/drizzle-adapter`, `@aws-sdk/client-s3`,
`@aws-sdk/s3-request-presigner`, `resend`, `@sentry/nextjs`, `@sentry/node`.

**35 werden nirgends importiert.** Vollständig:

| Bündel | Pakete | Vorgesehen für |
|---|---|---|
| FullCalendar | `@fullcalendar/core`, `-daygrid`, `-interaction`, `-list`, `-react`, `-timegrid` | M1 Termine, M5 Plantafel |
| Tiptap | `@tiptap/react`, `-starter-kit`, `-pm`, `-extension-mention`, `-suggestion` | M1 Notizen mit @-Mentions |
| Uppy | `@uppy/core`, `-react`, `-dashboard`, `-status-bar`, `-aws-s3` | M1 Datei-Upload |
| Pragmatic DnD | `@atlaskit/pragmatic-drag-and-drop` und drei Begleitpakete | M1 Kanban |
| TanStack | `@tanstack/react-table`, `@tanstack/react-virtual` | M1 Listen |
| Karten | `maplibre-gl`, `@vis.gl/react-maplibre` | M1 Pin-Bestätigung |
| Formulare | `react-hook-form`, `@hookform/resolvers`, `zod`, `drizzle-zod` | M1–M3 durchgehend |
| Dokumente | `react-pdf`, `signature_pad`, `node-zugferd`, `playwright` | M2/M3 |
| Sonstige | `recharts`, `papaparse`, `@anthropic-ai/sdk` | M1/M4, CSV-Import, KI |

Dazu `@types/papaparse` auf der Dev-Seite.

Das ist **keine schleichende Verwahrlosung, sondern eine dokumentierte
Entscheidung**. `docs/tooling/bedarfslandkarte.md` leitet jede dieser Wahlen
aus dem Modulkatalog ab, `docs/tooling/entscheidungen.md` begründet sie in 19
Abschnitten mit Alternativen und Ausschlussgründen. Der Nutzen ist real: die
Wahl ist getroffen, die Version ist gepinnt, die Kompatibilität ist einmal
gegen den Rest des Baums geprüft, und M1 kann ohne Evaluierungspause anfangen.
Bemerkenswerterweise wurde bewusst **nicht** alles installiert (Konva, hplib,
Tesseract, Ghostscript, Mustang, KoSIT sind mit Begründung ausgelassen) — die
Vorratshaltung ist also gezielt, nicht wahllos.

Trotzdem gehört die Last benannt, denn sie ist nicht null:

- **Sicherheitslast.** 35 ungenutzte Pakete plus deren Transitive stehen im
  Lockfile und werden bei jedem `npm ci` installiert — auch im Worker-Image,
  wo weder Tiptap noch FullCalendar je gebraucht werden. Jede Schwachstelle
  darin erscheint in Audits und muss bewertet werden, obwohl kein Code sie
  erreicht. Es gibt derzeit kein Audit-Gate, das das überhaupt sichtbar machen
  würde.
- **Wartungslast.** Bis M1 die Pakete anfasst, altern sie. Mehrere sind an
  riskanten Versionsständen gepinnt: `node-zugferd@0.1.1-beta.1` (Beta, laut
  `STATUS.md` mit Bus-Faktor 1), `@tanstack/react-table@9` (v8-Tutorials sind
  inkompatibel), `@fullcalendar/react@7` neben Core-Paketen auf `6.1.21` — eine
  Mischung, die beim ersten echten Einsatz Aufmerksamkeit kosten wird.
  `embedded-postgres@18.4.0-beta.17` ist ebenfalls Beta.
- **Falsche Einordnung.** `playwright` steht unter `dependencies` statt
  `devDependencies`, obwohl es ein Werkzeug ist. Konsequenz: das Worker-Image
  installiert es trotz `--omit=dev` mit — ohne Browser-Binaries, also nutzlos,
  aber nicht kostenlos.
- **Ein Signal, das leicht übersehen wird:** `zod` ist installiert und wird von
  keiner Zeile importiert. In einem Projekt, dessen Architektur Validierung an
  jeder Modulgrenze vorsieht, heißt das schlicht, dass es noch keine
  Eingabevalidierung gibt — was zum Befund aus Abschnitt 4 passt, dass es noch
  keine Eingaben gibt.

Empfehlung: die Vorratshaltung beibehalten, aber (a) `playwright` zu den
devDependencies verschieben, (b) `npm audit --audit-level=high` als
CI-Schritt aufnehmen, damit die Last wenigstens sichtbar ist, und (c) beim
Start jedes Moduls die dort fälligen Pakete auf den dann aktuellen Stand
heben, statt sie blind zu übernehmen.

---

## 6. `research/`

Das Verzeichnis enthält **eine einzige Datei**: `research/ga4_report_example.py`
(8 KB), ein Beispiel für die Google-Analytics-4-Data-API mit
Service-Account-Authentifizierung. Es liest `GA4_PROPERTY_ID` und `GA4_SA_KEY`
aus der Umgebung und gibt einen CRO-Report (Sessions, Engagement-Rate,
Bounce-Rate, Key-Events nach Kanal/Landingpage/Gerät) auf der Konsole aus.

Die Einordnung ist eindeutig: **Das hat mit diesem Projekt nichts zu tun.**
`energie-saas` ist ein B2B-Werkzeug für Installateure; GA4-Webanalytik kommt
weder im Modulkatalog noch in der Bedarfslandkarte, der Integrationskarte oder
der Einkaufsliste vor. Es gibt keinen Python-Code im Projekt außer dem
Hetzner-Skript, keine `requirements.txt`, keine Python-Toolchain. Die Datei ist
offensichtlich Beifang aus einer anderen Sitzung, die im selben Ordner
gearbeitet hat.

Empfehlung: **nicht ins Repo aufnehmen.** Die Datei gehört an den Ort, an dem
die zugehörige Arbeit stattfindet (Vault oder das jeweilige Projekt).
Anschließend `research/` löschen. Falls das Verzeichnis als Arbeitsablage
bestehen bleiben soll, gehört ein `research/`-Eintrag in `.gitignore` —
aber dann sollte niemand erwarten, dass dort etwas dauerhaft überlebt. Das
Gleiche gilt sinngemäß für `scripts/lagebericht.sh` (Abschnitt 1).

---

## 7. Env-Lage

`.env.example` listet 19 Schlüssel. Ein Abgleich gegen alle
`process.env`-Zugriffe im Code und in den Shell-Skripten zeigt Lücken in beide
Richtungen.

### Im Code benutzt, aber in `.env.example` nicht dokumentiert

| Variable | Verwendungsstelle | Bedeutung |
|---|---|---|
| `POSTGRES_URL_AUTH` | `lib/db/auth-client.ts:32` | vorbereitete Naht für die eigene Auth-Rolle nach ADR 0003 |
| `POSTGRES_URL_WORKER` | `worker/index.ts:27` | dasselbe für die Worker-Rolle; wird zusätzlich von `compose.yaml` nicht durchgereicht |
| `POSTGRES_URL_MIGRATE` | `scripts/migrate.mts` | eigenes Migrationsziel |
| `POSTGRES_URL_TEST_SUPERUSER` | `tests/setup/*` | Superuser-Verbindung für Tests |
| `RESEND_FROM` | `lib/mail.ts:50` | Absenderadresse |

Besonders `RESEND_FROM` ist heikel: Fehlt die Variable, fällt `lib/mail.ts`
auf `login@transactional.example.invalid` zurück. Der Kommentar erklärt, das
sei Absicht, damit ein vergessener Go-Live-Schritt auffällt — das stimmt, aber
er fällt erst beim ersten echten Login-Versuch eines Kunden auf, und die
Variable steht in keiner Vorlage und in keiner Einkaufsliste. Da M1 mit
Magic-Link-Login arbeitet, ist das ein direkter Startblocker in dem Moment, in
dem der erste Nutzer sich anmelden soll.

Die drei `POSTGRES_URL_*`-Varianten sind die vorbereiteten, aber nicht
gezogenen Nähte der Rollentrennung aus ADR 0003. Sie sind bewusst als
M0-Limitation dokumentiert. Solange sie nicht gesetzt sind, laufen App, Auth
und Worker alle auf **derselben Datenbankrolle** — die Rollentrennung existiert
im Code, aber nicht in der Realität. Für M1 ist das noch tolerierbar; vor dem
Pilot-Gate ist es das nicht.

### In `.env.example` dokumentiert, aber von keiner Codezeile gelesen

`ANTHROPIC_API_KEY`, `GEOAPIFY_API_KEY`, `NEXT_PUBLIC_STADIA_MAPS_API_KEY`,
`S3_BUCKET` (der Bucket wird als Konstruktorargument durchgereicht, nicht aus
der Umgebung gelesen). `HCLOUD_TOKEN`, `S3_BUCKET_BACKUP` und `AGE_PUBLIC_KEY`
werden korrekt außerhalb von TypeScript benutzt (Python-Skript bzw.
`backup.sh`). Das ist unschädlich, spiegelt aber denselben Befund wie
Abschnitt 5: Die Vorbereitung ist da, die Nutzung nicht.

### Welche Geheimnisse für M1 fehlen

Für einen echten M1-Betrieb (Kunden anlegen, Standorte, Login, Dateien) sind
konkret erforderlich und heute leer:

1. `POSTGRES_URL` — eine echte Datenbank. Ohne sie gibt es nicht einmal einen
   Produktionsbuild.
2. `BETTER_AUTH_SECRET` — sonst läuft better-auth mit Default-Secret; das ist
   sicherheitskritisch und wird derzeit von nichts verhindert.
3. `RESEND_API_KEY` **und** `RESEND_FROM` samt verifizierter Absenderdomäne
   (DKIM/SPF). Ohne beides funktioniert der Magic-Link-Login nicht.
4. `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` für
   Dateien. Achtung: Object Lock lässt sich laut ADR 0002 **nur bei der
   Bucket-Anlage** aktivieren — hier ist die Reihenfolge unumkehrbar.
5. `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` und `HEALTHCHECKS_PING_URL`, wenn
   der Worker produktiv laufen soll. Beide Gerüste sind fertig und liegen
   hinter Env-Flags — sie sind kostenlos zu aktivieren, sobald die Werte da
   sind.

Nicht für M1 nötig, aber in der Vorlage: `ANTHROPIC_API_KEY` (ab M4),
`GEOAPIFY_API_KEY` und `NEXT_PUBLIC_STADIA_MAPS_API_KEY` (M1-Karte, erst wenn
die Karte gebaut wird), `AGE_PUBLIC_KEY` und `S3_BUCKET_BACKUP` (Backup-Cron).

Positiv: `.gitignore` behandelt `.env*` mit Ausnahme von `.env.example`
korrekt, `.env.local` ist damit sicher. Ein kleiner Schönheitsfehler:
`.dockerignore` schließt nur `.env` und `.env.local` namentlich aus, nicht
`.env*` — eine lokale `.env.production` landete im Image.

---

## 8. Empfehlung

**Ja, `tooling` soll gemerged werden — aber nicht in diesem Zustand des
Arbeitsverzeichnisses, und der Merge löst keines der Betriebsprobleme.**

Der Branch selbst ist gut: die Entscheidungen sind dokumentiert und begründet,
die Codeanteile (Health-Probe, Heartbeat, Backup-Skript, Sentry hinter
Env-Flags) sind sorgfältig gebaut und durch einen Codex-Review gegangen, dessen
sechs Befunde nachweislich umgesetzt wurden. Die CI ist auf dem Branch grün
gelaufen. Ihn offen liegen zu lassen, während M1 beginnt, erzeugt nur
Konfliktpotenzial in `package.json` und `package-lock.json`.

### Vor dem Merge (Pflicht, Reihenfolge einhalten)

1. **Arbeitsverzeichnis auflösen.** Lokale Fassung von
   `docs/tooling/einkaufsliste.md` verwerfen (sie würde den Kaufstatus des
   Servers zurückdrehen), dann `git pull --ff-only`, dann `.env.example` und
   `scripts/hetzner-provision.py` als eigenen Commit sichern.
2. **`research/` und `scripts/lagebericht.sh` entscheiden.** Beides gehört
   nach heutigem Stand nicht ins Repo. `research/ga4_report_example.py` ist
   Fremdmaterial; `lagebericht.sh` enthält eine hart eincodierte private
   E-Mail-Adresse. Löschen oder ignorieren, nicht mitcommitten.
3. **`docs/tooling/STATUS.md` korrigieren.** Die Commit-Tabelle nennt sechs
   Hashes, die nach dem Rebase nicht mehr existieren.

### Vor M1 (dringend, unabhängig vom Merge)

4. **Produktionsbuild reparieren.** `betterAuth` in `lib/auth.ts` hinter einen
   Lazy-Getter legen, damit `npm run build` ohne `POSTGRES_URL` durchläuft.
   Danach **`npm run build` als CI-Schritt aufnehmen** — dieser Fehler existiert
   seit M0 und ist nur deshalb unbemerkt geblieben.
5. **Lokale Entwicklungsumgebung herstellen und dokumentieren.** Eine
   Postgres-Instanz für `npm run dev` (Docker-Compose oder Neon-Branch),
   `.env.local` mit `POSTGRES_URL`, `BETTER_AUTH_SECRET`, `RESEND_API_KEY` und
   `RESEND_FROM` füllen, Ablauf in `CONTRIBUTING.md` oder ein Runbook schreiben.
   Ohne das kann an M1 niemand arbeiten und niemand etwas ausprobieren.
6. **`.env.example` vervollständigen** um `POSTGRES_URL_AUTH`,
   `POSTGRES_URL_WORKER`, `POSTGRES_URL_MIGRATE`, `POSTGRES_URL_TEST_SUPERUSER`
   und `RESEND_FROM`.
7. **`POSTGRES_URL_WORKER` in `worker/compose.yaml` durchreichen** und dort
   festlegen, aus welcher Datei Compose seine Variablen zieht.

### Bald danach

8. **Worker-Deploy einmal echt durchführen.** Der Host läuft und kostet Geld,
   `docker compose up --build` wurde noch nie ausgeführt. Auf dieser Maschine
   ist inzwischen Docker vorhanden — der Build lässt sich vorab lokal testen.
   Dabei `tsx` im Dockerfile pinnen und einen `USER` setzen.
9. **Die Host-Grundinstallation in Code fassen** (cloud-init oder ein
   Setup-Skript). Der Server ist derzeit nicht reproduzierbar.
10. **Postgres-Version angleichen** — CI auf 17, lokale Tests auf 18 Beta. Eine
    Version wählen, vorzugsweise die des Produktionsziels.
11. **`npm audit` als CI-Schritt** und `playwright` in die devDependencies. Die
    Vorratshaltung ist in Ordnung, sie soll nur sichtbar bleiben.

### Was nicht dringend ist

KoSIT-Validator und Playwright-E2E-Flows sind vom Plan zugesagt, aber
sinnvollerweise an M3 bzw. an die erste echte Oberfläche gekoppelt. Sie jetzt
zu bauen, hieße gegen nicht existierende Artefakte zu testen. Sie gehören auf
die Liste der M1-Abschlusskriterien, nicht auf die der Vorbedingungen.
