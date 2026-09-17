# SPEC F7-02h — Block-Fälligkeitsdatum (Katalog F7.2)

## Matrix
F7.2: „Block (zuweisbar, Fälligkeitsdatum)". Zuweisbar = F7-05b VERIFIED;
Faelligkeitsdatum offen. Kein Portal-Bezug (interne Checkliste).

## Ziel
Optionales Faelligkeitsdatum je Block (Kalendertag, YYYY-MM-DD):
Struktur-Metadatum (nur mit Strukturrecht setzbar), lesbar fuer alle
(Vorschau/Text), Reload-fest, gate-neutral (kein Abschluss-Gate).

## Entwurf (Block-Ebene, Whole-Tree-Save)
- Tree-Key `dueDate` (String YYYY-MM-DD, nullish) je Block. STRUKTUR
  (kein Strip in `_f704_checklist_structure`): Editor-Antwort-Save mit
  geaendertem Datum = 42501-Strukturwechsel (fail-closed, F7-03b-Spiegel).
- Setzen nur bei canEditStructure (Admin/Configure bzw. Version 0 +
  Write — gleiche Regel wie Block-Name, keine Kapsel-Aenderung: der
  0077-Create-Guard prueft nur visible/required).
- Keine neue Tabelle/Permission/Route/Op (checklist.write via Save).

## Vertrag DB (0174, Replace nur `_f704_valid_checklist_blocks`)
- Block-Key-Allowlist + `dueDate`; nullish gueltig; sonst exaktes
  Kalenderdatum: Regex `^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$`
  PLUS Roundtrip `to_char(to_date(v,'YYYY-MM-DD'),'YYYY-MM-DD') = v`
  (weist 2026-02-31 ab; kein Exception-Pfad noetig).
- `_f704_checklist_structure` UNVERAENDERT (Datum = Struktur).
- Rollen-Pin validBlocks neu harvesten (structure-Pin bleibt).

## Vertrag App
- `editableChecklistBlockSchema` + `checklistBlockSchema`:
  `dueDate: z.string().regex(DATE_PATTERN).refine(isRealCalendarDate).nullish()`.
- Manager: BlockCard-Kopf — Strukturmodus: Date-Input
  `aria-label={Block ${i+1}: Fälligkeitsdatum}` (leeren = null);
  Lesemodus: `Fällig: <TT.MM.JJJJ>` (de-DE, UTC-fix, kein TZ-Rollover);
  Viewer sieht Text. Setter `setBlockDueDate` neben renameBlock.
- addBlock: ohne Key (nullish = kein Datum).

## Sicherheit
- Reiner Validator-Replace ohne Grant; RLS unberuehrt; Datum nie Gate.
- Fail-closed: Format + Echtheit auf beiden Ebenen (Zod + SQL).

## Tests (RED zuerst)
- DB: `tests/db/f702h-checklist-block-due-date.test.ts` — Save mit Datum
  persistiert; Update auf null; Formatbruch + Schalttag-Falle (2026-02-31)
  scheitern (Save-Guard + Direkt-Validator); Struktur-Vergleich: Datum-
  Wechsel IST Struktur (Editor-Answer-Save mit Datumswechsel = 42501).
- E2E: `tests/e2e/f7-02h-checklist-block-due-date.spec.ts` — Datum setzen,
  speichern, Reload persistent, Viewer sieht, Axe.
- Kein Storage, kein Template-Anteil (Vorlagen kennen keine Bloecke).

## Akzeptanz
- `npm run check` gruen; E2E Chromium gruen; Heartbeat + Push + CI gruen.
