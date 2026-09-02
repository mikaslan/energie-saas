# M1-11b — Cannot Fulfil mit Transactional Outbox

- Status: SPECIFIED (rekonstruiert) · IMPLEMENTIERT im verlorenen Worktree · NICHT REVIEWED/VERIFIED · NICHT ABGENOMMEN
- Datum: 2026-09-02 (Rekonstruktion)
- F-Bezug: F1 (Outcomes Open/Won/Lost/Cannot Fulfil) — PARTIAL
- Architektur: ADR 0018
- Basis: `01b52e9` (M1-12a) [V24:24]; geplante Migration `0040` [V24:68]

> **Rekonstruktionswarnung.** Der Arbeitsordner
> `~/Projects/reonic-clone-finale-claude` (Branch `claude/reonic-finale`,
> fünf lokale Commits `c9e6b50 … 09240ae`) existiert nicht mehr [V24:22–27,29–36].
> Die einzige erhaltene, detaillierte Beschreibung ist die Vault-Datei
> `24-Arbeitsstand-M1-11b.md` plus Abschnitt 11 der Übergabe
> `22-Claude-Code-Handoff-M1-12a.md`. Dieses Dokument rekonstruiert daraus die
> Spezifikation. Jede Aussage trägt eine Quellenangabe; nicht belegte Details
> sind `UNKNOWN`. Dies ist **kein** Abnahmedokument.

## Quellenlegende

- `V24:N` — `24-Arbeitsstand-M1-11b.md`, Zeile N
- `H22:N` — `22-Claude-Code-Handoff-M1-12a.md`, Zeile N
- `L01:N` — `01-Laufender-Stand.md`, Zeile N
- `M111A` — Spec `M1-11a-projektergebnis.md` (Codex-Branch `codex/m1-11a-project-outcomes`, `4d31b9f`) — erhalten
- `M111A/0039` — drizzle-Migration 0039 (M1-11a) — erhalten
- `M203B1/0035` — drizzle-Migration `0035_m2_03b1_offer_issuance.sql` (Codex-Branch `codex/m2-03b-offer-issuance-archive`, `a06f961`) — erhalten

## 1. Nutzerergebnis

Ein interner Editor oder Admin kann eine offene Anfrage ausdrücklich als
„nicht erfüllbar“ (Cannot Fulfil) abschließen. Der Abschluss ist fachlich
endgültig: Er erzeugt genau eine Kundenbenachrichtigung über eine Transactional
Outbox, sperrt Freigabekandidat, Genehmigung und Ausstellung unter diesem
Projekt und lässt kein Reopen zu [V24:64–66, H22:295–301].

Cannot Fulfil ist ausdrücklich **kein** bloßer Statuswechsel. Vier Pflichtteile
gehören zwingend zum Slice: Transactional Outbox, Kundenbenachrichtigungs-
zustellung, idempotente Delivery-/Retry-Evidenz und Sperre gegen
Signatur/Ausstellung [V24:64–66, H22:293–301]. Ein `cannot_fulfill`-Status
allein darf nicht als fertiger Slice deklariert werden [H22:301].

## 2. Öffentliche Clean-Room-Evidenz und bewusste Entscheidungen

Die M1-11a-Evidenz belegt die Outcome-Achse Open/Won/Lost einschließlich Reopen
über die öffentlichen Reonic-Seiten Lead-/Offer-Lifecycle und Kanban-Boards
[M111A, „Öffentliche Clean-Room-Evidenz“]. Für die **Cannot-Fulfil-Semantik**
gibt es keine öffentliche Beleglage: Weder Terminalität, Reopen-Verbot noch die
exakte Benachrichtigungs-/Sperrsemantik sind öffentlich belegt. Daher ist die
gesamte M1-11b-Semantik als `DECIDED WMEE` gekennzeichnet und im Register als
`UNK-F1-05` geführt [V24:223, siehe „Bewusste Entscheidungen“ unten].

Die vier bewussten Entscheidungen [V24:223–231]:

1. `cannot_fulfill` ist **terminal**: kein Reopen. Nach einer zugestellten
   Absage wäre Wiedereröffnung ein eigener fachlicher Vorgang. [V24:225–226]
2. Ein verbindlich ausgestelltes Angebot (Approval ohne Withdrawal)
   **blockiert** die Transition — „nicht erfüllbar“ wäre dann unwahr.
   [V24:227–228]
3. Feste interne Mailvorlage, kein Vorlagen-Editor, kein Freitext. [V24:229]
4. Evidenzzeilen beschreiben ausschließlich Sendeversuche; ein Storno ist ein
   Statusübergang ohne Versuchszeile. [V24:230–231]

## 3. Capability- und Abnahmematrix

| ID | Fähigkeit | Objektive Abnahme |
|---|---|---|
| `M111B-01` | Terminale Transition | offene Request-Revision N wird atomar zu `cannot_fulfill` N+1 mit DB-Zeit als `closed_at`; genau eine Outbox-Zeile und gesperrte Folgekante [V24:141–142] |
| `M111B-02` | Evidenz aus dem Trigger | Event und Audit entstehen genau einmal aus dem DB-Trigger, nicht im Service [V24:116,142] |
| `M111B-03` | Fälschungsschutz | ein gefälschter Evidenz-Insert scheitert; Whitelist deckt nur den neuen Eventtyp [V24:117,143] |
| `M111B-04` | Zustandsmaschine | jede verbotene Kante einschließlich Reopen wird abgewiesen [V24:143–144] |
| `M111B-05` | Fehlerfälle | Revisionskonflikt, unbekanntes Projekt, gelöschter Contact [V24:144] |
| `M111B-06` | Rollen/Privacy | Viewer, External, Fremdmandant fail-closed, ohne dass eine Outbox-Zeile entsteht [V24:144–145] |
| `M111B-07` | Outbox-Guards | Insert ohne `cannot_fulfill`, illegale Statusübergänge und DELETE werden abgewiesen [V24:145–146] |
| `M111B-08` | Abschlussliste | `cannot_fulfill` als dritter Abschlussfilter neben `won` und `all` [V24:146–147] |
| `M111B-09` | Worker-Kapseln | Empfängerauflösung, Storno nach Löschung, Zustellung, Wiederholung, idempotenter Doppel-Dispatch, append-only Evidenz [V24:149–150] |
| `M111B-10` | Erasure-Kreuzung | eine während der laufenden Transition committende Erasure gewinnt; Outcome, Outbox und Evidenz rollen vollständig zurück [V24:152–154] |
| `M111B-11` | Angebotssperre | Freeze-Guard auf exakt vier Angebotstabellen, nur auf INSERT; Freigabekandidat unter geschlossenem Projekt abgewiesen [V24:156–159] |
| `M111B-12` | Race gegen Ausstellungs-Genehmigung | Transition gegen parallel laufende `approve_offer_issuance` — **offener Nachweis** [V24:209] |
| `M111B-13` | UI/A11y | Chromium 4/4: Editor-Abschluss mit eingefrorener Akte, Abgeschlossen-Liste, Viewer read-only, External abgewiesen; Axe, Tastatur, 375 px [V24:135–137] |
| `M111B-14` | Migration/Gesamtpfad | Fresh-Migration, drei quellgepinnte Funktionsersetzungen, `db:generate` ohne Drift, Rollenvertrag, PG18, Build [V24:125–133] |

## 4. Zustandsmaschine

M1-11a autorisiert ausschließlich Request-Projects und die Kanten
Won/Lost/Reopen [M111A, „Zustandsmaschine“]. M1-11b ergänzt **additiv** genau
eine Kante [V24:91–92, M111A]:

```text
request/open@N --mark_cannot_fulfill--> request/cannot_fulfill@N+1
```

- `cannot_fulfill` ist **terminal**: es existiert keine ausgehende Kante, kein
  Reopen [V24:225–226].
- Die M1-11a-Kanten `mark_won`, `mark_lost` und `reopen` bleiben unverändert
  gültig [V24:91–92].
- `expectedOutcomeRevision` ist für jede Mutation Pflicht [M111A].
- Phase und Kanban-Board/-Spalte bleiben bytegleich [M111A].
- Feldkohärenz aus M1-11a bleibt gültig: `cannot_fulfill => closed_at NOT NULL,
  reason NULL, text NULL` [M111A, „Geschlossener Datenvertrag“].

Der DB-seitige Transition-Guard ist die autoritative Stelle. Die M1-11a-Funktion
`_m111a_guard_project_outcome()` enumeriert die erlaubten Transitionen; ohne
Ersetzung würde `open → cannot_fulfill` mit SQLSTATE `23514` abbrechen
[V24:115]. M1-11b ersetzt sie quellgepinnt (siehe §5).

## 5. Datenmodell und Datenbankvertrag

Migration `0040_m1_11b_cannot_fulfil.sql` (768 Zeilen) [V24:68] enthält:

### 5.1 Outbox `customer_notification`

- Zwei neue Tabellen: `customer_notification` (Outbox) und
  `customer_notification_delivery_attempt` (append-only Zustellevidenz), beide
  mit RLS, FORCE RLS, Tenant-Policy und Mutationsguards [V24:70–72].
- **Kein PII in der Datenbank:** weder Empfängeradresse noch Mailtext werden
  gespeichert. Der Empfänger wird zum Zustellzeitpunkt live aus dem
  Contact-Graphen aufgelöst [V24:73–74].
- Die Outbox-Zeile entsteht in derselben Transaktion wie das Project-Update und
  der pgboss-Job [V24:86–87,94–95].
- Belegte Statuswerte: `queued` und Storno-Übergang zu
  `cancelled_contact_erased` nach Contact-Löschung [V24:82–83]. Der vollständige
  Status-Enum (z. B. `delivered`/`failed`/Retry-Zustände) ist in der Vault nicht
  einzeln benannt → `UNKNOWN` (rekonstruiert: mindestens `queued`,
  `delivered`, `failed_retriable`, `failed_final`,
  `cancelled_contact_erased`; genaue Namen/Anzahl `UNKNOWN`).
- Mutationsguards: Insert ohne vorherige `cannot_fulfill`-Transition,
  illegale Statusübergänge und DELETE werden abgewiesen [V24:145–146].
- Append-only: physisches DELETE ist verboten [V24:146].

Exakte Spaltennamen/-typen der verlorenen Migration sind `UNKNOWN`. Aus dem
Beleg ableitbar und als Rekonstruktion markiert: Tenant-Schlüssel
(`workspace_id`), Projektbezug mit zusammengesetztem Tenant-FK, Status,
Erstell-/Aktualisierungszeit, Dispatch-/Retry-Metadaten und Idempotenzschlüssel.
Keine Spalte trägt Empfänger- oder Inhalts-PII [V24:73–74].

### 5.2 Zustellevidenz `customer_notification_delivery_attempt`

- Append-only; eine Versuchszeile je Sendeversuch mit klassifiziertem
  Retry-Fehler und Evidenz je Versuch [V24:70–71,96–97].
- Ein Storno ist ein Statusübergang der Outbox **ohne** Versuchszeile
  [V24:230–231].
- Idempotenter Doppel-Dispatch erzeugt keine zweite Evidenz [V24:150].

Exakte Spaltennamen/-typen `UNKNOWN` (rekonstruiert: Notification-FK,
Versuchsnummer, Status/Klassifikation, Fehlerklasse, Zeitstempel).

### 5.3 Vier Freeze-Trigger (Angebotssperre)

- Vier Freeze-Trigger verhindern, dass unter einem `cannot_fulfill`-Projekt
  Freigabekandidaten, Genehmigungen oder Ausstellungen entstehen [V24:74–76].
- Der Guard feuert **nur auf INSERT**; der Erasure-DELETE-Pfad bleibt frei
  [V24:76–77,157].
- Der Katalog belegt den Guard auf **exakt vier Angebotstabellen** und **nur auf
  INSERT** [V24:156–157].

Die konkrete Tabellenmenge ist in der Vault nicht namentlich genannt. Aus dem
erhaltenen M2-03b1-Schema rekonstruiert und als Inferenz markiert: die vier
INSERT-Ziele, die „Freigabekandidat, Genehmigungen, Ausstellungen“ abbilden —
`offer_release_candidate`, `offer_release_candidate_approval`,
`offer_issuance`, `offer_issuance_approval` [M203B1/0035]. Exaktes Set bleibt
`UNKNOWN`, bis der Root-Integrator es aus dem Rollenvertrag bestätigt.

- Das Prädikat „verbindlich ausgestellt“ ist „Approval ohne Withdrawal“, nicht
  ein bloßes `issued`-Flag [V24:118].
- Die Laufzeitrolle erfragt es über die schmale Definer-Kapsel
  `_m111b_project_has_binding_issuance(uuid, uuid)` (Boolean; Grant nur
  `app_runtime`) [V24:192–193].
- Der Genehmigungspfad verzichtet auf einen Vorabcheck; dort ist die Ausstellung
  unsichtbar, der DB-Guard ist die einzige richtige Stelle. Sein Fehler wird in
  einen `project_cannot_fulfil_locked`-Conflict übersetzt statt roh nach außen
  zu gelangen [V24:195–198].

### 5.4 Erasure-Integration

- `erase_inactive_lead` wird **quellgepinnt** erweitert: Notification-Zeilen des
  Contact-Graphen werden mitgelockt; `queued` wird zu
  `cancelled_contact_erased` storniert [V24:81–83].
- Die Erasure-Funktion trägt beide Anker aus Migration 0040 nachweislich im
  Live-Quelltext [V24:154–155].
- Eine Erasure, die während einer laufenden Transition committet, **gewinnt**:
  Outcome, Outbox und Evidenz rollen vollständig zurück [V24:152–154].
- Der Freeze-Guard lässt den Erasure-DELETE-Pfad frei, weil er nur auf INSERT
  feuert [V24:76–77,157].

### 5.5 Worker-Zugriffskapseln (SECURITY DEFINER)

- Drei Worker-Zugriffskapseln als SECURITY DEFINER, weil `app_worker` bewusst
  keine Tabellenrechte auf `project`/`contact` hat (Entscheidung aus ADR 0003
  bzw. Migration 0039) [V24:84–85,119].
- Genau eine Kapsel ist in der Vault namentlich belegt:
  `_m111b_project_has_binding_issuance(uuid, uuid)` (Runtime-Grant, siehe §5.3)
  [V24:192–193]. Die Namen der drei **Worker**-Kapseln (Empfängerauflösung,
  Zustell-/Storno-Übergang) sind `UNKNOWN`.

### 5.6 Dispatch-Einstieg `pgboss.enqueue_customer_notification`

- `pgboss.enqueue_customer_notification` folgt dem Muster von Migration 0035
  (`pgboss.enqueue_offer_issuance`): Job und Outbox-Zeile entstehen in
  derselben Transaktion [V24:86–87, M203B1/0035].
- Die Queue `notification.customer` ist im Rollenvertrag gepinnt [V24:104–105].

### 5.7 Drei quellgepinnte Ersetzungen der M1-11a-Funktionen

Migration 0040 ersetzt drei M1-11a-Funktionen; jede prüft den exakten SHA-256
des Ist-Standes und genau einen eindeutigen Anker, sonst bricht die Migration ab
[V24:78–80]. Die ersetzten Funktionen sind aus der erhaltenen Migration 0039
identifizierbar [M111A/0039]:

| M1-11a-Funktion (ersetzt) | Rolle | M1-11b-Änderung |
|---|---|---|
| `_m111a_guard_project_outcome()` | Transition-Guard | erlaubt zusätzlich `open → cannot_fulfill` [V24:115] |
| `_m111a_record_project_outcome()` | Evidenz-Trigger (Event + Audit) | kennt die neue Kante und den neuen Eventtyp [V24:116] |
| `_m111a_guard_outcome_evidence_insert()` | Evidenz-/Fälschungs-Whitelist | deckt den neuen Eventtyp [V24:117] |

Die Ersatznamen sind rekonstruiert als `_m111b_*` (exakte Namen `UNKNOWN`).
Der neue Eventtyp folgt dem M1-11a-Muster und ist rekonstruiert als
`project.outcome_cannot_fulfil` (exakter Name `UNKNOWN`).

## 6. Commands und Actions

Version `project-outcome-command.v1` [V24:91, M111A]:

- Bestehend: `mark_won`, `mark_lost`, `reopen` — bleiben gültig [V24:91–92].
- **Neu (additiv):** `mark_cannot_fulfill(projectId, expectedOutcomeRevision,
  confirmation=true)` [V24:91–92, rekonstruierte Signatur nach M111A-Muster].

Ablauf der Transition [V24:93–95]:

1. Project-Lock und CAS auf `expectedOutcomeRevision` (wie M1-11a) [M111A].
2. Prüfung auf verbindlich ausgestelltes Angebot über
   `_m111b_project_has_binding_issuance(uuid, uuid)` [V24:192–193]; bei Treffer
   Abbruch als `project_cannot_fulfil_locked`-Conflict [V24:197].
3. Project-Update, Outbox-Insert und Dispatch
   (`pgboss.enqueue_customer_notification`) in **derselben** Transaktion
   [V24:86–87,94–95].
4. Abgeschlossen-Liste um `cannot_fulfill` erweitert [V24:95].

Actions akzeptieren ausschließlich allowlistete Felder, reautorisieren jede
Anfrage und lesen Project/Membership serverseitig neu. Erwartete Fehler als
`invalid`, `not_found`, `conflict`, `illegal_transition`,
`unauthenticated` oder `denied`; unbekannte Fehler bleiben laut [M111A].

## 7. Rollen- und Datenvertrag

Neue/erweiterte Action `project.outcome.write` (aus M1-11a übernommen) [M111A]:

| Actor | Abschlussliste + Detail | `mark_cannot_fulfill` | Zustellstatus lesen |
|---|---:|---:|---:|
| interner Viewer | ja | nein | ja (ohne PII) |
| interner Editor | ja | ja | ja (ohne PII) |
| interner Admin | ja | ja | ja (ohne PII) |
| `external_only` | nur zugewiesene offene Sicht | nein | nein |
| revoked/fremder Actor | nein | nein | nein |
| Worker/Auth/System | nein | nein | nein |

- `project.outcome.write` ist `internalOnly`, mindestens Editor [M111A].
- Viewer, External und Fremdmandant bleiben in SQL, Actions, RSC und HTML
  fail-closed; es entsteht dabei keine Outbox-Zeile [V24:144–145].
- Der Zustellstatus der Kundenmail wird **ohne PII** angezeigt [V24:100–101].
- Worker-Zugriff ausschließlich über die drei SECURITY-DEFINER-Kapseln; kein
  direktes SELECT auf `project`/`contact` für `app_worker` [V24:84–85,119].

## 8. Event-, Audit- und Activity-Vertrag

- Event und Audit entstehen genau einmal aus dem DB-Trigger, nicht im Service
  [V24:116,142].
- Neuer Eventtyp rekonstruiert als `project.outcome_cannot_fulfil`; Whitelist und
  Evidenz-Trigger decken ihn [V24:116–117].
- Payloads bleiben minimal (Project-ID, vorheriger/nächster Outcome,
  Outcome-Revision), ohne PII/Freitext [M111A, „Event-, Audit- und
  Activity-Vertrag“].
- Die Projektaktivität zeigt ein festes deutsches Ereignislabel, rendert weder
  rohen Payload noch Benachrichtigungsinhalte [M111A].

## 9. Lock- und Race-Vertrag

- Outcome-Mutation sperrt zuerst das Project, danach bei Bedarf abhängige
  Aggregate; Update trägt erwarteten Outcome, Revision und unveränderten
  Request-Scope im WHERE; null Zeilen = Konflikt [M111A].
- Event, Audit, Project-Update, Outbox-Insert und Dispatch committen in
  derselben Transaktion [V24:86–87,94–95].
- Erasure sperrt bereits Project vor abhängigen Aggregaten und nutzt denselben
  ersten Lock; eine gewonnene Erasure kann nicht wiederauferstehen [M111A,
  V24:152–154].
- **Offener Nachweis:** die Kreuzung Transition gegen parallel laufende
  `approve_offer_issuance` benötigt Offer-, Variant- und Kandidaten-Fixtures
  [V24:209]. Der Erasure-Race ist belegt, der Ausstellungs-Genehmigungs-Race
  nicht.

## 10. UI-Vertrag

- Dritte Abschlussaktion in der Projektakte samt Warnung [V24:100].
- Zustellstatus der Kundenmail ohne PII [V24:100–101].
- Dritter Filter in der Abgeschlossen-Liste (neben `Alle`/`Gewonnen`) [V24:101,
  vgl. V24:146–147].
- Sperrmeldungen in beiden Angebots-Panels [V24:102].
- Viewer sieht Status ohne Mutationscontrols [V24:135–137, M111A].
- Bestätigung nennt die konkrete, endgültige Zustandsänderung; kein Reopen-
  Control nach `cannot_fulfill` [V24:225–226, M111A].
- Kein Farbsignal ohne Text/Icon; Touchziele ≥ 44 px; kein horizontaler
  Overflow bei 320/375 px [M111A].

## 11. Testmatrix

Belegter Stand aus `npm run check`: 175/175 Testdateien, 1.739 bestandene Tests,
1 opt-in übersprungen; darin 9 Contract-, 5 Build-UI-, 4 Unit- und
Datenbanktests für M1-11b [V24:132–133]. Rollenvertrag 88/88, PostgreSQL-18
5/5, Migration auf frischer Datenbank, `db:generate` ohne Drift, Build und
`git diff --check` grün [V24:125–133].

### 11.1 Datenbankfälle (`tests/db/m111b-cannot-fulfil-service.test.ts`)

Gegen echtes PostgreSQL belegt [V24:139–150]:

1. terminale Transition samt Outbox-Zeile und gesperrter Folgekante
2. Event und Audit genau einmal aus dem Trigger
3. gefälschter Evidenz-Insert scheitert
4. jede verbotene Kante einschließlich Reopen
5. Revisionskonflikt
6. unbekanntes Projekt
7. gelöschter Contact
8. Viewer fail-closed (ohne Outbox-Zeile)
9. External fail-closed (ohne Outbox-Zeile)
10. Fremdmandant fail-closed (ohne Outbox-Zeile)
11. Outbox-Guard: Insert ohne `cannot_fulfill`
12. Outbox-Guard: illegale Statusübergänge
13. Outbox-Guard: DELETE
14. `cannot_fulfill` als dritter Abschlussfilter neben `won` und `all`
15. Worker-Kapsel: Empfängerauflösung
16. Worker-Kapsel: Storno nach Löschung
17. Worker-Kapsel: Zustellung
18. Worker-Kapsel: Wiederholung und idempotenter Doppel-Dispatch
19. Worker-Kapsel: append-only Evidenz

> **Zählungshinweis:** V24:139 überschreibt „Die 19 Datenbanktests“, während
> V24:133 und L01:53 von „20 Datenbanktests/Fällen“ sprechen; die Commitliste
> (V24:34) zählt „15 + 4 = 19“. Die Differenz 19/20 ist `UNKNOWN` und gehört
> vor die Abnahme geklärt.

### 11.2 Heikelste Kanten (zusätzlich)

- Erasure-Kreuzung: eine während der laufenden Transition committende Erasure
  gewinnt; Outcome, Outbox und Evidenz rollen vollständig zurück. Die
  Erasure-Funktion trägt beide Anker aus Migration 0040 im Live-Quelltext.
  [V24:152–155]
- Freeze-Guard doppelt belegt: Katalog zeigt ihn auf exakt vier
  Angebotstabellen und nur auf INSERT; ein Freigabekandidat unter einem
  geschlossenen Projekt wird mit der Guard-Meldung abgewiesen. [V24:156–159]

### 11.3 Race gegen `approve_offer_issuance`

**Erforderlich, aber noch nicht belegt.** Die zweite Kreuzung — Transition
gegen eine parallel laufende `approve_offer_issuance` — braucht Offer-, Variant-
und Kandidaten-Fixtures [V24:209].

### 11.4 Chromium-E2E (4/4 grün)

1. Editor-Abschluss mit eingefrorener Akte
2. Abgeschlossen-Liste
3. Viewer read-only
4. External abgewiesen

inklusive Axe, Tastatur und 375 px [V24:135–137].

### 11.5 Regressionen in Bestandstests

Sieben Bestandspins wurden angepasst (Fixtures, Rollenvertrags-Abschnitt,
Exportliste, Journalpositions-/Längenprüfungen, ACL-Liste); keiner war ein
Defekt im neuen Code [V24:161–178].

## 12. Abschlussgates

Technisch grün [V24:125–133]: `npm run check` (175/175, 1.739), Rollen 88/88,
PG18 5/5, Fresh-Migration mit Quellhashes/Ankern, `db:generate` ohne Drift,
Build, Typecheck/ESLint, `git diff --check`, Chromium 4/4.

Vor einer Abnahme noch offen [V24:204–218]:

1. **Unabhängiger Security-/Race-/Privacy-Review** — noch nicht durchgeführt
   (wichtigster offener Punkt; keine offenen P0–P2 zulässig).
2. **Race gegen `approve_offer_issuance`** — Fixtures fehlen.
3. **Vollständiger Erasure-Lauf mit Storno** — Lock/Storno sind verankert, ein
   Lauf mit echter Eligibility und Tombstone fehlt.
4. **Worker-Zustelltests in Node** — Retry-Backoff/Transportklassifikation nur
   über DB-Kapseln belegt, der TypeScript-Handler nicht direkt getestet.
5. **Wechselnde Ausfälle in fremden Chromium-Specs** (`m1-08b`, `m1-10`,
   `m2-03a`) — Flake vs. Regression ungeklärt [V24:214–218].

Paritätsregister (`STATUS.md`, `CAPABILITY-MATRIX.md`, `TEST-EVIDENCE.md`)
werden bewusst erst nach dem Review aktualisiert [V24:212].

## 13. Nichtziele

- Kein Reopen nach `cannot_fulfill`; keine Wiedervorlage-Automation [V24:225–226].
- Kein Vorlagen-Editor, kein Freitext für die Kundenmail [V24:229].
- Kein PII (Empfängeradresse/Mailtext) in der Datenbank [V24:73–74].
- Keine Änderung an Offer-/Signatur-/Installationsautomation über die
  Angebotssperre hinaus [V24:74–76].
- Keine Lost-and-Archive-, Archivierungs- oder Restore-Funktion [M111A].
- Keine private Reonic-Texte, UI, Daten, Taxonomie oder
  Implementierungsdetails; keine Reonic-1:1-Behauptung [V24:237, H22:314–316].

## 14. Festgelegte Namen und Semantik (DECIDED 2026-09-02)

Diese Namen waren in der verlorenen Migration 0040 nicht einzeln belegt und
werden hiermit im Sinne der Clean-Room-Parität als eigene WMEE-Entscheidung
festgeschrieben. Sie sind Teil des Slices und für Migration, Contract, Service,
Worker und Rollenvertrag bindend.

### Status-Enum `customer_notification.status`

`queued`, `delivered`, `failed_retriable`, `failed_final`,
`cancelled_contact_erased`, `cancelled_manual`. `queued` ist der einzige
Ausgangswert. Storno ist der Übergang `queued`/`failed_retriable` → (a)
`cancelled_contact_erased` (DSGVO-Erasure) oder (b) `cancelled_manual`
(fachliches Storno vor Zustellung) — jeweils ohne Versuchszeile.

### Outbox `customer_notification` (Spalten)

`id` (uuid PK), `workspace_id` (uuid), `project_id` (uuid), `status` (text),
`template_id` (text, fest `cannot-fulfil.v1`), `idempotency_key` (text),
`attempt_count` (integer), `next_attempt_at` (timestamptz), `dispatched_at`
(timestamptz), `delivered_at` (timestamptz), `failed_at` (timestamptz),
`error_code` (text), `error_retryable` (boolean), `cancelled_at` (timestamptz),
`created_at` (timestamptz), `updated_at` (timestamptz). Keine Empfänger- oder
Inhalts-PII. Unique `(workspace_id, id)` und `(workspace_id, idempotency_key)`;
Partial-Unique `(workspace_id, project_id)` WHERE `status IN ('queued',
'failed_retriable')` (höchstens eine aktive Notification je Projekt);
FK `(workspace_id, project_id) → project`.

### Zustellevidenz `customer_notification_delivery_attempt` (Spalten)

`id` (uuid PK), `workspace_id` (uuid), `notification_id` (uuid),
`attempt_number` (integer), `outcome` (text: `delivered` | `failed_retriable` |
`failed_final`), `error_class` (text), `occurred_at` (timestamptz). Unique
`(workspace_id, id)` und `(workspace_id, notification_id, attempt_number)`; FK
`(workspace_id, notification_id) → customer_notification`. Append-only,
physisches DELETE verboten.

### Vier Freeze-Tabellen (Angebotssperre, nur INSERT)

`offer_release_candidate`, `offer_release_candidate_approval`, `offer_issuance`,
`offer_issuance_approval` (verifiziert gegen Migration 0034/0035).

### SECURITY-DEFINER-Kapseln

- Runtime: `_m111b_project_has_binding_issuance(uuid, uuid)` (Grant nur
  `app_runtime`).
- Runtime-Lesekapsel: `_m111b_read_notification_delivery(uuid, uuid)` → `TABLE
  (status text, attempt_count integer)` (Grant nur `app_runtime`). Sie liest
  ausschließlich Status + Versuchsanzahl (keine Empfänger-/Text-PII; die Tabelle
  ist ohnehin PII-frei). `app_runtime` erhält **kein** direktes SELECT/UPDATE auf
  `customer_notification` — nur INSERT (Outbox-Zeile im Transition-Tx) und die
  schmale Lesekapsel. Entscheidung nach dem 0035-Muster (`SECURITY DEFINER`,
  `search_path = pg_catalog`, interne Workspace/Projekt-Bindung über die WHERE-
  Klausel), damit die Runtime-Sichtbarkeitsgrenze erhalten bleibt (Chromium-P0:
  `permission denied for table customer_notification`).
- Worker (drei): `_m111b_worker_resolve_recipient(uuid, uuid)`,
  `_m111b_worker_deliver(uuid, uuid, integer, text, text)`,
  `_m111b_worker_cancel_erased(uuid, uuid)`.

### Quellgepinnte `_m111b_*`-Ersatzfunktionen

`_m111b_guard_project_outcome()`, `_m111b_record_project_outcome()`,
`_m111b_guard_outcome_evidence_insert()` (ersetzen die drei `_m111a_*`-
Funktionen; Trigger werden umgehängt, alte Funktionen entfernt).

### Event, Queue, Dispatch, Vorlage

- Eventtyp: `project.outcome_cannot_fulfil`.
- Queue: `notification.customer`.
- Dispatch: `pgboss.enqueue_customer_notification(workspace_id uuid,
  project_id uuid)` — projektbasiert, löst die Notification-ID Definer-seitig
  auf. Der Service schreibt die Outbox-Zeile **ohne `RETURNING`** und braucht
  deshalb keinerlei SELECT auf `customer_notification` (RETURNING verlangt in
  PostgreSQL SELECT auf die Rückgabespalten). Design bleibt Kapsel-only:
  `app_runtime` hat nur INSERT.
- Mailvorlage: `cannot-fulfil.v1` (einzige feste interne Vorlage; kein Editor,
  kein Freitext, kein PII).

## 15. Review-Befunde M1-11b-R1 (Kimi K3, 2026-09-02)

Unabhängige Zweitstimme zu Spec/ADR (`REVIEW-KIMI-M1-11B-SPEC.md`). Auflösungen:

| Befund | Maßnahme |
|---|---|
| **P0-1** Race `mark_cannot_fulfill` ↔ `approve_offer_issuance` | Gemeinsamer Serialisierungspunkt: Freeze-Guard liest die Project-Zeile mit `SELECT … FOR SHARE` (gegen `FOR UPDATE` der Transition), DANN Outcome-Prüfung. `_m111b_project_has_binding_issuance` läuft nach dem Project-`FOR UPDATE`-Lock. DB-Test mit echtem Interleaving (M111B-12). |
| **P1-2** at-least-once | pgboss-`singletonKey` = `notification_id:attempt`; Resend-Idempotency-Key = `notification_id`; Evidenz + Statuswechsel atomar in einer Tx (record-then-send). Ehrlich at-least-once, kein „genau einmal“ behauptet. |
| **P1-3** zwei Retry-Wahrheiten | pgboss ist die einzige Retry-Quelle: Handler wirft retriable Fehler, Outbox wird `failed_retriable`, pgboss retried; Evidenz je Versuch. Monitoring-Abfrage für stuck `queued` dokumentiert. |
| **P1-4** Erasure-TOCTOU | Empfängerauflösung (`FOR UPDATE OF contact`) + Cancel-Check unmittelbar vor Send in kurzer Tx; nach Send Status-Recheck. Nicht „geschlossen“ behauptet — at-least-once mit Storno-Zustandsmaschine. |
| **P1-5** Freeze nur INSERT | Verifiziert: alle vier Freeze-Tabellen entstehen ausschließlich per INSERT (Approvals append-only, Candidates/Issuances per INSERT; worker-`state` ist Fortschritt). Keine Signatur-Tabelle im Scope (M2-03b2 blockiert). Freeze bleibt INSERT-only. |
| **P2-6** Storno nur `queued` | Storno deckt `queued` UND `failed_retriable` (alle nicht-terminalen Zustände). |
| **P2-7** Evidenz-PII | Nur Enum-Fehlercodes (`error_code`/`error_class` ∈ feste Menge) + Metadaten; keine Provider-/SMTP-Rohmeldungen. |
| **P2-8** Eindeutigkeit | Partial-Unique-Index `(workspace_id, project_id)` WHERE `status IN ('queued','failed_retriable')`. |
| **P2-9** Erasure als Undo | `cancelled_manual` ergänzt (fachliches Storno, Outcome bleibt terminal); `cancelled_contact_erased` bleibt DSGVO-Erasure. |
| **P2-10** Definer-Hygiene | Alle Kapseln `SET search_path = pg_catalog`; Binding-Kapsel prüft Workspace/Projekt-Zusammengehörigkeit intern (WHERE-Bindung); Worker-Kapseln setzen den Workspace-GUC intern aus dem Parameter (Quelle Job-Payload) und sind im Rollenvertrag gepinnt. |

### Monitoring-Abfrage (stuck `queued`, P1-3)

```sql
select workspace_id, id, attempt_count, next_attempt_at, created_at
  from customer_notification
 where status = 'queued'
   and next_attempt_at < now() - interval '5 minutes'
 order by next_attempt_at;
```

## 16. Verbleibende UNKNOWN-Lücken (zur Root-Integrator-Klärung)

1. Exakter Status-Enum und Spaltennamen/-typen von `customer_notification` und
   `customer_notification_delivery_attempt` (verlorene Migration 0040).
2. Exaktes Set der vier Angebotstabellen für die Freeze-Trigger (rekonstruiert
   aus M2-03b1, nicht aus Migration 0040).
3. Namen der drei Worker-SECURITY-DEFINER-Kapseln und der drei
   `_m111b_*`-Ersatzfunktionen sowie des neuen Eventtyps.
4. DB-Fallzahl 19 vs. 20 (Widerspruch V24:139 ↔ V24:133/L01:53).
5. Ausstehender Review-Nachweis (Security/Race/Privacy), Race gegen
   `approve_offer_issuance`, vollständiger Erasure-Lauf, Node-Worker-Tests.
