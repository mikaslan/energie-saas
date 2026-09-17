# SPEC F7-02i — Unterschrift-Punkt (Katalog F7.2)

## Matrix
F7.2 Item-Typen: checkbox/radio/multi/freetext/image/description VERIFIED;
signature (mit Typ Kunde/Techniker/Dritter) offen. Q-ARCHIV-Vermerk:
Ablage ist WORM (immutable Keys, sha256-Beleg, F10-10-Praezedenz) —
keine weitergehenden Archiv/Rechts-Behauptungen in diesem Slice.

## Ziel
kind=signature: Unterschrift per Zeichenflaeche (Canvas) erfassen,
als PNG unveraenderlich ablegen, Vorschau lesbar, Reload-fest,
Ersetzen = neuer Key. Rollen-Typ je Punkt (Struktur), abhakbar wie
Aufgabe (required/done, Gates wie image).

## Entwurf (02g-Wiederverwendung, minimal)
- Tree-Key `photo` WIEDERVERWENDET (haelt am Signaturpunkt das
  Signatur-PNG; gleiche Domain/Regex/Upload-Op, Kind-Check auf
  image+signature erweitert). KEIN neuer Storage-Pfad.
- Neuer Tree-Key `signerRole` (kunde/techniker/dritter, nullish):
  STRUKTUR (kein Strip, Setzen nur mit Strukturrecht — dueDate-
  Spiegel F7-02h). Spiegel-Regel: nur am Signaturpunkt.
- `photo`-Spiegel erweitert: non-null nur bei kind image/signature.
- Upload-Op: gleiche Validierung (PNG aus Canvas; JPEG weiter
  erlaubt — Fehlertyp-Faelle unveraendert), gleiche Route.
- Typwechsel ehrlich: zu image/signature/task/... faellt jeweils die
  fremde Nutzlast (photo immer null; signerRole nur an signature).

## Vertrag DB (0175, Replace nur `_f704_valid_checklist_blocks`)
- Key-Allowlist + `signerRole`; kind-IN + `signature`.
- `photo`-Spiegel: kind IN (image, signature).
- `signerRole`: String aus (kunde, techniker, dritter), nur bei
  kind=signature (nullish ok).
- signature = Arbeitspunkt (required/done erlaubt; keine Gate-Regel).
- `_f704_checklist_structure` UNVERAENDERT (photo bleibt Nutzlast,
  signerRole bleibt Struktur).
- Rollen-Pin validBlocks neu harvesten.

## Vertrag App
- kind-Enum + signature; Item-Schema + signerRole-Enum (nullish);
  Spiegel-Refines (photo: image/signature; signerRole: signature);
  signature in Arbeitskind-Liste + isChecklistWorkItem.
- Service-Kind-Check: image ODER signature (Fehlerklasse unveraendert).
- Manager: Typ-Option „Unterschrift"; Strukturmodus: Rollen-Select
  (`aria-label {Titel}: Rollentyp`, Optionen Kunde/Techniker/Dritter);
  Zeichenflaeche (Canvas 300x100, Stift schwarz 2px) + „Löschen" +
  „Unterschrift speichern" (leere Flaeche = Hinweis, kein Upload);
  Vorschau wie Foto (`{Titel}: Unterschrift-Vorschau`); Antwortmodus
  analog (Editor signiert, Rolle nicht aenderbar); Viewer: nur Vorschau.
- Template-Manager: Option „Unterschrift" (kind 1:1, nie Inhalt).

## Sicherheit
- Wie 02g (Allowlist, Limits, Keys, WORM, uniforme Fehler, nosniff).
- Canvas-PNG client-seitig erzeugt, server-seitig revalidiert
  (Typ/Groesse/sha-Beleg); leere Flaeche nie hochgeladen.

## Tests (RED zuerst)
- DB: `tests/db/f702i-checklist-signature.test.ts` — kind+role+Key
  persistiert; photo-allein am task verworfen; signerRole am task
  verworfen; Struktur: Rollenwechsel IST Struktur (Editor-42501),
  Signatur-Bytes sind Nutzlast (Editor darf signieren).
- SVC: Upload an Signaturpunkt ok (SVC-03-Analog); Fehltyp-Matrix
  unveraendert (02g-Suite bleibt gruen).
- E2E: `tests/e2e/f7-02i-checklist-signature.spec.ts` — Rolle waehlen,
  Strich zeichnen (Maus), speichern, Vorschau, Reload, Viewer, Axe.
- Bestehende 02g-Tests bleiben unveraendert gruen (Kind-Check-
  Erweiterung ist Obermenge; SVC-03 assertiert nur Klasse).

## Akzeptanz
- `npm run check` gruen; E2E Chromium gruen; Heartbeat + Push + CI gruen.
