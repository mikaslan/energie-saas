# F1.8 Lead Sources — Slice A: Stammdaten + Projekt-Attribution

Status: **SPECIFIED** · Lane: `codex/m1-18-lead-sources` · Migration: 0049
Basis: Modulkatalog F1.8 · **OBSERVED Live-Sweep 2026-09-03** (read-only API)

## 1. Discovery-Quellen (Clean Room)

- Modulkatalog: „F1.8 Lead Sources (Name+Farbe, archivierbar statt löschbar,
  Auto-Zuweisung per Broker/Funnel-Variante)".
- Live-Sweep (nur GET, keine Werte übernommen): `GET /leadSources` → 8 Einträge,
  Felder `id, name, projectDomain, createdAt, updatedAt, archivedAt`;
  `GET /leadSources/{id}` → gleiche Struktur. **Kein Farbfeld beobachtet** —
  Katalog nennt „Farbe", daher als nullable `color` (ESTIMATE) übernommen.
- Projektseite: `GET /residentialProjects` zeigt `leadSourceId` + `leadSources`
  als eigenständige Ressource (Attribution existiert real).

## 2. Scope Slice A (vertikal)

1. **Stammdaten**: Tabelle `lead_source` je Workspace — Name, Domain
   (`residential`/`commercial`, nullable), Farbe (nullable Hex, ESTIMATE),
   Soft-Delete über `archived_at` (Katalog: archivierbar statt löschbar,
   kein Hard-Delete).
2. **CRUD-Service**: create / update / archive / restore / list
   (Filter aktiv/archiviert), Namens-Eindeutigkeit je Workspace
   (normalisiert, case-insensitive), unbekannte Id → `NotFoundError`.
3. **Attribution**: `project.lead_source_id` (nullable FK). Der Intake
   (`processRechnerIntake`) setzt die Quelle automatisch: aktive Lead-Quelle
   mit `name = producer.name` (z. B. `wmee-rechner-v5`) → zugeordnet;
   sonst `null` (Bestandsprojekte unverändert).
4. **UI**: Einstellungsseite `einstellungen/lead-quellen` — Liste
   (Name, Domain, Farb-Badge, Archivstatus), Formular anlegen/bearbeiten,
   Archivieren/Reaktivieren. WMEE-Sprache.

**Nicht in Slice A** (Slice B): Auto-Zuweisungs-Regeln pro Broker/Funnel-
Variante, Farbdarstellung/Filtermöglichkeit im Anfrageboard, UTM-Overrides.

## 3. Verträge

### 3.1 Berechtigungen (`lib/permissions.ts`)

| Action | minRole | capability | internalOnly |
|---|---|---|---|
| `lead_source.read` | viewer | — | ja |
| `lead_source.write` | editor | — | ja |

Admin-Bypass gilt wie in `hasPermission` etabliert.

### 3.2 Datenvertrag

`lead_source`:

| Feld | Typ | Regeln |
|---|---|---|
| id | uuid PK | default gen_random_uuid() |
| workspace_id | uuid FK → workspace | not null |
| name | text | not null, 1–120 Zeichen, je Workspace unique (normalisiert lowercase/trim) |
| name_normalized | text | generiert wie contact.email_normalized, unique (ws, name_normalized) |
| project_domain | text nullable | CHECK in ('residential','commercial') |
| color | text nullable | `#RRGGBB`-Pattern, ESTIMATE (Katalog „Farbe") |
| archived_at | timestamptz nullable | Soft-Delete; unique partial? nein — Name darf nach Archivierung NEU vergeben werden (Reonic-Muster: archivierte Quelle bleibt historisch referenzierbar, Name wird frei) |
| created_at / updated_at | timestamptz | Standard |

`project.lead_source_id uuid NULL REFERENCES lead_source(id)` — ON DELETE
RESTRICT (kein Hard-Delete möglich, daher nur Schutznetz); Index
(workspace_id, lead_source_id).

### 3.3 Service-Signatur (`modules/crm/lead-source.ts`)

```
listLeadSources(ctx, { includeArchived }) → LeadSourceDto[]
createLeadSource(ctx, { name, projectDomain?, color? }) → dto
updateLeadSource(ctx, { id, name?, projectDomain?, color? }) → dto (Conflict bei Namenskollision)
archiveLeadSource(ctx, { id }) → dto
restoreLeadSource(ctx, { id }) → dto
resolveLeadSourceForProducer(ctx, producerName) → id | null   // intern, intake
```

Fehler: `LeadSourceNotFoundError`, `LeadSourceConflictError`,
`LeadSourceValidationError`; Permission über `hasPermission`
(`lead_source.read`/`lead_source.write`).

### 3.4 RLS/ACL (M1-CRM-Muster — REVIDIERT gegen 0047-Entwurf, DECIDED)

- `lead_source` ist CRM-Stammdaten ohne Geldfluss → Muster der
  CRM-Kerntabellen `contact`/`project` (Migration 0020): RLS + FORCE mit
  permissiver `tenant_isolation`-Policy über `app.workspace_id`; KEINE
  restriktiven Actor-Policies, keine Actor-Routinen, kein no_truncate.
- Grund: Der Rechner-Intake läuft als HMAC-authentifizierter Service OHNE
  Membership-Actor (`verifiedRechnerIntakeAction` → `withTenant`) und muss
  die aktive Quelle auflösen können — restriktive Actor-Policies wären ein
  Selbst-Blocker (beim F108-INT-01-Test real beobachtet).
- Rollen-/Capability-Prüfung im Service-Layer (`lead_source.read` Viewer,
  `lead_source.write` Editor) — wie bei contact/project.
- ACL-Vertrag via `scripts/db-role-contract.mts`: REVOKE ALL + GRANT
  SELECT/INSERT/UPDATE an `app_runtime`, kein DELETE (Soft-Delete).

### 3.5 Intake-Fan-in

`processRechnerIntake` (modules/intake/service.ts): vor dem project-Insert
`resolveLeadSourceForProducer(payload.producer.application)`; Treffer → Spalte setzen.
Kein Treffer → `null` (kein Fehler). v3 und v5 identisch behandelt.

## 4. Testmatrix

| ID | Test | Ebene |
|---|---|---|
| F108-DB-01 | create/list/update happy path + Normalisierung | db |
| F108-DB-02 | Namenskollision → Conflict; case-insensitive | db |
| F108-DB-03 | archive/restore; archivierte Quelle = nicht mehr zuordnungsfähig; Name frei nach Archivierung | db |
| F108-DB-04 | Cross-Workspace-Isolation (read/write) + Viewer darf nicht schreiben | db |
| F108-DB-05 | lead_source_id am Projekt: FK-Integrität, nullable | db |
| F108-INT-01 | Intake v5 mit aktiver Quelle `wmee-rechner-v5` → project.lead_source_id gesetzt | db |
| F108-INT-02 | Intake ohne passende Quelle → null (Bestandsverhalten) | db |
| F108-PERM-01 | permissions: 35 → 37 Actions, Matrix 3×37 | unit |
| F108-E2E-01 | Editor legt Quelle an, sieht sie, archiviert, reaktiviert | e2e |
| F108-E2E-02 | Viewer: Liste sichtbar, kein Anlegen/Archivieren | e2e |
| F108-JRN-01 | m111a-Journal: idx 49 / TOTAL 50, Kette 0048 → 0049 | db |

## 5. Nachweise

`npm run check` (alle Dateien grün) · `npm run build` · `db:generate` ohne Drift ·
Rollenproben 88/88 + PG18 5/5 · E2E Chromium (F108-Grep) · Secret-Scan ·
Kimi-K3-Review Spec + Code.
