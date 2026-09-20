# F6-02b Ensure-Verdrahtung (Drift-Rewrite)

Ziel: Der F6-01-Snapshot (`schematic_diagrams`) folgt dem Angebot —
statt still zu divergieren. Das Review-P2 („ensure-Service wartet auf
F6.2-Verdrahtung", FINAL-REPORT-5G §3) wird geschlossen: Der Service
`ensureSchematicDiagram` bekommt seinen produktiven Aufrufer. Kein
Drag-UI, keine Vorlagen, kein Ask AI, kein JPG/PDF (F6.2-Rest/F6.3).

## Befund (Recon R1–R6, belegt)

- `ensureSchematicDiagram` hat produktiv KEINEN Aufrufer (nur Tests).
  Der First-Open-Pfad kennt nur `saved`/`already_saved` — bei
  geänderter Netzliste unter gleichem Key schweigt `already_saved`,
  der Snapshot bleibt Erstöffnen-Stand, das Live-Bild läuft weiter
  (stille Divergenz, ohne UI-Hinweis).
- First-Open persistiert seit F6-02a das GEMERGTE Netz (Overlay-Knoten
  inklusive, `offer-detail-view.tsx` übergibt `schematic` statt
  Backbone). Ensure baut Backbone-only → jede gemergte Zeile wäre
  Dauer-Drift; ein Rewrite würde Overlay-Knoten aus der Diagramm-Zeile
  streichen und den Overlay-Parent fälschlich stale schalten.
- Action-Zeilen tragen kein `unwired` (nur `{nodes,edges}`); Ensure
  fällt auf `unwired=[]` zurück — Angebote mit `unwired≠[]` wären
  Dauer-Drift, heilen aber nach genau einem Rewrite selbst
  (Ensure-Umschlag enthält `unwired`).

## Architektur (DECIDED)

1. **Trigger ist der Page-Loader (Server), nicht die Action.**
   Nach Scope, vor Overlay-Read: residential + `project.write` +
   nicht-leerer Build → `ensureSchematicDiagram` mit Sections aus
   `snapshot.sections` (gleiche Projektion wie die Ansicht).
   Begründung: Sections liegen dort vor (kein neuer Projektor in der
   Action-Schicht), Overlay-Stale wird sofort gegen die frische
   Revision gerechnet, First-Open-Pins (`already_saved`) bleiben
   unangetastet.
2. **First-Open bleibt Insert-only** (`on conflict do nothing`,
   ungestempelt `{nodes,edges}`). Keine Semantikänderung, keine neuen
   Client-Status.
3. **Backbone-Persistenz (Voraussetzung in diesem Slice):**
   First-Open übergibt künftig den BACKBONE (nie das gemergte Netz).
   Diagramm-Zeile = Backbone-Snapshot, Overlay-Tabelle = alleinige
   Overlay-Wahrheit, Render = Merge. Behebt das Merged-Leck aus F6-02a.
4. **Keine Migration 0302.** 0300 deckt Insert + Rewrite (Key,
   CHECKs, `revision≥1`, Grants SIU); 0301 (Parent-Pin) existiert.
   Range 0302–0309 bleibt frei.
5. **Kein `expectedRevision` im Page-Ensure (bewusst).** System-Sync,
   kein User-Edit: kein vorausgegangener UI-Read, FOR UPDATE +
   Revisions-WHERE serialisieren. (Kontrast: User-Schreibpfade wie
   Overlay-Save behalten CAS-Pflicht.)
6. **Konflikt → Skip + Render.** `SchematicConflictError`
   (Fremd-Stempel, Multi-Varianten-Drift) und jede Ensure-Störung
   degradieren zu „kein Rewrite, Backbone rendern" — nie Throw,
   nie Kette (kein Refresh, kein Retry im Loader).

## Ablauf (Loader, residential + Editor)

1. Scope laden (Bestand). Nicht residential → kein Ensure.
2. Sections aus `snapshot.sections` projizieren (sichtbare Lines,
   eine Einheit → `formatQuantity`, sonst `null`; Kategorie 1:1).
   `formatQuantity` wandert dafür nach `lib/` (reiner Move).
3. Leerer Build (keine Knoten, kein `unwired`) → kein Ensure
   (kein Snapshot-Wipe bei leerem Angebot).
4. `ensureSchematicDiagram(tx, ctx, {offerId, variantId, variantRevision,
   sections})` mit `variantId`/`revision` der aktiven Variante.
   Fehler/Scope/Conflict → `null` (Skip), sonst Revision übernehmen.
5. Overlay-Read + Stale-Rechnung laufen danach gegen die
   ggf. frische Diagramm-Revision (Bestand, unverändert).

## Contract (Verhalten-Pins, keine neuen Versionen)

Kein neues Versions-Artefakt: wiederverwendet werden
`schematic-jcs.v1` (Drift-Hash), `schematic-netlist.v1`,
`editor-overlay.v1` (Parent-Pin). Gepinnt wird Verhalten:

| # | Pin |
|---|---|
| C1 | Drift-Rewrite = In-Place `revision+1` je `(offer, variant_revision)`; kein Append, keine Neuanlage |
| C2 | Ohne Drift: `changed:false`, `updated_at` stabil, kein Refresh, keine Kette |
| C3 | `already_saved`-Semantik (driftlose Re-Opens, GATE-01/02, VG) unverändert |
| C4 | `variantRevision` + `variantId` aus der aktiven Variante; Fremd-Stempel → Konflikt, nie Overwrite |
| C5 | Gold-Canonical/-Hash, Fehleridentität, Gate-Texte, `count==1`-Semantik unverändert |
| C6 | First-Open persistiert Backbone-only (keine `ovl-*`-IDs in `schematic_diagrams`) |
| C7 | Commercial/Viewer/Fehler: kein Ensure-Write (Viewer liest höchstens) |
| C8 | Overlay-Stale gilt bis Re-Save mit neuem Parent; nie Auto-Rebase, nie falsches Merge-Bild |

## Sperren (SHALL-NOT)

- Nie `variant_revision`/`workspace_id`/`offer_id`/`created_by` im
  Rewrite anfassen; nie `unwired`-lose Vergleiche (Phantom-Drift);
  nie Ensure bei `commercial` oder ohne `project.write`; nie
  Ensure auf Overlay-Schreibungen anwenden; nie `updated`-Status
  ohne E2E-Vertragsupdate (der Loader meldet keine Client-Status);
  nie Render aus Snapshot-Read (Live-Build bleibt Render-Quelle).

## RED-Testliste (Stand: geschrieben + rot belegt, Overlap)

1. Unit `tests/unit/f602b-ensure-wire.test.ts` (4 failed/1 passed,
   Stub wirft): First-Open-Nutzlast Backbone-only + Schlüssel 1:1,
   Page-Ensure-Entscheidtabelle (ensure/skip:gate/skip:rights/
   skip:empty), Wire-Version-Pin. Contract-Stub:
   `lib/integrations/schematic/ensure-wire-v1.ts` (`ensure-wire.v1`).
2. E2E GATE-03 (`f601-schaltplan-gate.spec.ts`, rot belegt: Expected
   2/Received 1): Öffnen → Netzliste per SQL veralten → Re-Open →
   `revision==2`, `count==1`, `nodeCount>0` (DB-Read, kein
   Client-Status). Driftloser Reload bleibt `already-saved` (GATE-01).
3. Keine DB-Dupes (Ensure-Pfade sind in `f601-schematic-save.test.ts`
   grün abgedeckt), keine neuen Gold-Tests (JCS unverändert), VG nur
   als Regression. Der Backbone-only-Persistenz-Pin lebt als Unit-Pin
   (Helper), nicht als E2E (gemergte Persistenz ist produktiv nicht
   erreichbar — Defense-in-Depth, kein beobachtbares Verhalten).

## Ausgeschlossen

Migration 0302, `variant_id`-Key-Umbau (Fleet-Follow-up),
`netlist_sha256`-Spalte, History-Append, Overlay-Auto-Rebase,
Nach-Stempeln stiller Adoptionen, `updated_by`-Spalte,
Scope-Default-Angleichung in Export/Diagramm, Drag-UI, Vorlagen,
Ask AI, JPG/PDF-Export, Angebots-PDF-Einbettung, Checkliste.

## Offene Fragen (mit Empfehlung → Leitstand-Entscheid)

1. Trigger Page-Loader vs. Action-Upsert? **Empfehlung: Page-Loader**
   (§Architektur 1; Kompatibilität + Sections vor Ort).
2. Offene Overlay-Editoren bei Rewrite: Rebase/Verwerfen/Blockieren?
   **Empfehlung: Stale-Hinweis + Re-Save (Bestand), kein Auto-Rebase.**
3. `netlist_sha256`/`variant_id` persistieren (→ doch 0302)?
   **Empfehlung: nein (Laufzeit-Hash reicht, kein Schema-Defizit).**
4. Stille Adoption nach-stempeln? **Empfehlung: nein (No-Write bleibt;
   Folgeslice bei Bedarf).**
5. `already_saved` umbenennen/erweitern? **Empfehlung: nein (C3:
   neuer Drift-Fall ist server-intern, kein Client-Vokabular nötig).**
