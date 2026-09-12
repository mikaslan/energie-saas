# F12-01 — Funnel-Kampagnen (intern, ohne öffentliches Frontend)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02`
Nachweis: DB 6/6, E2E 1/1 (lokal beobachtet); Rollenvertrag + Invarianten grün.
Katalog: F12.2 („Varianten pro Kampagne: eigene Lead Source") — interner
Anteil. Keine behauptete Reonic-Parität; Näherungen als ESTIMATE,
REVIEW-pflichtig.

## Ziel und Abgrenzung

Der öffentliche Funnel (8-Screen-Flow, Embed, QR/Deeplinks-Bedienung)
wartet auf `Q-F12-FUNNEL-REFERENZ` (Reonic-Beleg oder ESTIMATE-Freigabe),
echte Provider-Flüsse auf `Q-F12-PROVIDER-PRIVACY`. Dieser Slice baut den
davon unabhängigen internen Anteil, zu dem sich beide Fragen bekennen
(„kein Stillstand"):

1. **Kampagnen-Entity**: benannte Variante mit eigener Lead-Quelle und
   stabilem Slug (Slug = reserviertes Deeplink-Token für F12-02; in
   diesem Slice ohne öffentliche Route).
2. **Manuelle Erfassung mit Kampagne**: F1-11 (`createManualLead`)
   akzeptiert `funnelCampaignId` und attributiert das Projekt mit
   Kampagne + deren Quelle (sichtbar in Formular und Projektakte).

Bewusst NICHT in diesem Slice (Folge-Slices): öffentliche Funnel-Screens,
Embed-Script/iframe, QR-/Deeplink-Bedienung, Partnerlogo-Upload,
Auto-Routing auf zugewiesenen User (kein `assignee`-Feld — keine
wirkungslose Konfiguration), Erinnerungsmails, Provider-Webhooks,
dynamische Day-ahead-Tarife (F4-Offenheit, separater Katalogpunkt).

## Datenmodell (Migration 0125, additiv)

`t funnel_campaign` (Tenant-Tabelle, FORCE RLS + `tenant_isolation`
bytegleich zu 0086):

```text
id, workspace_id NOT NULL,
name (1..120, nicht-leer), name_normalized (lower(trim)),
slug (Deeplink-Token, 1..64), slug_normalized (lower(trim)),
lead_source_id NOT NULL (composite-FK (workspace_id, lead_source_id)
  auf lead_source — Quelle muss im selben Workspace existieren),
archived_at NULL, created_at, updated_at.
```

- `unique(workspace_id, id)` (echter Constraint — zusammengesetztes
  FK-Ziel für `project.funnel_campaign_id`, Lehre aus F7-12).
- `uniqueIndex(workspace_id, name_normalized) WHERE archived_at IS NULL`
  und `uniqueIndex(workspace_id, slug_normalized) WHERE archived_at IS NULL`
  (F1.8-Muster: Archivierung gibt Name UND Slug wieder frei).
- CHECKs: Name nicht-leer/längenbegrenzt/normalisiert; Slug
  `^[a-z0-9][a-z0-9._-]{0,63}$`; Archiv-/Zeitstempel-Regeln wie
  `lead_source`.
- `project.funnel_campaign_id` NULLABLE + composite-FK
  `(workspace_id, funnel_campaign_id)` + Index
  `project_ws_funnel_campaign_idx`. NULL = keine Kampagne (kein
  Bucket-Zwang); Historie bleibt nach Kampagnen-Archivierung lesbar
  (kein ON DELETE, kein stilles Nullen).

## Validierung (fail-closed, keine stillen Defaults)

- Kampagne anlegen: `lead_source.write` (bestehend, KEIN neuer Key);
  Name/Slug-Regeln wie oben; Quelle muss existieren UND aktiv sein
  (archivierte Quelle verweigert — anders als die F1-11-Quellenprüfung,
  die historisch auch archivierte Quellen zulässt; Bestand bleibt
  unberührt).
- Archivieren: `lead_source.write`; bereits archiviert = idempotent OK;
  fremde/archivierte Kampagne = NotFound.
- Manuelle Erfassung: `project.write` (bestehend). `funnelCampaignId`
  UND `leadSourceId` gleichzeitig = `ManualLeadValidationError`
  (mehrdeutige Attribution, kein stiller Vorrang). Kampagne muss
  existieren, aktiv und im Workspace liegen, sonst
  `FunnelCampaignNotFoundError` (Action → `invalid`, wie
  `LeadSourceNotFoundError`). Kampagne setzt `lead_source_id` auf IHRE
  Quelle (kein Mischen) und `funnel_campaign_id` auf sich.
- Listen (Formular-Dropdown, Verwaltung): `lead_source.read`; nur aktive,
  nach Name sortiert. Archivierte erscheinen nirgends zur Auswahl.

## Anzeige

- Manuell-Formular (`/anfragen`): Kampagnen-Dropdown (aktive, „Keine
  Kampagne"); gewählt → Quelle wird von der Kampagne bestimmt
  (Quellen-Dropdown bleibt für kampagnenlose Erfassung).
- Lead-Quellen-Verwaltung (`/einstellungen/lead-quellen`): Kampagnen-
  Abschnitt (anlegen mit Name/Slug/Quelle, archivieren; ohne
  Schreibrecht nur lesend).
- Projektakte: Kampagnen-Name neben der Lead-Quelle (NULL → keine Zeile).

## Akzeptanz

- Unit/DB: Namens-/Slug-Regeln, Doppelanlage (aktiv → Konflikt, nach
  Archiv → frei), fremde/archivierte Quelle verweigert,
  Attribution (Quelle + Kampagne gesetzt), Doppelangabe
  Quelle+Kampagne verweigert, fremde/archivierte Kampagne verweigert,
  Tenant-Fixture `funnel_campaign` (Invarianten-Suite bleibt grün).
- Actions: Formular-Parität (Kampagnen-Allowlist nur aktiv+eigener
  Workspace).
- E2E (isolierter Workspace, F7-12-Muster): Kampagne anlegen →
  manuelle Anfrage mit Kampagne → Projektakte zeigt Kampagne +
  Quelle; Axe sauber.
- Gates: lint/typecheck/test + CI `codex-lane-gates` grün; keine neuen
  Permissions (nur `lead_source.read/write`, `project.write`,
  `note.write` wie F1-11).
