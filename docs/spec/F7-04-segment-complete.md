# F7.4 — Segment abschließen und Admin-Unlock

Status: **REVIEWED / VERIFIED (LOKAL)** · Migration: 0077
Basis: Modulkatalog F7.2/F7.4 · Clean-Room-Sweep 2026-09-06

## 1. Rechtmäßige Referenzbasis

Öffentliche Reonic-Dokumentation belegt als `FACT`:

- eine Installationscheckliste gehört zur Baustellendokumentation einer
  vorhandenen Installation;
- `Mark segment complete` setzt Abschlusszeit und abschließende Person;
- sichtbare, unerledigte Pflichtpositionen blockieren; konditional verborgene
  Pflichtpositionen zählen nicht;
- der Checklistenfortschritt rollt über abgeschlossene Segmente auf;
- nur Admins dürfen ein Segment entsperren;
- Unlock entfernt den Abschluss, bewahrt ausgefüllte Werte, Fotos und
  Signaturen und rollt keine Folgeprozesse zurück;
- mehrere Baustellendokumentations-Checklisten/Subphasen sind möglich.

Quellen:
[Baustellendokumentation](https://docs.reonic.com/docs/en/installation-checklist-baustellendokumentation),
[Checklistenübersicht](https://docs.reonic.com/docs/en/settings-checklists-checklists-overview),
[Installationsvorlagen](https://docs.reonic.com/docs/en/settings-checklists-site-documentation-installation),
[OpenAPI v3.11.0](https://api.reonic.de/rest/v3/openapi).

Die OpenAPI zeigt stabile Segment-`id`, `versionHash`, `completedAt` und
`completedById`, aber keine öffentlichen Complete-/Unlock-Write-Endpunkte.
Exakte Fehlercodes und Replay-Antworten bleiben deshalb `ESTIMATE`.

## 2. Gelieferter vertikaler Vertrag

### Identität und Snapshot

- `project_checklist` trägt `phase`, `title`, CAS-`version` und einen
  JSONB-Baum mit stabilen UUIDs für Block, Segment und Item.
- Das frühere Unique `(workspace_id, project_id)` entfällt. Gleichnamige und
  gleichphasige Checklisten bleiben eigenständige Aggregate.
- Der aktuelle Projektbildschirm öffnet deterministisch die erste
  `site_documentation`; eine explizite Container-Auswahl ist ein eigener
  F7.2-Folgeslice.
- Persistiert werden nur editierbare Felder. `completedAt/completedById`
  werden beim Lesen aus einer separaten DB-kontrollierten Relation überlagert.

### Abschluss und Unlock

- Complete: interner Editor oder Admin, gültige Projekt-/Checklisten-/
  Segmentbindung, positive erwartete Version, Projektphase `installation`
  und vorhandene Installation.
- Nur sichtbare Segmente in sichtbaren Blöcken sind abschließbar.
- Jede sichtbare `required=true`-Position muss `done=true` sein. Unsichtbare
  Pflichtpositionen werden nicht gezählt.
- DB-Zeit und Actor stammen ausschließlich aus dem Transaktionskontext.
- Ein echter Abschluss erhöht die Version genau einmal und schreibt Event +
  Audit atomar. Identischer Replay erzeugt keine zweite Evidenz.
- Ein abgeschlossenes Segment ist bis Unlock als kompletter Snapshot
  unveränderlich, auch für Admins.
- Unlock: ausschließlich interner Admin. Es löscht nur die Completion-Zeile,
  erhöht die Version einmal und schreibt Event + Audit. Itemwerte und Baum
  bleiben bytegleich; Projekt, Installation und sonstige Downstream-Aggregate
  werden nicht zurückgesetzt.

### Strukturrechte

- `checklist.write`: Editor/Admin für Antworten und Complete.
- `checklist.configure`: Admin-only für Phase, Titel, Pflicht-/Sichtbarkeits-
  und Baumstruktur. Ein Editor darf bei Version 0 eine einfache Struktur mit
  ausschließlich sichtbaren, optionalen Feldern anlegen; danach nur Antworten
  ändern. `done` ist für Editoren nur auf einem vollständig sichtbaren
  Block→Segment→Item-Pfad veränderbar; verborgene Antworten bleiben
  DB-seitig eingefroren.
- `checklist.unlock`: Admin-only.
- Viewer liest; `external_only` bleibt vollständig fail-closed.

### DB-Grenze

`app_runtime` besitzt auf `project_checklist` und
`project_checklist_segment_completion` nur `SELECT`. Sämtliche Writes laufen
über drei `SECURITY DEFINER`-Kapseln mit festem `search_path`:

```text
save_project_checklist_v2(uuid,uuid,uuid,text,text,integer,jsonb)
complete_project_checklist_segment(uuid,uuid,uuid,uuid,integer)
unlock_project_checklist_segment(uuid,uuid,uuid,uuid,integer)
```

Private Validator-/Authorizer-Helfer sind nicht ausführbar. RLS/FORCE,
No-Truncate, Owner, Security-Modus, Quellhashes und exakte ACLs werden vom
Rollenvertrag attestiert. Zusätzlich pinnt er vollständige Spalten-,
Constraint-, Index-, Policy- und Trigger-Metadaten einschließlich Defaults,
Validität, FK-Aktionen, Key-Reihenfolge, Operatorklassen und Prädikaten.

Die Eingabegrenze entspricht dem kanonischen JavaScript-Vertrag: NFKC,
JavaScript-Trim, Ausschluss aller Unicode-17-`Cc`/`Cf`-Codepoints,
UTF-16-Längen und wohlgeformte Surrogatpaare. Der bekannte
PostgreSQL-16/Unicode-17-Versatz U+A7F1 wird explizit fail-closed behandelt.
Ein Baum umfasst höchstens 500 Block-, Segment- und Item-Knoten und höchstens
900.000 UTF-8-Bytes serialisiertes JSON; die Server Action ist explizit auf
1 MiB begrenzt. Die App bricht vor tiefer Zod-Validierung ab, die DB vor
weiterer Baumarbeit. UUID-Eindeutigkeit wird set-basiert statt quadratisch
geprüft.

## 3. Migration und Bestand

- 0077 nimmt während des Backfills einen exklusiven Checklist-Lock.
- Dokumentierte Legacy-Felder `name`, `position`, `title`, `done` und ihre
  Reihenfolge bleiben erhalten.
- Fehlende IDs werden deterministisch aus Checklist-ID + JSON-Pfad erzeugt;
  vorhandene gültige IDs bleiben bestehen.
- `visible=true`, `required=false`, Phase `site_documentation` und Titel
  `Baustellendokumentation` sind kompatible Defaults.
- Unbekannte Legacy-Felder, explizit ungültige IDs, doppelte Identitäten oder
  strukturell ungültiger Bestand brechen fail-closed ab.
- Vorlagenanwendung sperrt das Projekt vor Existing-Check und Insert. Zwei
  parallele Apply-Transaktionen erzeugen damit exakt eine Checkliste; der
  Verlierer endet als fachlicher Konflikt ohne Event-/Audit-Duplikat.

## 4. Nachweise

| ID | Erwartung |
|---|---|
| F704-DB-01 | Required-Gate, hidden-required, DB-Actor/-Zeit, Replay, Segment-Lock, Admin-Unlock, Datenerhalt, je ein Event |
| F704-DB-02 | Baustellendokumentation verlangt Projektphase und Installation |
| F702-DB-02b | DB-Capsule und Zod teilen NFKC-/Trim-/Cc-/Cf-/UTF-16-Semantik einschließlich Unicode-Versatz |
| F702-DB-02c | Editor kann `done` auf verborgenem Block-, Segment- oder Item-Pfad nicht fälschen |
| F702-DB-02d | 501 Knoten, mehr als 900.000 Byte, Position > int32 und doppelte UUID scheitern in Zod und Capsule; exakt 500 einschließlich UTF-8-Worstcase und int32-Max sind gültig; HashAggregate ohne Disk-Spill |
| F703-DB-04 | zwei parallele Template-Apply-Aufrufe: ein Erfolg, ein Conflict, exakt ein Aggregate/Event/Audit |
| F704-MIG-01 | echter 0076→0077-Legacy-Backfill, stabile/eindeutige IDs, Defaults und Multi-Checklist |
| F704-MIG-02 | unerwarteter/ungültiger Legacybestand bricht Upgrade atomar ab |
| F704-RBAC-01 | Viewer/External denied, Editor Complete, Admin Unlock; Runtime SELECT-only; aktueller und 0→0076-Rollenstand grün |
| F704-E2E-01 | Create→Save→Complete→Reload→Admin-Unlock, Datenerhalt, 375/768/1440, Console und Axe |
| F704-E2E-02 | gültiger ~800-KB-/500-Knoten-Worstcase passiert den echten Server-Action-Transport unterhalb 1 MiB |

Lokale Nachweise: fokussiert 76/76 Vitest, F7.3 1/1 und F7.4 2/2 Chromium;
Production-Build, Generator mit 90 Tabellen ohne Drift sowie Rollenvertrag
88/88 plus PG18 5/5 sind grün. Der Gesamtlauf belegt 240/240 Testdateien mit
2.179 bestandenen/1 übersprungenen Tests und 113 bestandene/1 übersprungene
Chromium-E2E. Unabhängiges Abschlussreview: keine offenen P0–P2.

## 5. Bewusste Grenzen

- Vollständige if/then-Auswertung, Zyklen-/Missing-Source-Gate, 12+ Itemtypen,
  `Mark as irrelevant`, Fotos/Signaturen und Block-Zuweisung bleiben offen.
- Die Schutzlimits von 500 Gesamtknoten und 900.000 JSON-Bytes sind mangels
  öffentlicher Reonic-Grenze `ESTIMATE`; sie liegen weit oberhalb einer
  operativen Projektcheckliste und unter der expliziten 1-MiB-Transportgrenze.
- `visible` ist in diesem Slice persistierter Admin-/Templatezustand; eine
  vollständige konditionale Ableitung folgt im F7.2-Engine-Slice.
- Exakte Reonic-Replayantwort ist mangels öffentlichem Write-Schema
  `ESTIMATE`; geliefert ist idempotentes Last-write-wins ohne Duplikate.
- Es gibt keinen automatischen Downstream-Trigger. Das entspricht der
  beobachteten Milestone-Semantik; interne Reonic-Nebenwirkungen bleiben
  mangels Evidenz ausdrücklich unbelegt.
