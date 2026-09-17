# SPEC F7-15 — Fotodoku-Batch: Mehrfach-Upload am Bild-Punkt (Katalog F7.8)

## Matrix
F7.8 (Katalog: „Order Parts ...; Fotodoku mit Batch-Aufnahme und
Markup"): Order Parts VERIFIED (F7-12), Fotodoku offen. 02g =
genau EIN Foto je Bild-Punkt (`photo` single String, Validator
0173/0178, UI ersetzt per `onSetItem({photo})`). Rest: Batch-
Aufnahme + Markup — Markup ist explizit Folgeslice.

Slice-15-Wahl C (diese SPEC). Verworfen mit Beleg: A)
Handover-Auto-PDF — Pipeline existiert, aber strikt offer-
gebunden (`offer_pdf_draft`/`offer_issuance`, DB-bytea statt
Storage-Keys, Source-Lock auf `offer_variant_revision`,
pgboss-Dispatch `pgboss.enqueue_offer_pdf_draft` + Worker-
Container linux/x64-pinned, `worker/offer-pdf-renderer.ts`);
Handover braeuchte neue Ablage + neuen pgboss-Job/Worker +
Solar-/WP-Templates (existieren nicht) — kein minimaler Slice,
Worker-Registrierung = Blocker. B) Projekt-Dateien-Kern —
machbar ohne Provider (`lib/storage` immutableKey+putImmutable,
`file_request_upload`-Praezedenz F10-10, Session-Routen-Muster),
aber groesserer Scope als C (neue Tabelle + RLS + Service +
Route + neue UI-Flaeche) — Folgeslice, kein Blocker.

„Ohne Validator-Umbau" ist woertlich unerfuellbar (Allowlist
0178:98 lehnt jeden neuen Key ab); gewaehlt ist der kleinste
Validator-Touch (rein additive OR-Glieder, Bestand validiert
unveraendert) OHNE neues Schema-Objekt. Verworfen: „N Fotos
als N Bild-Punkte" (keine Migration, aber kein Batch pro
Befund — Zaehlung/Sichtbarkeit verwaessert) und nummerierte
Keys `photo1..N` (N Allowlist-Eintraege + N Regeln statt
einer Array-Regel). Array gewinnt: eine Regel, Limit als
Konstante, kein weiterer Validator-Touch bei Limitwechsel.

## Ziel
Am Bild-Punkt (kind=image) haengt der Monteur bis zu 8 Fotos
in EINEM Upload-Vorgang an (statt zu ersetzen): Galerie mit
Cover, Entfernen je Foto (Referenz), Reload-fest, Viewer
liest. `photo` bleibt das Cover (02g/02i-Leser unveraendert);
Signatur-Punkt unberuehrt (Single-`photo` wie heute).

## Entwurf (02g-Spiegel + Array, kein neues DB-Objekt)
- Tree-Key `photos: string[] | null` NUR kind=image;
  `photo` = Cover = `photos[0]` sobald `photos` non-empty,
  sonst wie heute (Einzelfoto, Legacy). Kopplung in Zod-
  Refine + DB-Funktion (Spiegel-Praezedenz 02e/02g).
- Upload = Session-Route POST wiederverwendet (1 Datei pro
  Request, Client-Loop ueber `input multiple`; KEINE
  Routenaenderung). Key-Schema unveraendert
  (`itemId_sha8.ext`, inhalts-deterministisch); Duplikat-
  Bytes = idempotenter Erfolg + Dedupe im Array.
- Lesen = GET + optionaler `index`-Query (Default 0);
  Liste = `photos ?? [photo]`; Out-of-bounds = NotFound
  (kein Orakel). Service `readChecklistItemPhoto` +
  `{index?}` (checklist.read, keine neue Permission).
- UI (project-checklist-manager.tsx): Multiple-Input +
  Galerie (Thumbs via GET+index) + Entfernen je Foto;
  Cover-Entfernung re-deriviert `photo = photos[0] ??
  null`; Persistenz via Whole-Tree-Save (Version-CAS).
- Limit `CHECKLIST_ITEM_PHOTOS_MAX = 8` (ESTIMATE,
  reversibel; ~1.2 KB Worstcase, weit unter 900-KB-
  Transport). Kein Markup, kein Portal, kein WORM-Delete
  (Referenz weg = Objekt verwaist, 02g-ESTIMATE).

## Vertrag DB (0180, Vollkopie 0178 + photos)
- `_f704_valid_checklist_blocks`: Allowlist + `photos`;
  `photos`: jsonb-Array, 1..8 Elemente, jedes String +
  clean_text(500) + Key-Regex (identisch `photo`,
  `checklist-photos`); keine Duplikate (count-Distinct-
  CTE, identities-Praezedenz); nur kind=image;
  non-empty `photos` → `photo` non-null UND
  `photo = photos->>0`. `photo`- und `signerRole`-
  Regeln unveraendert (02i-Signatur traegt nie `photos`).
- `_f704_checklist_structure`: `photos` in die
  done/value/photo-Streichliste (Antwort-Nutzlast,
  F7-03b-Praezedenz).
- Owner-Tanz wie 0142/0144 (plain CREATE OR REPLACE,
  kein neues Objekt); Rollen-Pins beider Validatoren
  neu harvesten (`db:roles:verify`). Keine neue
  Tabelle, keine RLS-Aenderung, kein Backfill
  (Legacy: `photos` null, `photo` wie heute).

## Vertrag App
- `contract.ts`: `CHECKLIST_ITEM_PHOTOS_MAX = 8`;
  Item-Schema + `photos` (Array max 8, Element =
  `photo`-Regel, nullish); Refine (photos nur image;
  non-empty → `photo === photos[0]`; signature nie).
  kind-Enum unveraendert, Counter unveraendert.
- Template-Vertrag: `photos` nie in Vorlagen
  (Antwort-Nutzlast wie `photo`, kein Template-Feld).
- Typwechsel-Reset (02e-Praezedenz): weg von image →
  `photo/photos = null`; zu image →
  `description/value = null` (`photo/photos` bleiben
  null); `photos` je Wechsel mit resettet wie `photo`.
- Service: `uploadChecklistItemPhoto` unveraendert;
  `readChecklistItemPhoto` + `{index?: number}`
  (Default 0; Liste `photos ?? [photo]`; OOB/fehlend
  → NotFound, korrupt → ValidationError).
- Route: GET + optionaler `index`-Param (Ziffern,
  Schranke, sonst invalid); POST byte-identisch.
- UI: Multiple-Input (accept jpeg/png), Galerie,
  Entfernen mit Cover-Re-Derivation; Fehler deutsch,
  kein Key-Leak (nur Fehlertyp, 02g-Praezedenz).

## Sicherheit
- Keine neue Tabelle/Permission/Route (nur Query-
  Param); reine Validatoren ohne Grant (nur via
  DEFINER-Kapsel); RLS unberuehrt.
- Upload-Validierung VOR putImmutable (Fail-fast,
  kein Orphan bei Fehltyp); fremde Keys nicht
  uebernehmbar (Service baut Key); `index`
  bounds-geprueft (OOB = NotFound, kein Orakel).
- Audit: Save-Audit traegt Tree-Write (kein Foto-
  Detail mit Key/Dateiname).
- Haertung wie 02g: 10-MiB-Limit pro Datei (DoS),
  Allowlist JPEG/PNG + Endungs-Match, Key-Regex
  serverseitig (Traversal tot); 8er-Limit deckelt
  Galerie-I/O.

## Tests (RED zuerst)
- DB: `tests/db/f715-fotodoku-batch.test.ts` — D-01
  image + `photos`[2 Keys] gueltig; D-02 `photos` an
  task/signature → CHECK verletzt; D-03 Element mit
  ungueltigem Key → verletzt; D-04 9 Elemente →
  verletzt; D-05 Duplikat-Key → verletzt; D-06
  `photos` ohne `photo` / `photo ≠ photos[0]` →
  verletzt; D-07 Struktur-Aequivalent (`photos`-
  Wechsel ≠ Struktur); D-08 Legacy (`photo` ohne
  `photos`) weiter gueltig; D-09 f702g/f702i-Suiten
  unveraendert gruen.
- Service: U-01 Read index 0/1/2 ok (Cover + Folge);
  U-02 OOB-Index → NotFound; U-03 Legacy ohne index
  ok; U-04 fehlendes Storage-Objekt → NotFound;
  U-05 Upload-Pfad unveraendert (Key-Schema, sha8,
  Idempotenz); U-06 kein Key-Leak in Errors.
- E2E: `tests/e2e/f7-15-fotodoku-batch.spec.ts`
  (Setup nach 02g) — E-01 Mehrfach-Upload (3 Fotos)
  → Galerie mit Cover; E-02 Reload persistent;
  E-03 Entfernen (Cover-Promotion auf naechstes);
  E-04 Einzelfoto-Legacy (altes `photo` lesbar);
  E-05 Viewer liest Galerie; E-06 Axe; E-07
  Duplikat-Upload deduped (kein zweites Thumb).
- Fixture: kleinstes gueltiges PNG/JPEG als
  Byte-Array (kein Asset-File, 02g-Praezedenz).
- Nachbarn: F7-02g, F7-02i, F7-03b (Struktur).

## Akzeptanz
- `npm run check` + `npm run db:roles:verify` gruen; E2E
  Chromium gruen; Heartbeat + Push + CI gruen.
