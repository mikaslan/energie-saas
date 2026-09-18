# SPEC F7-15b — Fotodoku-Markup-Editor (Katalog F7.8)

## Matrix
Katalog F7.8 (Modulkatalog: „Order Parts
...; Fotodoku mit Batch-Aufnahme und
Markup"): Order Parts VERIFIED (F7-12),
Batch VERIFIED (F7-15). F7-15-SPEC Zeile
8 deferriert „Markup ist explizit
Folgeslice" — dieser Slice schliesst den
letzten offenen Rest von F7.8. Kein
Portal-Change, keine neue Permission,
kein Provider, keine Migration.

DECIDED (Parent-Entscheid, reversibel):
KEIN Sidecar/keine Vektor-Ablage — die
annotierte Kopie wird als NEUES Foto
ueber den bestehenden 02g/F7-15-Upload-
Pfad hochgeladen (WORM-sicher via
immutable Keys + putImmutable, Audit via
Upload + Tree-Save). Verworfen: Sidecar-
JSON (Annotationen als Daten + Live-
Render) — neue Ablage + neues Schema +
neue Route + neuer Renderer, kein
minimaler Slice; die eingebrannte Kopie
ist ueberall lesbar (Viewer, Galerie,
GET+index) ohne einen einzigen neuen
Leser.

## Bestand (verifiziert am Code)
- Katalog fordert Markup:
  `docs/blaupause/01-modulkatalog.md:98`
  („Fotodoku mit Batch-Aufnahme und
  Markup").
- 0 Markup-Code im Repo: `grep -rni
  "markup|annotat" app modules lib` = 0
  Treffer.
- Foto-UI: `ItemPhotoControl`
  (project-checklist-manager.tsx:1328-
  1523) — Galerie-`<li>` je Foto mit
  Entfernen-Button (Z.1480-1488, nur
  canWrite), Zaehlung Z.1494-1496,
  Multiple-Input accept jpeg/png
  Z.1499-1507, Upload-Loop Z.1410-1427
  mit funktionalem Merge+Dedupe
  Z.1432-1440.
- Cover-Re-Derivation: `changeItemPhotos`
  Z.291-293 (`photo = photos[0] ??
  null`), `removeAt` Z.1453-1457,
  `galleryKeys` Z.1315-1319 (Legacy-
  `photo` als Ein-Foto-Galerie).
- `useItemPhotoPreview` Z.1222-1268
  (Single-Vorschau, Signatur);
  Galerie-Previews Z.1340 + GET+index-
  Fetch Z.1369-1389 (Ref-Guard, Keys mit
  Preview werden nie gefetcht).
- Upload-Helper `postItemPhoto`
  Z.1274-1302 (FormData checklistId/
  itemId/datei, wirft
  `ItemPhotoUploadError`); deutsche
  Fehlertexte `itemPhotoUploadErrorText`
  Z.1304-1311 (kein Key-Leak).
- Canvas→PNG-Praezedenz: `canvasToPng`
  Z.1205-1212 + `blobToDataUrl`
  Z.1196-1203 (Duplikat in
  installation-section.tsx:63-79);
  Signatur-Save Z.1573-1604 (canvasToPng
  → postItemPhoto mit Filename
  „unterschrift.png" → lokaler Preview +
  Tree-Patch).
- Signatur-Canvas Z.1642-1676: Pointer-
  Events, Tap-Punkt, KEIN Tastatur-Pfad
  (kein onKeyDown).
- Route POST `.../checkliste/foto/
  route.ts:27-89`: uuid-Guards, FormData-
  `datei`, Size-Pre-Check gegen
  `CHECKLIST_PHOTO_MAX_BYTES` (Z.47),
  `authorizedAction` checklist.write
  (Z.61-64) → `uploadChecklistItemPhoto`
  (Z.65); Antwort `{photoKey}` (Z.74);
  Mapping Validation→400, NotFound→404,
  403/401/500 (Z.75-88).
- Service `uploadChecklistItemPhoto`
  (modules/checklists/service.ts:457-
  542): MIME-Allowlist jpeg→jpg/png→png
  (Z.396-399), Cap 10_485_760 (Z.395+
  475), Endungs-Match (Z.478-482),
  Fail-fast VOR put (Projekt-Sicht +
  Tree-Art image|signature, Z.484-501),
  Key `immutableKey(projectId,
  "checklist-photos",
  `${itemId}_${sha8}.${ext}`)`
  (Z.503-508), putImmutable + Receipt-
  Vergleich (Z.509-515), WORM-Conflict →
  Read-back-Idempotenz (Z.516-540).
- Lesen: `readChecklistItemPhoto`
  Z.557-593 (Galerie `photos ?? [photo]`
  Z.581, Index-Default 0 Z.582, Key-
  Regex Z.584, fehlend→NotFound Z.587-
  592); GET+index route.ts:91-150
  (Ziffern + Schranke `CHECKLIST_ITEM_
  PHOTOS_MAX` Z.103-109, checklist.read
  Z.119-124, no-store Z.132).
- Key-Regex + Galerie-Max:
  `lib/integrations/checklists/
  contract.ts:22-26` (Pattern Z.22-24,
  `CHECKLIST_ITEM_PHOTOS_MAX = 8`
  Z.26); photos-Element = photo-Regel
  (Z.150).
- E2E-Maus-Praezedenz: Canvas-Zeichnen
  per boundingBox + mouse.move/down/up
  mit steps (f7-02i-E2E Z.177-184).
- Dialog-Praezedenz: `role="dialog"`-
  Divs (z.B. project-task-editor-
  dialog.tsx:493); natives `<dialog>`
  nirgends.
- drizzle-Stand endet bei 0185
  (`0185_f7_02l_circuit_plan.sql`) —
  keine Nummer zu vergeben.

## Ziel
Der Monteur markiert ein Galerie-Foto
(Pfeil + Kurztext) und speichert; die
annotierte Kopie erscheint als
ZUSAETZLICHES Galerie-Foto, das Original
liegt unveraendert daneben (Cover bleibt
das Original). Reload-fest, Viewer liest
beide; ohne Schreibrecht kein Einstieg;
volle Galerie (8) = ehrlicher Fehler
statt stillen Verwerfens.

## Entwurf (02i-Canvas × F7-15-Galerie)
- Je Galerie-`<li>` ein „Markieren"-
  Button (nur canWrite, neben
  „Entfernen") → Editor-Dialog
  (client-only; Bild aus dem
  `previews`-Record — kein Server-
  Roundtrip vor Save).
- Dialog: Display-Canvas (Foto via
  drawImage als Hintergrund) +
  Annotations-Overlay als State-Liste
  (Pfeile + Texte); Farbe/Schrift fix,
  keine Picker.
- Save: Export-Canvas (Foto +
  Annotationen eingebrannt, lange Kante
  max 2048) → `canvasToPng` (Bestand)
  → Size-Pre-Check → `postItemPhoto`
  (Bestand, Filename „markiert.png") →
  lokaler Preview + `onChangePhotos`-
  Append (Updater+Dedupe-Muster) →
  Whole-Tree-Save (Bestand).
- Abbrechen (Escape/Button): kein
  Upload, kein Tree-Touch.

## Aufloesung (entschieden, belegt)
1. Umfang: PFEIL + TEXT, sonst nichts
   (DECIDED). Pfeil ohne Text erklaert
   nichts; Text ohne Zeiger ist ortslos
   — das Paar ist das minimale
   verstaendliche Markup. Gegen Stempel:
   braeuchten Taxonomie/Katalog (neues
   Vokabular, kein F7.8-Auftrag). Gegen
   Highlighter: halbtransparente
   Flaechen = Farb-/Deckkraft-UI, mehr
   Werkzeugflaeche ohne Auftrag. Gegen
   Coins/Marker-Pins: zweite
   Nummerierung neben der Galerie-
   Position — verwirrt; der Pfeil zeigt
   direkt. Gegen Freihand: unleserlich
   auf der Baustelle, E2E-flaky; 02i-
   Freihand ist Unterschrift
   (Personenakt), kein Sach-Markup.
   Fix: Rot, Linienbreite fix, Schrift
   fix — keine Picker (kein State, keine
   E2E-Kombinatorik).
2. Export: PNG NUR (DECIDED).
   `canvasToPng`-Wiederverwendung
   (Z.1205); eine JPEG-Qualitaet waere
   ein neuer Magic-Parameter ohne
   Praezedenz (Repo: 2× toBlob
   image/png, 0× JPEG-Export) und
   verlustbehaftet am Beweisfoto. Der
   MIME-Pin serverseitig bleibt
   jpeg+png (service.ts:396-399) — der
   Editor nutzt nur die png-Seite.
   Cap: `CHECKLIST_PHOTO_MAX_BYTES`
   10 MiB serverseitig unveraendert
   (route.ts:47 + service.ts:475);
   Client pre-checkt `blob.size`
   fail-fast mit deutschem Fehler.
   Export-Kante max 2048 (ESTIMATE,
   reversibel): Das Original bleibt in
   voller Aufloesung erhalten — die
   annotierte Kopie ist Arbeitskopie,
   kein Beweis-Ersatz; der Downscale
   haelt PNGs typischer Kamerafotos
   unter dem Cap.
3. Tastatur: KEIN Tastatur-Zeichnen
   (DECIDED). 02i-Praezedenz: der
   Signatur-Canvas hat keinen Tastatur-
   Pfad (Z.1642-1676). Der Dialog
   selbst ist tastaturbedienbar (Fokus,
   Escape-Abbruch, Buttons, Text-
   Input); Axe pinnt Labels/Kontrast/
   Fokus. E2E zeichnet per Maus
   (02i-Muster).
4. Zaehlung: Die annotierte Kopie ist
   ein regulaeres Galerie-Foto und
   zaehlt gegen das 8er-Max; bei voller
   Galerie ist der Markieren-Button
   disabled (Titel „Galerie voll" —
   ehrlich vor Save, nicht erst beim
   Fehler).

## Vertrag DB (KEINE Migration)
Verifiziert nicht noetig: (a) kein neues
Datum — annotierte Bytes liegen als
regulaeres checklist-photos-Objekt, die
Referenz als regulaeres photos-Element
(Validator 0180 deckt die Form); (b)
kein Tree-Wandel — Append nutzt den
bestehenden photos-Array + die Cover-
Regel, kein neuer Item-Key, daher kein
Validator-Replace; (c) RLS unberuehrt;
(d) kein Rollen-Pin — keine neue
Permission, keine DEFINER-Funktion
(`db:roles:verify` unberuehrt); (e)
drizzle endet bei 0185 — keine Nummer,
kein Journal-Eintrag, kein
`db:generate`-Drift.

## Vertrag App
- Neue Komponente `ItemPhotoMarkup-
  Dialog` IM Manager-File (Naehe zum
  `previews`-State wie `ItemPhoto-
  Control`/`ItemSignatureControl`, kein
  Prop-Drill-Export); pure Math
  (Skalierung, Pfeilgeometrie,
  Clamping) in Sibling `photo-markup.ts`
  daneben (DOM-frei unit-testbar).
- Einstieg: „Markieren"-Button je
  Galerie-`<li>` (Z.1467-1491, neben
  „Entfernen" Z.1480-1488, nur
  canWrite; aria-label je Position
  wie Z.1483). Props minimal:
  Quell-Key + Daten-URL + itemIndex +
  onSave/onClose.
- Dialog (`role="dialog"`-Praezedenz):
  Display-Canvas + Werkzeuge Pfeil/
  Text + Text-`<input>` (maxLength 140,
  ESTIMATE) + Speichern/Abbrechen.
  Annotationen als State-Liste
  (Display-Koords); Pfeil per Drag
  (Pointer-Muster 02i Z.1647-1673),
  Spitze rein geometrisch; Text-Anker
  per Klick.
- Skalierung: Display→Export-Faktor =
  Export-Kante / Display-Kante (nativ,
  gecappt 2048); pure Funktion
  `scalePoint`, Anker-Clamping (nie
  negativ/overflow) — unit-gepinnt.
- Save-Flow exakt: Export-Composit →
  `canvasToPng` → `blob.size <=
  CHECKLIST_PHOTO_MAX_BYTES`, sonst
  deutscher Fehler („Markiertes Foto
  zu gross (max. 10 MB).") →
  `postItemPhoto({... filename:
  "markiert.png"})` (Endungs-Match
  service.ts:481) → lokaler Preview
  (`blobToDataUrl`-Muster Z.1421-
  1422) → `onChangePhotos(itemIndex,
  append+dedupe, canWrite)`
  (Z.1433-1439-Muster) → Dialog zu.
  Fehler via `itemPhotoUploadErrorText`
  (Bestand).
- Kein Server-Roundtrip vor Save:
  Quelle ist `previews[key]`; fehlt
  der Preview (li ohne Bild), EIN
  GET+index-Fetch (Lese-Pfad, kein
  Save-Roundtrip).
- Original unberuehrt: kein `removeAt`,
  kein Reorder; Cover-Regel Z.291-293
  laeuft unveraendert (Append ans Ende
  → Cover bleibt `photos[0]`; Lesen
  Default-Index 0, service.ts:582).
- Viewer (canWrite=false): kein
  Markieren-Button (Entfernen-Muster
  Z.1479); Galerie zeigt beide Fotos.
- Route/Service/Contract/Validator:
  UNVERAENDERT (kein Diff ausserhalb
  Manager + `photo-markup.ts` + Tests).

## Sicherheit
- Keine neue Route/Permission/Tabelle;
  checklist.write (Upload) +
  checklist.read (Lesen) wie Bestand.
- Key nie client-gebaut (Service baut,
  service.ts:503-508); MIME-Allowlist +
  Endungs-Match + Cap serverseitig
  unveraendert (Upload-Validierung VOR
  putImmutable, kein Orphan bei
  Fehltyp).
- Text-Input: maxLength client,
  eingebrannt ins PNG (nie im Tree/in
  der DB → kein Stored-XSS-Traeger);
  Export ohne SVG/innerHTML (kein
  XSS-Sink).
- Audit via Tree-Save wie jedes Foto
  (kein Foto-Detail mit Key/Dateiname).
- no-store-GET unveraendert (neue
  Galerie-Position = neue URL-Bytes).

## Tests (RED zuerst)
- Unit (`tests/unit/f715b-foto-markup.
  test.ts`, pure `photo-markup.ts`,
  kein DOM): U-01 Display→Export-
  Skalierung (Faktor, 2048-Cap,
  Rundung); U-02 Pfeilspitzen-
  Geometrie (2 Fluegel, Winkel/Laenge
  deterministisch); U-03 Anker-
  Clamping (ausserhalb → gecappt, nie
  negativ/overflow); U-04 Text-
  Laengen-Cap (140).
- DB: KEINE eigene Datei (DECIDED
  gegen Fremdtest-Dopplung) — keine
  Migration, keine Service-Op-
  Aenderung; den Upload-Pfad pinnen
  die f702g- + f715-Suiten (muessen
  unveraendert gruen bleiben). Der
  Slice-Anteil ist client-only.
- E2E (`tests/e2e/f7-15b-fotodoku-
  markup.spec.ts`, Setup nach f715
  Z.1-60 + m1-11g-Fixture; Fixture-
  PNG groesser als 1×1 — 64×64
  einfarbig inline-base64 — sonst ist
  kein Maus-Pfeil adressierbar):
  E-01 Upload 1 Foto → Markieren-
  Button sichtbar; E-02 Dialog
  oeffnet OHNE Server-Upload
  (Request-Zaehler: kein POST vor
  Save); E-03 Pfeil per Maus
  (02i-Muster Z.177-184) + Text →
  Save → Galerie 2 Fotos,
  Original-Bytes unveraendert (GET
  index 0 sha = Upload-sha), index 1
  = PNG (Magic-Bytes), Cover =
  Original (Titelbild-Label);
  E-04 Reload persistent; E-05 Viewer:
  kein Markieren-Button, beide Fotos
  lesbar; E-06 volle Galerie (8):
  Button disabled; E-07 Abbrechen:
  kein POST, Galerie unveraendert;
  E-08 Axe; E-09 Server-Log ohne
  Fehler (readFileSync/statSync-
  Muster f715).
- Nachbarn: F7-02g (Upload-Helper),
  F7-02i (Canvas-Muster), F7-15
  (Galerie/Cover), m111a-Pins
  unberuehrt — keine Migration.

## Akzeptanz
- `npm run check` + `npm run db:roles:verify`
  gruen; E2E Chromium gruen; Heartbeat +
  Push + CI gruen.
