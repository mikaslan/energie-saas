# M1-01 — Die Schlüsselregeln werden zur Test-Invariante

> Status: Spec · erstellt 2026-08-28 · Vorbedingung für die M1-Datenmodellierung
> Anlass: Ist-Bericht vom 2026-08-28. Zwei Prüfungen melden unabhängig, dass der
> Schlüsselregel-Vertrag aus `modules/README.md:16-31` nicht nur ungetestet, sondern
> bereits gebrochen ist.

## Warum jetzt und nicht später

`modules/README.md` erklärt drei Regeln für **bindend** (Anlass: Codex-Review #7 —
Foreign-Key-Prüfungen in PostgreSQL nutzen RLS nicht als Sichtbarkeitsfilter, ein
einspaltiger FK kann also über die Mandantengrenze zeigen):

1. Jede Tenant-Tabelle trägt zusätzlich zum Primary Key ein `UNIQUE (workspace_id, id)`.
2. Jeder FK auf eine Tenant-Entität ist zusammengesetzt, nie einspaltig.
3. Jede Tenant-Tabelle hat einen FK `workspace_id → workspace.id`.

`tests/db/tenant-invariants.test.ts` prüft davon **nichts**. Die Suite deckt RLS,
`workspace_id NOT NULL`, den Policy-Vertrag, die Auth-Allowlist und Matviews ab — die
Schlüsselregeln fehlen vollständig. Entsprechend sind sie stillschweigend gebrochen:
`site` trägt `site_ws_id_uq`, aber `membership`, `domain_events` und `audit_log` nicht.

M1 bringt rund zwanzig neue, querverwiesene Tabellen (Kontakte, Komponenten,
Kanban-Boards und -Spalten, Aufgaben, Notizen, Termine, Lead Sources, Tags). Jede von
ihnen wird auf `site`, `contact` oder einander zeigen. Eine Regel, die nur in einer
Markdown-Datei steht, überlebt zwanzig neue Tabellen nicht. Danach ist die Reparatur
keine halbe Tagesarbeit mehr, sondern eine Migration über zwanzig Tabellen mit
Datenbestand.

## Die eigentliche Entscheidung: Ausnahmen sind Teil der Regel

Blind ein `UNIQUE (workspace_id, id)` auf jede Tabelle zu setzen wäre falsch. Die drei
heutigen Abweichler sind sachlich unterschiedlich:

**`membership`** ist eine gewöhnliche Tenant-Entität. Heute zeigt kein FK auf sie, aber
M1 wird das ändern (Aufgabenzuweisung, Assignment-Sichtbarkeit, `external_only`). Sie
bekommt die Regel-1-UNIQUE. Kein Sonderfall.

**`domain_events` und `audit_log`** sind append-only Protokolle. Auf sie zeigt
definitionsgemäß nie ein FK — sie sind Blätter, keine Knoten. Regel 1 hat für sie keinen
Zweck: die UNIQUE existiert, damit ein zusammengesetzter FK auf sie zeigen *kann*.

Regel 3 ist bei ihnen sogar aktiv schädlich. Ein FK `workspace_id → workspace.id` würde
das Löschen eines Workspace an das Löschen seiner Events koppeln — und beide Tabellen
sind per Trigger (`drizzle/0004`, `drizzle/0005`) gegen DELETE und TRUNCATE gesperrt. Der
FK wäre damit nicht bloß überflüssig, sondern erzeugte einen Zustand, aus dem es keinen
legalen Ausweg gibt. Dieselbe Spannung trifft das DSGVO-Löschkonzept
(`docs/konzepte/dsgvo-loeschkonzept.md`): Events tragen bewusst nur IDs, damit die
Löschung an der fachlichen Tabelle stattfinden kann, während das Protokoll stehen bleibt.

Daraus folgt die Bauform: **die Regeln werden getestet, mit einer expliziten, begründeten
Ausnahmeliste** — genau das Muster, das die Suite mit `TENANT_EXEMPT` und
`MATVIEW_ALLOWLIST` bereits verwendet. Eine Ausnahme kostet einen Eintrag plus
Begründung; das ist die Hürde, die verhindert, dass sie aus Bequemlichkeit entsteht.

## Zu bauen

### 1. `tests/setup/tenant-fixtures.ts` — zwei Ausnahmelisten

```ts
// Regel 1 (UNIQUE (workspace_id, id)): existiert, damit ein zusammengesetzter FK
// auf die Tabelle zeigen kann. Append-only-Protokolle sind Blätter im
// Referenzgraph — auf sie zeigt nie ein FK.
export const COMPOSITE_KEY_EXEMPT = new Set<string>(["domain_events", "audit_log"]);

// Regel 3 (FK workspace_id -> workspace.id): koppelt die Löschbarkeit des
// Workspace an die der Zeile. Bei append-only-Protokollen (drizzle/0004, 0005
// sperren DELETE und TRUNCATE) entstünde ein Workspace, der nicht mehr löschbar
// ist, ohne legalen Ausweg.
export const WORKSPACE_FK_EXEMPT = new Set<string>(["domain_events", "audit_log"]);
```

Beide Listen brauchen — wie `MATVIEW_ALLOWLIST` — den Karteileichen-Test: ein Eintrag für
eine nicht mehr existierende Tabelle ist ein Suite-Fehler.

### 2. `tests/db/tenant-invariants.test.ts` — drei neue Invarianten

Ein eigener `describe("Schlüsselregeln für Tenant-Entitäten")`. Alle drei laufen
generisch über `tables` (die bereits ermittelte Liste der nicht-exemptierten
Tenant-Tabellen), niemals über eine handgepflegte Tabellenliste — sonst veraltet die
Prüfung genau so still wie die Regel selbst.

**Regel 1 — `UNIQUE (workspace_id, id)`.** Über `pg_constraint` / `pg_index`: für jede
Tabelle außer `COMPOSITE_KEY_EXEMPT` muss ein Unique-Constraint oder ein Unique-Index
existieren, dessen Spaltenmenge exakt `{workspace_id, id}` ist. Die Reihenfolge ist
gleichgültig, die Menge nicht.

**Regel 2 — kein einspaltiger FK auf eine Tenant-Entität.** Die schärfste und wichtigste
Prüfung. Über `pg_constraint` mit `contype = 'f'`: für jeden FK, dessen **Zieltabelle**
eine Tenant-Tabelle ist, muss die Spaltenmenge der Quelle `workspace_id` enthalten.
Ausnahme: FKs, deren Ziel `workspace` selbst ist (das ist Regel 3 und per Definition
einspaltig). Diese Prüfung braucht keine Ausnahmeliste — ein einspaltiger FK auf eine
Tenant-Entität ist immer ein Fehler.

**Regel 3 — FK `workspace_id → workspace.id`.** Für jede Tabelle außer
`WORKSPACE_FK_EXEMPT`: es existiert ein FK, dessen Quellspalte `workspace_id` und dessen
Ziel `workspace(id)` ist.

Jede Fehlermeldung nennt die betroffene Tabelle **und** sagt, was zu tun ist — entweder
die Constraint nachziehen oder mit Begründung in die Ausnahmeliste eintragen. Eine
Invariante, deren Fehlschlag man erst debuggen muss, wird umgangen statt befolgt.

### 3. Migration: die Lücke bei `membership` schließen

Eine neue Migration ergänzt `unique (workspace_id, id)` auf `membership`.
`domain_events` und `audit_log` bleiben unberührt — sie stehen in beiden Ausnahmelisten.

Die Migration wird über `npm run db:generate` aus einer Schemaänderung in
`lib/db/schema/core.ts` erzeugt, nicht handgeschrieben: das Schema-Drift-Gate der CI
(`.github/workflows/ci.yml`) verlangt, dass Schema und Migrationen deckungsgleich sind.

### 4. `modules/README.md` — auf den Stand bringen

Der Abschnitt „Durchsetzung" nennt heute nur die drei dependency-cruiser-Regeln. Er muss
ergänzt werden: die Schlüsselregeln werden ab jetzt von
`tests/db/tenant-invariants.test.ts` erzwungen, und Ausnahmen brauchen einen Eintrag mit
Begründung. Ebenso gehört die Begründung für die beiden Protokolltabellen dorthin — sie
ist der interessante Teil und darf nicht nur im Testcode stehen.

## Abnahme

- `npm run check` grün. Die drei neuen Invarianten laufen über alle Tenant-Tabellen.
- **Gegenprobe (der eigentliche Beweis):** ein bewusst falscher, einspaltiger FK auf
  `site` lässt Regel 2 rot werden. Ohne diesen Nachweis ist unklar, ob die Prüfung
  überhaupt greift oder nur über eine leere Menge iteriert. Der Nachweis wird
  durchgeführt und wieder zurückgenommen, nicht committet — er gehört als Notiz in die
  Abschlussmeldung.
- `membership` trägt die UNIQUE, `domain_events` und `audit_log` nicht.

## Bewusst nicht in diesem Schritt

- Keine Änderung an `domain_events` oder `audit_log`. Sie sind append-only; jede
  Strukturänderung dort ist ein eigener, begründeter Vorgang.
- Keine `ON DELETE`-Regeln. Welche Referenz kaskadiert und welche restriktiv ist, ist
  eine fachliche Entscheidung pro Beziehung und gehört zur jeweiligen M1-Entität.
