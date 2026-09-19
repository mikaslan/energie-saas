# F1-16 Manuelle Anfrage als Modal + Kontakt-Vorbefüllung (T1) — Slice-Spec

Lane `codex/muse-fleet-1c-f1`. KEINE Migration. Quelle: Schwarm-Spec S1 (reviewed).

## DISCOVERED

- Ist: `manual-lead-form.tsx` (F1-11) rendert inline (`useState(open)`),
  kein Dialog. Service `createManualLead` kennt KEIN `contactId`
  (Dedupe nur implizit). `modules/contacts` hat KEINE Suggest-Funktion.
- Vorbilder: `note-editor-dialog.tsx` (Dialog-Shell, Fokus-Trap, Escape),
  F1-15-E2E (Viewport-Gate lokal kopiert).
- Stabilität: `manual-lead-open`/`manual-lead-form` werden von ~30 E2E-Setups
  genutzt → testids UNVERÄNDERT lassen.

## SPECIFIED

- Modal: Button öffnet `role="dialog" aria-modal` (Overlay, Fokus-Trap,
  Escape, Abbrechen/Schließen). Form-States (`success`/`note-failed`/
  `invalid`/`denied`/`lane-missing`) unverändert, gleiche Action.
- Kontakt-Suche: erstes Feld, mind. 2 Zeichen, Debounce ~250 ms, Server
  Action, Limit 8, nur `deleted_at IS NULL`, Tenant-Scope. Auswahl füllt
  Name/E-Mail/Telefon (+ Kontakt-Adresse) vor, setzt hidden `contactId`;
  Clear-Button leert Auswahl. Ohne Auswahl = Neuanlage wie bisher.
- Validierung F1-11 unverändert + `contactId` optional UUID: muss im
  Workspace existieren und ungelöscht sein (sonst `invalid`); bei
  Vorbefüllungs-Drift (E-Mail nach Auswahl geändert) gewinnt der
  Formularwert, `contactId` wird ignoriert, Dedupe läuft normal.
- Suche ohne `contact.read` → leere Liste mit Hinweis (Form nutzbar).
  KEINE neue Permission (Anlage `project.write`, Suche `contact.read`).
- Mobile: 375/768/1440 ohne Overflow, Touch-Targets, Trap/Escape mobil.

## CONTRACTED

- EDIT: `manual-lead-form.tsx`, `manual-lead-actions.ts` (contactId),
  `manual-lead-service.ts` (contactId + Drift-Regel).
- NEU: `manual-lead-contact-actions.ts`, `modules/contacts/contact-suggest.ts`
  (+ Barrel), `tests/db/f116-manual-lead-modal.test.ts`,
  `tests/e2e/f1-16-manual-lead-modal.spec.ts`.
- DB-Tests (5): Reuse via contactId / Drift / fremd-gelöscht→invalid /
  Suggest (Tenant, gelöscht, Limit, ohne Recht) — Details S1.
- E2E (4): Dialog+Escape / Suche→Prefill→Submit / ohne Treffer /
  Viewport-Gate. `f1-11` muss UNVERÄNDERT grün bleiben.
