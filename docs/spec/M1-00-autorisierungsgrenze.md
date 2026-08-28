# M1-00 — Die Autorisierungsgrenze

> Status: Spec · erstellt 2026-08-28 · Vorbedingung für jeden weiteren M1-Baustein
> Anlass: Ist-Bericht vom 2026-08-28, Befund „Die Autorisierungsgrenze existiert nicht"
> (von drei unabhängigen Prüfungen als dringlichste Schuld benannt).

## Warum das zuerst kommt

M0 hat die Tür gebaut, aber niemanden hindurchgeschickt. `withAuthorizedTenant`
(`lib/db/tenant.ts:110`) ist vollständig und korrekt — es hat nur **keinen produktiven
Aufrufer**. Es gibt keine `middleware.ts`, keine Abbildung von der Session auf
`user_identity.id`, keinen Server-Action-Wrapper. Das Denial-Audit-Muster, das
`lib/audit.ts:19-31` als verbindlichen Vertrag beschreibt, existiert ausschließlich als
Simulation in `tests/db/site.test.ts:107-141`.

Die Zusage aus Architektur §4 („erlaubte UND abgelehnte Zugriffe werden protokolliert")
ist damit zur Hälfte eingelöst: der Erfolgspfad ist atomar und getestet, der
Ablehnungspfad hat produktiv niemanden.

Solange diese Grenze fehlt, ist jeder weitere M1-Baustein (Kontakte, Komponenten,
Kanban) gezwungen, seinen eigenen Zugang zu erfinden. Genau so entstehen die Umgehungen,
die `.dependency-cruiser.cjs` mit der Regel `app-nicht-direkt-an-db` verhindern soll.

## Das Kernproblem und seine saubere Auflösung

Die Session kennt nur `auth_user.id` (better-auth). Die Domäne rechnet mit
`user_identity.id`. Dazwischen liegt `user_identity.auth_user_id`
(`lib/db/schema/core.ts:27`).

Der naive Weg wäre, `user_identity` ohne Mandantenkontext nach `auth_user_id`
abzufragen. Das geht nicht, und das ist gut so: die SELECT-Policy aus
`drizzle/0002_rls_user_identity.sql:19-26` macht eine Identität nur sichtbar, wenn sie
in einer Membership **des aktuellen Workspace** steckt.

Daraus folgt die Auflösung — und sie ist strukturell fail-closed:

```
1. Session liefert auth_user.id
2. Request liefert workspace_id
3. In EINER Transaktion mit gesetztem app.workspace_id:
   membership ⋈ user_identity ⋈ workspace, gefiltert auf auth_user_id
4. Kein Treffer  ->  PermissionDeniedError(WORKSPACE_ACCESS)
   Treffer       ->  vollständiger ServiceCtx aus DB-Werten
```

Wer nicht Mitglied des angefragten Workspace ist, bekommt durch die RLS schon die
Identität nicht zu sehen. Es gibt keinen Pfad, auf dem eine fremde Workspace-UUID mit
einer eigenen Rolle kombiniert werden könnte — das ist derselbe Angriff, den
Codex-Review #2 an `withTenant` gefunden hat, hier eine Ebene höher geschlossen.

## Zu bauen

### 1. `lib/session.ts` — Session lesen, sonst nichts

```ts
export type SessionUser = { authUserId: string };
export async function getSessionUser(): Promise<SessionUser | null>;
```

Liest über `getAuth().api.getSession({ headers: await headers() })`. Gibt `null` zurück,
wenn keine gültige Session existiert — wirft nicht, denn „nicht eingeloggt" ist kein
Fehler, sondern ein Zustand.

Diese Datei darf `lib/db/auth-client.ts` **nicht** importieren
(`.dependency-cruiser.cjs`, Regel `auth-client-nur-fuer-lib-auth`). Der einzige Weg zur
Session führt über `lib/auth.ts`.

### 2. `lib/db/tenant.ts` — `withSessionTenant` ergänzen

```ts
export function withSessionTenant<T>(
  authUserId: string,
  workspaceId: string,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T>;
```

Analog zum vorhandenen `runAuthorized`, aber die Membership wird über
`user_identity.auth_user_id` gefunden statt über eine bereits bekannte
`user_identity.id`:

```sql
select ui.id as user_identity_id, m.role, m.capabilities, w.feature_flags
from membership m
join user_identity ui on ui.id = m.user_id
join workspace w on w.id = m.workspace_id
where ui.auth_user_id = $1
  and m.workspace_id = $2::uuid
```

Alle drei Tabellen unterliegen dabei ihren eigenen Policies — die Abfrage ist damit
dreifach abgesichert, nicht einfach.

Ohne Treffer: `PermissionDeniedError(WORKSPACE_ACCESS, "workspace", "not a member")`.
Rolle wird wie in `runAuthorized` zusätzlich über `isRole()` laufzeitvalidiert.

Eine Testvariante `withSessionTenantOn(pool, …)` analog zu den bestehenden
`*On`-Funktionen, damit die Tests ohne `POSTGRES_URL` laufen.

**Refactoring-Hinweis:** `runAuthorized` und die neue Funktion unterscheiden sich nur im
`where`. Der gemeinsame Teil (Rollenvalidierung, `asFlagRecord`, ctx-Bau) gehört in eine
private Hilfsfunktion — aber ohne die vorhandenen Kommentare zu verlieren.

### 3. `lib/action.ts` — der Wrapper, der den Vertrag durchsetzt

Das ist das Herzstück. Er ist die einzige Stelle im System, an der der
Denial-Audit-Vertrag aus `lib/audit.ts:19-31` tatsächlich vollzogen wird.

```ts
export class NotAuthenticatedError extends Error {}

export async function authorizedAction<T>(
  workspaceId: string,
  action: DeniedAction,        // für den Denial-Audit, falls die Grenze selbst ablehnt
  resource: string,
  fn: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T>;
```

Ablauf:

1. `getSessionUser()`. Kein Nutzer → `NotAuthenticatedError`. **Kein Audit** — ohne
   Session gibt es keinen Akteur und keinen belegbaren Workspace-Bezug; ein Eintrag wäre
   mit einer beliebigen UUID aus dem Request beschreibbar und damit ein
   Audit-Spam-Vektor.
2. `withSessionTenant(authUserId, workspaceId, fn)`.
3. `PermissionDeniedError` abfangen und nach Ursprung unterscheiden:
   - **Service-Denial nach erfolgreicher Membership-Auflösung** (`can()` lehnt ab):
     Denial-Audit in einer **neuen, eigenen** Transaktion nach dem Abort schreiben —
     `withTenant(workspaceId, tx => writeAudit(tx, …))`, mit `allowed: false`.
   - **Grenz-Denial ohne Membership** (`WORKSPACE_ACCESS`): **kein** Eintrag in
     `audit_log`. Ohne verifizierten Bezug zwischen Akteur und Workspace ist ein
     Audit-Eintrag kein Nachweis, sondern ein vom Angreifer beschreibbares Feld in
     einer append-only-Tabelle. Das ist dieselbe Logik wie bei „keine Session“.
     Der Vorfall verschwindet nicht: er wird als System-Sicherheitsereignis an
     Sentry gemeldet (`captureMessage`, Level `warning`, Felder `authUserId`,
     `workspaceId`, `action`, `resource`), sofern `SENTRY_DSN` gesetzt ist.
   Danach den Fehler erneut werfen.
4. Andere Fehler unverändert durchreichen. Der Wrapper ist keine Fehlerbehandlung.

**Der Akteur im Denial-Audit.** `audit_log.actor` ist `text` (nicht `uuid`,
`lib/db/schema/events.ts:29`), und `domain_events.actor` dokumentiert bereits die
Konvention `"system"` / `"api:<key>"`. Zwei Fälle:

- Der Fehler kam **aus einem Service** (Membership existiert, `can()` hat abgelehnt):
  Akteur ist die `user_identity.id` aus dem ctx.
- Der Fehler kam **von der Grenze selbst** (`WORKSPACE_ACCESS`, keine Membership):
  Es gibt keine sichtbare `user_identity.id` und keinen verifizierten Workspace-Bezug.
  Deshalb gibt es in diesem Fall **keinen Tenant-Audit**. Die `auth_user.id` bleibt
  als `authUserId` im System-Monitoring, nicht in der Mandanten-Audit-Tabelle.

Damit der erste Fall den ctx kennt, muss `withSessionTenant` den ermittelten
`ServiceCtx` auch im Fehlerfall nach außen reichen. Sauberste Variante: der Wrapper hält
eine `let resolvedActor: string | undefined`, die `withSessionTenant` über einen
optionalen Callback setzt, bevor `fn` läuft. Alternative (bevorzugt, weil ohne
Seiteneffekt): `PermissionDeniedError` um ein optionales Feld `actor` erweitern, das
`can()`-Ablehnungen in Services mitgeben — dann trägt der Fehler seinen Akteur selbst.
**Entscheidung: die Fehler-Erweiterung.** Sie ist explizit, testbar und erzeugt keinen
verborgenen Zustand im Wrapper.

### 4. Route-Form

Workspace-Auflösung über den Pfad: `app/w/[workspaceId]/…`. Explizit statt implizit —
kein „aktueller Workspace" in Cookie oder Session, der beim zweiten Browser-Tab
auseinanderläuft. Der Wrapper bekommt die `workspaceId` als Argument, validiert sie aber
nicht selbst als UUID; das erledigt die Route per `zod` vor dem Aufruf, damit ein
Nicht-UUID-Segment gar nicht erst eine Transaktion öffnet.

## Tests (TDD — zuerst schreiben)

`tests/db/authorization-boundary.test.ts`, gegen die echte Test-DB:

1. **Mitglied, ausreichende Rolle** → `fn` läuft, ctx trägt Rolle/Capabilities/Flags aus
   der DB, Erfolgs-Audit liegt in derselben Transaktion.
2. **Mitglied, unzureichende Rolle** (viewer ruft `createSite`) → `PermissionDeniedError`,
   die abgebrochene Transaktion hinterlässt **keinen** Audit, und der Wrapper hat einen
   Denial-Audit mit `allowed = false` und `actor = <user_identity.id>` geschrieben.
   Das ist `tests/db/site.test.ts:107-141`, jetzt gegen echten Produktivcode statt
   simuliert.
3. **Keine Membership im angefragten Workspace** → `PermissionDeniedError(WORKSPACE_ACCESS)`,
   kein Audit-Eintrag im angefragten Workspace; stattdessen Sentry-Warnung hinter
   `SENTRY_DSN`.
4. **Fremder Workspace mit eigener Rolle** — der Angriff aus Codex-Review #2, eine Ebene
   höher: Nutzer ist Admin in Workspace A und ruft mit `workspaceId = B`. Muss abgelehnt
   werden, obwohl seine Rolle nominell ausreicht.
5. **Keine Session** → `NotAuthenticatedError`, **kein** Audit-Eintrag in irgendeinem
   Workspace.
6. **Identität ohne `auth_user_id`** (eingeladen, nie eingeloggt) → keine Auflösung,
   Ablehnung wie 3.

## Abnahme

- `npm run check` grün, `npm run build` grün.
- `modules/sites` wird über den Wrapper aufgerufen, nicht mehr nur aus Tests.
- `grep -rn "withTenant(" app/ modules/` findet **keinen** Treffer außerhalb von
  System-/Worker-Pfaden — der legale Weg für Nutzeraktionen ist ausschließlich
  `authorizedAction`.
- Der Kommentar in `lib/audit.ts:28-31` („Dieses Boundary-Pattern selbst landet erst mit
  Task 9") wird auf den tatsächlichen Ort aktualisiert.

## Bewusst nicht in diesem Schritt

- Kein `middleware.ts`. Die Grenze gehört in die Server-Action, nicht in eine
  Edge-Middleware: Middleware sieht keine Transaktion und kann den Audit-Vertrag nicht
  einhalten. Middleware kommt später höchstens für Redirects Unangemeldeter.
- Keine Workspace-Umschaltung im UI, keine Einladungen, keine Rollenverwaltung — das ist
  eigener M1-Stoff und braucht diese Grenze als Vorbedingung.
- Keine API-Keys / `api:<key>`-Akteure. Erst mit der REST-API in M8.
