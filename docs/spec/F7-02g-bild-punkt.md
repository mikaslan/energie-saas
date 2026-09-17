# SPEC F7-02g — Bild-Punkt (kind=image, Foto-Upload)

## Matrix
F7.2 (Katalog: Text, Bild, Auswahl, Aufgabenliste, Datum, Unterschrift).
02e (text) + 02f (multi) VERIFIED; 02g (image) naechste offene Punktart.
Kein Portal-Bezug (interne Checkliste, kein Ticket/Route).

## Ziel
Checklistenpunkt `kind=image`: Monteur laedt genau ein Foto (JPEG/PNG,
max. 10 MiB) je Bild-Punkt hoch; Foto ist im Tree persistiert (Key),
Vorschau lesbar, Reload-fest, Ersetzen erzeugt neuen Key (WORM).

## Entwurf (F7-02e-Spiegel, kein neues DB-Objekt ausser Validator-Replace)
- Tree-Key `photo` (Storage-Key, String) nur am Bild-Punkt, sonst Spiegel
  von `value`: Antwort-Nutzlast, kein Gate, keine Struktur.
- Upload = neue Service-Op `uploadChecklistItemPhoto` (checklist.write):
  validiert (Punkt existiert, kind=image, Typ/Endung/Groesse), `putImmutable`,
  Beleg-Integritaet (sha256-Vergleich, F10-10-Praezedenz), gibt Key zurueck.
  Persistenz via bestehenden Whole-Tree-Save (Version-CAS); nie gespeicherte
  Keys verwaiste WORM-Objekte (ESTIMATE, dokumentiert).
- Anzeige = neue Service-Op `readChecklistItemPhoto` (checklist.read):
  Key aus Tree, Bytes via Storage-get, ausgeliefert ueber Session-API-Route
  (Praezedenz File-Request-Upload: Route statt Server-Action wegen
  10 MiB / 1-MB-Action-Limit; Vorschau als Daten-URL).
- Key-Schema (projekt-skoped, F10-10-Praezedenz):
  `immutableKey(projectId, "checklist-photos", itemId_sha8.ext)` — ohne
  Checklist-ID, damit der Upload auch vor dem ersten Save laeuft (die
  Save-Kapsel 0077 vergibt Server-IDs selbst). Gleiche Bytes erneut =
  idempotenter Erfolg (inhalts-deterministisch).
- Ersetzen: neuer Upload + Save (neuer Key); kein Delete (WORM).

## Vertrag DB (0173, Vollkopie 0144 + Foto)
- `_f704_valid_checklist_blocks`: Key-Allowlist + `photo`; kind-IN +
  `image`; `photo` nur String + clean_text(500) + Key-Regex
  `^immutable/[0-9a-f-]{36}/checklist-photos/[0-9a-f-]{36}_[0-9a-f]{8}\.(jpg|jpeg|png)$`;
  Spiegel-Regel: non-null `photo` nur bei kind=image. image ist
  Arbeitspunkt (required/done erlaubt, keine Gate-Aenderung).
- `_f704_checklist_structure`: `photo` in die done/value-Streichliste
  (Editor-Antwort auf Vorlagen ab Version 1, F7-03b-Praezedenz).
- Owner-Tanz wie 0142/0144 (plain CREATE OR REPLACE; kein neues Objekt).
- Rollen-Pins beider Validatoren neu harvesten (db:roles:verify).

## Vertrag App
- `checklistItemKindSchema` + `image`; Item-Schema + `photo` (Key-Regex,
  max 500, nullish); Spiegel-Refine (photo nur bei image); image in die
  Arbeitskind-Liste (Zeile 280f); Counter: image wie task (done/total).
- Template-Vertrag: gleiche kind-Enum (automatisch); Manager-Select +
  Bild-Option; Apply transportiert kind 1:1; `photo` nie in Vorlagen
  (Antwort-Nutzlast, kein Template-Feld).
- Typwechsel-Reset (Praezedenz 02e): weg von image → `photo=null`;
  zu image → `description/value=null`.
- Manager-UI: Bild-Option im Typ-Select; Bildpunkt rendert Datei-Input
  (accept image/jpeg,image/png) + Hochladen-Button + Vorschaubild
  (Base64 via Server-Action) + Ersetzen-Hinweis; Fehlertext deutsch,
  kein Key-Leak (nur Fehlertyp).
- i18n: keine Keys — interne UI ist deutsch-hardcodiert (Manager-Praezedenz);
  Upload/Lesen als Session-API-Route (10 MiB, 1-MB-Action-Limit unberuehrt,
  F10-04-Praezedenz).

## Sicherheit
- Keine neue Tabelle/Permission/Route; reine Validatoren ohne Grant
  (nur via DEFINER-Kapsel); RLS unberuehrt.
- Upload-Validierung Service-seitig VOR putImmutable (Fail-fast, kein
  Orphan bei Fehltyp); fremde Keys nicht uebernehmbar (Service baut Key).
- Audit: Save-Audit traegt Tree-Write (kein Foto-Detail mit Key/Dateiname).
- Härtung: 10-MiB-Limit (DoS), Allowlist JPEG/PNG + Endungs-Match
  (Sniff-Schutz), Key-Regex serverseitig (Pfad-Traversal tot).

## Tests (RED zuerst)
- DB: `tests/db/f702g-checklist-image-photo.test.ts` — kind=image + Key
  gueltig; photo an task → CHECK verletzt; ungueltiger Key → verletzt;
  Struktur-Aequivalent (photo-Wechsel ≠ Struktur); image mit
  required/done gueltig.
- Service: Upload-Happy-Path (Key-Schema, sha8), Fehltyp/Endungsmismatch/
  Uebergroesse/Leere, kind!=image, unbekannter Punkt; Read: ok,
  unbekannt, fehlendes Storage-Objekt (NotFound); kein Key-Leak in Errors.
- E2E: `tests/e2e/f7-02g-checklist-image-photo.spec.ts` — Bildpunkt
  anlegen, Foto hochladen, Vorschau sichtbar, Reload persistent,
  Ersetzen, Viewer sieht, Axe.
- Fixture: kleinstes gueltiges PNG/JPEG als Byte-Array (kein Asset-File).

## Akzeptanz
- `npm run check` + `npm run db:roles:verify` gruen; E2E Chromium gruen;
  Heartbeat + Push + CI gruen.
