# M1-10 — Umsetzungsplan Projektaufgaben und Aktivität

## Zielpfad

```text
interne Projektakte
  → Quick- oder Full-Task
  → persistierte Taskrevision mit Assignees/Labels/Checkliste
  → Edit/Checklist/Complete/Reopen
  → redigierte Project-Activity
  → einwegiges Archive
```

## Reihenfolge

1. Spec, ADR, Quellen-, Capability-, Rollen-, Workflow-, Domain- und
   Unknown-Vertrag festschreiben.
2. RED: Contract-/Richtext-/Permissiontests.
3. RED: `0038` Fresh-/Upgrade-/RLS-/ACL-/Erasure-/Race-Verträge.
4. Schema und Migration für vier Tabellen sowie Taskrevision implementieren;
   `db:generate` muss danach null Drift melden.
5. Service mit Project→Task→Kind-Lockordnung, CAS, sicheren Events/Audits und
   Activity-Allowlist implementieren.
6. Thin Server Actions mit exakten FormData-Allowlisten und stabiler
   Fehlerunion implementieren.
7. Interne Projekt-UI für Quick/Full/Edit/List/Activity bauen; External-Branch
   bleibt strukturell davor.
8. Rollen-, Privacy-, XSS-, Erasure-, Race-, Action-, Build- und E2E-Verträge
   schließen.
9. Vollständige Gates: `db:generate`, `npm run check`, `npm run build`,
   `npm run test:e2e`; anschließend drei unabhängige Read-only-Reviews.
10. Nur bei grünem P0–P2-Stand dokumentieren und committen.

## Datei-Ownership

- `lib/db/schema/project-task.ts`, `lib/db/schema/project.ts`, Schema-Barrel
- `drizzle/0038_*`, Journal/Snapshot
- `modules/tasks/**`, `modules/tasks/index.ts`
- `lib/permissions.ts`
- `app/w/[workspaceId]/anfragen/[projectId]/task-*` und `page.tsx`
- `tests/**/m110-*`, E2E-Runner/Fixture nur additiv
- Paritätsdokumente, ADR, Spec und Vault-Checkpoint

## Harte Gates

- keine Taskdaten in External-SQL/DTO/RSC/HTML
- keine freien Richtext-Nodes/Attrs/HTML-Sinks
- keine Freitexte/PII in Events, Audit oder Logs
- keine Teilstände bei Stale/Race/Erasure/Offboarding
- Archive bleibt einwegig
- `node_modules`, Secrets und private Reonic-Daten bleiben außerhalb
