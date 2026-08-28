# Ist-Bericht energie-saas — konsolidiert

Stand: 2026-08-28 · Branch `tooling` · Zusammenfassung von vier unabhängigen Prüfberichten
(`01-m0-gegen-modulkatalog.md`, `02-mandanten-und-sicherheit.md`,
`03-tooling-branch-und-betrieb.md`, `04-m1-bereitschaft.md`).
Alle hier genannten Befunde stammen aus Code-Belegen, nicht aus Plandokumenten.

---

## 1. Urteil

**Das Fundament steht — die Anwendung darüber existiert nicht, und der Produktionsbuild ist
kaputt, ohne dass irgendein Gate es merkt.**

Ausführlicher, weil ein Satz hier täuscht: Der sicherheitskritische Kern (Mandantentrennung,
Ereignis- und Audit-Historie, Rechteprüfung, Modulgrenzen) ist belastbar gebaut und durch
Tests abgesichert, die nachweislich scharf sind — teils über Plan-Niveau. Darüber liegt
nichts: keine Oberfläche, keine Aufrufgrenze, kein produktiver Aufrufer der eigenen
Sicherheitsfunktionen. Das ist planmäßig so, macht die Restarbeit vor M1 aber größer als die
Meilenstein-Abnahme suggeriert.

---

## 2. Was steht (verifiziert)

**Testlage** — vier Gates grün, in allen vier Prüfungen unabhängig bestätigt:

| Gate | Ergebnis |
|---|---|
| `npm run typecheck` | grün |
| `npm run lint` | grün |
| `npm run depcruise` | grün — 43 Module, 58 Dependencies, 0 Grenzverletzungen |
| `npm test` | grün — 15 Dateien, 110 Tests, gegen echtes Postgres mit angewendeten Migrationen |

**Kein Fail-Open in der Mandantentrennung gefunden.** Das ist die zentrale Aussage des
Sicherheitsberichts, und sie ist belegt:

- Alle fünf Mandantentabellen (`workspace`, `membership`, `site`, `domain_events`,
  `audit_log`) tragen RLS mit `ENABLE` **und** `FORCE`, jeweils genau eine permissive Policy
  `tenant_isolation` `FOR ALL` mit identischem Prädikat in `using` und `with check`
  (`drizzle/0001`, `0002`, `0004`, `0008`, `0013`). Keine Tabelle ohne Policy, keine mit
  `ENABLE` ohne `FORCE` — letzteres entscheidend, weil die App-Rolle Eigentümerin ist.
- Der Mandantenkontext wird transaktionslokal gesetzt (`set_config(..., true)`,
  `lib/db/tenant.ts:13-18`) — die richtige Wahl bei Pooling. `getPool()` ist bewusst nicht
  exportiert, depcruise verbietet `app/` jeden `lib/db`-Zugriff.
- `withAuthorizedTenant` (`lib/db/tenant.ts:110`) liest Rolle, Capabilities und Feature-Flags
  **in derselben Transaktion aus der DB**, nachdem `app.workspace_id` gesetzt wurde — der
  Membership-Lookup unterliegt selbst der RLS. Der Aufrufer kann seinen Berechtigungskontext
  nicht behaupten. Das ist eine Klasse besser als geplant.
- `can()` (`lib/permissions.ts:76-84`) ist an keiner Stelle fail-open: unbekannte Action,
  unbekannte Rolle und Nicht-`true`-jsonb-Werte enden alle bei `false`. Dazu eine
  handgeschriebene, von der Implementierung unabhängige Rechtematrix als Test.
- `domain_events` und `audit_log` sind append-only per Row-Trigger **und** Statement-Trigger
  gegen `TRUNCATE` (`drizzle/0004`, `0005`) — der TRUNCATE-Fall wird fast immer übersehen,
  hier nicht. `emitEvent(tx, …)` erzwingt die gemeinsame Transaktion über die Signatur;
  die Rollback-Garantie ist getestet (`tests/db/events.test.ts:55`).
- Die Tenant-Invarianten-Suite ist **echt generisch und gegen Vakuum-Grün gehärtet**: Tabellen
  aus `pg_class` statt Handliste, exakter Prädikatvergleich statt Substring, RLS-spezifische
  Fehlerprüfung beim Cross-Write, frischer Pool für den Nullkontext-Test, Wächter gegen
  versteckte Tenant-Tabellen, Matview-Verbot. Das ist der Mechanismus, der M1–M8 tragen soll.
- **Schema-Drift-Gate in CI**: `npm run db:generate` + `git diff --exit-code` auf `drizzle/`
  und `lib/db/schema/`. Schließt die Lücke, durch die eine neue Tabelle ohne Migration für
  alle Tenant-Invarianten unsichtbar grün durchgemergt wäre. Dazu bootstrappt die CI eine
  `nosuperuser`/`nobypassrls`-Rolle `app_ci`.
- **Auth-Härtung über Branchenniveau**: Magic-Link-Token gehasht, OTP verschlüsselt (mit
  korrekter Begründung über ~20 Bit Entropie), Rate-Limit in der DB statt in-memory pro
  Serverless-Instanz, kein Credential-Logging in Produktion (`lib/mail.ts` wirft dort hart).
- **ADR 0003 ist ausgeführt, nicht behauptet**: `scripts/adr-0003-probe.mts` spielt die
  Rollentrennungs-Skizze real gegen eine Postgres-18-Instanz durch, 24/24 Nachweise grün —
  und hat dabei einen echten Portabilitätsfehler in `drizzle/0015` aufgedeckt.
- **Keine Secrets im Repository.** `.gitignore` deckt `.env*` korrekt ab, nur `.env.example`
  ist versioniert.
- `worker/health.ts` und `tests/setup/global-setup.ts` sind auf Betriebsniveau: echte
  Readiness-Probe mit Pool-Timeouts statt `Promise.race`, Dead-Man-Heartbeat mit rekursiver
  Planung; die Test-DB verweigert den Start, wenn der DB-Name nicht „test" enthält.

---

## 3. Was fehlt oder Schuld ist

### Blocker

**B-1 · `npm run build` schlägt fehl — `lib/auth.ts:40`**
`betterAuth({ database: drizzleAdapter(getAuthDb(), …) })` ruft `getAuthDb()` auf Modulebene
auf; die Lazy-Konstruktion in `lib/db/auth-client.ts:33` läuft dadurch ins Leere. Beim
„Collecting page data" wirft `requireUrl()`:
`Failed to collect configuration for /api/auth/[...all] — POSTGRES_URL_AUTH/POSTGRES_URL ist
nicht gesetzt`. Gegenprobe mit Dummy-URL: Build läuft durch. Der Build braucht also eine
DB-URL, die er nie benutzt.
*Konsequenz:* Der erste Vercel-Deploy scheitert mit einer Fehlermeldung, die niemand richtig
deutet. Fix: `betterAuth` hinter einen Lazy-Getter.

**B-2 · CI hat kein Build-Gate — `.github/workflows/ci.yml`**
Der Job führt `npm run check` (lint, typecheck, depcruise, test) aus, aber niemals
`npm run build` (verifiziert: `package.json:13` enthält `build` nicht in `check`).
*Konsequenz:* B-1 existiert seit M0 und ist durch die gesamte Tooling-Mission gelaufen,
während alle Gates grün meldeten. Das ist der eigentliche Befund — nicht der Bug, sondern
dass nichts ihn fangen konnte.

**B-3 · `BETTER_AUTH_SECRET` ist leer — better-auth läuft mit Default-Secret**
Aus dem echten Build-Lauf: `BetterAuthError: You are using the default secret`. Der Build
läuft trotzdem durch, nichts im Repo verhindert einen Deploy in diesem Zustand.
*Konsequenz:* Mit bekanntem Default-Secret lassen sich Session-Tokens fälschen. Deploy-Sperre,
bis der Wert gesetzt ist.

**B-4 · Die M1-Roadmap widerspricht der eigenen Testsuite**
`docs/blaupause/05-roadmap.md` fordert für M1 „erste KPI-Kacheln (materialisierte Views)".
`tests/setup/tenant-fixtures.ts:104` — `MATVIEW_ALLOWLIST` ist leer (verifiziert) — macht jede
Matview in `public` zum Suite-Fehler, weil Matviews Cross-Tenant-Ergebnisse physisch speichern
und die RLS ihrer Basistabellen nicht erben (Codex-Review #5 aus M0).
*Konsequenz:* Wer das baut, macht `npm test` rot und umgeht die Mandantengrenze. Auflösung
ist billig: gewöhnliche Aggregat-Queries unter RLS, Roadmaptext korrigieren.

### Hoch

**H-1 · Die Autorisierungsgrenze existiert nicht** — `app/` (nur `app/api/auth/[...all]/route.ts` real), `lib/audit.ts:4-32`, `tests/db/site.test.ts:107-141`
Grep-Gegenprobe: `withTenant(` und `withAuthorizedTenant(` kommen im Produktivcode
ausschließlich in ihrer eigenen Definition vor. Es gibt keine `middleware.ts`, keinen Aufruf
von `auth.api.getSession`/`cookies()`/`headers()` im ganzen Repo, keine Abbildung
Session → `user_identity.id`, keinen Server-Action-Wrapper. Das Denial-Audit-Boundary-Muster
ist über Dutzende Kommentarzeilen als „Controller-Ruling" beschrieben und in
`tests/db/site.test.ts:107` vollständig implementiert — **im Test**.
*Konsequenz:* Die Zusage aus Architektur §4 (erlaubte *und* abgelehnte Zugriffe im Audit) ist
zur Hälfte eingelöst: der Erfolgspfad schreibt atomar und getestet, der Ablehnungspfad hat
produktiv niemanden, der ihn schreibt. Planmäßig so — aber der Wrapper ist damit zwingend der
erste M1-Baustein und muss beim ersten Mal richtig sein, weil sich jedes M1-Modul anhängt.

**H-2 · Tenant-sichere Schlüsselregeln sind Dokumentation statt Test-Invariante** — `modules/README.md:16-31` gegen `tests/db/tenant-invariants.test.ts`
Drei Regeln gelten laut Doku als bindend: `UNIQUE (workspace_id, id)`, zusammengesetzte statt
einspaltige FKs auf Tenant-Entitäten, FK `workspace_id → workspace.id`. Anlass ist ein echter
Befund (Codex-Review #7): PostgreSQL prüft FKs ohne RLS als Sichtbarkeitsfilter, ein
einspaltiger `site_id`-FK aus Workspace A kann auf eine Site aus B zeigen. Die Regeln wurden
nur auf `site` angewendet; die generische Suite prüft weder Unique-Constraints noch
Fremdschlüssel noch deren Spaltenzahl. **Der Vertrag ist bereits gebrochen:** `membership`,
`domain_events` und `audit_log` haben kein `UNIQUE (workspace_id, id)`; `domain_events` und
`audit_log` zusätzlich keinen FK auf `workspace` (`lib/db/schema/events.ts:12`, `:28`).
*Konsequenz:* Alles andere in diesem Projekt wird von CI erzwungen — ausgerechnet die aus
einem gefundenen Sicherheitsdefekt entstandene Regel hängt an Aufmerksamkeit, unmittelbar vor
M1 mit rund 20 neuen, querverwiesenen Tenant-Tabellen. Aufwand zum Schließen: gering
(`pg_constraint`/`pg_index` abfragen, analog zur bestehenden Policy-Prüfung).

**H-3 · Rechteschichten 2 und 3 ohne strukturellen Rückhalt — Selbstbeförderung möglich** — `drizzle/0001_rls_core.sql:17-21`
Die `tenant_isolation`-Policy auf `membership` gilt `FOR ALL` und filtert nur den Mandanten,
nicht die Rolle. Ein `viewer` kann darunter `update membership set role = 'admin' where
user_id = <selbst>` in der eigenen Mandantentransaktion ausführen. Weder restriktive Policy
noch Trigger noch Test verhindern das; nur Servicecode, der `can()` aufruft — und `can()` ist
optional aufrufbar.
*Konsequenz:* Heute nicht ausnutzbar (kein Request-Pfad), ab dem ersten M1-Endpunkt für
Mitgliedschaften akut. Der Schutz gehört in die Datenbank, nicht nur in den Service.

**H-4 · Objektspeicher ohne jede Mandantenbindung** — `lib/storage/s3.ts:76`, `:129`, `:137`
`getSignedReadUrl(key)` signiert **jeden** übergebenen Schlüssel ohne Prüfung. `put()` und
`getSignedUploadUrl()` validieren mutable Schlüssel gar nicht — kein SAFE-Regex, keine
Präfixprüfung außer der `immutable/`-Ablehnung, `../` wird durchgereicht. `ttlSeconds` hat
keine Obergrenze, Upload-URLs keine Größenbeschränkung, Credentials werden mit `!` gelesen.
Der Kommentar in Zeile 33-39 benennt die Lücke offen und vertagt sie auf M2.
*Konsequenz:* Heute kein Leck (`S3Storage` wird nirgends instanziiert, `S3_BUCKET` von keiner
Codezeile gelesen). Ab dem ersten Upload-Feature der wahrscheinlichste Ort für ein
Cross-Tenant-Leck im ganzen System, weil die Grenze dort allein von Anwendungslogik gezogen
wird. Die WORM-Seite ist dagegen sauber gelöst (SHA-256, `IfNoneMatch: "*"` gegen TOCTOU).

**H-5 · Es gibt keine Oberfläche und kein Design-System** — `app/page.tsx`, `app/layout.tsx:16,23`
`app/` ist unveränderter `create-next-app`-Scaffold: Next-Logo, „To get started, edit the
page.tsx file", `title: "Create Next App"` (Zeile 16), `lang="en"` (Zeile 23) bei einem
deutschsprachigen Produkt. Genau drei Routen, davon zwei generische. shadcn/ui ist in PLAN und
Design-Mission gesetzt, aber nicht installiert — weder Radix noch `class-variance-authority`,
`tailwind-merge` oder `lucide-react`; kein `components/`, kein `docs/design/`. Die
Design-Mission (`docs/prompts/02-design-mission.md`, Branch `design`) ist geschrieben, nie
gelaufen.
*Konsequenz:* M1 verlangt sechs eigenständige Interaktionsflächen (Kanban mit Drag&Drop,
virtualisierte Tabellen, Rich-Text, Kalender, Karte mit Pin, Import-Assistent). Wer M1 nach
Datenmodell schätzt, unterschätzt es um mindestens die Hälfte.

**H-6 · Keine lokale Entwicklungsdatenbank — an M1 kann heute niemand arbeiten** — `.env.local`
19 Schlüssel, davon **zwei mit Wert** (verifiziert: `BETTER_AUTH_URL`, `S3_REGION`).
`POSTGRES_URL` ist leer, auf der Maschine gibt es weder Postgres noch `psql`. Die Testsuite
umgeht das über `embedded-postgres`; für den Dev-Server hilft das nicht. Kein Runbook, keine
docker-compose für eine Dev-DB, kein dokumentierter Setup-Pfad in `CONTRIBUTING.md`.
*Konsequenz:* `npm run dev` startet und zeigt das Next.js-Beispiel. Sobald etwas Fachliches
passieren soll, fehlt die Datenbank.

**H-7 · Der Worker-Host kostet Geld und trägt keinen Container** — `worker/compose.yaml`, `docs/runbooks/worker.md`
CX33 `energie-saas-worker`, ID 163858990, nbg1, IPv4 2.28.70.140, Firewall nur 22/tcp,
Docker 29.1.3 + Compose 2.40.3 installiert. `docker compose up --build` wurde **nie**
ausgeführt („Docker/Compose konnte auf dieser Maschine nicht ausgeführt werden"), der
Deploy-Pfad ist ungetestet. Auf dem Entwicklungsrechner ist inzwischen Docker vorhanden — der
Build wäre vorab testbar.
*Konsequenz:* Laufende Kosten für null Nutzen, und ein Deploy-Pfad, der beim ersten echten
Bedarf (M2, PDF) zum ersten Mal ausprobiert wird. Zusätzlich reicht `compose.yaml:7`
`POSTGRES_URL_WORKER` nicht durch — die im Code vorbereitete Rollentrennung ist im Deployment
gar nicht erreichbar.

**H-8 · Uncommittete `docs/tooling/einkaufsliste.md` würde Dokumentation zurückdrehen**
Der lokale Branch `tooling` hängt einen Commit hinter `origin/tooling` (`4cf2d3c`, „Hetzner-Server
gekauft und grundinstalliert"). Die uncommittete lokale Fassung stammt aus der Zeit **vor** dem
Kauf und schreibt „CAX21, P1 sofort, 16 €/Monat". Ein Commit dieses Stands löscht Server-ID, IP
und Erledigt-Status und stellt einen falschen Kostenrahmen wieder her. `git pull --ff-only`
bricht deshalb aktuell ab. Die beiden anderen uncommitteten Dateien (`.env.example` mit
`HCLOUD_TOKEN`, Token-Härtung in `scripts/hetzner-provision.py`) sind dagegen erwünscht.

**H-9 · Der Moat läuft nicht — Förder-Regelwerk und VNB-Verzeichnis existieren nicht**
Volltextsuche über `*.ts`, `*.sql`, `*.mts`, `*.cjs` nach `förder`, `foerder`, `vnb`,
`zeitscheibe`, `valid_from`, `effective_from`: **null Treffer**. Die Plandokumente
widersprechen sich hier selbst — `docs/PLAN.md` führt die Zeitscheiben-Tabellen unter den
nicht nachrüstbaren Tag-1-Investitionen, die M0-Abnahmekriterien schließen sie ausdrücklich
aus. Formal ist M0 sauber abgenommen.
*Konsequenz:* Der Plan nennt Datenpflege an mehreren Stellen den eigentlichen
Wettbewerbsvorteil und veranschlagt die gesamte Projektlaufzeit dafür — davon sind null
Wochen verstrichen. Kein Code-Blocker für M1, aber der Posten mit der längsten Vorlaufzeit im
ganzen Vorhaben, und er blockiert M4-light und damit das Pilot-Gate.

**H-10 · `project` fehlt als Position in der M1-Roadmap, obwohl fünf F-Nummern daran hängen**
Der M1-Text listet F16.1, F1.1–F1.6, F1.8, F1.9 — aber nicht den „Ein-Projekt-Spine"
(Request → Offer → Installation) aus der Kernarchitektur. F1.2, F1.5, F1.6, F1.9 und der
Activity Feed setzen ihn alle voraus. Die Action `phase.convert` steht bereits in
`lib/permissions.ts` `ACTION_REQUIREMENTS`, hat aber kein Objekt, auf das sie wirken könnte.
*Konsequenz:* `project` ist der Flaschenhals der gesamten M1-Abhängigkeitskette und gehört als
erste Entität nach `contact` gebaut — und als eigene Position in die Roadmap.

**H-11 · Schema-Evolution der Zod-typisierten JSONB-Daten ist ungelöst** — `lib/validation/` fehlt
`zod@4` und `drizzle-zod` sind installiert, `zod` wird von **keiner Zeile** importiert. Es gibt
keine Registry, kein Versionierungsmuster. Drizzle migriert Spalten, nicht JSONB-Inhalte.
*Konsequenz:* Sobald der erste Kunde 300 Wechselrichter erfasst hat, ist jede Feldumbenennung,
jedes neue Pflichtfeld und jede Typänderung eine Datenmigration ohne Werkzeug. Verbindlich ab
der ersten Zeile: `schema_version` als **eigene Spalte** (indizierbar, zählbar — nicht im
JSONB), Registry pro Typ mit expliziten `migrate_vN_to_vN+1`-Funktionen, Lesen migriert nach
oben, Golden-Fixture-Tests durch alle Versionen.

**H-12 · Snapshot-Semantik hat keinen Träger außer einem Satz** — `CONTRIBUTING.md`
„Snapshot statt Referenz an jeder kommerziellen Grenze (BOM, Rechnung, Signatur)." — sonst
nichts: kein Helfer, kein Typmuster, kein Testbeispiel, keine Schema-Konvention, kein Eintrag
in `modules/README.md`, keine Invariante. Der M0-Implementierungsplan sieht dafür keine Task
vor.
*Konsequenz:* Was „nicht nachrüstbar" ist, ist nicht eine Tabelle, sondern die Gewohnheit.
Wenn M2 die BOM mit Referenzen statt Kopien baut, merkt das niemand, bis ein Kunde ein altes
Angebot öffnet und neue Preise sieht. Blockiert M1 nicht, muss vor M2 als Schema-Muster mit
erzwingendem Test existieren.

### Mittel

| # | Befund | Belegstelle | Konsequenz |
|---|---|---|---|
| M-1 | Eine DB-Rolle, zugleich Tabelleneigentümerin mit DDL-Vollmacht — kann RLS abschalten, Policies und Trigger droppen | `docs/adr/0003` | Ein kompromittierter App-Prozess schaltet die ganze Mandantengrenze ab, statt nur fremde Daten zu sehen. Sauber dokumentiert, Umstellung ist reine Konfiguration (4 Env-Variablen), Grant-Skizze real durchgespielt. Frist: „vor dem ersten Pilotkunden" — ein Ereignis, kein Datum |
| M-2 | Statusmaschinen: guter Helfer, keine einzige echte Maschine, keine Konvention | `lib/state-machine.ts:21` (nur im eigenen Test aufgerufen) | Weder Projektphase noch Rechnungsstatus definiert, obwohl beide in der Blaupause vollständig beschrieben sind. Unklar bleibt: wer ruft `assertTransition` — Service oder Aufrufgrenze? M1 bringt Kanban-Spalten und Outcomes; ohne Konvention entstehen Ad-hoc-Lösungen |
| M-3 | Outbox strukturell nicht abarbeitbar — kein Sortierschlüssel, kein Verarbeitet-Marker möglich | `lib/db/schema/events.ts:8-21`, `drizzle/0004` | Nur `occurred_at` als Cursor (nicht eindeutig, nicht monoton in Commit-Reihenfolge); `processed_at` ist wegen des Append-only-Triggers unmöglich. Activity Feed (M1) unkritisch, die acht Mail-Automatiken (M7) und signierten Webhooks (M8) nicht. `bigserial` ist **jetzt** bei leerer Tabelle trivial, später nicht |
| M-4 | `user_identity_insert with check (true)` + globaler Unique-Index = Cross-Tenant-Existenz-Orakel | `drizzle/0002:28-29`, `0010:4` | Ein Insert für eine geratene fremde E-Mail scheitert genau dann, wenn die Adresse auf der Plattform existiert. Zusätzlich: fremde Identität vorbelegen + Membership geben = die Person landet beim Erst-Login still im eigenen Workspace. Das ist das gewollte Einladungsverhalten, aber ohne `can()`-Gate und ohne Audit. Genau das muss der M1-Einladungsfluss richtig machen |
| M-5 | `withTenant` kennt keine Reentrancy — verschachtelt zweite unabhängige Transaktion | `lib/db/tenant.ts:13-18` + `lib/db/client.ts:30` (`max: 5`) | `d.transaction(...)` auf dem Db-Objekt statt auf `tx`: der innere Schreibvorgang überlebt ein Rollback der äußeren Transaktion (Outbox-Garantie fällt weg), und tiefe Verschachtelung ist ein Deadlock-Kandidat. Kein Sicherheitsleck, aber eine unsichtbare Falle |
| M-6 | depcruise scannt `scripts/`, `tests/` und Wurzeldateien nicht | `package.json:12` (`depcruise modules lib app worker`) | Ein künftiges Wartungsskript unter `scripts/`, das `getDb()` importiert und damit an `withTenant`, RLS-Kontext, Outbox und Audit vorbei auf jede Mandantentabelle zugreift, wäre kein CI-Fehler |
| M-7 | `.env.example` unvollständig — genau die vier Nähte der Rollentrennung fehlen | `.env.example` | Nicht dokumentiert: `POSTGRES_URL_AUTH`, `POSTGRES_URL_MIGRATE`, `POSTGRES_URL_WORKER`, `POSTGRES_URL_TEST_SUPERUSER`, `RESEND_FROM`. Alle vier fallen **still** auf `POSTGRES_URL` zurück — ein vergessenes Setzen schreibt lautlos den Ein-Rollen-Zustand fort. `RESEND_FROM` fehlend heißt: Absender fällt auf `login@transactional.example.invalid`, auffällig erst beim ersten echten Kundenlogin |
| M-8 | Session- und Token-Lebensdauern nicht konfiguriert, Registrierung offen | `lib/auth.ts:39-92` | Kein `session`-Block, kein `useSecureCookies`, kein `trustedOrigins`, keine expliziten Gültigkeitsdauern — alles Bibliotheksdefaults, die sich mit einem Minor-Update ändern. Zusätzlich: jede beliebige E-Mail kann einen Login-Link anfordern und wird zu `auth_user` + `user_identity` |
| M-9 | Postgres-Versionsschieflage: CI 17, lokale Tests 18 Beta | `.github/workflows/ci.yml` gegen `package.json` (`embedded-postgres@18.4.0-beta.17`) | Dieselbe Suite läuft gegen zwei Hauptversionen, eine davon Beta. Bei versionsabhängigem Verhalten in Migrationen oder Policies divergieren die Ergebnisse und man sucht an der falschen Stelle. Dazu drei Node-Versionen (CI 22, Image 22, Maschine 24.20.0, `@types/node` auf `^20`) |
| M-10 | Provisionierungsskript ist create-if-absent, nicht konvergierend — Grundinstallation fehlt darin | `scripts/hetzner-provision.py:96-122` | Zweiter Lauf bestellt keinen zweiten Server (die wichtige Eigenschaft stimmt). Aber: existierende Firewalls werden nicht auf Regel-Gleichheit geprüft, bei bestehendem Server nicht verifiziert ob die Firewall daran hängt, Fallback nur über Servertypen statt Standorte. Docker/Compose wurden von Hand nachinstalliert — **der Host ist nicht aus Code reproduzierbar** |
| M-11 | Chrome-PDF, pvlib-Sidecar und E-Rechnung existieren nicht | `worker/index.ts:70-71` | Real läuft nur pg-boss v12 + Health-Endpunkt. Playwright installiert, nirgends importiert, keine Browser-Binaries im Image, `node:22-slim` ohne Chrome-Systembibliotheken. `node-zugferd` installiert, null Imports. Planmäßig M2/M4 — darf nur nicht mit dem Zielbild verwechselt werden |
| M-12 | 35 von 48 Produktionsabhängigkeiten unbenutzt | `package.json` | Bewusste, in `bedarfslandkarte.md`/`entscheidungen.md` begründete Vorratshaltung (Konva, hplib, Tesseract, KoSIT wurden gezielt ausgelassen). Die Last gehört benannt: 1184 Pakete im Lockfile, 1,2 GB `node_modules`, kein `npm audit`-Gate, riskante Stände (`node-zugferd@0.1.1-beta.1` Bus-Faktor 1, TanStack Table v9, FullCalendar React 7 neben Core 6.1.21). `playwright` liegt fälschlich unter `dependencies` |
| M-13 | Docker-Image: ungepinntes `npm i tsx`, kein `USER` | `worker/Dockerfile:4` | `tsx` ist devDependency und wird nach `--omit=dev` ungepinnt nachinstalliert — jeder Build zieht die dann aktuelle Version. Bei einem Paket, das den gesamten Anwendungscode transformiert, ist das Lieferketten-Angriffsfläche. Container läuft als root |
| M-14 | Zugesagte Gates fehlen: KoSIT-Validator, Playwright-E2E | `docs/PLAN.md:66,139-140` | Zurückstellung ist inhaltlich vertretbar (erst mit echten Rechnungs-Fixtures bzw. echter Oberfläche sinnvoll), gehört aber als M1-Abschlusskriterium festgehalten. Ebenfalls fehlend: Secret-Scanning, `npm audit`, CodeQL, Coverage-Schwelle (`@vitest/coverage-v8` installiert, von keinem Skript aufgerufen), `concurrency`, `timeout-minutes` |
| M-15 | CSV-Import: Teilerfolge, Encoding und Mandanten-Fairness nicht spezifiziert | `docs/tooling/entscheidungen.md:63-67` | Der Import ist die einzige Massentür in M1 und faktisch der Migrationspfad für Wechselkunden, obwohl nicht dafür ausgelegt. Nötig: Zeile = Transaktion / Job = Bericht; Fehler mit Zeilennummer, Spaltenname, Rohwert, stabilem Code; Idempotenzschlüssel; CP1252 + Semikolon + Komma-Dezimaltrennzeichen als **Standardfall** (sonst Preise um Faktor 1000 daneben); Zeilenobergrenze und ein Job pro Workspace; Geoapify-Limit 3.000 Credits/Tag mit Zustand „Geocoding ausstehend" |
| M-16 | DSGVO-Consent braucht Version, Zeitpunkt, Historie und eine Policy-Verwaltung | `docs/konzepte/dsgvo-loeschkonzept.md` | Consent als Bool ohne Version/Zeitpunkt/Quelle ist im Streitfall nicht belegbar — per DB-CHECK zusammen erzwingen. Zustimmung/Widerruf/erneute Zustimmung brauchen drei Einträge, nicht ein Feld; die Events dürfen dabei **keine E-Mail** tragen, sonst steht die Adresse für immer in einer append-only-Tabelle. `anonymizeContact` ist eine M1-Bauaufgabe, nicht nur ein Konzept. Ohne `consent_policy`-Tabelle ist die Versionsnummer ein bedeutungsloses Freitextfeld |
| M-17 | Kanban-Spalten-Typ darf nicht an den Outcome gekoppelt werden | `docs/blaupause/01-modulkatalog.md` (Kernarchitektur) | Die Kopplung wirkt in der UI natürlicher und ist aus drei Gründen falsch: ein Workspace darf mehrere `won`-Spalten haben; `Cannot fulfill` hat gar keinen Spalten-Typ; Reopen müsste die Karte zurückschieben. Ein Test „Verschieben in eine `won`-Spalte ändert `project.outcome` nicht" gehört in M1 |
| M-18 | Zielpakete aus F1.4 gehören ans Projekt, nicht an die Site | `docs/blaupause/01-modulkatalog.md:16` | `energy_profile` (Verbrauch, Bestandsanlagen) gehört an die Site — die Zielpakete (Solar/Speicher/Wallbox/Heizung, je Purchase/Lease/Financing) beschreiben Kaufabsicht und gehören ans `project`. Sonst teilen sich „PV heute" und „WP nächstes Jahr" am selben Haus eine Struktur, die nur einem der beiden gehört |
| M-19 | Capability `external_only` ist deklariert, hat aber keinerlei Wirkung | `lib/permissions.ts:5` gegen `:46-56` | Steht im Capability-Typ, taucht in `ACTION_REQUIREMENTS` nicht auf, hat keine RLS-Policy. Sie zu setzen hat exakt keine Wirkung. Ein Feld mit diesem Namen im Typsystem lädt dazu ein, sich darauf zu verlassen. Zusätzlich: `admin` überspringt Schicht 3 vollständig — würde je eine Action `external_only` über `can()` auswerten, hebelte die Admin-Ausnahme sie stillschweigend aus |
| M-20 | M0-Rechtsgrundausstattung: Checkliste geliefert, Artefakte nicht | `docs/konzepte/rechts-checkliste.md` Z. 1-2, `docs/konzepte/backup-dr.md` | Clean-Room-Regeln sind vollständig da. Markencheck und AGB/AVV-Vorlagen stehen mit Status „offen" — es gibt also keine Vorlage und keinen durchgeführten Markencheck. Der als Pflicht definierte Restore-Test wurde nie durchgeführt, `docs/runbooks/restore-log.md` existiert nicht. Blockiert nicht M1-Code, blockiert den Pilot |
| M-21 | M1 ist die einzige Planungsstufe ohne unabhängige Zweitmeinung | `docs/blaupause/07-k3-gegenprobe.md` | Die Gegenprobe prüft M2–M4 und äußert sich zu M1 gar nicht; sie war budgetbedingt auf wenige hundert Token eingedampft (Restguthaben 0,0238 $). Die M1-Planung ist einstimmig — was dieses Projekt sonst bewusst vermeidet |

### Niedrig

- **`STATUS.md` fehlt im Projektwurzelverzeichnis** (verifiziert). Die Projekt-CLAUDE.md
  verlangt sie mit `status`/`next`/`money`/`note`; vorhanden ist nur `docs/tooling/STATUS.md` —
  inhaltlich guter Abschlussbericht, aber am falschen Ort und ohne das Format. Der Meilenstein
  ist von oben nicht sichtbar (Cockpit, 08:00-Digest).
- **`docs/tooling/STATUS.md` verweist auf sechs Commit-Hashes, die nach dem Rebase nicht mehr
  existieren** (`6dd627e`, `808300f`, `2f1c99f`, `8fc912d`, `0fe54c1`, `f589da1` →
  `25822a8`, `498d76e`, `6e1e283`, `a2f7f86`, `18df8ab`, `16a42fa`).
- **`research/` enthält Fremdmaterial**: genau eine Datei, `research/ga4_report_example.py`,
  ein GA4-Data-API-Beispiel. GA4-Webanalytik kommt in keinem Projektdokument vor, es gibt
  keine Python-Toolchain außer dem Hetzner-Skript. Beifang einer anderen Sitzung.
- **`scripts/lagebericht.sh:13` ist unversioniert und trägt eine private E-Mail-Adresse als
  Default-Empfänger** — Kandidat dafür, per `git add -A` samt Adresse ins Repo zu rutschen.
- **`.dockerignore` schließt `.env`-Dateien nur namentlich aus**, nicht `.env*` — eine lokal
  angelegte `.env.production` landete im Image. `.gitignore` macht es korrekt.
- **`worker/health.ts:176`** gibt `String(err)` im HTTP-Body zurück (Host, DB, Rollenname);
  Port auf `127.0.0.1` gebunden, Exposition also hostbegrenzt.
- **`scripts/hetzner-provision.py:87-93`** öffnet SSH für `0.0.0.0/0` und `::/0`.
- **`instrumentation.ts:18-22`** reicht Request-Fehler an Sentry weiter, ohne `beforeSend`-Filter
  gegen den Magic-Link-Token im Query-String (Sentry filtert serverseitig Felder namens `token`
  — geprüft ist es nicht).
- **`modules/README.md:51-61`** nennt drei depcruise-Regeln; es sind sieben.
- **Invariantensuite deckt nur Schema `public` ab** und erfasst gewöhnliche Views (`relkind 'v'`)
  weder prüfend noch meldend; Append-only wird auf zwei Tabellen festverdrahtet statt
  katalogbasiert geprüft.
- **Fehlende generische Kundenmail-Funktion** — `lib/mail.ts:13` exportiert nur `sendAuthMail`.
  F1.6 („Cannot fulfill") verlangt eine Kundenmail; ohne sie ist F1.6 nicht abnahmefähig.
- **Geoapify- und Stadia-Schlüssel nicht beschafft** (`docs/tooling/einkaufsliste.md:20,23`,
  beide „P1", offen). Für die Entwicklung reicht OpenFreeMap; vor dem F1.3-Sprint nötig.

---

## 4. Empfehlung zum `tooling`-Branch

**Mergen — ja. In diesem Zustand des Arbeitsverzeichnisses — nein. Und der Merge löst kein
einziges Betriebsproblem.**

Der Branch selbst ist gut: 13 Commits, +7134/−505 Zeilen, davon 6412 allein
`package-lock.json` — der Handarbeitsanteil liegt bei rund 700 Zeilen, überwiegend
Dokumentation. Die Entscheidungen sind in 19 Abschnitten begründet, die Codeanteile
(Health-Probe, Heartbeat, Backup-Skript, Sentry hinter Env-Flags) sind sorgfältig gebaut und
durch einen Codex-Review gegangen, dessen sechs Befunde nachweislich umgesetzt wurden. Die CI
ist auf dem Branch grün. Ihn offen zu lassen, während M1 beginnt, erzeugt nur Konfliktpotenzial
in `package.json` und `package-lock.json`.

**Vor dem Merge, in dieser Reihenfolge:**

1. Lokale Fassung von `docs/tooling/einkaufsliste.md` verwerfen
   (`git checkout -- docs/tooling/einkaufsliste.md`) — sie würde den Kaufstatus des Servers
   zurückdrehen. Dann `git pull --ff-only`.
2. `.env.example` (HCLOUD_TOKEN) und `scripts/hetzner-provision.py` (Token-Härtung) als
   eigenen Commit sichern — beides ist erwünscht und nirgends committet.
3. `research/` und `scripts/lagebericht.sh` entscheiden: löschen oder per `.gitignore` als
   Arbeitsablage dulden. Nicht mitcommitten (Fremdmaterial bzw. private E-Mail-Adresse).
4. Commit-Tabelle in `docs/tooling/STATUS.md` auf die Hashes nach dem Rebase korrigieren.

**Unmittelbar nach dem Merge, unabhängig davon (das sind die Blocker aus Abschnitt 3):**

5. `betterAuth` in `lib/auth.ts` hinter einen Lazy-Getter (B-1).
6. `npm run build` in den CI-`check`-Job (B-2) — sonst wiederholt sich B-1 in anderer Form.
7. `BETTER_AUTH_SECRET` erzeugen und setzen (B-3).
8. `.env.example` um die fünf fehlenden Variablen ergänzen (M-7),
   `POSTGRES_URL_WORKER` in `worker/compose.yaml` durchreichen (H-7).

---

## 5. M1-Startplan

M1 ist mit **36–57 Personentagen (≈ 7–11 Arbeitswochen solo)** geschätzt — die erste Zahl, die
es für M1 überhaupt gibt. Rund 20 neue Tenant-Tabellen, jede mit RLS-Migration, Fixture,
Service, Modul-Barrel und Tests. M1 ist kein Datenmodell-Meilenstein, sondern der erste
UI-Meilenstein.

**Stufe 0 — Restarbeit aus M0, vor der ersten M1-Zeile (1–2 Tage):**

1. Schlüsselregeln als generische Invarianten in `tests/db/tenant-invariants.test.ts` ziehen
   (H-2). Für `domain_events`/`audit_log` die Ausnahme entscheiden und begründet allowlisten.
   Halber Tag — danach kann M1 zwanzig Tabellen anlegen, ohne dass jemand die Regel im Kopf
   behalten muss.
2. `bigserial` auf `domain_events` und das Cursor-Muster als Absatz in `modules/README.md`
   oder als ADR (M-3). Jetzt trivial, bei Millionen Zeilen nicht mehr.
3. Statusmaschinen-Konvention festschreiben und die Projektphasen-Maschine bauen (M-2). Eine
   Stunde, und M1 hat für Kanban-Spalten und Outcomes ein Muster.
4. Vier Entscheidungen als kurze ADRs (je 1–2 Sätze, das Verfahren steht): `project` gehört zu
   M1 · KPI-Kacheln ohne Matview · keine Teams in M1 (`scope` startet mit `personal`,
   `project`) · CSV in M1, xlsx erst wenn ein echter Kunde eine .xlsx schickt.

**Stufe 1 — die Aufrufgrenze (P0.1), als eigenes kleines Vorhaben:**

`lib/server-action.ts` mit `serverAction(inputSchema, action, handler)`: löst die
better-auth-Session zur `user_identity.id` auf, nimmt die Workspace-ID serverseitig verifiziert
entgegen, validiert per Zod, ruft `withAuthorizedTenant`, fängt `PermissionDeniedError` und
schreibt den Denial-Audit in einer **neuen** Transaktion nach dem Abort.

**Das ist der erste Teilschritt für die nächste Sitzung**, und zwar gegen das bereits
existierende `sites`-Modul. Begründung, warum genau das:

- Es ist **keine neue Tabelle** — der Tabellen-Vertrag muss nicht bedient werden, die Sitzung
  geht nicht in RLS-Migrationen auf.
- Es löst die dringlichste Schuld aus M0 (H-1).
- Es ist **exakt vermessen**: `tests/db/site.test.ts:100-141` beschreibt das Sollverhalten
  bereits Zeile für Zeile. Der Test schreibt sich fast von selbst.
- **Jede** weitere M1-Position hängt daran. Ohne den Wrapper wird das Muster in jedem Modul
  neu erfunden und irgendwo falsch.

Tests, die dazugehören: Erfolgspfad (Insert + Event + Audit committen gemeinsam), Denial-Pfad
(Transaktion bricht ab, Denial-Audit steht trotzdem in neuer Transaktion), Validierungspfad
(ungültiger Input erreicht die DB nie), Membership-Pfad (`workspace.access`-Denial).
`npm run check` bleibt grün.

**Stufe 2 — parallel und ohne Konflikt: die Design-Mission** auf Branch `design` starten. Sie
hat die längste Vorlaufzeit, blockiert später jede Seite und berührt keine Datei, die P0.1
anfasst.

**Stufe 3 — der erste kundensichtbare Nutzen, in dieser Reihenfolge und nichts dazwischen:**

P0.2 Workspace-Kontext/Switcher → F1.1 `contact` → `project`-Spine → F1.8 Lead Sources →
F1.5 Kanban → F1.6 Outcome-Aktionen.

An diesem Punkt existiert die kleinste Anwendung, die ein Handwerksbetrieb zweimal öffnet:
Kontakt anlegen → Projekt anlegen → Karte auf dem Kanban verschieben → gewonnen/verloren
markieren. Das ist noch kein CRM (Aufgaben und Notizen fehlen), aber es ist ein Grund, das
Programm ein zweites Mal zu öffnen.

**Stufe 4 — danach:** P0.4 Zod-Registry + F16.1 Komponentenkatalog (unabhängiger Strang, der
natürliche Übungsplatz für die Registry) → F1.3 Site/Pin/Geocoding → F1.4 `energy_profile` →
F1.2 CSV-Import → F1.9 Aufgaben/Notizen/Termine (größter Einzelblock, 8 Tabellen, 3
UI-Flächen) → Querschnitt Suche/Filter/Tags, Activity Feed, KPI-Kacheln.

**Zusätzlich vor dem Bau des M1-Schemas:** die Schema-Skizze aus
`04-m1-bereitschaft.md` §7 durch einen unabhängigen Review schicken. Aktuell nicht möglich,
siehe Abschnitt 7.

**Parallel und unabhängig vom Code:** die lokale Entwicklungsdatenbank herstellen und
dokumentieren (H-6). Ohne sie kann niemand an M1 arbeiten und niemand etwas ausprobieren.

---

## 6. Was der Eigentümer entscheiden muss

Nur echte Entscheidungen — nichts, was Claude oder Codex selbst klären kann.

**Sofort, weil sie den Zeitplan bestimmen:**

1. **Der Moat: terminieren oder das Pilot-Gate ehrlich verschieben.** Der Plan nennt
   Förder-Regelwerk und VNB-Verzeichnis den eigentlichen Wettbewerbsvorteil und veranschlagt
   die gesamte Projektlaufzeit dafür. Es sind null Wochen verstrichen. Entweder feste
   Wochenstunden ab jetzt, oder die Feststellung, dass M4-light und damit das Pilot-Gate sich
   entsprechend nach hinten verschieben. Das ist keine Arbeit, sondern die Entscheidung mit
   der größten Hebelwirkung auf den Zeitplan.

2. **Positionierung: Wallbox-/Elektriker-Keil (Marktbild 02) oder PV-Residential (Roadmap 05)?**
   Die Antwort bestimmt, welche Felder `energy_profile` (F1.4) und welche
   `component_type`-Schemata (F16.1) zuerst gebaut werden. Solange sie offen ist, wird F1.4
   entweder zu breit oder am falschen Kunden gebaut. Die Vollständigkeitskritik nennt das die
   größte offene Entscheidung des Vorhabens.

**Credentials und Konten (Tier-2, nur Mikail):**

3. **`BETTER_AUTH_SECRET`** erzeugen — Deploy-Sperre, siehe B-3.
4. **Produktionsdatenbank** (Neon) anlegen. Davon hängt auch ab, welche Postgres-Hauptversion
   CI und lokale Tests fahren sollen (M-9).
5. **Resend**: `RESEND_API_KEY` + `RESEND_FROM` mit verifizierter Absenderdomäne (DKIM/SPF).
   Ohne beides funktioniert der Magic-Link-Login nicht — direkter M1-Startblocker.
6. **Objektspeicher-Bucket.** Achtung, unumkehrbar: Object Lock lässt sich laut ADR 0002 **nur
   bei der Bucket-Erstellung** aktivieren, und COMPLIANCE-Retention ist 8 Jahre nicht
   zurücknehmbar. Der Bucket muss neu angelegt werden, die Reihenfolge ist nicht korrigierbar.
7. **Geoapify** (Geocoding, F1.3 und CSV-Import) und **Stadia Maps** (Kartenkacheln) —
   registrieren, bevor der F1.3-Sprint ansteht, nicht während. Geoapify Free hat 3.000
   Credits/Tag; das begrenzt den CSV-Import.
8. **OpenRouter aufladen** — Restguthaben 0,0238 $. Ohne das gibt es keinen Kimi-Gegenblick,
   und M1 bleibt die einzige Planungsstufe ohne unabhängige Zweitmeinung (M-21).

**Rechtlich, blockiert den Pilot (nicht den Code):**

9. **Markencheck** durchführen lassen — steht seit M0 mit Status „offen".
10. **AGB/AVV-Vorlagen** zum Anwalts-Review geben — ebenfalls „offen", es existiert keine
    Vorlage.
11. **Restore-Test** einmal durchführen und protokollieren — `docs/konzepte/backup-dr.md`
    definiert ihn als Pflicht, `docs/runbooks/restore-log.md` existiert nicht.

**Termine statt Ereignisse setzen:**

12. **ADR 0003 (DB-Rollentrennung)** und **ADR 0002 (Object-Lock-Bucket)** sind beide auf „vor
    dem ersten Pilotkunden" terminiert — ein Ereignis, kein Datum, während die Pilot-Akquise
    laut Plan ab M3 parallel läuft. Erfahrungsgemäß der Moment, in dem solche Punkte verloren
    gehen. Beide brauchen ein Datum.

**Betrieb:**

13. **Wer führt den ersten echten `docker compose up --build` auf dem Hetzner-Host aus?** Der
    Server kostet seit dem 28.08. Geld und trägt keinen Container; der Deploy-Pfad ist nie
    durchlaufen worden.
14. **Lokale Dev-DB: docker-compose im Repo oder Neon-Branch?** Beides vertretbar, aber ohne
    Entscheidung gibt es keinen dokumentierten Setup-Pfad für M1.

---

## 7. Fehlendes Werkzeug: das Codex-Gate greift derzeit still nicht

**Das `codex`-Binary ist nicht im PATH.** Verifiziert: `which codex` → nicht gefunden
(Exit-Code 1).

Die Konfiguration existiert und wird aktiv benutzt: `~/.codex/` enthält `config.toml`,
`auth.json`, `models_cache.json` (Stand heute 15:24) und eine 2 MB große
`logs_2.sqlite` mit WAL-Datei von heute 15:25. Die Git-History belegt frühere, produktive
Nutzung im selben Repo:

- `120f46c` — „Merge M0: Multi-Tenant-Fundament (13 Tasks + **Codex-Ultra-Review-Härtung**)"
- `032e416` — „fix(tooling): **alle 6 Codex-Review-Befunde** umgesetzt"
- Im Code selbst stehen die Befundnummern als Kommentare (`lib/auth.ts`: „Codex-Review #16";
  `modules/README.md`: Regel aus Codex-Review #7; `tenant-fixtures.ts`: Matview-Verbot aus
  Codex-Review #5).

Die Projekt-CLAUDE.md schreibt vor: „**Codex** (`/codex-review`, `/codex`): nach JEDER fertigen
Code-Änderung Review (P0-P3)". Dieses Gate lässt sich zurzeit **nicht ausführen** — und es
scheitert nicht laut, sondern stillschweigend: eine Sitzung, die `codex exec` aufrufen will,
bekommt „command not found" und arbeitet ohne Review weiter, ohne dass es irgendwo protokolliert
wird.

Konkret betroffen und nicht theoretisch:

- Die M1-Schema-Skizze (`04-m1-bereitschaft.md` §7, rund 20 Tabellen) soll laut eigener
  Empfehlung **vor dem Bau** durch `/codex-review` — geht aktuell nicht.
- Die Fixes für B-1 bis B-3 und die Schlüsselregel-Invarianten (H-2) sind genau die Art von
  Änderung, für die das Gate vorgesehen ist.

Die zweite Stimme fällt zeitgleich aus: **Kimi** braucht OpenRouter-Guthaben, und das steht
laut K3-Gegenprobe bei 0,0238 $. Gemini und Qodo sind seit 2026-07-03 abgeschaltet.

**Damit läuft dieses Projekt derzeit ohne jede unabhängige Modell-Gegenstimme** — ausgerechnet
vor dem größten Meilenstein und der einzigen Planungsstufe, die noch nie gegengeprüft wurde.
Zwei Handgriffe: `codex` wieder in den PATH bringen (Installation prüfen, ggf. Symlink), und
OpenRouter aufladen. Beides gehört erledigt, bevor die erste M1-Zeile entsteht.
