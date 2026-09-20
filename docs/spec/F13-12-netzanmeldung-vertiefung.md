# F13-12 Netzanmeldung-Vertiefung (Katalog F13.1)

Stand: GEBAUT (Migration 0261, 2026-09-20; Welle 2: Backend/Portal/UI
als Schwarm, Owner-Integration).
Ref: `tests/unit/f1312-netz.red.test.ts` (6 Tests, entskippt, grün).

Ziel: Katalog F13.1 als zweite Stufe über F13-02 legen — 2-stufiger
Netzpfad (Einreichung → Fertigmeldung) mit Rückfrage-Loop,
Einspeisezusage, Datei-Slots, 6-Monats-Frist, MaStR/Wallbox-Add-ons.
Bauarbeit, kein Referenzbeleg. Die F13-02-Grenzen bleiben: 1:1 je
Projekt (UNIQUE, keine Durchlauf-Historie, F13-02 :10-17),
`installation.read`/`installation.write` ohne neue Keys, Zählernummer
nie ins Portal (F13-09 §3). Keine Migration in diesem Slice (reine
Spec + RED-Test; Bau-Scope unten skizziert).

Katalog-Mapping (F13.1 → Maschine): Draft → `vorbereitung`,
Submitted → `eingereicht`, Rückfrage → `rueckfrage`, VNB accepted →
`genehmigt`, Einspeisezusage → `einspeisezusage`, Closed →
`fertiggemeldet` → `abgeschlossen`, Rejected → `storniert` (mit
Wiedereröffnung statt eigenem Rejected-Status, §1).

## §1 Status-7 (+ Storno)

Sieben Produktivstatus plus `storniert` als Seitenzustand:

- `vorbereitung → eingereicht → genehmigt → einspeisezusage →
  fertiggemeldet → abgeschlossen`.
- Rückfrage-Loop: `eingereicht ↔ rueckfrage` (VNB-Rückfrage und
  Wiedereinreichung; `rueckfrage → storniert` bleibt möglich).
- `einspeisezusage` liegt zwischen `genehmigt` und `fertiggemeldet`
  (Zusage des VNB ≠ Genehmigung zur Errichtung).
- `storniert` aus jedem nicht-abgeschlossenen Zustand (F13-02-Muster);
  NEU: Kante `storniert → vorbereitung` (Wiedereröffnung nach Storno
  statt neuem Rejected-Status; F13-02 :16-17 wird damit geöffnet).
- `abgeschlossen` bleibt terminal; Zeiten je Übergang (Service setzt
  `submitted_at`/`decided_at`/`completed_at`, nie per Hand).

## §2 Phasen-Guards

Übergang `→ fertiggemeldet` erfordert beides, sonst
`GridRegistrationValidationError` (fail-closed):

1. Zählernummer gesetzt (`meter_number` nicht-null, nicht-leer).
2. Foto-Mindestzahl erreicht: ≥ 16 Fertigmeldungs-Fotos (§3).

Vertrag (vom RED-Test gepinnt): Export
`GRID_REGISTRATION_FERTIGMELDUNG_REQUIRES_METER` (Guard-Kennzeichen)
und `GRID_REGISTRATION_FERTIGMELDUNG_MIN_PHOTOS = 16`.

## §3 Datei-Slots (F13-07-Muster)

Keine neuen Upload-Pfade: Datei-Anfragen (F10-04) mit Titel-Vorgaben,
Verknüpfung per Titel-Präfix wie F13-07 (BnD-Beleg-Titel trägt den
Kontext, kein Schema-Umbau am anonymen Pfad):

- Stufe 1 (Einreichung): `Netz-Vollmacht`, `Netz-Zählerfoto`,
  `Netz-Planungs-PDF` (je eine Anfrage, `allow_many = false`).
- Stufe 2 (Fertigmeldung): `Netz-Fertigmeldungs-Fotos`
  (`allow_many = true`; Zähl-Guard: `upload_count ≥ 16` bzw.
  Dateinamens-Zahl ≥ 16 für den §2-Guard).
- Portal-Projektion unverändert (Titel reicht, F13-07-Präzedenz).

## §4 Frist (6 Monate, Tracking ohne Automatismus)

- Spalte `fertigmeldung_due` (Datum): `submitted_at + 6 Monate`,
  gesetzt beim Übergang `→ eingereicht` (Service, nie per Hand).
- Akte zeigt Fälligkeit + Überfälligkeit (Tracking-Liste je
  Workspace: Projekt, Status, Fälligkeitsdatum, überfällig ja/nein).
- Kein Automatismus: kein Worker, keine Mails, keine Eskalation
  (F13-02 :25 bleibt dafür offen).

## §5 Add-ons (MaStR + Wallbox, Preis-Snapshot)

Flags + Preisstand je Anmeldung, keine Fremdsystem-Anbindung:

- Spalten: `mastr_addon` / `wallbox_addon` (bool, default false),
  Preis-Snapshot `addon_produkt` (`pv` | `wp`),
  `addon_betrag_cents` (int, ≥ 0).
- Vertrag: Export `GRID_REGISTRATION_ADDONS`
  (`["mastr_addon", "wallbox_addon"]`); DTO trägt Flags + Snapshot.
- Kein MaStR-SOAP-Client: nur Vormerkung („Kunde wünscht
  MaStR-Service / Wallbox-Mitmeldung") plus eingefrorenem Preis;
  tatsächliche Meldung bleibt Handarbeit (F13-02 :45 bleibt offen).

## §6 Details-Sperre

Betreiber/Zähler pflegen nur in `vorbereitung`/`rueckfrage`:

- `setGridRegistrationDetails` wirft ab `eingereicht` (außer
  Rückfrage-Rückkehr) `GridRegistrationValidationError`.
- Vertrag: Export `GRID_REGISTRATION_EDITABLE_STATUSES =
  ["vorbereitung", "rueckfrage"]`.
- UI: Felder ab `eingereicht` readonly (außer `rueckfrage`).

## §7 DE-only, IT/BR deferred, Auto-Ordner

- DE-only: keine Länderprofile, keine fremden Marktprozesse im
  Netzpfad; IT/BR-Eingaben werden fail-closed abgewiesen (Guard wie
  F4-02d-Länder-Default). IT/BR bleiben Roadmap (Verweis:
  Länder-Slices F4-02d), kein Code-Pfad in diesem Slice.
- Auto-Ordner bis zum Mappen-Generator: Die §3-Titel-Vorgaben
  (`Netz-…`) sind der Ordner-Ersatz; ein echter Projektmappen-
  Generator (Verzeichnisstruktur/Export) ist Folgethema.

## Bau-Scope (Skizze, NICHT in diesem Slice)

1. Migration 01xx: `grid_registration`-CHECK + `rueckfrage` /
   `einspeisezusage`; Spalten `fertigmeldung_due`,
   `mastr_addon`, `wallbox_addon`, `addon_produkt`,
   `addon_betrag_cents`; RLS/Rollenvertrag unverändert.
2. Service: Kanten §1, Guards §2, Sperre §6, Frist §4, Add-ons §5;
   Events/Audit IDs + Status (kein Kundenkontext).
3. Akte-Sektion: Status-Buttons je legalem Folgezustand, Datei-Slots
   §3, Frist-Anzeige §4, Add-on-Flags §5.
4. Portal: `portalGridSchema`-Status +2 Werte (Resolver-Projektion
   sonst unverändert, nie Zählernummer — F13-09 §3).

## Testmatrix (Bau-Slice)

- `F1312-DB-01`: Rückfrage-Loop begehbar, Einspeisezusage-Kette,
  `storniert → vorbereitung` möglich, `abgeschlossen` terminal.
- `F1312-DB-02`: `→ fertiggemeldet` ohne Zählernummer / mit < 16
  Fotos abgewiesen; mit Zählernummer + 16 Fotos offen.
- `F1312-DB-03`: Details-Sperre ab `eingereicht`, offen in
  `vorbereitung`/`rueckfrage`; Frist = Einreichung + 6 Monate.
- `F1312-DB-04`: Add-on-Flags + Preis-Snapshot rundgespeichert.
- `F1312-E2E-01`: Akte → einreichen → Rückfrage → wiedereinreichen
  → genehmigen → Einspeisezusage → Fotos → fertigmeldung.

## ROT-Beleg (2026-09-19, `npx vitest run tests/unit/f1312-netz.red.test.ts`)

```text
FAIL ... Rückfrage-Loop: eingereicht ↔ rueckfrage ist begehbar
AssertionError: expected [ 'vorbereitung', 'eingereicht', …(4) ] to include 'rueckfrage'
FAIL ... Einspeisezusage steht zwischen genehmigt und fertiggemeldet
AssertionError: expected [ 'vorbereitung', 'eingereicht', …(4) ] to include 'einspeisezusage'
FAIL ... Fertigmeldung ohne Zählernummer ist abgewiesen (Guard-Export)
AssertionError: expected false to be true // Object.is equality
FAIL ... Foto-Mindestzahl 16 ist als Konstante exportiert
AssertionError: expected false to be true // Object.is equality
FAIL ... Add-on-Flags MaStR + Wallbox mit Preis-Snapshot sind vorgesehen
AssertionError: expected false to be true // Object.is equality
FAIL ... Details-Sperre: Edit nur in vorbereitung/rueckfrage
AssertionError: expected false to be true // Object.is equality

Test Files  1 failed (1)
     Tests  6 failed (6)
```

Danach `describe.skip` mit Ref auf diese Spec; der Bau-Slice
entskippt die 6 Tests und macht sie grün.
GRÜN-Beleg (2026-09-20, Migration 0261): Unit 6/6, DB F1312-DB-01…04,
Nachbarn f1302/f1309 + f1001, E2E F1312-E2E-01 (Kette + Guard-Block +
16-Foto-Seed bis Abschluss) — Belegzahlen im Commit.
Owner-DECIDED: Fotozählung per photoCount-Parameter (keine
file_request-Kopplung im Grid-Service); Add-ons jederzeit pflegbar
(§6 sperrt nur Betreiber/Zähler); Re-Entry löscht nichts.

## Bewusst offen (Delta zu F13-02 :24-25/:45)

- MaStR-Meldung (echt), Netzbetreiber-Integration, Historie mehrerer
  Durchläufe (1:1 bleibt), Fristen-Automatik, Mappen-Generator,
  IT/BR-Länderpfade, Angebotsbindung (Q-F13-ANGEBOTSBINDUNG-M2).
- Geschlossen durch diese Spec: Dokumente (als Datei-Slots §3),
  Frist-Tracking (§4, ohne Automatismus).
