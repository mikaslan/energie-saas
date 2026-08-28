# Ist-Bericht 02 — Mandantentrennung und Sicherheit (M0-Fundament)

Stand: 2026-08-28 · Branch: `tooling` · Reine Repo-Analyse ohne Änderung an Produktivcode.

Gegenstand: die 17 Migrationen unter `drizzle/`, die Datenbank-Zugriffsschicht (`lib/db/`),
die Rechteprüfung (`lib/permissions.ts`), Event- und Audit-Log (`lib/events.ts`,
`lib/audit.ts`), die Authentifizierung (`lib/auth.ts`), der Objektspeicher
(`lib/storage/`), die Testsuite zur Mandantenisolation sowie Konfiguration und Secrets.

---

## 1. Gesamturteil

**Es wurde kein Fail-Open in der Mandantentrennung gefunden.** Alle fünf mandantenbezogenen
Tabellen tragen Row Level Security mit `FORCE`, jede hat genau eine permissive Policy mit
identischem Prädikat in `using` und `with check`, und die Testsuite leitet ihre Tabellenliste
aus dem Systemkatalog ab statt aus einer Handliste. Die Nachweise sind nicht behauptet,
sondern als laufende Tests hinterlegt — einschließlich echter Angriffstests, die den jeweils
vorher gefundenen Fehler nachfahren.

Das ist die gute Nachricht. Die zweite Hälfte des Bildes ist genauso wichtig:

**Die erste Rechteschicht (Mandant) ist strukturell abgesichert. Die zweite und dritte
Schicht (Rolle, Einzelrecht) sind es nicht.** Ob ein Betrachter zum Bearbeiter wird,
entscheidet ausschließlich Anwendungscode, der `can()` aufruft. Die Datenbank hat davon keine
Kenntnis: ein Mitglied mit Rolle `viewer` darf unter der `tenant_isolation`-Policy seine
eigene `membership`-Zeile per `update … set role = 'admin'` verändern. Heute ist das nicht
ausnutzbar, weil überhaupt kein Request-Pfad die Domänendatenbank erreicht — aber genau
diese Schranke fällt mit der ersten Zeile M1-Code.

**Die Autorisierungsgrenze existiert noch nicht.** `withAuthorizedTenant` und `withTenant`
(die Produktionsvarianten, die den App-Pool nutzen) werden im gesamten Produktivcode an
**keiner einzigen Stelle** aufgerufen — nur die `…On`-Testvarianten in `tests/`. Es gibt
keine Middleware, keinen Server-Action-Wrapper und keine Funktion, die eine better-auth-Session
auf eine `user_identity.id` abbildet. Das M0-Fundament ist damit fail-closed, aber der Teil,
der die Mandantengrenze im laufenden Betrieb tatsächlich zieht, ist ungebaut und ungetestet.

**Der Objektspeicher hat gar keine Mandantengrenze.** `lib/storage/s3.ts` nimmt für
`getSignedReadUrl`, `put` und `getSignedUploadUrl` beliebige Schlüssel entgegen, ohne sie zu
validieren oder an einen Workspace zu binden. Der Quelltext sagt das offen und vertagt es auf
M2. Solange kein Aufrufer existiert, ist es kein akutes Leck; sobald der erste Upload-Endpunkt
gebaut wird, ist es eines.

---

## 2. Ebene 1 — Row Level Security in der Datenbank

### 2.1 Tabelleninventar

| Tabelle | Mandantenschlüssel | RLS aktiv | FORCE | Policy | FK → `workspace` | `UNIQUE (workspace_id, id)` |
| --- | --- | --- | --- | --- | --- | --- |
| `workspace` | `id` | ja (`0001`) | ja | `tenant_isolation` (ALL) | — | Primärschlüssel |
| `membership` | `workspace_id` | ja (`0001`) | ja | `tenant_isolation` (ALL) | ja (`0000`) | **nein** |
| `site` | `workspace_id` | ja (`0008`) | ja | `tenant_isolation` (ALL) | ja (`0010`) | ja (`site_ws_id_uq`) |
| `domain_events` | `workspace_id` | ja (`0004`) | ja | `tenant_isolation` (ALL) | **nein** | **nein** |
| `audit_log` | `workspace_id` | ja (`0004`) | ja | `tenant_isolation` (ALL) | **nein** | **nein** |
| `user_identity` | global, keine Spalte | ja (`0002`) | ja | vier Policies, siehe 2.4 | — | — |
| `auth_user`, `auth_session`, `auth_account`, `auth_verification`, `auth_rate_limit` | — | **nein** | nein | keine | — | — |

Es gibt keine mandantenbezogene Tabelle ohne Policy. Es gibt keine Tabelle mit `ENABLE`, aber
ohne `FORCE`. Das ist der entscheidende Punkt, weil die Anwendungsrolle in M0 zugleich
Eigentümerin aller Tabellen ist — ohne `FORCE` wären sämtliche Policies für sie wirkungslos.

### 2.2 Das Prädikat, und warum `nullif` darin nicht kosmetisch ist

Alle fünf Policies tragen exakt:

```sql
workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
```

Der Grund steht ausführlich in `drizzle/0001_rls_core.sql:1-10` und ist korrekt: auf einer
Verbindung, die den Parameter noch nie gesehen hat, liefert `current_setting(…, true)` NULL.
Nach einer `withTenant`-Transaktion mit `set_config(…, true)` fällt der Wert auf einer
wiederverwendeten Pool-Verbindung jedoch nicht auf NULL zurück, sondern auf den leeren String.
`''::uuid` würde **werfen** statt fail-closed NULL zu liefern; ein Fehler statt einer leeren
Ergebnismenge wäre zwar nicht unsicher, aber `nullif` macht das Verhalten definiert. Dass das
tatsächlich so ist, prüft `tests/db/tenant-invariants.test.ts:183-198` mit einem eigens
frisch geöffneten Pool.

### 2.3 Der Policy-Vertrag

`drizzle/0013_rls_policy_contract.sql` ändert nichts am Schema; es hält den Vertrag fest:
genau **eine** permissive Policy je Mandantentabelle, `FOR ALL`, identisches Prädikat in
`using` und `with check`, jeder Zusatzfilter zwingend `as restrictive`. Der Hintergrund ist
richtig erkannt: PostgreSQL verknüpft permissive Policies mit ODER, eine zweite permissive
Policy würde die Grenze also *öffnen*. Der in der Architektur vorgesehene
`external_only`-Filter (externe Monteure sehen nur zugewiesene Projekte) wäre als permissive
Policy nicht nur wirkungslos, sondern aktiv schädlich.

Durchgesetzt wird der Vertrag maschinell in `tests/db/tenant-invariants.test.ts:200-257`, und
zwar mit **exaktem** Vergleich des normalisierten Prädikats gegen eine im Test hinterlegte
kanonische Zeichenkette — nicht per Substring. Das ist der Unterschied, der zählt: eine
frühere Fassung hätte ein korrektes `using` in Kombination mit `with check (true)`
anstandslos durchgewinkt.

### 2.4 `user_identity` — der begründete Sonderweg

`user_identity` hat keine `workspace_id` (eine Identität kann in mehreren Workspaces
Mitglied sein) und trägt deshalb vier Policies statt einer:

1. `user_identity_select` (`0002`) — sichtbar nur, wenn eine Membership im aktuellen
   Workspace existiert.
2. `user_identity_insert` (`0002`) — `with check (true)`, bewusst uneingeschränkt.
3. `user_identity_reconcile_select` (`0014`, verengt in `0015`) — nur für die Rolle
   `identity_reconciler`, nur außerhalb jedes Mandantenkontexts, nur für genau eine E-Mail.
4. `user_identity_reconcile_update` (dito).

Es gibt **keine** DELETE-Policy. Unter `FORCE` heißt das: `delete from user_identity` ist für
jede Rolle wirkungslos, auch für den Eigentümer
(`tests/db/identity-and-site-keys.test.ts:108-117`).

Der Kopplungsweg `user_identity.auth_user_id ← better-auth` ist die aufwendigste Konstruktion
im ganzen Fundament, und sie ist sauber: eine eigene, anmeldeunfähige Definer-Rolle
`identity_reconciler`, die keine einzige Tabelle besitzt, mit `inherit false, set false` an
die App-Rolle gebunden, sodass diese die Rolle weder erbt noch per `SET ROLE` annehmen kann.
Das Fenster ist zusätzlich transaktionslokal auf eine E-Mail verengt. Der Angriff, der gegen
die Vorgängerfassung (`0014`, Policies noch `TO PUBLIC`) funktionierte, ist als Test
konserviert (`tests/db/identity-and-site-keys.test.ts:291-358`) und schlägt fehl. `0016`
entfernt außerdem die auskunftsfreudige Fehlermeldung, die im Konfliktfall die bestehende
`auth_user_id` preisgab; auch das ist als Test festgehalten (Zeilen 220-249, geprüft wird die
gesamte Fehlerkette, nicht nur `.message`).

Der Trigger `user_identity_link_auth_only` (`0011:40-54`) wirkt unabhängig von RLS und
verhindert ein Umbiegen der Kopplung selbst gegenüber einem Superuser.

**Kritikpunkt zu Policy 2:** `with check (true)` bedeutet, dass jede Transaktion in
*irgendeinem* Workspace eine Identität mit *beliebiger* E-Mail anlegen darf. Zusammen mit dem
globalen Unique-Index `user_identity_email_lower_uq` (`0010:4`) ergibt das zwei
Nebenwirkungen, die nirgends im Repo benannt sind:

- **Existenz-Orakel über Mandantengrenzen hinweg.** Ein Insert für `chef@konkurrent.de`
  scheitert genau dann mit `user_identity_email_lower_uq`, wenn diese Adresse auf der
  Plattform bereits existiert. Der Sichtschutz aus `0002` wird dadurch am Fehlerkanal
  vorbei umgangen — dieselbe Klasse von Leck, die `0016` an der Reconcile-Funktion
  geschlossen hat.
- **Vorbelegen einer fremden Identität.** Wer eine Identität für eine noch nicht registrierte
  Adresse anlegt und ihr im eigenen Workspace eine Membership gibt, hat die Person beim ersten
  Login stillschweigend im eigenen Workspace. Der Reconcile trägt `auth_user_id` genau in diese
  vorhandene Zeile nach (`0016:68-73`) — das ist das *gewollte* Einladungsverhalten, aber es
  gibt heute weder ein `can()`-Gate noch einen Audit-Eintrag davor.

Beides ist derzeit nicht ausnutzbar (kein Request-Pfad). Beides ist genau das, was der
M1-Einladungsfluss richtig machen muss.

### 2.5 Append-only für Outbox und Audit

`domain_events` und `audit_log` sind doppelt geschützt:

- Row-Level-Trigger gegen `UPDATE` und `DELETE` (`0004:11-14`),
- Statement-Level-Trigger gegen `TRUNCATE` (`0005:10-13`).

Der zweite Trigger ist der wichtige: ein Row-Level-Trigger feuert bei `TRUNCATE` nie, und RLS
greift dort ebenfalls nicht. Ohne ihn hätte die App-Rolle als Eigentümerin den gesamten
Audit-Bestand mit einem Statement löschen können. Beide Wege sind als Test hinterlegt
(`tests/db/events.test.ts:75-121`), verhaltensbasiert und nicht per Katalogabfrage — das ist
die stärkere Variante.

Trigger wirken unabhängig von RLS und auch gegen den Tabelleneigentümer. Das ist der
einzige Schutz im M0-Fundament, der die DDL-Vollmacht der App-Rolle wirklich übersteht —
solange niemand den Trigger droppt, was der Eigentümer allerdings darf (siehe 2.7).

### 2.6 Die `auth_*`-Tabellen tragen keine RLS

Das ist eine bewusste Entscheidung: better-auth verwaltet diese Tabellen selbst und braucht
sie global. Abgesichert wird das nicht in der Datenbank, sondern durch drei Grenzen im Code:

- ein eigener Pool `lib/db/auth-client.ts` mit einem Drizzle-Schema, das **nur** die
  `auth_*`-Tabellen kennt,
- der Ausschluss von `lib/db/schema/auth.ts` aus dem Haupt-Barrel (`lib/db/schema/index.ts:1-13`),
- zwei dependency-cruiser-Regeln (`auth-schema-ist-privat`, `auth-client-nur-fuer-auth`).

Das ist konsequent gedacht — `auth_user` repliziert sämtliche Plattform-E-Mails ohne
Sichtschutz, ein vergessenes `WHERE` dort läse genau die Cross-Tenant-Daten, die die
`user_identity`-RLS schützen soll. Die Absicherung ist aber **rein statisch**: sie hält,
solange niemand eine Ausnahme in die Regel schreibt, und sie deckt nur die Verzeichnisse ab,
die `npm run depcruise` scannt (siehe 3.3).

Bemerkenswert und gut: `auth_verification` enthält keine verwendbaren Credentials.
Magic-Link-Token werden gehasht (`storeToken: "hashed"`), OTPs symmetrisch verschlüsselt
(`storeOTP: "encrypted"` — richtig begründet, ein sechsstelliger Code hat rund 20 Bit Entropie
und wäre als nackter Hash offline brechbar). Beides ist als Test abgesichert
(`tests/db/auth.test.ts:182-220`).

### 2.7 Welche Rolle RLS umgehen kann

Kurz: **keine, die im Betrieb verwendet wird** — mit einer wichtigen Einschränkung.

- `scripts/migrate.mts:26-35` ist ein hartes Gate ohne Override-Flag: läuft die
  Migration (und damit die App, die dieselbe Verbindung nutzt) als Superuser oder mit
  `BYPASSRLS`, bricht sie ab. Das ist richtig platziert, weil beide Eigenschaften RLS
  bedingungslos aushebeln, auch bei `FORCE`.
- Die CI legt eine eigene Nicht-Superuser-Rolle `app_ci` an; die eingebettete Test-Datenbank
  legt `app_test` an. Der Superuser existiert dort ausschließlich als getrennte Verbindung für
  Testaussagen, die unter RLS strukturell nicht treffbar sind (`tests/setup/superuser-db.ts`),
  und wird nie als `POSTGRES_URL_TEST` verwendet.
- `identity_reconciler` ist `nologin`, `nosuperuser`, `nobypassrls` und besitzt keine Tabelle —
  als Test festgehalten (`tests/db/identity-and-site-keys.test.ts:360-386`).

**Die Einschränkung** ist in `docs/adr/0003-db-rollen-trennung.md` sauber dokumentiert: es gibt
in M0 genau eine Datenbankrolle, und sie ist Eigentümerin aller Tabellen. Sie darf damit DDL —
also `ALTER TABLE … NO FORCE`, Policies droppen, Trigger droppen und danach `TRUNCATE` auf dem
Audit-Log fahren. Ein kompromittierter App-Prozess kann die gesamte Mandantengrenze abschalten,
statt nur die eigenen Daten zu sehen. Die Garantie ist korrekt implementiert, aber nicht
strukturell abgesichert.

Das ADR bewertet das offen als akzeptierte Known-Limitation für M0 (keine Produktionsdaten,
kein Pilotkunde), nennt eine bindende Frist (vor dem ersten Pilotkunden, beim Neon-Setup) und
liefert das Zielbild als **ausführbares** SQL in vier Blöcken. Es ist zudem einmal real gegen
eine PG-18-Instanz durchgespielt worden (`scripts/adr-0003-probe.mts`, 24 von 24 Nachweisen
grün, inklusive der Entdeckung eines echten Portabilitätsfehlers in `0015`). Das ist deutlich
mehr als die übliche „machen wir später"-Notiz und der Grund, warum dieser Punkt hier nicht als
Blocker geführt wird — er ist als Blocker für den *Pilotkunden* geführt.

---

## 3. Ebene 2 — Der Mandantenkontext im Code

### 3.1 Wie er gesetzt wird

`lib/db/tenant.ts:13-18` ist die gesamte Mechanik:

```ts
return d.transaction(async (tx) => {
  await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
  return fn(tx);
});
```

Das dritte Argument `true` bedeutet `SET LOCAL` — transaktionslokal. Das ist die richtige Wahl
bei Connection-Pooling: eine Sitzungsvariable (`false`) würde auf der wiederverwendeten
Verbindung überleben und den nächsten, eigentlich kontextlosen Zugriff in einen *fremden*
Mandanten setzen. Der Wert wird als Parameter gebunden, nicht interpoliert; eine SQL-Injection
über die Workspace-ID gibt es nicht. Ein ungültiger Wert (kein UUID) lässt den Cast im
Policy-Prädikat scheitern — das ist ein Fehler, kein Zugriff.

Der Callback bekommt `tx`, nicht den Pool. Alle Service-Funktionen nehmen `TenantTx` als erstes
Argument. Das macht es typseitig unmöglich, versehentlich außerhalb der Transaktion zu
schreiben — solange man sich nicht bewusst einen anderen Client besorgt.

### 3.2 Kann der Kontext vergessen werden?

Nicht auf dem vorgesehenen Weg, und der vorgesehene Weg ist der einzige verfügbare:

- `getPool()` in `lib/db/client.ts:28` ist **bewusst nicht exportiert** (mit begründendem
  Kommentar). Nur `getDb()` ist öffentlich.
- Die dependency-cruiser-Regel `db-client-nur-ueber-tenant` erlaubt den Import von
  `lib/db/client.ts` ausschließlich aus `lib/db/tenant.ts`.
- Die Regel `app-kennt-lib-db-nicht` verbietet `app/` jeden Zugriff auf `lib/db/` — ohne
  Ausnahme. Eine Route kann den Mandantenkontext also nicht selbst wählen.
- Vergisst man den Kontext trotzdem, sieht man nichts: `tests/db/tenant-invariants.test.ts:183-198`
  prüft für jede Mandantentabelle, dass eine fabrikfrische Verbindung ohne
  `app.workspace_id` null Zeilen liefert.

Das ist fail-closed und gut abgesichert.

### 3.3 Wo die Absicherung endet

- **`npm run depcruise` scannt nur `modules lib app worker`** (`package.json:12`). Nicht
  gescannt werden `scripts/`, `tests/` und die Dateien im Repo-Wurzelverzeichnis
  (`instrumentation.ts`, `drizzle.config.ts`). Ein künftiges Wartungsskript unter `scripts/`,
  das `getDb()` oder `getAuthDb()` importiert, wäre kein CI-Fehler. Die Regel steht, ihre
  Reichweite ist kleiner, als der Kommentar suggeriert.
- **Verschachtelte Aufrufe sind nicht erkannt.** `withTenant` innerhalb eines `withTenant`
  ruft `d.transaction(...)` auf dem Drizzle-*Db*-Objekt auf, nicht auf `tx`. Die innere
  Transaktion holt sich damit eine **zweite Verbindung aus dem Pool** und läuft unabhängig.
  Folgen: der innere Schreibvorgang wird von einem Rollback der äußeren Transaktion *nicht*
  mitgenommen (die Outbox-Garantie aus `lib/events.ts` gilt dann nicht mehr), und bei
  `max: 5` (`lib/db/client.ts:30`) ist tiefe Verschachtelung ein Deadlock-Kandidat, weil die
  äußere Transaktion ihre Verbindung hält, während die innere auf eine wartet. Es ist kein
  Sicherheitsleck — jede Transaktion setzt ihren eigenen Kontext —, aber es ist eine Falle,
  die niemand sieht, bis sie zuschnappt. Ein Reentrancy-Guard oder ein bewusstes
  Savepoint-Verhalten fehlt.
- **`withTenant` autorisiert nichts.** Es akzeptiert jede UUID als gültigen Mandanten. Das ist
  im Quelltext ausdrücklich vermerkt (`lib/db/tenant.ts:24-28`) und durch
  `withAuthorizedTenant` beantwortet, das Rolle, Capabilities, Feature-Flags und Actor in
  derselben Transaktion aus der Datenbank liest, nachdem der Kontext gesetzt wurde — der
  Membership-Lookup unterliegt damit selbst der RLS. Ohne Membership gibt es keinen `ctx`,
  sondern einen `PermissionDeniedError`. Der Angriff „Opfer-Workspace-UUID mit Adminrolle aus
  einem anderen Workspace kombinieren" ist als Test hinterlegt
  (`tests/db/authorized-tenant.test.ts:70-81`). Zusätzlich wird die Rolle auch zur Laufzeit
  validiert, nicht nur per CHECK-Constraint (`lib/db/tenant.ts:96-98`).

  **Aber:** nichts verhindert, dass ein künftiger Aufrufer `withTenant` statt
  `withAuthorizedTenant` benutzt. Es gibt dafür weder eine Lint-Regel noch eine
  dependency-cruiser-Regel, nur einen Kommentar.

### 3.4 Es gibt heute überhaupt keinen Pfad zur Domänendatenbank

Die Grep-Gegenprobe ist eindeutig: `withTenant(` und `withAuthorizedTenant(` kommen im
Produktivcode **ausschließlich in ihrer eigenen Definition** vor. Alle Aufrufe stehen in
`tests/` und nutzen die `…On`-Varianten mit eigenem Pool. `app/` enthält genau eine Route
(`app/api/auth/[...all]/route.ts`, die better-auth-Catch-all), eine Startseite aus dem
Next.js-Template und ein Layout. Es gibt keine `middleware.ts` und keinen Aufruf von
`auth.api.getSession`, `cookies()` oder `headers()` irgendwo im Repo.

Konsequenzen, ehrlich benannt:

- Zum Prüfpunkt „Trennung von Kundenportal- und Funnel-Routen": **existiert nicht.** Es gibt
  keine geschützten Routen, also auch keine Trennung. Das ist kein Versäumnis in M0, aber es
  heißt, dass zu diesem Thema heute nichts geprüft werden kann.
- Die Abbildung *Session → `user_identity.id`* ist nirgends implementiert. `lib/auth.ts`
  koppelt `auth_user.id ↔ user_identity.auth_user_id`, aber es gibt keine Funktion, die aus
  einer Session die Domänen-Identität ermittelt. Genau dieser Baustein ist die Eingangstür der
  gesamten Autorisierung — er ist der erste, der in M1 entstehen muss, und er hat heute keine
  Zeile Test.

---

## 4. Ebene 3 — `can()` und die Rechteschichten

`lib/permissions.ts:76-83` implementiert alle drei Schichten:

```ts
if (!req) return false;                       // unbekannte Action
if (!isRole(ctx.role)) return false;          // unbekannte Rolle
if (req.feature && ctx.featureFlags?.[req.feature] !== true) return false;   // Schicht 1
if (RANK[ctx.role] < RANK[req.minRole]) return false;                        // Schicht 2
if (req.capability && ctx.role !== "admin" && ctx.capabilities?.[req.capability] !== true)
  return false;                                                              // Schicht 3
return true;
```

**Kein Fail-Open.** Jeder Zweig endet im Zweifel bei `false`:

- Eine unbekannte Action (Laufzeit-String) liefert `undefined` aus `ACTION_REQUIREMENTS` und
  wird abgelehnt.
- Eine unbekannte Rolle wird explizit vor dem Rangvergleich abgefangen. Das ist wichtig und
  war einmal ein echter Fehler: `RANK["owner"]` ist `undefined`, und `undefined < 1` ergibt
  `false` — der Rangvergleich hätte die Aktion also *durchgelassen*. Jetzt gibt es zwei
  Schichten (Laufzeitprüfung hier, CHECK-Constraint in `drizzle/0009:16-17`), beide getestet.
- Capabilities und Feature-Flags kommen aus `jsonb` und sind zur Laufzeit beliebig. Verglichen
  wird strikt gegen `true`; `"true"`, `1`, `{}`, `[]` zählen nicht
  (`tests/unit/permissions.test.ts:156-172`).

Die Testabdeckung ist überdurchschnittlich: neben den aus `ACTION_REQUIREMENTS` abgeleiteten
Tests gibt es eine **handgeschriebene, unabhängige Erwartungstabelle** (9 Actions × 3 Rollen ×
Capability an/aus), die bewusst nicht aus der Implementierung abgeleitet ist. Wer
`ACTION_REQUIREMENTS` ändert, muss sie bewusst mitändern. Das ist die richtige Konstruktion für
eine Rechtematrix.

Zwei Anmerkungen:

- **`admin` überspringt Schicht 3 vollständig.** Das ist eine bewusste, dokumentierte und
  getestete Entscheidung („Admin impliziert alle Capabilities"). Fachlich heißt das: es kann
  keinen Admin geben, der *keine* Einkaufspreise sehen darf. Solange Capabilities nur
  *gewährende* Rechte sind, ist das konsistent. Der Typ `Capability` enthält allerdings mit
  `external_only` bereits ein Recht, das der Sache nach *einschränkend* gemeint ist. Wenn je
  eine Action eine Capability als Einschränkung nutzt, hebelt die Admin-Ausnahme sie
  stillschweigend aus. Der geplante Weg (restriktive RLS-Policy für `external_only`) vermeidet
  das — er muss dann aber auch wirklich diesen Weg gehen und nicht über `can()`.
- **`can()` hat keinen strukturellen Rückhalt.** Vergisst eine Service-Funktion den Aufruf,
  schreibt sie trotzdem erfolgreich: RLS prüft nur den Mandanten, nicht die Rolle. Der
  schärfste Fall ist `membership` selbst — die `tenant_isolation`-Policy erlaubt einem
  beliebigen Mitglied ein `update membership set role = 'admin' where user_id = <selbst>`
  innerhalb der eigenen Mandantentransaktion. Es gibt keine restriktive Policy, keinen Trigger
  und keinen Test, der das verhindert. Heute nicht erreichbar (kein Request-Pfad), aber der
  erste M1-Endpunkt, der Mitgliedschaften bearbeitet, muss diesen Schutz mitbringen — und er
  gehört in die Datenbank, nicht nur in den Service.

---

## 5. Event- und Audit-Log

**Laufen Event-Insert und Mutation in derselben Transaktion?** Ja, und zwar erzwungen durch die
Signatur: `emitEvent(tx, …)` und `writeAudit(tx, …)` nehmen die Transaktion als erstes
Argument, es gibt keine Variante, die sich selbst eine Verbindung besorgt. Das Referenzmuster
in `modules/sites/service.ts:59-93` schreibt Site, Event und Erfolgs-Audit in einem
Transaktionsblock; `tests/db/site.test.ts:82-98` weist nach, dass ein Rollback alle drei
gemeinsam mitnimmt.

**Sind beide Tabellen gegen `UPDATE`/`DELETE`/`TRUNCATE` geschützt?** Ja, siehe 2.5 —
einschließlich des `TRUNCATE`-Falls, den reine Row-Level-Trigger nicht abdecken.

Der Transaktionsgrenzen-Vertrag für **abgelehnte** Zugriffe ist sauber durchdacht
(`lib/audit.ts:4-32`): ein `writeAudit(tx, { allowed: false })` gefolgt von `throw` würde mit
der sterbenden Transaktion zurückgerollt und wäre spurlos weg. Savepoints lösen das nicht. Also
wirft der Service einen typisierten `PermissionDeniedError`, und die Aufrufgrenze schreibt den
Denial-Audit in einer neuen Transaktion nach dem Abbruch. Das ist die richtige Antwort.

**Der Haken:** diese Aufrufgrenze existiert nur im Test. `tests/db/site.test.ts:107-141`
simuliert sie von Hand. Im Produktivcode wird heute **kein einziger Denial-Audit geschrieben**,
weil es die Stelle nicht gibt, die ihn schreiben müsste. Das Audit-Versprechen aus Architektur
§4 („erlaubte *und* abgelehnte Zugriffe") ist damit zur Hälfte eingelöst. Das ist in
`lib/audit.ts:28-31` als „kommt mit Task 9" vermerkt — es ist also bekannt, aber es ist offen.

Positiv hervorzuheben: der Event-Payload trägt bewusst nur IDs, keinen Klartext. `site.created`
enthält ausschließlich `{ siteId }`, nicht Straße, PLZ und Koordinaten. Der Grund ist richtig:
`domain_events` ist append-only, personenbezogener Klartext dort wäre nie wieder löschbar und
liefe dem DSGVO-Löschkonzept zuwider. Der Test prüft das nicht nur strukturell, sondern
zusätzlich per Rohtext-Gegenprobe über alle Adressbestandteile
(`tests/db/site.test.ts:32-65`).

---

## 6. Authentifizierung

`lib/auth.ts` ist sorgfältig gebaut, und jede Option trägt eine Fundstelle in den
*installierten* Typen statt einer Erinnerung. Gut gelöst:

- `emailAndPassword: { enabled: false }` — nur Magic Link und E-Mail-OTP, keine Passwörter.
- `transaction: true` im Drizzle-Adapter (Default ist `false`); ohne das konnte ein Abbruch
  zwischen zwei Verification-Löschungen einen alten OTP wiederbeleben.
- `rateLimit: { storage: "database" }` statt des In-Memory-Defaults. Auf einer serverlosen
  Plattform hätte jede Instanz sonst einen eigenen Zähler, und Mail-Flooding ließe sich über
  Instanzwechsel vervielfachen.
- Token-Speicherung gehasht bzw. verschlüsselt (siehe 2.6).
- `lib/mail.ts:16-27`: ohne `RESEND_API_KEY` wird in Produktion **geworfen**, statt Magic Links
  und OTPs ins Log zu schreiben und better-auth einen Versanderfolg zu melden. Das war einmal
  ein direkter Übernahmeweg für jeden mit Logzugriff.
- Der Session-Hook als Selbstheilung für einen fehlgeschlagenen `user.create.after`-Reconcile
  ist ein guter Griff — der Create-Hook feuert nie wieder, der Session-Hook bei jedem Login.
  Die Wirksamkeit ist getestet (`tests/db/auth.test.ts:141-180`).

Was **nicht** konfiguriert ist und deshalb auf den Bibliotheksdefaults läuft:

- **Session-Lebensdauer.** Es gibt keinen `session`-Block mit `expiresIn`/`updateAge`, keine
  Cookie-Konfiguration, kein `useSecureCookies`, kein `trustedOrigins`. Für ein B2B-Werkzeug
  mit Preis- und Rechnungsdaten sollte die Sitzungsdauer eine bewusste Entscheidung sein und
  im Quelltext stehen, nicht ein Bibliotheksdefault, der sich mit einem Minor-Update ändern
  kann. Gleiches gilt für die Gültigkeitsdauer von Magic Link und OTP.
- **Registrierung ist offen.** Jede beliebige E-Mail-Adresse kann einen Login-Link anfordern
  und wird dabei zu einem `auth_user` plus `user_identity`. Ohne Membership bekommt sie
  nirgends Zugriff — die Mandantengrenze hält. Es ist trotzdem eine unbegrenzte Quelle für
  Identitätszeilen und ausgehende Mails, gebremst allein durch das better-auth-Rate-Limit.
  Für M1 gehört hier eine Entscheidung hin (Einladung erforderlich? Domänen-Allowlist?).
- **Sentry und Auth-URLs.** `instrumentation.ts:18-22` reicht Request-Fehler an Sentry weiter.
  Die Magic-Link-Verify-URL trägt den Token im Query-String. Sentry filtert serverseitig
  Felder mit Namen wie `token`, aber es gibt hier weder ein `beforeSend` noch eine explizite
  Prüfung. Vor dem Scharfschalten von Sentry (die DSNs sind noch leer) sollte ein Testfall
  belegen, dass kein Login-Token in einem Fehlerereignis landet.

---

## 7. Objektspeicher

`lib/storage/s3.ts` löst die WORM-Zusage sauber: `immutableKey()` ist der einzige legale
Konstruktionsweg für Schlüssel unter `immutable/` und validiert seine Bestandteile gegen
`/^[a-zA-Z0-9._-]+$/` sowie gegen `.` und `..`; `put()` und `getSignedUploadUrl()` lehnen
`immutable/`-Schlüssel ab, sodass sich ein unveränderliches Objekt weder überschreiben noch
über eine Upload-URL umgehen lässt; `putImmutable()` kombiniert eine `HeadObject`-Vorprüfung
mit `IfNoneMatch: "*"` gegen den TOCTOU-Wettlauf. Alles getestet.

**Die Mandantenbindung fehlt vollständig, und zwar bewusst.** Der Kommentar
`lib/storage/s3.ts:33-39` sagt es selbst: `immutableKey(workspaceId, …)` nimmt die
Workspace-ID entgegen, prüft aber nicht, ob der Aufrufer sie führen darf. Konkret:

- `getSignedReadUrl(key)` (Zeile 129) signiert **jeden** übergebenen Schlüssel. Ein Endpunkt,
  der eine Workspace-ID oder einen Objektschlüssel aus dem Request durchreicht, stellt damit
  eine gültige Lese-URL auf fremde Mandantenobjekte aus.
- `put()` (Zeile 76) und `getSignedUploadUrl()` (Zeile 137) validieren mutable Schlüssel **gar
  nicht** — kein `SAFE`-Test, keine Präfixprüfung außer der `immutable/`-Ablehnung. `../` in
  einem mutablen Schlüssel wird durchgereicht.
- Die Ablaufzeiten sind mit 300 s (Lesen) und 600 s (Upload) vernünftig gewählt, aber es gibt
  keine Obergrenze: `ttlSeconds` ist ein freier Parameter des Aufrufers.
- Eine Upload-URL bindet den `Content-Type`, aber keine Größenbeschränkung.
- Die Zugangsdaten werden mit `!` aus der Umgebung gelesen (Zeilen 70-71). Fehlen sie, fällt
  das erst beim ersten Aufruf auf, nicht beim Start.
- `S3_BUCKET` steht in `.env.example`, wird aber von keiner Zeile Code gelesen: `S3Storage`
  bekommt den Bucket über den Konstruktor, und **es gibt keine Stelle, die `S3Storage`
  instanziiert.** Der Objektspeicher ist ein ungenutzter Baustein.

Bewertung: heute kein Leck, weil kein Aufrufer existiert. Ab dem ersten Dokument-Upload ist es
der wahrscheinlichste Ort für ein Cross-Tenant-Leck im ganzen System, weil die Mandantengrenze
dort nicht von der Datenbank, sondern allein von Anwendungslogik gezogen wird. Die Boundary
muss den Schlüssel aus einem verifizierten `ctx.workspaceId` konstruieren und darf niemals
einen Schlüssel oder eine Workspace-ID aus dem Request durchreichen.

---

## 8. Die Testsuite zur Mandantenisolation

**Sie ist echt generisch.** `tests/db/tenant-invariants.test.ts:79-89` liest die Tabellenliste
aus `pg_class` join `pg_namespace` für Schema `public` und filtert auf `relkind in ('r','p','m')`
— gewöhnliche Tabellen, partitionierte Elterntabellen und materialisierte Views. Es gibt keine
Handliste von Tabellennamen. Eine neue Mandantentabelle wird automatisch geprüft auf:

- `workspace_id NOT NULL`,
- RLS aktiviert **und** forciert,
- registrierte Fixture-Factory (sonst rot),
- Unsichtbarkeit aus einem fremden Workspace,
- Ablehnung eines Cross-Tenant-Inserts, **nachweislich durch RLS** (der Test prüft, dass die
  Fehlermeldung `row-level security` enthält — nicht PK, FK oder CHECK, sonst wäre er
  vakuum-grün),
- Unsichtbarkeit ohne Mandantenkontext auf frischer Verbindung,
- exakte Übereinstimmung von `using` und `with check` mit dem kanonischen Prädikat,
- genau eine permissive Policy namens `tenant_isolation` mit `FOR ALL`.

Die Ausnahmelisten sind selbst abgesichert: eine exemptierte Tabelle darf keine
`workspace_id`-Spalte haben (sonst versteckt sich dort eine echte Mandantentabelle), jede
unbekannte `auth_*`-Tabelle ist ein Suite-Fehler, jede nicht allowlistete materialisierte View
ist ein Suite-Fehler (Matviews erben die RLS ihrer Basistabellen nicht), und eine Karteileiche
in der Allowlist ist ebenfalls ein Fehler. Zusätzlich erzwingt die CI, dass jede
Schemaänderung eine committete Migration hat — sonst existierte die neue Tabelle in der
Test-Datenbank gar nicht und bliebe für alle Invarianten unsichtbar.

Das ist die beste Stelle des ganzen Fundaments. Die verbleibenden Lücken, ehrlich:

1. **Nur Schema `public`.** Eine Mandantentabelle in einem anderen Schema wäre unsichtbar. Für
   `pgboss` ist das begründet und harmlos; als generelle Aussage ist die Invariante
   schema-begrenzt.
2. **Gewöhnliche Views (`relkind = 'v'`) werden nicht erfasst.** Dank `FORCE` auf den
   Basistabellen ist eine View über Mandantendaten heute trotzdem gefiltert, aber sie wird
   weder geprüft noch als unbeaufsichtigt gemeldet — anders als eine Matview.
3. **Der Vertrag „zusammengesetzte Schlüssel" wird nicht generisch geprüft und ist bereits
   gebrochen.** `modules/README.md:16-31` erklärt beide Regeln als bindend: jede Tenant-Tabelle
   trägt `UNIQUE (workspace_id, id)`, und jede Tenant-Tabelle hat einen FK
   `workspace_id → workspace.id`. Geprüft wird beides nur für `site`, namentlich, in
   `tests/db/identity-and-site-keys.test.ts:421-450`. Tatsächlich erfüllen `membership`,
   `domain_events` und `audit_log` die erste Regel nicht, und `domain_events` und `audit_log`
   auch die zweite nicht. Die Dokumentation beschreibt hier bereits heute nicht den
   Ist-Zustand, und nichts macht darauf aufmerksam. Genau dieser Vertrag ist der, der
   stillschweigend verrottet, wenn M1 sechs neue Tabellen bringt — und es ist derselbe
   Vertrag, der verhindert, dass ein einspaltiger FK aus Workspace A auf eine Zeile aus B
   zeigt.
4. **Append-only wird nur für die zwei bekannten Tabellen geprüft**, nicht katalogbasiert. Das
   ist vertretbar (die Zusage gilt genau diesen beiden), aber es ist eine Handliste.

---

## 9. Secrets, Umgebungsvariablen, unsichere Defaults

**Keine Secrets im Repository.** Der Mustersuchlauf über den gesamten Baum (ohne
`node_modules`, `.next`, `.git`) findet keinen API-Schlüssel, kein Token, keinen privaten
Schlüssel und keine hartkodierten Zugangsdaten. Die einzigen Treffer sind die
Platzhalter-Variablen im SQL-Entwurf des ADR 0003. `.gitignore` deckt `.env*` ab und nimmt nur
`.env.example` aus; `git ls-files` bestätigt, dass ausschließlich `.env.example` versioniert
ist. Die Passwörter in `tests/setup/embedded-postgres.ts` gehören zu einer ephemeren, auf
`127.0.0.1` gebundenen Testinstanz mit zufälligem Port und sind unbedenklich.

**`.env.example` ist gegenüber dem tatsächlichen Bedarf unvollständig.** Vom Code gelesen,
aber nicht dokumentiert:

| Variable | Fundstelle |
| --- | --- |
| `POSTGRES_URL_AUTH` | `lib/db/auth-client.ts:32` |
| `POSTGRES_URL_MIGRATE` | `scripts/migrate.mts:11` |
| `POSTGRES_URL_WORKER` | `worker/index.ts:27` |
| `RESEND_FROM` | `lib/mail.ts:50` |
| `POSTGRES_URL_TEST_SUPERUSER` | `tests/setup/superuser-db.ts:24` |

Die vier `POSTGRES_URL_*`-Varianten sind exakt die Nähte der Rollentrennung aus ADR 0003 und
dort in einer Tabelle aufgeführt — sie fehlen aber in der Datei, die jemand beim Aufsetzen
tatsächlich kopiert. Umgekehrt steht `S3_BUCKET` in `.env.example`, wird aber nirgends gelesen.

Weitere Beobachtungen:

- **Fallback-Kette als Sicherheitsvoreinstellung.** Alle vier `POSTGRES_URL_*` fallen auf
  `POSTGRES_URL` zurück. Das ist bewusst so und dokumentiert; es heißt aber, dass ein
  vergessenes Setzen in Produktion still den heutigen Ein-Rollen-Zustand fortschreibt, statt zu
  scheitern. Beim Neon-Setup sollte ein Startup-Check verlangen, dass die vier Variablen
  tatsächlich verschieden sind.
- `worker/compose.yaml:7` reicht nur `POSTGRES_URL` durch, nicht `POSTGRES_URL_WORKER`. Nach
  der Rollentrennung muss die Datei mitgeändert werden, sonst läuft der Worker weiter auf der
  Runtime-Rolle.
- `.dockerignore` schließt `.env` und `.env.local` aus, aber nicht `.env*`. Eine
  `.env.production` oder `.env.local.bak` landete im Worker-Image. Einzeiler-Fix.
- `worker/health.ts:176` gibt im Fehlerfall `String(err)` im HTTP-Body zurück. Ein
  Postgres-Verbindungsfehler enthält typischerweise Host, Datenbank und Rollennamen. Der Port
  ist in `compose.yaml:11` auf `127.0.0.1` gebunden, die Exposition ist also auf den Host
  begrenzt — trotzdem gehört die Ursache ins Log und nicht in die Antwort.
- `scripts/hetzner-provision.py:87-93` legt die Firewall mit SSH (22/tcp) offen für
  `0.0.0.0/0` und `::/0` an. Für einen Einzelhost mit Schlüsselanmeldung vertretbar, aber eine
  Quell-IP-Einschränkung wäre billiger als jede spätere Härtung.
- `worker/Dockerfile:4` installiert `tsx` ungepinnt (`npm i tsx`) nach einem `npm ci`. Kleiner,
  aber vermeidbarer Lieferketten-Freiheitsgrad.
- `scripts/lagebericht.sh:12` trägt eine persönliche E-Mail-Adresse als Default. Kein
  Sicherheitsproblem, aber sie gehört in eine Variable.
- `modules/README.md:51-61` nennt drei dependency-cruiser-Regeln; tatsächlich sind es
  inzwischen sieben, darunter die drei sicherheitsrelevanten. Dokumentations-Drift.

---

## 10. Befunde nach Schwere

### Blocker

Keine. Es wurde kein Fail-Open in der Mandantentrennung gefunden.

### Hoch

1. **Die Rechteschichten 2 und 3 haben keinen strukturellen Rückhalt** — schärfster Fall:
   `membership` erlaubt unter `tenant_isolation` ein `update … set role = 'admin'` auf die
   eigene Zeile. Nur `can()` im Servicecode verhindert das, und `can()` ist optional aufrufbar.
   Heute unerreichbar, ab dem ersten M1-Endpunkt für Mitgliedschaften akut.
   *Empfehlung:* restriktive Policy oder Trigger auf `membership`, der eine Rollenänderung nur
   zulässt, wenn der Aufrufer im selben Workspace `admin` ist; plus ein Test, der die
   Selbstbeförderung nachfährt.
2. **Die Autorisierungsgrenze existiert nicht** — kein Session-zu-Identität-Mapping, kein
   Server-Action-Wrapper, keine Middleware, kein einziger Produktivaufruf von
   `withAuthorizedTenant`. Damit ist auch kein Denial-Audit implementiert.
   *Empfehlung:* dieser Wrapper ist das erste M1-Artefakt und braucht eigene Tests, bevor
   irgendein Fachmodul darauf aufsetzt.
3. **Objektspeicher ohne Mandantenbindung** (`lib/storage/s3.ts:129`, `:76`, `:137`) — beliebige
   Schlüssel werden signiert, mutable Schlüssel gar nicht validiert.
   *Empfehlung:* Schlüsselkonstruktion ausschließlich aus verifiziertem `ctx.workspaceId`;
   `SAFE`-Prüfung auch für mutable Schlüssel; TTL-Obergrenze; nie einen Schlüssel oder eine
   Workspace-ID aus dem Request durchreichen.

### Mittel

4. **Eine Datenbankrolle, die zugleich Tabelleneigentümerin ist** (ADR 0003). Sie darf DDL und
   kann Policies und Trigger abschalten. Bewusst akzeptiert, mit ausführbarem Zielbild,
   Gegenprobe und bindender Frist „vor dem ersten Pilotkunden". Wird hier nur deshalb nicht
   höher geführt, weil Frist und Umsetzungsweg dokumentiert und einmal real durchgespielt sind.
5. **`user_identity_insert with check (true)` plus globaler Unique-Index** ergibt ein
   Cross-Tenant-Existenz-Orakel (`drizzle/0002:28-29`, `drizzle/0010:4`) und erlaubt das
   Vorbelegen fremder Identitäten mit anschließender stiller Zuordnung beim Erst-Login.
   Nirgends im Repo benannt. *Empfehlung:* in M1 darf das Anlegen einer Identität nur über
   einen geprüften, auditierten Einladungspfad geschehen, und der Endpunkt darf die
   Existenzinformation nicht an den Aufrufer durchreichen.
6. **Der Vertrag „zusammengesetzte Schlüssel" wird nicht generisch durchgesetzt und ist bereits
   gebrochen**: `membership`, `domain_events`, `audit_log` haben kein
   `UNIQUE (workspace_id, id)`; `domain_events` und `audit_log` haben keinen FK auf `workspace`
   — entgegen `modules/README.md:30-31`. *Empfehlung:* beide Regeln in
   `tests/db/tenant-invariants.test.ts` als generische Invarianten aufnehmen, mit begründeter
   Ausnahmeliste für die Log-Tabellen, falls sie dort bewusst nicht gelten sollen.
7. **`withTenant` verschachtelt öffnet eine zweite, unabhängige Transaktion auf einer zweiten
   Verbindung** (`lib/db/tenant.ts:13-18` in Verbindung mit `max: 5` in
   `lib/db/client.ts:30`). Bricht die Outbox-Garantie und ist ein Deadlock-Kandidat.
   *Empfehlung:* Reentrancy-Guard, der bei einem bereits offenen Kontext wirft, oder bewusstes
   Savepoint-Verhalten.
8. **Session- und Token-Lebensdauern sind nicht konfiguriert** (`lib/auth.ts:39-92`) und laufen
   auf Bibliotheksdefaults. Für ein Werkzeug mit Preis- und Rechnungsdaten sollte das eine
   sichtbare Entscheidung sein.
9. **`npm run depcruise` scannt `scripts/`, `tests/` und die Wurzeldateien nicht**
   (`package.json:12`). Die drei sicherheitsrelevanten Importgrenzen gelten dort nicht.
10. **`.env.example` ist unvollständig**; es fehlen genau die vier Variablen, die die
    Rollentrennung tragen.

### Niedrig

11. Die Invariantensuite deckt nur Schema `public` ab und erfasst gewöhnliche Views nicht.
12. `worker/health.ts:176` gibt Fehlerdetails im HTTP-Body zurück (auf `127.0.0.1` gebunden).
13. `.dockerignore` schließt nur `.env` und `.env.local` aus, nicht `.env*`.
14. `worker/compose.yaml` reicht `POSTGRES_URL_WORKER` nicht durch.
15. SSH offen für `0.0.0.0/0` im Provisionierungsskript.
16. `npm i tsx` ungepinnt im Worker-Image; persönliche E-Mail als Default in
    `scripts/lagebericht.sh:12`; `modules/README.md` nennt drei statt sieben depcruise-Regeln.
17. Offene Registrierung: jede E-Mail kann sich einen Login-Link schicken lassen und wird zu
    einer Identität. Ohne Membership ohne Zugriff, aber eine unbegrenzte Quelle für
    Identitätszeilen und ausgehende Mails.
18. Sentry-Fehlerereignisse sind nicht explizit gegen Login-Token im Query-String gefiltert.

### Lob

- Der Policy-Vertrag wird mit **exaktem** Prädikatvergleich erzwungen, nicht per Substring. Das
  ist der Unterschied zwischen einem Test und einem Test, der etwas fängt.
- Die Angriffe, die frühere Reviews gefunden haben, sind als laufende Tests konserviert. Auch
  der Informationsabfluss über eine *Fehlermeldung* wurde erkannt und geschlossen
  (`drizzle/0016`).
- Der `TRUNCATE`-Trigger (`drizzle/0005`) ist der Fall, den fast jede Append-only-Konstruktion
  übersieht.
- Die handgeschriebene, von der Implementierung unabhängige Rechtematrix in
  `tests/unit/permissions.test.ts:52-125`.
- Das Superuser-Gate in `scripts/migrate.mts` ohne Override-Flag, konsequent gespiegelt in CI
  und eingebetteter Test-Datenbank.
- ADR 0003 ist keine Absichtserklärung, sondern ausführbares SQL mit protokollierter
  Gegenprobe.

---

## 11. Offene Fragen

1. Soll `admin` dauerhaft alle Capabilities implizieren? Falls je eine Capability
   *einschränkend* wirken soll (`external_only`), muss dieser Weg über restriktive
   RLS-Policies laufen und nicht über `can()`.
2. Gelten `UNIQUE (workspace_id, id)` und der FK auf `workspace` auch für `domain_events` und
   `audit_log`, oder sind Log-Tabellen bewusst ausgenommen? Die Antwort gehört als Ausnahme
   samt Begründung in die generische Invariantensuite.
3. Wie soll der M1-Einladungsfluss das Existenz-Orakel auf `user_identity` vermeiden?
4. Welche Session-Lebensdauer ist für das Portal gewollt, und braucht das Kundenportal eine
   andere als die Installateurs-Oberfläche?
5. Wann genau wird ADR 0003 umgesetzt — an welchem Punkt des Neon-Setups, und wer prüft, dass
   die vier `POSTGRES_URL_*` danach wirklich verschieden sind?
6. Soll `withTenant` (die nicht autorisierende Variante) für Anwendungscode überhaupt
   erreichbar bleiben, oder gehört sie hinter eine eigene Grenze für System- und Worker-Pfade?
