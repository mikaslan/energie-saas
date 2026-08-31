# M1-09 — Umsetzungsplan Projektzuweisung

Abschluss 2026-08-31: Feature-Commit `af8f297`; gemeinsam mit M1-08b/`0036`
in `e631814` integriert. Das Integrationsgate ist mit 150/150 Testdateien,
1.432 bestandenen Tests, 27 aktiven Chromium-Fällen, Build, Rollen-/PG18-Proben
und drei unabhängigen Reviews ohne offene P0–P2 grün. Die nachfolgenden
Commit-/Deploy-Sperren dokumentieren den historischen Planstand vor der späteren
ausdrücklichen Automatisierungsfreigabe.

## Ziel

```text
unzugewiesener Rechner-Lead
  → interner berechtigter Nutzer setzt Hauptverantwortung/weitere Nutzer
  → Board und Projektakte zeigen den Verantwortungsstand
  → direkt zugewiesenes external_only-Mitglied sieht nur diesen offenen Request
  → Entfernung entzieht die Sicht ab der nächsten Transaktion
```

Teams, Auto-Routing, externe Mutationen, Offers, Preise, KAM-PDF-/Mailwirkung und
Kundenportal bleiben außerhalb.

## Reihenfolge

1. **Vertrag und Evidenz**
   - Spec M1-09 und ADR 0014 festschreiben;
   - öffentliche Reonic-Capability als beobachtbare Funktionsidee, eigene
     Sicherheitssemantik als WMEE-Entscheidung klassifizieren;
   - `project.assign` und `assign_projects` als getrennte Grenze definieren.

2. **RED: Contracts und Permissions**
   - diskriminierte Assignment-Commands und Membership-Suche testen;
   - Viewer, Editor ohne Recht, External und malformed Flags fail-closed;
   - Admin-Implikation und Action-FormData-Minimierung belegen.

3. **RED: Datenbank und RLS**
   - Migration/Schema für Project-Revision und Assignment-Tabelle;
   - Composite-FKs, Partial Unique, Limit und Membership-Delete-Blocker;
   - genau eine permissive Tenant-Policy plus restriktive Actor-Policies;
   - Runtime-/Worker-ACL und Cross-Tenant-/Direct-DML-Proben.

4. **RED: Service und Readmodelle**
   - unassigned, KAM-Wechsel, Add/Remove, Limit, No-op und Revision-Conflict;
   - parallel genau ein Gewinner, keine Teilstände;
   - External A/B, Fremdtenant, Phase-/Outcome-Entzug und Objekt-Oracle;
   - PII-freie Events/Audits und Project-Erasure.

5. **Implementierung Datenbank und Domain**
   - `lib/db/schema/project-assignment.ts` und Project-Revision;
   - Forward-only Migration, RLS-Helfer/Policies und ACL;
   - `project.assign` in der zentralen Rechte-Matrix;
   - Assignment-Service unter Project-First-Lockordnung.

6. **Implementierung Reads und Actions**
   - internes Assignment-Context-/Search-DTO;
   - eigener minimierter External-Request-DTO;
   - Board-Filter und KAM-Summary;
   - typisierte Server Action mit stabilen expected errors.

7. **Geschützte Oberfläche**
   - interne Verantwortungssektion mit serverseitiger Suche und nativen Forms;
   - Board-Label `Nicht zugewiesen`/Hauptverantwortung;
   - getrennte read-only External-Projektansicht;
   - Navigation, Loading/Error/Conflict, Fokus und 320/375-px-Reflow.

8. **Abschlussprüfung**
   - fokussierte Unit-/DB-/Migration-/Action-/Buildtests;
   - Chromium Golden Path, External-Entzug und Axe;
   - vollständiges `npm run check`, Build, Rollenvertrag und PG18;
   - unabhängiges Code- und Security-Review, P0–P2 schließen;
   - Paritätsdokumente und Vault aktualisieren;
   - Gate-2-Diff vorlegen, kein Commit/Push/Deploy ohne Bestätigung.

## Kritische Dateien

- `lib/permissions.ts`
- `lib/db/schema/project.ts`
- `lib/db/schema/project-assignment.ts`
- neue Forward-only-Migration (Nummer 0037 ist wegen parallelem M1-08b/0036
  reserviert und wird beim späteren Integrationsmerge im Journal geordnet)
- `modules/projects/**`, `modules/boards/**`
- `app/w/[workspaceId]/anfragen/**`
- `tests/unit/m109-*`, `tests/db/m109-*`, `tests/e2e/m1-09-*`
- `tests/setup/tenant-fixtures.ts`, Rollen- und Cutover-Skripte

## Stoppschilder

- Kein globaler User-FK statt tenantgebundener Membership.
- Keine permissive Assignment-Erweiterung an bestehender RLS.
- Keine externe Mutation und kein Offer-/Preis-/Kalkulationspayload.
- Keine E-Mail oder Kontakt-PII in Event, Audit, Log oder URL.
- Kein stiller Default-KAM und kein stiller KAM-Verlust beim Wechsel.
- Keine Abschwächung bestehender External-Sperren anderer Module.
- Keine Behauptung vollständiger Reonic-Parität; M1-09 bleibt F1 PARTIAL.
- Kein Commit, Push, Deploy, Providerkauf oder private Reonic-Nutzung.
