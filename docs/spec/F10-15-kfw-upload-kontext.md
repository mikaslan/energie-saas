# F10-15 KfW-Upload-Kontext in der Foerdersektion

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/muse-fleet-3-portal-install` · Stand 2026-09-17
Beleg: `npm run check` exit 0 (410 Dateien, 2893 bestanden/1 skipped,
Rollen 88/88, PG18 5/5), F1015 DB 1/1 + Contract 2/2, E2E F10-15 1/1
(375/768/1440 + Axe, Badge/Block/Negativfaelle, Upload ok+ungueltig,
Ruecksprung, Tab-Default), 23 Portal-Nachbar-E2E gruen, Build exit 0,
db:generate ohne Drift, 2 Reviews GO (P1 + alle P2 geschlossen)
Basis: Modulkatalog F10.2 (KfW-Bereich „mit Chat + Upload-Dropzone").
Baut auf F13-04 (Foerderstand), F13-10 (Chat), F13-07 (aktenverknuepfte
Datei-Anfragen via `file_request.subsidy_case_id`), F10-13 (Dateityp).
Kein Reonic-Referenzbeleg; Verhalten ist reversible eigene Naeherung
(ESTIMATE).

## Ziel und Abgrenzung

Die Portal-Foerdersektion (Uebersichts-Tab) zeigt Stand + Chat, aber
keinen Upload-Kontext: aktenverknuepfte Datei-Anfragen erscheinen nur
im Dateien-Tab ohne Foerder-Kennzeichen. Dieser Slice: Projektion
`subsidyLinked` je Anfrage → Kennzeichen im Dateien-Tab + verknuepfte
Anfragen mit Upload-Formular direkt in der Foerdersektion
(Dropzone-Ersatz ohne JS: Datei-Feld + Button, Muster Dateien-Tab).

Nicht in diesem Slice: neue Chat-Funktionen, Aenderung an
Akte/Chat/Guards (F13-07/F13-10), Upload-Logik (F10-04/F10-10/F10-13),
neue Woerterbuecher (Reuse, s. ESTIMATEs), KfW-Programmlogik.

## ESTIMATEs (Reonic-Referenz unbekannt)

- Ein Bit reicht: `subsidyLinked = (subsidy_case_id IS NOT NULL)` —
  bei genau einer Akte je Projekt (v1-Grenze F13-03) kein Akten-ID-Hash
  ins Portal (waere verdeckte interne Referenz ohne Nutzen).
- Eine Liste, zwei Sichten: gleiche Anfragen-Liste wie Dateien-Tab,
  Foerdersektion filtert client-seitig (serverseitig gerendert) auf
  `subsidyLinked`; kein zweiter Resolver-Pfad.
- Keine neuen Portal-Strings (keine 22 geratenen Uebersetzungen):
  Kennzeichen = vorhandenes `subsidyHeading` („Foerderung"/„Subsidy"/…),
  Blocktitel = vorhandenes `filesHeading`, Formular/Feedback = vorhandene
  Upload-Woerter. Eigene KfW-Labels bleiben Folge-Slice mit Referenz.
- Ruecksprung per `returnTab` (Allowlist `uebersicht|dateien`, Default
  `dateien`); Foerder-Uploads kehren zur Uebersicht zurueck.
- Alle Punkte reversibel.

## Vertrag

- Resolver (`resolve_portal_public_view`, SECURITY DEFINER):
  `fileRequests[].subsidyLinked` (Boolean, `subsidy_case_id IS NOT
  NULL`). Minimiert: nur das Bit, keine Akten-ID.
- Contract (`portalFileRequestSchema`): `subsidyLinked` Pflicht-Boolean
  nach tolerantem Parse; fehlend = Alt-Projektion → `false`;
  deformiert (nicht-boolean) ⇒ Gesamt-`null` fail-closed.
- Dateien-Tab: verknuepfte Anfragen tragen Kennzeichen
  (`t.subsidyHeading`, `data-testid="file-request-subsidy-badge"`).
- Foerdersektion (Uebersicht): Block „Dateien" (`t.filesHeading`,
  `data-testid="portal-subsidy-files"`) genau dann, wenn verknuepfte
  Anfragen existieren; je Anfrage Titel + Stand + Upload-Formular
  (Muster Dateien-Tab: `accept` je `fileType` per F10-13-Maps,
  Dateityp-Hinweis, `returnTab=uebersicht`); Upload-Feedback (`?upload=`,
  gleiche Texte + `data-testid="file-request-upload-feedback"` —
  Tabs rendern exklusiv, kein Doppel-Testid).
- Route `POST /p/[token]/file-requests`: `returnTab` aus Formular
  (Allowlist, Default `dateien`); Redirect `?tab=<returnTab>&upload=…`
  (303, Sprach-Cookie wie bisher) — fuer `uebersicht` entfaellt der
  `tab`-Param per Konvention (Page-Default + Nav-Link, Review P2-1).
  Guards unveraendert (gleicher Service-Pfad, gleiche Fehlertypen).
- Rechte: keine neue Permission (Token-DEFINER wie bisher).
- Events/Audit: keine neuen Typen.

## Datenmodell (Migration 0172, additiv)

- Nur Resolver-Replace: `CREATE OR REPLACE resolve_portal_public_view`
  (beide Ruempfe im Owner-Tanz, Muster 0170: `'subsidyLinked'` in
  `file_request_list`; Signatur unveraendert — Grants bleiben).
- Keine Modell-Migration (`subsidy_case_id` existiert seit F13-07).
- Rollenvertrag: Stufenmarker `hasPortalFileRequestSubsidyLinked`
  (prosrc enthaelt `subsidy_case_id IS NOT NULL`, Muster 0171);
  bedingter Prosrc-Pin als neue Kettenstufe (Hash per Embedded-Probe
  geerntet, alte Prefixe bleiben gruen).
- Journal-/Upgrade-Pins: `TOTAL_MIGRATION_COUNT` 151 → 152, End-Eintrag
  `0172_...` (Erweiterung, kein Umbau).

## Geschlossene Testmatrix

- `F1015-DB-01`: Projektion `subsidyLinked` (verknuepft true, allgemein
  false, nach Upload weiter true); keine Akten-ID in der Sicht.
- `F1015-CONTRACT-01`: gesetzt/fehlend (`false`)/deformiert (`null`).
- `F1015-E2E-01` (isolierter Workspace): Akte + verknuepfte + allgemeine
  Anfrage (per Service-Seed? — E2E nutzt UI-Anlage + SQL-Seed der Akte;
  Details s. Implementierung) → Dateien-Tab zeigt Kennzeichen nur an
  verknuepfter → Foerdersektion listet nur verknuepfte + Upload dort →
  Ruecksprung Uebersicht + Feedback → Beleg im Dateien-Tab sichtbar.
  Viewports 375/768/1440 + Axe als anonymer Kunde.

## Bewusst offen

- Eigene KfW-Upload-Wortlaute (Referenz fehlt; Reuse ist ehrlich).
- Upload direkt aus Chat-Nachricht heraus; Drag&Drop (braucht JS).
- Kennzeichen-Filter/Suche im Dateien-Tab.
- `returnTab`-Allowlist-Erweiterung (nur existierende Tabs).
