# Ist-Bericht 01 — M0 gegen Plan und Modulkatalog

Datum: 2026-08-28 · Branch: `tooling` · Reine Repo-Analyse, kein Produktivcode geändert
Grundlage: `docs/PLAN.md`, `docs/blaupause/05-roadmap.md` (M0/M1), `docs/blaupause/01-modulkatalog.md`,
`docs/superpowers/plans/2026-08-26-m0-fundament.md` (13 Tasks + Abnahmekriterien) sowie der
tatsächliche Code in `lib/`, `modules/`, `app/`, `worker/`, `drizzle/`, `tests/`, `.github/`.

## Verifizierte Ausgangslage (echte Läufe, heute — nicht erneut ausgeführt)

- `npm run typecheck` — grün
- `npm run lint` — grün
- `npm run depcruise` — grün, 43 Module / 58 Dependencies, 0 Grenzverletzungen
- `npm test` — 15 Testdateien, 110 Tests, alle grün, gegen echtes Postgres mit angewendeten Migrationen

## Das Urteil vorweg

**M0 ist im technischen Kern abgeschlossen — aber nicht vollständig.** Das Fundament, das der Plan
als „nicht nachrüstbar" bezeichnet, steht in fünf von sieben Punkten wirklich im Code und ist durch
Tests abgesichert, die nachweislich scharf sind. Die Qualität dieser fünf Punkte ist deutlich über
dem, was ein normales Projekt an dieser Stelle hätte: RLS ist nicht nur eingeschaltet, sondern per
Testsuite auf einen exakten Prädikatstext festgenagelt; append-only ist nicht nur ein Trigger,
sondern auch gegen TRUNCATE abgesichert; die Rechteprüfung ist fail-closed und gegen kaputte
JSONB-Daten getestet.

Zwei der sieben Tag-1-Positionen existieren jedoch **überhaupt nicht als Code**: die
Snapshot-Semantik und die Zeitscheiben-Tabellen für Förder-Regelwerk und VNB-Verzeichnis. Beide
tragen im Plan das Etikett „nicht nachrüstbar", beide sind heute nichts weiter als ein Satz in
einem Markdown-Dokument. Dazu kommt eine strukturelle Lücke, die konkret gefährlich für M1 wird:
die Regeln zur tenant-sicheren Verknüpfung (`UNIQUE (workspace_id, id)`, zusammengesetzte
Fremdschlüssel, FK auf `workspace`) sind in `modules/README.md` als „Pflicht" formuliert, werden
aber von **keinem** Test erzwungen — anders als jede andere Invariante in diesem Projekt.

Restarbeit vor M1: ja, aber überschaubar und klar benennbar. Details am Ende.

---

## Abgleichstabelle: M0-Soll gegen Ist

Soll-Positionen aus `docs/blaupause/05-roadmap.md` §M0 und `docs/PLAN.md` §Roadmap.

| # | M0-Soll-Position | Ist | Belegstelle | Bemerkung |
|---|---|---|---|---|
| 1 | Multi-Tenant-Skeleton: `workspace`, `membership` | vollständig | `lib/db/schema/core.ts`, `drizzle/0000` | `membership` mit `UNIQUE (workspace_id, user_id)`, Rolle per CHECK auf drei Werte begrenzt (`drizzle/0009`) |
| 2 | RLS auf allen Mandantentabellen | vollständig | `drizzle/0001`, `0002`, `0004`, `0008` | `enable` **und** `force` überall; `nullif(current_setting(…), '')` gegen den Pool-Reuse-Fallstrick |
| 3 | `withTenant` als zweite Schicht | vollständig | `lib/db/tenant.ts:29` | zusätzlich `withAuthorizedTenant` (Zeile 110), das den Kontext an eine echte Membership bindet — mehr als der Plan verlangte |
| 4 | Passwortlose Auth (Magic Link + OTP, better-auth) | vollständig | `lib/auth.ts`, `app/api/auth/[...all]/route.ts`, `drizzle/0006`, `0012` | Magic-Link-Token gehasht, OTP verschlüsselt, Rate-Limit in der DB statt in-memory; getesteter Erst-Login- und Selbstheilungspfad |
| 5 | Zentrale `can()`-Rechteprüfung, 3 Schichten | vollständig (im Code) / teilweise (in der Anwendung) | `lib/permissions.ts:76` | 9 Actions, 8 Capabilities, fail-closed. **Es gibt keinen produktiven Aufrufer** — siehe Befund H-2 |
| 6 | `domain_events`-Outbox in derselben Transaktion | vollständig | `lib/events.ts:8`, `modules/sites/service.ts:71`, `tests/db/events.test.ts:55` | Rollback-Garantie ist explizit getestet |
| 7 | `audit_log` getrennt von `domain_events` | vollständig | `lib/db/schema/events.ts:26`, `lib/audit.ts:39` | Trennung sauber begründet: Events = fachliche Änderung, Audit = erlaubte *und* abgelehnte Zugriffe |
| 8 | Beide append-only | vollständig | `drizzle/0004`, `drizzle/0005` | Row-Trigger **plus** Statement-Trigger gegen TRUNCATE — der TRUNCATE-Fall wird oft vergessen, hier nicht |
| 9 | Statusmaschinen-Konvention | teilweise | `lib/state-machine.ts:21` | Helfer existiert und ist gut (eingefroren, receiver-fest). **Keine einzige echte Statusmaschine ist definiert**, und eine „Konvention" im Sinne einer Regel steht nur als Halbsatz in `CONTRIBUTING.md` — siehe M-1 |
| 10 | Site-Entität (schmal) zwischen Contact und Project | teilweise | `lib/db/schema/site.ts`, `modules/sites/` | Site existiert mit `UNIQUE (workspace_id, id)` und FK auf `workspace`. Contact und Project existieren nicht (planmäßig M1/M2), die Entität steht also noch zwischen nichts und nichts |
| 11 | Storage-Abstraktion mit WORM-Vorbereitung | vollständig | `lib/storage/types.ts`, `lib/storage/s3.ts` | App-seitige WORM-Semantik, SHA-256, `immutable/`-Präfix gegen `put()`/`getSignedUploadUrl()` verriegelt, `IfNoneMatch: "*"` gegen TOCTOU |
| 12 | Worker-Host (pg-boss, Chrome-PDF) | teilweise | `worker/index.ts`, `worker/health.ts`, `worker/compose.yaml`, `docs/runbooks/worker.md` | pg-boss v12 mit Queue-Roundtrip-Test, echte Readiness-Probe mit Timeouts, Dead-Man-Heartbeat. Chrome-PDF ist planmäßig M2. Nur die Queue `health.echo` registriert; Hetzner-Host nicht provisioniert (`scripts/hetzner-provision.py` liegt bereit) |
| 13 | CI mit dependency-cruiser-Modulgrenzen | vollständig | `.dependency-cruiser.cjs`, `.github/workflows/ci.yml` | 7 Regeln statt der geplanten 3; alle `severity: error`. Zusätzlich ein Schema-Drift-Gate, das eine Schemaänderung ohne Migration rot macht |
| 14 | Generische Tenant-Isolations-Suite | vollständig | `tests/db/tenant-invariants.test.ts`, `tests/setup/tenant-fixtures.ts` | Der stärkste Einzelbaustein des Meilensteins — Details unten |
| 15 | ADR-Prozess | vollständig | `docs/adr/template.md`, `0001`–`0003` | ADR 0003 ist ungewöhnlich ehrlich: die Rollentrennungs-Skizze wurde per `scripts/adr-0003-probe.mts` real durchgespielt, 24 von 24 Nachweisen grün |
| 16 | Clean-Room-Regeln als CONTRIBUTING | vollständig | `CONTRIBUTING.md` | Vier klare Verbote plus Architektur-Invarianten |
| 17 | Markencheck | fehlt | `docs/konzepte/rechts-checkliste.md` Zeile 1 | steht als „offen" in der Checkliste — nicht durchgeführt |
| 18 | AGB/AVV-Vorlagen zum Anwalts-Review | fehlt | `docs/konzepte/rechts-checkliste.md` Zeile 2 | Die Roadmap nennt „Vorlagen" als M0-Inhalt. Geliefert ist eine Tabellenzeile mit Status „offen", keine Vorlage |
| 19 | Backup/DR-Konzept | vollständig (als Konzept) | `docs/konzepte/backup-dr.md` | RPO/RTO benannt, Restore-Test als Pflicht definiert. **Noch nie durchgeführt** — `docs/runbooks/restore-log.md` existiert nicht |
| 20 | DSGVO-Löschkonzept | vollständig (als Konzept) | `docs/konzepte/dsgvo-loeschkonzept.md` | Regel 1 (kein Klartext in Events) ist im Referenz-Service tatsächlich eingehalten und getestet (`tests/db/site.test.ts:32`) |
| 21 | Förder-Regelwerk + VNB-Verzeichnis als Zeitscheiben-Tabellen | fehlt vollständig | — | Kein Treffer im gesamten Code für `förder`, `vnb`, `zeitscheibe`, `valid_from`, `effective_from`. Siehe H-3 |
| 22 | Snapshot-Semantik an kommerziellen Grenzen | fehlt (als Code) | `CONTRIBUTING.md`, Abschnitt Architektur-Invarianten | Ein Satz. Kein Helfer, kein Test, kein Schema-Muster. Siehe H-4 |

---

## Die sieben „nicht nachrüstbaren" Tag-1-Investitionen, einzeln geprüft

Der Plan (`docs/PLAN.md`, Abschnitt Architektur) führt sieben Positionen, deren Nachrüsten
„Wochen statt Stunden" kosten würde. Jede wurde gegen den Code geprüft.

### 1. `workspace_id` überall + RLS + `withTenant` doppelt — **erfüllt, und zwar gut**

Alle fünf Mandantentabellen (`workspace`, `membership`, `domain_events`, `audit_log`, `site`)
tragen den Mandantenschlüssel als `NOT NULL`, haben RLS `enabled` **und** `forced` und genau eine
permissive Policy `tenant_isolation`.

Der zweite Riegel existiert doppelt: `withTenant` (`lib/db/tenant.ts:29`) für System- und
Worker-Pfade und `withAuthorizedTenant` (Zeile 110) für alles im Namen eines Nutzers. Letzteres
liest Rolle, Capabilities und Feature-Flags **in derselben Transaktion aus der Datenbank**, nachdem
`app.workspace_id` gesetzt wurde — der Aufrufer kann seinen eigenen Berechtigungskontext also nicht
frei behaupten. Das ist eine Klasse besser als das, was der ursprüngliche Plan verlangt hat, und
schließt genau den Angriff, bei dem man eine fremde Workspace-UUID mit der eigenen Adminrolle
kombiniert.

Abgesichert wird das nicht durch Disziplin, sondern durch zwei dependency-cruiser-Regeln:
`db-client-nur-ueber-tenant` (der rohe Pool ist ausschließlich für `lib/db/tenant.ts` erreichbar)
und `app-kennt-lib-db-nicht` (Routen dürfen `lib/db` überhaupt nicht sehen). `getPool()` ist bewusst
nicht exportiert.

**Die generische Isolations-Suite ist echt.** Sie prüft nicht nur, ob RLS eingeschaltet ist, sondern:
dass jede Tabelle eine Fixture-Factory registriert hat (fehlt sie, wird die Suite rot), dass ein
Cross-Tenant-Insert **an der RLS** scheitert und nicht zufällig an einem Primary Key, dass eine
fabrikfrische Verbindung ohne Mandantenkontext nichts sieht, dass `with check` weder `NULL` noch
`true` ist, und dass `using` und `with check` **exakt** dem kanonischen Prädikat entsprechen — kein
Substring-Vergleich, der ein zusätzliches `OR` durchgehen ließe. Dazu ein Wächter, der verhindert,
dass sich eine echte Mandantentabelle hinter einem Exempt-Namen versteckt, eine exakte (nicht
präfixbasierte) Auth-Allowlist und ein Verbot unbeaufsichtigter materialisierter Views. Das ist der
Mechanismus, der M1 bis M8 tragen soll, und er sieht so aus, als könnte er das.

### 2. `domain_events`-Outbox in derselben Transaktion, getrennt vom `audit_log`, beide append-only — **erfüllt, mit einer offenen Designfrage**

Getrennt: ja, zwei Tabellen mit unterschiedlicher Semantik. In derselben Transaktion: ja,
`emitEvent(tx, …)` nimmt die Transaktion als erstes Argument entgegen, und
`tests/db/events.test.ts:55` beweist, dass ein Rollback das Event mitnimmt. Append-only: ja, und
zwar gründlicher als üblich — der Row-Level-Trigger allein hätte TRUNCATE nicht abgefangen, dafür
gibt es `drizzle/0005`.

Bemerkenswert sauber ist der Transaktionsgrenzen-Vertrag in `lib/audit.ts`: ein Denial-Audit darf
**nicht** in der abbrechenden Transaktion geschrieben werden, weil er sonst mit zurückgerollt würde.
Der Service wirft stattdessen einen typisierten `PermissionDeniedError`, und die Aufrufgrenze
schreibt den Audit in einer neuen Transaktion. Das ist richtig durchdacht. Es ist allerdings
bislang **nur im Test** implementiert (siehe H-2).

Offene Designfrage (siehe M-2): die Outbox hat keinen monotonen Sortierschlüssel und — weil sie
append-only ist — auch keine Möglichkeit, eine Zeile als „verarbeitet" zu markieren. Ein späterer
Konsument braucht deshalb zwingend eine eigene Cursor-/Checkpoint-Tabelle.

### 3. Site-Entität zwischen Contact und Project — **teilweise**

Die Site existiert (`lib/db/schema/site.ts`) und trägt genau das, was für M1 gebraucht wird:
Adresse, Koordinaten, `pin_confirmed` (Blaupause F1.3 — der bestätigte Pin ist die Voraussetzung
fürs Planen). Sie hat einen echten FK auf `workspace` und ein `UNIQUE (workspace_id, id)` als Ziel
für spätere zusammengesetzte Fremdschlüssel.

Was fehlt, fehlt planmäßig: es gibt weder Contact noch Project, die Site steht also noch frei. Der
eigentliche Wert dieser Tag-1-Investition — dass Gebäudedaten nicht am Kontakt und nicht am Projekt
hängen — entscheidet sich erst in M1, wenn Contact dazukommt. Der Platz ist reserviert, das Muster
ist dokumentiert. Mehr kann M0 hier nicht leisten.

### 4. Snapshot-Semantik an kommerziellen Grenzen — **nicht vorbereitet**

Es gibt dazu genau einen Satz, in `CONTRIBUTING.md`:
„Snapshot statt Referenz an jeder kommerziellen Grenze (BOM, Rechnung, Signatur)."

Sonst nichts. Kein Helfer, kein Typmuster, kein Testbeispiel, keine Schema-Konvention, kein
Eintrag in `modules/README.md`, keine Invariante in der Testsuite. Der M0-Implementierungsplan hat
für diesen Punkt keine einzige Task vorgesehen.

Ehrliche Einordnung: die Sache ist **fachlich** M2-Scope (die BOM-Zeile, die Katalogwerte kopiert,
gibt es erst mit Angeboten). Was „nicht nachrüstbar" ist, ist nicht eine Tabelle, sondern die
Gewohnheit — und für die Gewohnheit gibt es heute keinen Träger außer einem Satz, den man beim
Bauen von M1 nicht liest. Das ist die schwächste Stelle unter den sieben Positionen, weil sie
formal „geplant" wirkt und praktisch nichts hat, was sie durchsetzt.

### 5. Explizite Statusmaschinen — **Werkzeug ja, Anwendung nein**

`lib/state-machine.ts` ist ein guter kleiner Baustein: die Übergangsmatrix wird tief kopiert und
eingefroren (der Aufrufer kann nach dem Erzeugen keine Übergänge nachschieben), die Methoden sind
Closures statt Methoden am Receiver (sie funktionieren also auch destrukturiert oder als Callback),
und `IllegalTransitionError` nennt beide Zustände.

`createStateMachine` wird jedoch **nirgends außer im eigenen Test** aufgerufen. Es ist keine einzige
echte Maschine definiert — weder die Projektphase `Request → Offer → Installation` aus der
Kernarchitektur des Modulkatalogs noch der Rechnungsstatus `draft → issued → sent → void` aus M3,
obwohl beide in der Blaupause klar beschrieben sind und sich ohne jede Implementierung hinschreiben
ließen.

Die Roadmap verlangt eine „Statusmaschinen-**Konvention**". Eine Konvention beantwortet: Wo liegen
die Maschinen? Wie heißen sie? Wer ruft `assertTransition` auf — der Service oder die Aufrufgrenze?
Wie hängt die Maschine mit dem DB-seitigen Schutz zusammen (bei M3 ist die Festschreibung laut
Roadmap ein DB-Trigger)? Keine dieser Fragen ist beantwortet. Das ist Restarbeit, aber billige.

### 6. WORM/Object-Lock + Content-Hash für Belege — **erfüllt, soweit ohne Bucket möglich**

`lib/storage/s3.ts` löst das App-seitig sorgfältig: `immutableKey()` ist der einzige legale Weg zu
einem `immutable/`-Key und validiert gegen Path-Traversal; `put()` und `getSignedUploadUrl()`
**verweigern** jeden Key unter diesem Präfix, sodass sich `putImmutable()` nicht umgehen lässt;
`putImmutable()` prüft per HeadObject vor und sendet zusätzlich `IfNoneMatch: "*"`, um das
TOCTOU-Fenster zu schließen, wo der Anbieter das unterstützt. SHA-256 wird berechnet und
zurückgegeben.

Ehrlich benannte Grenzen — und sie sind im Code selbst benannt, nicht nur im ADR: die Bindung eines
Keys an den Workspace des Aufrufers leistet diese Ebene **nicht**. Wer `immutableKey()` mit einer
Workspace-ID aus einem Request füttert, stellt gültige Lese-URLs für fremde Mandanten aus. Das muss
die Aufrufgrenze in M2 tun — und die Aufrufgrenze existiert noch nicht (H-2).

Echtes Object Lock ist entschieden (ADR 0002: Hetzner, COMPLIANCE-Mode), aber nicht eingerichtet.
Zwei Punkte daraus sind unumkehrbar und gehören vor den ersten Beleg: Object Lock muss **bei
Bucket-Erstellung** aktiviert werden, und COMPLIANCE-Retention lässt sich 8 Jahre lang nicht
zurücknehmen. Das ist im ADR korrekt als Test-Gate festgehalten.

### 7. Zeitscheiben-Tabellen für Förder-Regelwerk und VNB-Verzeichnis — **existiert nicht**

Eine Volltextsuche über den gesamten Code (`*.ts`, `*.sql`, `*.mts`, `*.cjs`) nach `förder`,
`foerder`, `vnb`, `zeitscheibe`, `valid_from`, `gueltig_von`, `effective_from` liefert **null
Treffer**.

Hier widersprechen sich die Plandokumente selbst, und das sollte man nicht glattbügeln:

- `docs/PLAN.md` führt die Zeitscheiben-Tabellen ausdrücklich in der Liste der **nicht
  nachrüstbaren Tag-1-Investitionen**.
- `docs/blaupause/05-roadmap.md` §M0 sagt „Parallel ab Woche 1: redaktioneller Aufbau … als
  Zeitscheiben-Tabellen (**der Moat, kein Code**)".
- Die Abnahmekriterien im M0-Implementierungsplan schließen den Punkt explizit aus: „Bewusst NICHT
  in M0 … Förder-/VNB-Redaktionsstart (paralleler, nicht-technischer Track)".

Die Auflösung, die beim Bauen gewählt wurde, war also „gehört nicht zu M0". Formal ist M0 damit
sauber abgenommen. Sachlich bleibt: der Plan bezeichnet die Datenpflege an mehreren Stellen als den
eigentlichen Moat („der Moat ist Datenpflege, nicht Code") und veranschlagt dafür die gesamte
Projektlaufzeit — und davon sind bisher null Wochen verstrichen. Das ist kein Code-Blocker für M1,
aber es ist der Posten mit der längsten Vorlaufzeit im ganzen Vorhaben, und er läuft nicht.

---

## Befunde nach Schwere

### H-1 (hoch) — Die tenant-sicheren Schlüsselregeln sind Dokumentation, nicht Invariante

`modules/README.md` formuliert drei Regeln als bindend für jede Tenant-Entität:

1. jede Tenant-Tabelle trägt zusätzlich zum Primary Key ein `UNIQUE (workspace_id, id)`,
2. jeder FK auf eine Tenant-Entität ist zusammengesetzt, nie einspaltig,
3. jede Tenant-Tabelle hat einen FK `workspace_id → workspace.id`.

Der Anlass ist ein echter Befund (Codex-Review #7): PostgreSQL prüft Fremdschlüssel **ohne** RLS als
Sichtbarkeitsfilter, ein einspaltiger `site_id`-FK aus Workspace A kann also auf eine Site aus B
zeigen und die Mandantengrenze über die Referenz umgehen.

Die Regeln wurden auf `site` angewendet — und **nur** dort. Die Invarianten-Suite prüft sie nicht:
`tests/db/tenant-invariants.test.ts` enthält keinen einzigen Test auf Unique-Constraints,
Fremdschlüssel oder deren Spaltenzahl. Zwei der fünf bestehenden Mandantentabellen verletzen Regel 3
bereits heute: `domain_events` und `audit_log` haben `workspace_id uuid NOT NULL` **ohne** FK auf
`workspace` (`lib/db/schema/events.ts:12`, `:28`; `drizzle/0003` enthält keine
FOREIGN-KEY-Klausel). Ob das eine bewusste Ausnahme ist (ein FK von einem append-only-Log auf
`workspace` würde das Löschen eines Workspace blockieren), steht nirgends.

Warum das für M1 zählt: M1 bringt `contact`, `kanban_board`, `kanban_column`, `task`, `lead_source`,
`tag`, `note`, `appointment` — also mindestens acht neue Tenant-Tabellen mit reichlich
Querverweisen untereinander und auf `site`. Genau die Konstellation, für die die Regel geschrieben
wurde. Alles andere in diesem Projekt wird von CI erzwungen; ausgerechnet die Regel, die aus einem
gefundenen Sicherheitsdefekt entstand, hängt an der Aufmerksamkeit beim Schreiben der nächsten
Migration.

**Empfehlung:** die drei Regeln als Tests in die Invarianten-Suite ziehen, bevor M1 beginnt.
Aufwand: gering (`pg_constraint`/`pg_index` abfragen, analog zur bestehenden Policy-Prüfung). Für
`domain_events`/`audit_log` entweder den FK nachziehen oder die Ausnahme begründet in
`tenant-fixtures.ts` allowlisten — so, wie es das Projekt bei jeder anderen Ausnahme auch hält.

### H-2 (hoch) — Es gibt keine Aufrufgrenze; `can()` ist zentral nur der Absicht nach

`app/` besteht aus unverändertem `create-next-app`-Boilerplate (`app/page.tsx` zeigt das
Next.js-Logo, `app/layout.tsx` trägt den Titel „Create Next App") plus einer einzigen echten Datei:
dem better-auth-Route-Handler.

Damit fehlt der gesamte Pfad zwischen Session und Service:

- kein Login-UI, keine Workspace-Auswahl, keine Auflösung Session → `user_identity.id` → Workspace,
- **kein produktiver Aufrufer von `withAuthorizedTenant`** (nur Tests rufen es),
- **kein Server-Action-/Route-Wrapper**, der den `PermissionDeniedError` fängt und den Denial-Audit
  in einer neuen Transaktion schreibt.

Der letzte Punkt ist der wichtigste. Der Transaktionsgrenzen-Vertrag in `lib/audit.ts` und
`modules/sites/service.ts` beschreibt ihn über Dutzende Kommentarzeilen als „Controller-Ruling", und
`tests/db/site.test.ts:107` implementiert das vollständige Muster — **im Test**. In
`app/` existiert es nicht. Die Zusage aus Architektur §4, dass erlaubte *und* abgelehnte Zugriffe
im Audit landen, ist heute nur zur Hälfte eingelöst: der Erfolgspfad schreibt (getestet, atomar),
der Ablehnungspfad hat niemanden, der ihn schreibt.

Das ist **planmäßig** — die Global Constraints des M0-Plans sagen ausdrücklich „In M0 gibt es noch
keine UI — die Konvention wird in `CONTRIBUTING.md` dokumentiert und ab M1 gelebt". Es ist also
keine gebrochene Zusage. Es bedeutet aber: der Wrapper ist das allererste, was M1 bauen muss, bevor
irgendeine CRM-Funktion entsteht, und er muss beim ersten Mal richtig sein, weil sich jedes
M1-Modul daran anhängt. Er sollte nicht nebenbei im ersten CRM-Ticket entstehen.

### H-3 (hoch) — Der Moat läuft nicht

Siehe Tag-1-Position 7. Null Zeilen Förder-Regelwerk, null Einträge VNB-Verzeichnis, keine
Tabellenstruktur, kein Redaktionsprozess, keine reservierten Wochenstunden im STATUS. Der Plan sagt
an drei Stellen, dass dies der eigentliche Wettbewerbsvorteil ist und redaktionell über die gesamte
Laufzeit reift. Formal ist der Punkt aus M0 herausdefiniert; praktisch heißt „parallel ab Woche 1"
nach Abschluss von M0 immer noch Woche 0.

Blockiert M1 nicht. Blockiert M4-light (Pilot-Gate) mit erheblichem Vorlauf.

### H-4 (hoch) — Snapshot-Semantik hat keinen Träger

Siehe Tag-1-Position 4. Ein Satz in `CONTRIBUTING.md` ist alles. Wenn M2 die BOM baut und dabei
Referenzen statt Kopien verwendet, merkt das niemand, bis ein Kunde ein altes Angebot öffnet und
neue Preise sieht. Blockiert M1 nicht (M1 hat keine kommerzielle Grenze), muss aber **vor** M2
mindestens als Schema-Muster mit Testbeispiel existieren — idealerweise im selben Stil wie die
Schlüsselregeln in `modules/README.md`, also mit einem Test, der es erzwingt.

### M-1 (mittel) — Statusmaschinen: Helfer ohne Konvention und ohne Anwendung

Siehe Tag-1-Position 5. Konkret fehlt: mindestens eine echte Maschine (Projektphase wäre der
natürliche Kandidat und ist in der Blaupause vollständig beschrieben), ein Absatz in
`modules/README.md`, der festlegt wo Maschinen liegen und wer `assertTransition` aufruft, und die
Klärung des Verhältnisses zu den DB-Triggern, die M3 für die Rechnungs-Festschreibung vorsieht.
Billig zu schließen, und es ist besser vor M1 geklärt als mittendrin.

### M-2 (mittel) — Die Outbox lässt sich nicht abarbeiten

`domain_events` hat als Sortier-/Cursor-Kandidaten nur `occurred_at` (`timestamptz`, uhrzeitbasiert,
nicht eindeutig, bei nebenläufigen Transaktionen nicht monoton in Commit-Reihenfolge). Es gibt
keinen `bigserial`, keine Sequenz, keine `processed_at`-Spalte.

Und eine `processed_at`-Spalte könnte es auch gar nicht geben: die Tabelle ist per Trigger
append-only, ein `UPDATE` wirft. Das ist konsistent mit der fachlichen Zusage („unveränderliche
Historie"), macht aber das übliche Outbox-Muster („Zeile holen, verarbeiten, als publiziert
markieren") strukturell unmöglich. Jeder künftige Konsument — Activity Feed ist unkritisch, aber
die acht Mail-Automatiken (M7) und die signierten Webhooks (M8) sind es nicht — braucht eine eigene,
schreibbare Cursor-Tabelle pro Konsument.

Das ist keine Fehlkonstruktion, aber es ist eine unausgesprochene Konsequenz, die heute nirgends
steht. Ein monotoner Sortierschlüssel (`bigserial`) lässt sich später nachrüsten, sollte aber jetzt
kommen, solange die Tabelle leer ist; der Cursor-Ansatz gehört als Absatz in `modules/README.md`
oder als ADR festgehalten, bevor jemand in M7 auf die Idee kommt, den Trigger „kurz" zu lockern.

### M-3 (mittel) — `external_only` ist deklariert, wirkt aber nicht

Die Capability `external_only` steht in `lib/permissions.ts:5` im `Capability`-Typ, taucht aber in
`ACTION_REQUIREMENTS` **nicht auf** und hat keine RLS-Policy. Sie zu setzen hat heute exakt keine
Wirkung. Der Modulkatalog beschreibt sie als „External-User-Flag = sieht nur Zugewiesenes", also als
Sichtbarkeitsbeschränkung — die laut `drizzle/0013` und `modules/README.md` korrekt als
`restrictive` Policy kommen muss, nicht als Capability-Prüfung.

Risiko ist gering, solange niemand sie setzt, aber ein Feld mit diesem Namen im Typsystem lädt dazu
ein, sich auf es zu verlassen. Entweder mit einem Kommentar als „reserviert, ohne Wirkung bis
M5/M7" markieren oder bis dahin herausnehmen.

### M-4 (mittel) — Offene Sicherheits-Limitationen mit Frist, aber ohne Termin

Zwei bewusst akzeptierte Restrisiken sind sauber dokumentiert und beide auf „vor dem ersten
Pilotkunden" terminiert:

- **ADR 0003, DB-Rollentrennung:** Migrationen, Portal, Auth und Worker teilen sich heute eine
  Rolle, die Eigentümerin aller Tabellen ist und damit DDL darf — sie kann RLS abschalten, Policies
  droppen, Trigger entfernen. Der Code ist bereits so geschnitten, dass die Umstellung reine
  Konfiguration ist (vier Env-Variablen mit Fallback), und die Grant-Skizze wurde real durchgespielt.
- **ADR 0002, Object-Lock-Test-Gate:** `If-None-Match` bei Hetzner ist undokumentiert; der Bucket
  muss mit aktiviertem Object Lock **neu** angelegt werden.

Beides blockiert M1 nicht. Beides ist aber an ein Ereignis gekoppelt („erster Pilotkunde"), nicht an
ein Datum, und die Pilot-Akquise läuft laut Plan ab M3 parallel. Erfahrungsgemäß ist das der Moment,
in dem solche Punkte verloren gehen.

### N-1 (niedrig) — Kein `STATUS.md` im Projektwurzelverzeichnis

Die Projekt-CLAUDE.md verlangt eine `STATUS.md` im Wurzelverzeichnis (`status` / `next` / `money` /
`note`), die der Brain-Collector read-only ausliest. Vorhanden ist nur `docs/tooling/STATUS.md` —
ein inhaltlich sehr guter Abschlussbericht der Tooling-Session, aber am falschen Ort und ohne das
erwartete Format.

### N-2 (niedrig) — Boilerplate-Reste

`app/page.tsx` ist die unveränderte Next.js-Startseite mit Vercel-Werbelinks, `app/layout.tsx` trägt
`title: "Create Next App"`. Kosmetisch, verschwindet mit dem ersten M1-Screen — aber `lang="en"` im
`<html>` bei einem deutschsprachigen Produkt sollte man beim Anfassen gleich mitkorrigieren.

### Lob (kurz, dann weiter)

- Die Invarianten-Suite prüft die *Fehlerklasse* statt der Einzelfälle und ist gegen
  Vakuum-Grün gehärtet (exakter Prädikatvergleich, RLS-spezifische Fehlerprüfung beim
  Cross-Write, frischer Pool für den Nullkontext-Test, Wächter gegen versteckte Tenant-Tabellen).
- Das Schema-Drift-Gate in der CI (`npm run db:generate` + `git diff --exit-code`) schließt genau
  die Lücke, durch die eine neue Tabelle ohne Migration an allen Tenant-Invarianten vorbeigerutscht
  wäre.
- `scripts/adr-0003-probe.mts`: eine ADR, deren Grant-Skizze tatsächlich ausgeführt und mit 24
  Nachweisen belegt wurde, statt behauptet zu werden. Die Probe hat dabei einen echten
  Portabilitätsfehler in `drizzle/0015` gefunden.
- Die Auth-Härtung (Magic-Link gehasht, OTP verschlüsselt statt gehasht — mit korrekter Begründung
  über die 20 Bit Entropie, Rate-Limit in der DB statt pro Serverless-Instanz, kein
  Credential-Logging in Produktion) ist über dem Branchenniveau.

---

## Was laut Plan zu M0 gehört, im Code fehlt — und ob es M1 blockiert

| Fehlend | M1-Blocker? | Begründung |
|---|---|---|
| Aufrufgrenze / Server-Action-Wrapper (H-2) | **ja, faktisch** | Nicht formal M0-Scope, aber M1 kann keine einzige Mutation bauen, ohne ihn vorher zu haben. Muss der erste M1-Baustein sein, nicht der nebenbei entstandene |
| Schlüsselregeln als Test-Invariante (H-1) | **ja, dringend** | M1 bringt ~8 neue Tenant-Tabellen mit Querverweisen. Danach nachzurüsten heißt, alle Migrationen erneut zu prüfen |
| Statusmaschinen-Konvention + erste Maschine (M-1) | teilweise | M1 hat Kanban-Spalten und Outcomes (`Open/Won/Lost/Cannot fulfill`) — beides Zustandslogik. Ohne Konvention entstehen dort Ad-hoc-Lösungen |
| Sortierschlüssel + Cursor-Muster für die Outbox (M-2) | nein | M1 liest Events aggregatbezogen (Activity Feed), das funktioniert. Nachrüsten des `bigserial` ist jetzt trivial, bei Millionen Zeilen nicht mehr |
| Snapshot-Semantik als durchgesetztes Muster (H-4) | nein | erst ab M2 relevant, muss aber vor M2 stehen |
| Förder-/VNB-Zeitscheiben (H-3) | nein | blockiert M4-light und damit das Pilot-Gate; Vorlaufzeit ist der Punkt, nicht die Technik |
| Markencheck, AGB/AVV-Vorlagen (#17, #18) | nein | blockiert den Pilot, nicht den Code |
| Restore-Test (#19) | nein | Konzept steht, Durchführung fehlt. Vor Produktivbetrieb Pflicht |
| DB-Rollentrennung, Object-Lock-Gate (M-4) | nein | bewusst und begründet nach M0 verschoben, Code ist vorbereitet |
| Chrome-PDF im Worker, Hetzner-Provisionierung | nein | planmäßig M2 |
| Teams/Bereichs-Toggles, OIDC-SSO, Command-Executor | nein | in der Roadmap ausdrücklich aus M0 ausgeschlossen |

Abweichungen gegenüber dem **Modulkatalog** (nicht gegenüber dem Plan), zur Klarstellung: der
Katalog beschreibt unter Querschnittsfunktionen **vier** geschichtete Rechteprüfungen und ~20
Einzelrechte; implementiert sind **drei** Schichten und 8 Capabilities. Das ist keine Lücke, sondern
die bewusste Entscheidung aus `docs/blaupause/04-architektur.md` §5 („Verfeinerung Richtung Reonics
4 Schichten/20 Rechten kostet später Daten, nicht Code"). Das Membership-Schema hält den Weg dorthin
offen, weil Capabilities als JSONB liegen und Bereichs-Toggles additive Spalten wären. Ebenso fehlen
planmäßig QR-Device-Pairing und OIDC-SSO aus dem Auth-Abschnitt des Katalogs.

---

## Abschließende Aussage

**M0 ist nicht abgeschlossen — aber es fehlt weniger, als die Liste vermuten lässt, und das
Fehlende ist gut sichtbar.**

Was der Meilenstein leisten sollte — ein Fundament bauen, dessen Verletzung auffällt, statt sich
auf Disziplin zu verlassen — hat er für die Mandantentrennung, die Ereignis- und Audit-Historie,
die Modulgrenzen und den Migrationspfad tatsächlich erreicht. Diese Teile sind belastbar und in
mehreren Fällen besser als geplant.

Nicht erreicht hat er es für die Regeln zur tenant-sicheren Verknüpfung (H-1), die als einzige
Architektur-Invariante ohne Testabdeckung geblieben sind, obwohl sie aus einem echten gefundenen
Defekt stammen. Und er hat zwei der sieben als „nicht nachrüstbar" markierten Positionen gar nicht
angefasst (Snapshot-Semantik, Zeitscheiben-Tabellen) — bei der einen mit guter Begründung
(Fachlichkeit gehört zu M2), bei der anderen mit einer Begründung, die den Punkt formal aus M0
herausdefiniert, ohne das dahinterliegende Problem — die Vorlaufzeit des Moats — zu lösen.

**Empfohlene Restarbeit vor M1-Start, in dieser Reihenfolge:**

1. **Schlüsselregeln in die Invarianten-Suite** (H-1) — `UNIQUE (workspace_id, id)`, FK auf
   `workspace`, keine einspaltigen FKs auf Tenant-Entitäten; für `domain_events`/`audit_log` die
   Ausnahme entscheiden und begründet allowlisten. Halber Tag, und danach kann M1 acht Tabellen
   anlegen, ohne dass jemand die Regel im Kopf behalten muss.
2. **Aufrufgrenze als eigenes, kleines Vorhaben** (H-2) — Session → `user_identity` → Workspace →
   `withAuthorizedTenant`, plus der Denial-Audit-Wrapper, der heute nur im Test existiert. Mit
   eigenen Tests, bevor das erste CRM-Feature daran hängt.
3. **Statusmaschinen-Konvention festschreiben und die Projektphasen-Maschine bauen** (M-1) — eine
   Stunde, und M1 hat für Kanban-Spalten und Outcomes ein Muster.
4. **`bigserial` auf `domain_events` und Cursor-Muster dokumentieren** (M-2) — jetzt trivial,
   später nicht.
5. **Entscheidung zum Moat treffen** (H-3) — nicht bauen, sondern terminieren: feste Wochenstunden
   für die Redaktion, oder die ehrliche Feststellung, dass das Pilot-Gate sich entsprechend nach
   hinten verschiebt.

Die Punkte 1–4 zusammen sind realistisch ein bis zwei Arbeitstage. Punkt 5 ist keine Arbeit,
sondern eine Entscheidung — und die mit der größten Hebelwirkung auf den Zeitplan.
