# ADR 0004: Actor-Kontext und Membership-DML als Datenbankgrenze

Datum: 2026-08-29 · Status: akzeptiert

## Kontext

Die Tenant-RLS kennt bisher nur `app.workspace_id`. Damit kann die Datenbank zwar
Workspace-Grenzen erzwingen, aber nicht erkennen, welcher Nutzer handelt. Auf
`membership` erlaubt die bestehende `FOR ALL`-Policy deshalb jedem Mitglied alle DML-
Operationen im eigenen Workspace: Selbstbeförderung, Fremdbeförderung und Löschung sind
ohne zusätzliche Schranke möglich. Spätere Assignment-Policies benötigen denselben
Actor-Kontext.

## Optionen

1. **Nur Anwendungscode:** verworfen. Ein vergessener Service-Check würde die
   Rechteeskalation wieder öffnen.
2. **Nur Trigger:** verworfen. Er schließt DML, erfüllt aber nicht den Architekturvertrag
   für actorbasierte restriktive Policies und verliert eine unabhängige Schutzschicht.
3. **Admin-Prüfung ausschließlich in RLS:** verworfen. Eine Policy mit Subquery auf
   `membership` würde in RLS-Rekursion laufen oder eine privilegierte
   `SECURITY DEFINER`-Hilfsfunktion benötigen.
4. **Transaktionslokaler Actor + restriktive Self-DML-Policies + zwei Invoker-Trigger:**
   gewählt.

## Entscheidung

- Jeder verwaltete Tenant-Start leert `app.actor_id` transaktionslokal. Autorisierte
  Pfade setzen danach die aus Membership und Identität verifizierte
  `user_identity.id`; der Systempfad belässt NULL.
- Als erste SQL-Anweisung pinnt jeder verwaltete Tenant-Start die Isolation auf
  `READ COMMITTED`. Membership-DML unter einer anderen Isolation wird zusätzlich
  DB-seitig mit SQLSTATE `25001` abgelehnt.
- `public.app_actor_id()` kapselt das pool-sichere `current_setting`-/`nullif`-Muster.
- Drei befehlsspezifische `AS RESTRICTIVE`-Policies blockieren eigene INSERT-, UPDATE-
  und DELETE-Mutationen, lassen aber den bewusst privilegierten NULL-Actor zu. Die
  bestehende `tenant_isolation` bleibt die einzige permissive Policy.
- Ein `SECURITY INVOKER`-Statement-Trigger sperrt den kanonischen
  `app.workspace_id` vor jedem Zielzeilen-Lock. Ein zweiter `SECURITY INVOKER`-Row-
  Trigger schützt unveränderliche Membership-Identität, verbietet Self-DML und lässt
  fremde DML nur durch einen Admin desselben Workspace zu. Autorisierungsablehnungen
  verwenden stabil SQLSTATE `42501`. Beide Triggerfunktionen sind ausdrücklich
  `VOLATILE`; die Rollenabfrage nach dem Lock erhält damit unter `READ COMMITTED` einen
  frischen Snapshot.
- Produktive Browserpfade nutzen `withSessionTenant`. `withAuthorizedTenant` und
  `withTenant` sind vertrauenswürdige Adapter-/Systemgrenzen, keine APIs für behauptete
  Nutzerwerte.

## Security-Auswirkungen

Die Entscheidung schließt Selbst- und Fremdbeförderung, Self-DELETE/Reinsert,
Identitätstransfer und „Admin in A, Viewer in B" auf normalen Actor-Pfaden. Policies und
Trigger sind unabhängige Schranken; Tenant-RLS bleibt zusätzlich aktiv.

Die Statement-Sperre liegt absichtlich vor dem Lock einer Ziel-Membership. Andernfalls
könnten zwei gegenseitige Admin-Löschungen je eine Membership-Zeile halten und sich an
der gemeinsamen Workspace-Zeile verkeilen. `READ COMMITTED` ist dabei eine harte
Voraussetzung: Unter `REPEATABLE READ` könnte die spätere Rollenprüfung trotz Sperre den
alten Actor-Snapshot sehen. App-Einstieg und DB-Trigger erzwingen diesen Vertrag beide.

Custom-GUCs authentifizieren keinen SQL-Caller. Wer beliebiges SQL ausführen kann, kann
den Actor verändern oder NULL setzen. M1-03 schließt deshalb die damals dokumentierte
Lücke strukturell: `app_runtime` besitzt kein Membership-DML; Principal-Policies und der
Statement-Trigger verlangen zusätzlich die echte Markerrollen-Mitgliedschaft, die nur
`app_system` trägt. Actor-Spoof/NULL ist damit für Membership wirkungslos, auch wenn ein
einzelner DML-Grant versehentlich zurückkehrt. Für andere direkt zugängliche Tenant-
Tabellen bleiben parametrisierte Queries und die strukturellen Importgrenzen bindend.

## Datenmigration und Betrieb

Keine Datenzeile wird verändert, kein Backfill und kein Tabellenrewrite ist nötig. Die
Migration ergänzt drei Funktionen, drei Policies und zwei Trigger. Bestehende
Memberships bleiben unverändert. Ein künftiger Membership-Service prüft Berechtigungen
vor dem SQL und erzeugt auditierbare `PermissionDeniedError`; die Trigger bleiben der
Backstop.

## Konsequenzen

- Ein Nutzer kann die eigene Membership niemals selbst ändern oder löschen. Für den
  alleinigen Admin ist ein anderer Admin oder der dokumentierte System-Recovery-Pfad
  nötig.
- Membership-Schreibvorgänge sind bewusst auf `READ COMMITTED` begrenzt; ein abweichender
  Pool-Default wird im verwalteten Einstieg überschrieben, direkte abweichende
  Transaktionen werden abgelehnt.
- Die globale Lock-Reihenfolge für Membership-Code lautet Workspace vor Membership.
  Ein Service darf daher keine Membership-Zeile vor dem DML sperren; sonst könnte er die
  durch den Statement-Trigger beseitigte Lock-Inversion wieder einführen.
- System-Bootstrap und Recovery bleiben über `app_system` möglich, sind aber eine
  explizite, vom Web-/Worker-Environment isolierte privilegierte Grenze.
- Spätere actorbasierte Assignment-Policies verwenden dieselbe Funktion und müssen
  weiterhin `AS RESTRICTIVE` sein.

## Rollback und Recovery

Rollback erfolgt vorwärtsgerichtet: zuerst abhängige Membership-Policies droppen, dann
beide Trigger und Triggerfunktionen, `app_actor_id()` zuletzt. Sobald weitere Policies
die Actor-Funktion verwenden, muss deren Abhängigkeit vorher migriert werden. Das Setzen
des Custom-GUC durch ältere/neueere App-Versionen ist ohne konsumierende Funktion
harmlos.
