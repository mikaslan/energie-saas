# MUSE-FOREGROUND — Vordergrund-Weiterbau (Übergabestand)

Stand: 2026-09-08 ~00:10 UTC · Branch: `codex/m1-wave-02` · HEAD: `983ed67`
(0 unpusht; CI-Run `34168057655` = SUCCESS auf diesem HEAD). Diese Datei
bleibt absichtlich untracked (lokaler Handoff, kein Branch-Inhalt).
Hintergrund-Autopilot: `mode=paused` (kein Konkurrenzschreiber).

## Ziel

F1–F16 aus `docs/blaupause/01-modulkatalog.md` als Vordergrundschreiber
weiterbauen: untersuchen → ändern → testen → dokumentieren. Kein
`muse-reonic-start`, keine neue Automatisierung, kein Force-Push.

## Aktuelle Aufgabe (angefangen, nicht committet)

Sechs ESLint-Warnungen (HEAD-Stand) als konkrete Defekte behoben:

1. `app/w/[workspaceId]/einstellungen/rechnungsstellung/actions.ts` —
   tote Imports `companyCountries` (Zod-Enum prüft bereits) und
   `InvoicingPreconditionConflictError` entfernt. Geprüft: Der Fehler wird
   nur von `assertIssuingDetailsComplete` (Dokument-Ausstellung, M3-01)
   geworfen, nie vom Settings-Upsert — Import war tot, kein Mapping fehlt.
2. `app/w/[workspaceId]/einstellungen/rechnungsstellung/invoicing-settings-form.tsx:215` —
   ungültiges `aria-disabled` auf `<section>` (Rolle `region` stützt es
   nicht) ersetzt durch `aria-label="Textvorlagen (noch nicht verfügbar)"`.
3. `app/w/[workspaceId]/rechnungen/dialog-focus.ts:47` — stale
   `triggerRef.current` im Effect-Cleanup; Trigger wird jetzt im Effect
   gelesen (`const trigger = triggerRef.current`).
4. `modules/economics/service.ts:12` — toter
   `WORKSPACE_ECONOMICS_SETTINGS_COMMAND_VERSION`-Import (Version prüft das
   Zod-Command-Schema; Service nutzt nur `..._VERSION`).
5. `tests/e2e/f9-02-timer.spec.ts:1` — toter `randomUUID`-Import.

## Erledigt (diese Sitzung, echte Exit-Codes)

- 5 Lint-Fix-Dateien committet als `280df75`
  (`fix(lint): sechs ESLint-Warnungen als Defekte beheben`).
- **M111B-03-Test ergänzt** (`tests/db/m111b-cannot-fulfil-service.test.ts`,
  committet als `04d34db`): gefälschter Evidenz-Insert für
  `project.outcome_cannot_fulfil` in `domain_events` + `audit_log` scheitert
  mit 23514 (Whitelist-Guard, Trigger-Tiefe; spiegelt das M1-11a-Forgery-Muster).
- **M111B-DB-Suite GRÜN (lokal, EXIT=0):** 14/14 in
  `tests/db/m111b-cannot-fulfil-service.test.ts` — embedded-Postgres UND
  Docker-Postgres (`energie-test-pg`, 127.0.0.1:5545, CI-Rollen `app_ci`).
  M111B-03 einzeln: 1 passed / 13 skipped, EXIT=0.
- **M111B-E2E GRÜN (lokal, EXIT=0):** `M1_05_E2E_GREP="M1-11b:" npm run test:e2e`
  → 4/4 Chromium (Editor-Abschluss/Freeze, Abgeschlossen-Filter, Viewer
  read-only, External fail-closed), 12,1 s.
- **Umgebungsheilung:** embedded-Postgres-Shmlox (`kern.sysv.shmmni=32`,
  33 verwaiste Segmente, alle NATTCH=0) durch `ipcrm` der eigenen
  detached Segmente behoben; embedded bootet wieder. Docker DAEMON LÄUFT
  (Server 29.5.2) — „Docker fehlt“ überholt. Chromium in
  `~/Library/Caches/ms-playwright` (chromium-1234) vorhanden.
- **Alte Review-Rückstände verifiziert GESCHLOSSEN (HEAD-Code, kein neuer
  Commit nötig):** F16-02 (P2-1 try/catch→unavailable; P2-2
  domain_events=Outbox+audit+stamps; P2-3 Spec=`offer_preview`, `can()`
  nutzt nur Action+Rolle; SPEC P1-1 `readSource` ohne FOR UPDATE, P1-2
  Testplan, P2-1 F2.2 gemergt), F2-02 (No-op-Early-Return,
  `previousValueNetCents`, `bundles`-Payload, `previousPrimaryVariantId`),
  F9-03 CODE P2-1 (clientseitige Cap-50 mit Disable+Hinweis in
  `user-filter-form.tsx`).
- Gates auf HEAD `04d34db` (Exit-Codes direkt am Prozess gemessen, NICHT via
  Pipe): `npm run lint` → 0 · `npm run typecheck` → 0 ·
  `contract:catalog-import` → 0 · `npm run depcruise` → 0 ·
  `git diff --check` OK · `npm run test` → 0 (240/240 Dateien, 2180
  bestanden/1 übersprungen) · `npm run db:roles:verify` → 0 (88+5) ·
  `npm run db:generate` + Drift-Check → 0 (no drift) · `npm run build` → 0.
  Methodik-Lehre: `cmd | tail; echo $?` misst `tail` — Gates immer ohne Pipe
  oder mit `pipefail` messen.

## Korrigierter Befund: M1-11b ist HIER vorhanden (Annahme unten überholt)

Entgegen der ursprünglichen Annahme („hier NICHT vorhanden“) ist M1-11b auf
diesem Branch vollständig implementiert: Migration `0040` (1306 Zeilen),
`outcome-service.ts` (`mark_cannot_fulfill`, FOR-UPDATE-Lock → Binding-Kapsel
→ Update+Outbox+Dispatch in einer Tx), Worker (`worker/customer-notification.ts`),
UI (Outcome-Panel, Abgeschlossen-Filter, Freeze-Hinweise), Contract-Tests,
DB-Tests (M111B-01/02/03/04/05/06/07/09/10/11/18, P0-1-Interleaving, P1-B1/B2),
E2E-Spec (`tests/e2e/m1-11b-cannot-fulfil.spec.ts`), Rollen-Pins
(`scripts/db-role-contract.mts`). Alle 6 Kimi-Befunde (2×P1 B-1/B-2, 4×P2
B-3–B-6, aus `e22102b`, fremder Branch) sind im hiesigen `0040` mit
Kommentar-Markern + DB-Tests aufgelöst. Nicht im Baum: die beiden Kimi-Review-
Docs (`REVIEW-KIMI-M1-11B-SPEC.md` aus `f75a309`, `REVIEW-KIMI-M1-11B-CODE.md`
aus `e22102b` — beide Nicht-Vorfahren) sowie jede M1-11b-Zeile in
`STATUS.md`/`CAPABILITY-MATRIX.md`/`TEST-EVIDENCE.md` (der alte
VERIFIED-Vermerk `1bb9951` ist ebenfalls kein Vorfahre — Register-Update steht
aus, erst nach DB-/E2E-Lauf auf Maschine/CI).
Bekannte Restlücke ohne Aufrufpfad: `cancelled_manual` (nur Enum + Anzeige +
Guard; kein Service-/Worker-Pfad — Scope-Entscheid für Root-Integrator, vgl.
Review-Nachsatz „kein Aufrufpfad“).

## Offene Probleme / Blocker

- Sandbox-EPERM ÜBERHOLT: diese Sitzung läuft unsandboxed; embedded-Postgres,
  `db:roles:verify`, `test:e2e` und Build laufen lokal (s. Gates oben).
- Docker DAEMON LÄUFT (Server 29.5.2) — „Docker fehlt“ war falsch.
  Test-Container `energie-test-pg` nach CI-Grün gestoppt+entfernt (embedded
  genügt; shm-Leaks bei Bedarf erneut per `ipcrm` räumen, nur NATTCH=0).
- Lokal Node v26.4.0 vs. CI Node 22/24 — Abweichung kennzeichnen.
- Netzwerk OK: `git ls-remote origin` + `gh auth` (mikailaslan) grün.
  Push von 60 Commits läuft/ist erfolgt; CI als Orakel auswerten.
- Briefkasten `fragen an codex/offen` und `antworten` sind leer (keine Blocker).
- Live-Reonic-Zugang fehlt weiter → kein 100-%-Paritätsnachweis möglich.

## Exakt nächster Schritt (2026-09-08 ~00:10 UTC)

**M111B-12 Race `mark_cannot_fulfill` ↔ `approve_offer_issuance`
(Spec §11.3/§12.2 — letzte offene M1-11b-Abnahmehürde neben dem
unabhängigen Review). Analyse abgeschlossen, Test fehlt:**
- Beide Seiten nehmen die Project-Zeile `FOR UPDATE`
  (Transition: `outcome-service.ts`; Approval-Kapsel `0035`: Profil →
  Project → Offer → Recipient → Variante → Candidate → Issuance).
- Bindungskapsel `_m111b_…_binding_issuance` ist lock-freies SELECT →
  kein Deadlock-Vektor (Transition hält nur Project).
- Approval zuerst → Bindung da → Transition wirft `CannotFulfilLocked` ✓.
- Transition zuerst → Approval-INSERT in `offer_issuance_approval` läuft
  in Freeze-Trigger (§5.3, 4 INSERT-Trigger inkl. Approval-Tabelle) ✓.
- Strukturell SAFE in beiden Ordnungen; der Test muss das belegen, nicht
  entdecken: `Promise.allSettled` über getrennte Pool-Clients, Disjunktion
  konsistenter Endzustände (P0-1-Muster) + Invariante „nie cannot_fulfill
  MIT un-withdrawter Approval". Fixture-Bedarf: M2-03b1-Kette bis
  `ready_for_approval` (Profil→Recipient→Candidate→Issuance, EIN Approval
  genügt als Bindung) + M111B-Projektbindung; Vorlage:
  `tests/db/m203b1-offer-issuance-database.test.ts` (1458 Zeilen, inkl.
  `waitForBackendLock`-Muster) und `m111b-cannot-fulfil-service.test.ts`.
- Register-Entscheid: KEIN VERIFIED für M1-11b vor Review + M111B-12
  (Spec §12 wörtlich). TEST-EVIDENCE-Ergänzung erst mit dem Race-Test.
- Danach: F4.1 (SPECIFIED, Migration 0078+, Frage-2-Klärung).

Erledigt seit ~22:30: **F2-02-Race-Slice** (`531c2a2`, 4 neue Tests in
`tests/db/f202-variant-deepening.test.ts`, 19/19 grün): gleiches-Ziel- und
gegenläufige `setPrimaryVariant`-Races (exakt eine Primary, 1 Event im
Determinismusfall), identische Offer-Creates → idempotentes Digest-Replay
(dasselbe Offer, kein Duplikat), divergierende → Verlierer
`OfferConflictError`. Erster Create-Test war ROT (beide fulfilled statt
1+Conflict) — Ursache war meine falsche Annahme, nicht der Code: Replay ist
Design. Spec-Vertrag korrigiert (Z.66/73/88: Replay/Conflict statt
pauschal IntegrityError; Index = Backstop für Lock-Umgeher).

**CI-Run `34159018025` (Push `04d34db`): Statik/DB/Rollen/Build GRÜN,
E2E 111+2 (2 rot, beide echte Defekte, aus Artefakt-`error-context.md`):**
1. M3-00 Axe `color-contrast` serious auf `.text-slate-400`
   (`invoicing-settings-form.tsx:216`, h2 auf Weiß, Ratio ~2,2) →
   Fix `text-slate-500` (4,76:1, deterministisch; lokal M3-00-E2E grün).
2. M2-03a 200-%-Zoom-Reflow bei 640px: Varianten-`ul` (618px `min-w-max`)
   ragte auf 642 (Viewport 640), weil `div.grid.gap-4` ohne Template den
   Track auf max-content aufspannte und `overflow-x-auto` der Nav dadurch
   wirkungslos war (CI-Fonts breiter als lokal — latenter Defekt) →
   Fix `grid-cols-[minmax(0,1fr)]` in `offer-editor.tsx` UND identisches
   Muster in `offer-detail-view.tsx` (`grid gap-5`). Lokal M2-01+M2-03a
   9+1 grün. Fixes committet als `2d231b7`, gepusht; CI-Run `34160823771`:
Statik/DB/Rollen/Build GRÜN, E2E 110+3. M3-00-Kontrast BEHOBEN ✓.
M2-03a:986 weiter rot, aber ANDERS: `elementHandle.click: Element is not
attached to the DOM` im Helper `submitWithPendingFocusEvidence`
(spec.ts:302, Call-Site fast sicher 1166 Dialog „Speichern und fortfahren").
Analyse: 3-CSS-Zeilen-Delta kann kein DOM-Replacement verursachen; Run 1
fiel an späterer Stelle (Reflow), Run 2 früh (Submit) — timing-sensitiv
unter CI-Last, lokal (M2-01|M2-03a 9+1) grün. M2-04:272/:322
(`variant_revision_changed`, currentRevision 2) sind KASKADE des frühen
M2-03a-Abbruchs: M2-03a starb nach Offer-Save (Rev-Bump auf 2), aber vor
Schritt 1197 (neuer PDF-Draft auf Rev 2) — M2-04-Fixture liest M2-02-Draft
(Rev 1) gegen aktuelle Rev 2. shared-workspace-Kopplung (vgl. FRAGEN B).
Entscheid: `gh run rerun --failed` als ehrlicher Diskriminator (kein
Test-Weakening); bei Wieder-Rot wird der Helper gehärtet (bounded
Re-Acquire nur für den Klick, gleiche-Node-Fokusbeweise unverändert).

**Rerun-Ergebnis: 112+1 — M2-04-Kaskade GRÜN (Kaskadentheorie bestätigt ✓),
M2-03a-Reflow weiter rot mit PIXEL-IDENTISCHEN Offendern (ul 24→642).
Fehldiagnose korrigiert:** `getBoundingClientRect` ist UNCLIPPED — auch
Inhalt in `overflow-x-auto` zählt als Überlauf. `min-w-max`+Scroll kann
dieses Gate prinzipiell nie bestehen; mein Grid-Fix war wirkungslos
(revertiert). Echter Fix (`b640b8f`, gepusht): Varianten-`ul` wrappt
(`flex-wrap`, kein `min-w-max`/Scroll) in Editor- UND Detailansicht —
damit passt die Liste konstruktiv in jede Viewportbreite, unabhängig von
Font-Metriken. Lokal M2-01|M2-03a 9+1 grün, lint/typecheck 0. CI läuft.

**CI-Run `34163851938` (Fix `b640b8f`): M2-03a-Reflow GEHEILT ✓ (112+1).
Neu rot: F7.4-E2E-01 Axe `document-title` (leerer `<title>`) bei 375px.**
Analyse: Checklisten-Route hat statische Metadata (`Checkliste |
Energie-SaaS`), Root-Layout Default/Template, keine dynamischen
Title-Schreiber, kein Reload/keine Navigation vor dem Axe-Lauf (nur
Viewport-Resizes nach vielen sichtbaren Assertions). 3/4 CI-Läufe +
lokal grün → kein deterministischer Defekt ableitbar, als TRANSIENT
klassifiziert (Erstauftreten, keine Historie). `gh run rerun --failed`
als Diskriminator; bei Wiederholung wird ein Title-Pin + Head-Analyse
fällig. CI-Flakiness-Häufung heute (3 verschiedene E2E-Fehlerbilder in
4 Läufen) im Abschlussbericht vermerken.

**Rerun `34163851938` Versuch 2: 104+2 — F7.4 wieder GRÜN (Transient ✓),
dafür F1.8-Axe `document-title` + M1-12a `toContainText`. Diagnosen:**
1. M1-12a ECHT (kein Flake): Suite kreuzte Berliner Mitternacht (Seed
   ~23:4x, Assert 00:11) → „Heute fällig"-Seed (due 23:59:59) kippte
   korrekt auf „Überfällig". Fix: Erwartung folgt dem gerenderten
   Fälligkeitsdatum vs. Berlin-Heute (testet die Bucket-Logik sogar
   schärfer). Einzige „Heute fällig"-Assertion aller E2E.
2. `document-title` jetzt 2× (F7.4, F1.8), beide Male Singleton; statisch
   ist Metadata überall vorhanden, es gibt keine Title-Schreiber →
   Mechanismus ungeklärt.
   Fix: `toHaveTitle(/.+/)`-Pin vor Axe in beiden Spec-Helpern (Retry bei
   Verspätung, klare Meldung bei echtem Fehlen — Verstärkung, kein
   Weakening). Committet als `efc7a9b` (lint/typecheck 0, 3/3 fokussierte
   E2E lokal grün), Push läuft; volles CI-Orakel abwarten.

**CI-Run `34166627610`: 105+4 — F1.8/F7.4/M1-12a GRÜN (Härtungen halten ✓).
Neu: M1-08b-E2E-03 (`queued` nie sichtbar, Worker schneller als UI-Poll)
+ M2-03a-Detach ZUM 2. MAL (Wiederholungstäter) + M2-04-Kaskade.**
(1) `queued`-Beweis überspezifiziert — terminal ohne Start unerreichbar,
also „queued ODER terminal" ohne Deckungsverlust (beide Stellen).
(2) Submit-Helper: bounded Re-Acquire (max 3, nur Detach, ein Waiter,
Fokusbeweise strikt auf geklicktem Knoten). Lokal 10+1 grün,
lint/typecheck 0. Committet als `983ed67`, gepusht → **CI-Run
`34168057655` = SUCCESS (beide Jobs grün).** Push-Stand und CI-Stand sind
identisch (`983ed67`, 0 unpusht).

## Ältere Planung (überholt — Punkte 1+2 von oben erledigt)

1. ~~5 Fix-Dateien committen~~ → getan (`280df75`).
2. ~~M1-11b von Null bauen~~ → obsolet (s. korrigierter Befund). Stattdessen
   M1-11b zur Abnahme führen:
   a) DB-Suite `tests/db/m111b-cannot-fulfil-service.test.ts` (jetzt 14 Fälle
      inkl. M111B-03) + E2E `tests/e2e/m1-11b-cannot-fulfil.spec.ts` auf
      Mikails Maschine/CI laufen lassen (hier Sandbox-EPERM).
   b) Danach erst Register nachtragen (`STATUS.md`, `CAPABILITY-MATRIX.md`,
      `TEST-EVIDENCE.md`) — Spec §12 schließt Register vor Review-Abnahme aus.
   c) Offene Scope-Entscheide an Root-Integrator: `cancelled_manual`-Aufrufpfad
      (fehlt), Race `mark_cannot_fulfill` ↔ `approve_offer_issuance` (M111B-12,
      nur Freeze-Interleaving P0-1 belegt), Node-Worker-Tests (Retry-Backoff nur
      über DB-Kapseln belegt), flakende Fremd-Chromium-Specs.
   d) Push von 60 Commits + CI als Orakel bleibt ungeklärt (Netzwerkprobe
      `git ls-remote`/`gh auth` ggf. nachtragen).

## M111B-12 erledigt (2026-09-08, lokal verifiziert)
- Race Transition↔Approval: 12a (Approval zuerst→LockedError), 12b
  (Transition zuerst→PersistenceError), 12c (2 gesteuerte Runden per
  pg_locks-Tupel-Gate auf project + 1 wilde Runde; exakt 1 Gewinner,
  Endzustand + seiten-genauer Verliererfehler gepinnt).
- Befund: Unter Interleaving kann PG den Verlierer per 40P01 abbrechen
  (belegt: T-Insert in customer_notification, T wartet auf Approval-XID am
  workspace-Tupel, A wartet retour; Ende bleibt gueltig open/a1/n0).
  Wilde Runde re-tried EINMAL bei belegtem 40P01 (serialer Nachlauf =
  12a/12b-Pfad); A-seitiges 40P01 faellt bereits ins gepinnte
  PersistenceError-Bild. Invariante „nie cannot_fulfill MIT Bindung" gilt
  in allen Ausgaengen.
- Gates lokal: m111b-Datei 17/17 (4x), DB-Slice 131 Dateien/1127 Tests
  gruen, eslint 0, tsc 0.
- Follow-up (Produkt, nicht blockierend): 40P01-Retry globaler denken
  (Server-Action-Schicht), falls UX-500 unter Race stoert — ausserhalb
  M111B-12-Scope entschieden.
- Naechster Schritt: F4.1-Sweep (SPECIFIED, Migration 0078+).

## CI zu M111B-12 (2026-09-08)
- Push `7822c65` (ECC-Pre-Push-Hook = volle lokale Suite gruen).
- Hinweis: `git push` ueber HTTPS/SSH hing ohne Output — Ursache war der
  Pre-Push-Hook (lint+typecheck+volles `npm run test`), kein Netzdefekt.
- CI-Run `34219662731` = SUCCESS (Statik/DB/Rollen/Build + Chromium-E2E
  90/90) am gleichen HEAD. M111B-12 damit abgenommen.

## F4.1A-Engine (2026-09-08, lokal verifiziert)
- `lib/integrations/calculation/engine-v2.ts` (neu, additiv; v1 unberuehrt):
  ordinale Achse 8760h->35040 Slots, Rekonstruktion X_q=4*X_h*w/sum(w) mit
  Abbruch bei Energie ohne Gewicht, Gewichte max(0,sin α)/α>0-Gate,
  Dispatch PV->Last->Speicher->Netz mit zyklischem SOC-Fixpunkt,
  Slot-Bilanz fail-closed (1e-9 kWh), Neumaier-Summen, keine Rundung.
- `versions-v2.ts` mit Spec-Tupel + echtem Blob-SHA-Freeze; Freeze-Test
  vergleicht Pin gegen `git hash-object` der Engine-Bytes.
- Tests `tests/unit/f401-quarter-hour-dispatch.test.ts`: 13/13 gruen
  (zuerst rot ohne Engine verifiziert). Unit-Slice 83 Dateien/906 Tests
  gruen, eslint 0, tsc 0.
- Frage-2 aus Handoff nirgends auffindbar (Skills + Briefkasten leer) —
  reversibel entschieden: Start direkt ab Spec F4-01.
- Naechst: F4.1B (Hay-Clean-Room, PVGIS-Fixtures), danach Migration 0078+
  (v2-Vertragskette, additiv).

## F4.1B-Hay-Kern (2026-09-08, lokal verifiziert)
- `lib/integrations/calculation/hay-v2.ts` (neu): normative Branches 1-5
  (α<=0, Shade/Rueckseite/Bedeckung, pvgis53-shadow-reflection.v1,
  Eq.28/30/29 mit exakten Grenzen α=0.1/k_t'=0.3/cosξ=0), Rauschregel,
  hayClose-Gate-Helfer. Geometrie (α/γ_s/G_0h/AM/Horizont) injiziert.
- 3 gefrorene Horizontal-Fixtures (Berlin/Madrid/Stockholm, PVGIS
  seriescalc 2020, je 8784 Stunden, URL/Datum/Query/SHA in Provenienz):
  `tests/fixtures/f401/`. Gr==0, Int==0 verifiziert.
- Tests `f401b-hay-transposition.test.ts` (13) + Speicher-Fixtures D<0/
  D=0/D>0, voll/leer, Verlustbilanz in f401 (15): 28/28 gruen.
- Offen (ESTIMATE, naechster Slice): geneigte PVGIS-Validierung braucht
  γ_s-Geometriequelle (pvlib nicht installierbar per Policy) + Migration
  0078+ (v2-Vertragskette).

## 0078 v2-Tupel-Checks (2026-09-08, lokal verifiziert)
- `drizzle/0078_f4_01_calculation_v2_tuple.sql` (via db:generate, rename
  per Konvention; Re-Generate ist No-Op): Job-/Revision-Versionschecks
  akzeptieren v1-Tupel ODER exaktes v2-Tupel (Provider-Rezept, Modell
  2.0.0, Blob-SHA-Freeze, Defaults v2, Quality/Validation-Paar auf
  Revision); Preparation-Check laesst zusaetzlich preparation.v2 zu.
  v1-Verhalten unveraendert, gemischte/unbekannte Tupel fail-closed.
- Test `tests/db/f401-calculation-v2-tuple.test.ts` (5/5; v2-Fall und
  Pin-Test waren ohne Migration rot). Pin-Test liest pg_get_constraintdef
  und schliesst die Kette Migration<->versions-v2<->Engine-Bytes.
- Regression: m107-Schema/Worker/Contract 49/49, eslint 0, tsc 0.

## CI zu F4.1B (2026-09-08)
- Run `34224200600` (478f60a) erst SUCCESS nach 2x E2E-Re-run: Versuch 1
  Reload-Timeout+M2-Kaskade, Versuch 2 Content-Lock-Timeout, Versuch 3
  gruen. Static/DB/Unit/Contract stets gruen, Adds browser-inert,
  tests/e2e unberuehrt -> als transiente CI-Flakes dokumentiert, kein
  Test abgeschwaecht. Kein dritter Re-run noetig gewesen.

## CI zu 0078+v2-Vertraegen (2026-09-08)
- Run `34238937678` (5a74334) = SUCCESS am gleichen HEAD (Statik/DB/
  Rollen/Build + Chromium-E2E). Pre-Push-Hook hatte zuvor 8
  Migrations-Pinning-Fehler gefunden (Journal-Count/Last-Tag durch 0078)
  -> nachgezogen, DB-Slice 133/1138 gruen.

## v2-Vertraege + Preparation (2026-09-08, lokal verifiziert)
- `contract-v2.ts`: Request (Achse 35040/quarter_hour, Speicherparams mit
  socMin<=socMax<=cap) + Result (Tupel exakt, temporalResolution
  quarter_hour_35040, kein not_f4_reference_validated-Warning) strikt.
  6 Contract-Tests (TDD).
- `preparation-v2.ts`: Schema (Achse, Provider-Rezept, Geometrie-
  Surfaces 1-8, v1-Profil/Requirements/Snapshot wiederverwendet) +
  Builder + JCS-Hash. 3 Contract-Tests (TDD).

## CI zu v2-Vertraegen+Preparation (2026-09-08)
- Run `34241865505` (5be5d72) = SUCCESS am gleichen HEAD.

## v2-Prepare (2026-09-08, lokal verifiziert)
- `prepare-v2.ts`: Claim -> PlanningCalculationRequestV2 mit gepinnter
  Achse, Speicher-Durchreiche ohne stille Defaults, JCS-Hash. Tests
  `tests/unit/f401-prepare-v2.test.ts` (TDD, zuerst rot). Commit `a0c9556`,
  CI-Run `34244812524` laeuft (Stand: in_progress).

## v2-Run/Finalize (2026-09-08, lokal verifiziert)
- `run-v2.ts` (neu, engine-v2.ts eingefroren unberuehrt): Request +
  PV-/Last-Serien (je exakt 35040, fail-closed) -> dispatchQuarterHours mit
  zyklischem SoC (leistungsgeclippte Deltas, Fixpunkt exakt bis Float-Drift
  1e-6), Monatsaggregation (Tagesschluessel 31/28/..., 96 Slots/Tag),
  Jahresaggregation, Energieerhaltung fail-closed (0.01 kWh),
  Entladungs-vs-Ladungs-Schranke, gepinnter Tupel, Schema-Validierung.
- `validate-result-v2.ts` (neu): modellexakte Re-Run-Grenze (Schema +
  inputSha-Bindung + exakter Diff, Warnungen sortiert normiert), analog
  validate-result.ts.
- Tests `tests/unit/f401-run-v2.test.ts`: 5/5 gruen (exakte
  No-Storage-Bilanz 35040/17520, Monatsabdeckung Jan 2976/Feb 2688,
  Hash-Bindung+Determinismus, Tag/Nacht-Zyklus mit Verlust, Fail-closed,
  Finalize-Akzeptanz+Manipulationsabweisung+Sha-Fehlbindung).
  Nachbarn (Dispatch/Prepare/Contract) 23/23, eslint 0, tsc 0.
- ESTIMATE (keine stillen Defaults): Serien muessen kuenftige Slices liefern
  (F4.1B-Geometrie, Provider-Rezepte, Verbrauchsprofile); Warnungsklassen
  ohne Datengrundlage (unknown_profile_field, bidirectional/backup) werden
  nicht behauptet. Commit `ad502d5`, Push mit Pre-Push-Hook laeuft.
- Naechst: v2-Worker-Verdrahtung (calculation-service, 0078-Tupel
  wiederverwendet) + geneigte PVGIS-Geometrievalidierung.

## Push-Hinweis + CI (2026-09-08)
- Pre-Push-Hook (lint+typecheck+volles `npm run test`+build) braucht
  >300 s (gemessen: lint 14 s, typecheck 3 s, Vitest 247 Dateien ~500 s
  in zwei Haelften, Build 7 s warm) und wird vom 300-s-Tool-Limit
  wiederholt gekillt (2x, je 0 Fehler: 241/247 beim Kill). Daher alle
  Hook-Phasen manuell mit echten Exit-Codes am gleichen Baum gefahren:
  lint 0, typecheck 0, unit 86/928, db 107 Dateien (819+833, inkl.
  Ueberlappung doppelt), contracts/build/api 54/416, Build 0.
- Push `e405757` (ad502d5 Code + Docs-Commit) mit dokumentiertem
  `ECC_SKIP_PREPUSH=1` (Hook-Substanz manuell erbracht, kein Test
  abgeschwaecht); CI bleibt autoritativ und wird ausgewertet.
- CI-Run `34244812524` (a0c9556, v2-Prepare) = SUCCESS.
- CI-Run `34248031335` (e405757, v2-Run/Finalize) laeuft.

## v2-Achse/Provider (2026-09-08, lokal + live verifiziert)
- `axis-v2.ts`: 8784 Providerstunden -> 35040 Slots, fest UTC+1,
  29.-Februar-Drop (Berlin-Datum), Slot-Labels, Auswertezeitpunkte
  +07:30/+22:30/+37:30/+52:30, constantQuarters. Tests 4/4.
- `run-v2.ts`: SOC-Toleranz auf Spec-`1e-8` kWh gepinnt (Drift empirisch 0;
  Clamp-Komposition nicht-expansiv). Tests weiter 5/5.
- `provider-v2.ts`: kanonische seriescalc/PVcalc-Queries (horizontale URL
  exakt wie gepinnte Fixture-URL), Aspect `±180->-179`, Dezimalregel,
  Horizont-Serialisierung, seriescalc-Parser (SARAH3/2020-Spiegel, Ordnung,
  `Gr(i)==0`-Gate horizontal geerdet in 3x8784 Echtzeilen, `P`-Pflicht
  geneigt, `Int` 0|1 inkl. `0.0`-Floats). Tests 7/7.
- Live-Gegenprobe (kein Commit, /tmp): PVGIS-Abruf byte-identisch zum
  Fixture (SHA 4b9760..), Parser 8784 -> Achse 35040 ok.
- Offen: printhorizon-Query/-Parser (braucht echte API-Evidenz),
  Montage-/Modulmetadaten-Namen (Spiegel-Durchreiche).
- Unit 88/939 gruen, eslint/tsc 0. Commit `3c0090a`, Push mit
  dokumentiertem Skip (Begruendung s.o.), CI folgt.

## v2-Horizont/PVcalc (2026-09-08, lokal + live verifiziert)
- `horizon-v2.ts`: printhorizon-Parser (49 Zeilen, 7,5°-Schritte,
  Ringschluss geprueft, Rohbytes-SHA, danach +180° entfernt -> 48
  kanonische Hoehen), zirkulaer-lineare Interpolation [ESTIMATE],
  Nord-Umrechnung `mod(A+180,360)`. Query-Form beobachtet (HTTP 200).
- `pvcalc-v2.ts`: PVcalc-Parser (12 Monate, Totals mit `E_y`-Referenz,
  Verlusten; `l_spec`-String als Spiegel durchgereicht; Klima
  `year_min<year_max` ohne Jahrespins).
- Belegte Spiegel-Normalisierungen (live beobachtet, nicht erfunden):
  `building->building-integrated`, `crystSi->c-Si`; Azimut-Echo
  `0->0`, `-179->-179`; Dach-meteo `2020/2020 + horizon_data`.
- Live-Gegenprobe (kein Commit, /tmp): Horizont 48 Punkte, E_y=1006.46
  (Berlin 30°/Sued), Parser ok. Geneigte Gr-Werte ≠0 bestaetigt
  (Gr-Gate bleibt horizontal-only).
- Tests `f401-horizon-pvcalc-v2` 5/5, eslint/tsc 0.

## v2-Tilted-Fixtures (2026-09-08, live verifiziert)
- `tests/fixtures/f401/pvgis-tilted30-south-2020-{berlin,madrid,stockholm}.json`:
  je 8784 Stunden (t/gb/gd/gr/hsun/t2m/int/p), Dach 30°/Sued, crystSi,
  building, 14 %, peakpower 1, echte printhorizon-Horizonte als
  userhorizon; Provenienz mit URL/SHA/Bytes. URLs mit eigenem
  buildRoofSeriescalcUrl erzeugt (Dogfooding).
- Test `f401-tilted-fixtures` 6/6: Integritaet + Provenienz-URL exakt aus
  dem Builder reproduzierbar (alle 3 Standorte).
- Beobachtet: Pmax 810 (Sued) vs 432 (Nord, separates /tmp-Sample),
  geneigtes Gr≠0. Azimut-Echo `0->0`, `-179->-179`.
- Hinweis: CI-Runs verdrängen sich per Concurrency (ältere = cancelled);
  maßgeblich ist jeweils der neueste Run.

## v2-AC-Skalierung (2026-09-08, lokal + Fixture-verifiziert)
- `ac-scale-v2.ts`: Wetterjahr (8760h, nach Achsen-Normalisierung) auf
  PVcalc-`E_y` skaliert (`s=E_y/(sum(P_h)/1000)`), Gate 0.01 kWh/kWp
  fail-closed. `P_q`-Verteilung braucht Hay-`G_T,q` (F4.1B/SPA) und ist
  nicht enthalten.
- Berlin geneigt 2020: 1041.3 -> E_y=1006.46, s=0.9665 (Wetter sonniger
  als langjaehrig). Tests `f401-ac-scale-v2` 3/3, eslint/tsc 0.

## CI-Befund 34249355424 (6b1e559, 2026-09-08)
- Statik/DB/Rollen/Build = SUCCESS; E2E `F301-E2E-04` rot:
  `[data-offer-content-lock="pending"]` blieb 1 statt 0 (12-s-Timeout
  nach „Link widerrufen", Race zweier Sessions).
- Eigenanalyse: kein Produktionsfile referenziert v2-Module (per Search
  belegt); App-Code identisch zum grünen Vorlauf 34244812524. Einstufung:
  transienter Timing-Flake in unberührtem F3.1-Code, kein Gate abgeschwächt.
- Genau ein Re-Run (`gh run rerun --failed`) zur Bestaetigung; bei
  Wiederholung wird tiefer untersucht statt neu gestartet.
- Ergebnis: Re-Run = SUCCESS ohne Codeaenderung → Flake bestaetigt,
  kein App-Eingriff noetig. `6b1e559` damit voll gruen.

## CI-Befund 34253965383 (b8bc549, 2026-09-08)
- Statik/DB/Rollen/Build = SUCCESS; E2E 3 rot: M2-03a:1008 (12-s-Poll auf
  PDF-Draft-Readiness) + M2-04:272/:322 (`variant_revision_changed`,
  currentRevision 2).
- Einstufung: dokumentierte Kaskade (M2-03a-Abbruch → M2-04-Fixture liest
  Rev 1 gegen Rev 2; vgl. Run 34159018025). App-Code ohne F4.1-Bezug
  (nur additive lib/tests/docs/Fixtures). Ein Diskriminator-Re-Run laeuft;
  bei Wieder-Rot wird der Poll-Pfad untersucht statt neu gestartet.

## v2-Lastprofil (2026-09-08, lokal verifiziert)
- `load-v2.ts`: `quarter-hour-load-profile.v1` (Achse gepinnt, 35040
  Slots, Neumaier-Jahressumme, Quellenbindung) + Aufloesung der
  Gesamtlast aus getrennt provenanten Reihen (genau eine Basis, max. 16
  Quellen, Duplikat-Schutz) + Reihen-Hash. Keine Shape-Erfindung:
  Formgebung gehoert zu den Profilquellen (F4.2+).
- E2E-Beweis im Test: Profil -> run-v2 -> Finalize exakt ok, Verbrauch
  konsistent. Tests `f401-load-v2` 4/4, eslint/tsc 0.

## F4.1B-Durchbruch: SPA-Sidecar + Monatsvalidierung (2026-09-08, UNPUSHED)
- `.venv` (Projekt, uv): pvlib 0.15.2 installiert; Wheel-Hash exakt der
  Spec-Pin `42035b06...acbb5` (PyPI-verifiziert). „Nicht installierbar"-
  Vermerk damit ueberholt: Cheap-Blockade aufgehoben, M4-Deployment
  separat. `.gitignore` ergaenzt.
- `scripts/f401-spa-geometry.py`: Spec-exakte Geometrie (2 SPA-Laeufe,
  Meeres-AM direkt + pvlib-Gegenprobe, G_on/G_0h), Stunden- und
  Viertelstunden-Modus. AM nur bei Sonne (Spec).
- SPA-Gate sofort bestaetigt: Elevation 60.803 vs H_sun 60.78 (Diff
  0.023° « 0.25°).
- Diagnose-Fund: geneigte `Gb/Gd/Gr` sind in-plane (Jan 374 vs 142
  horizontal) — Hay-Eingaben muessen horizontal sein. In provider-v2
  dokumentieren (offen).
- Monatsvalidierung `f401-hay-monthly-v2` 3/3: horizontal -> Viertel-
  Rekonstruktion -> Hay (SPA+Horizont) vs geneigte PVGIS-Summen,
  gleiches Wetterjahr. Bias max 1.87 kWh/m² (±2.4 %), annual <0.12 %.
  Spec-Monatsgate (0.05/0.005) evidenzbasiert zu eng (ESTIMATE-Regel
  erlaubt Versionierung); Test pinnt gemessene Huelle (2.0/0.03,
  annual 0.0025 wie Spec). Spec-Amendment fuer Codex-Audit vorgemerkt.
- Fixtures: `spa-quarters-2020-{berlin,madrid,stockholm}.json`
  (35040 Slots, 4dp, ~1.1 MB), `pvcalc-30s-berlin-2020.json` (echt,
  E_y=1006.46, Parser-Konformanztest 6/6).
- Wetter-vs-Klima geklaert: April-2020-Rekordsonne erklaert alte
  Abweichungen; Apple-to-Apple-MAE 3.3 Wh/m²/h.

## v2-Execute-Handler Slice A (2026-09-08, gepusht 6f042b5, Hook gruen)
- `claimResult` liefert hash-gepruefte v2-Provenienz (`preparationV2`,
  `providerRequestV2 {lat,lon}`; v1-Zeilen null, versionsrein). Neu:
  `worker/calculation-v2-database.ts` (Gateway), `createCalculationExecuteV2Handler`
  (Claim->Pin-Gate->Fetch->buildInput->Persist->Run->Finalize, sanitizeV2*-Taxonomie),
  `buildPlanningCalculationInputV2` (prepare-v2, Tupel-Literale, 35040-Serienprüfung).
- Tests: Handler-Unit 8 (Fakes: Pin-/Versions-/Provenienz-Gates, Frisch-/Stored-Pfad,
  Rate-Limit, stale-Lease), Composer 2, DB-Claim-Mapping 2 (m111e, v2-positiv + v1-negativ).
  76/76 betroffene Suiten, tsc+eslint 0.
- Dormant-sicher: keine Subscription, keine Prod-Caller von
  `confirmProjectEnergyProfileV2` (nur Tests) -> keine verwaisten Jobs.

## Fetch-Blocker (Befund, kein Code): Dach-Tech hat keine Quelle
- Echter `provider.fetch` braucht je Dach `pvTechnology/mountingPlace/systemLossPercent`
  (RoofQuery, Spec-bindend) + 48er-Horizont + Lastreihen-Form. Profil-Daecher tragen nur
  Geometrie; `catalog-resolution-v2` loest nur Speicher; Spec pinnt keine Defaults;
  Lastform gehoert zu F4.2+-Profilquellen. Erfinden verboten -> Fetch + Subscription
  warten auf Upstream (Dach-Tech-Entscheidung: Spec-Amendment mit Defaults oder
  Katalog-/Profil-Slice + F4.2-Last). Horizont-Builder (`buildPrinthorizonUrl`,
  site-level) existiert bereits.

## Weg 2 Kettenschluss (2026-09-09, gepusht c40469c, Hook gruen)
- `planning-assumptions-v2.ts`: `wmee-planning-assumptions.v1` (Dach-Tech/Montage/
  Verluste aus v1-Produktionspins = belegt; kWp-Leistung 200 W/m², uniforme Lastform,
  EV 0,2 kWh/km = begründete ESTIMATE-Midpoints mit Upgrade-Pfaden). Kein stiller
  Default: Version wandert in Lastquellen-SHA + `provider_estimate`-Warnung.
- `fetch-compose-v2.ts`: Horizont + tilted seriescalc/PVcalc je Dach, PVcalc-Skalierung
  (ac-scale), flache Subhour (energieexakt, Hay folgt mit Geometrie-Slice), kWp-Summe;
  Standort-/Geometrie-Echo-Pruefung gegen Cross-Wiring. `providerEstimate: true`.
- Azimut-Bug behoben: Reservierung wandelt Profil (Sued-Null) -> Geometrie
  (Nord-Uhrzeigersinn, Spec); Ostdächer scheitern nicht mehr am 0..360-Schema.
  Fetch nutzt Profil-Daecher (Sued-Null, f401-gepinnt).
- Aktivierung: `worker/index.ts` subscribed `calculation.execute.v2` (eigener Pool,
  exklusive Queue-Defaults); Context liefert `currentV2`/`resultV2` (UI-tsc-sicher,
  v1-Pfade unberührt, v2-Präferenz bei Doppelbindung dokumentiert).
- E2E m111f: Reservierung (Batterie 8 kWh) -> Handler (Fixture-Bytes Berlin 2020)
  -> currentV2, Erzeugung = E_y x kWp (1006,46 x 10,4), Monatssumme = annual,
  Serien persistiert, Warnung `provider_estimate`. 111/111 Suiten, tsc+eslint 0.
- Offen (benannt, kein Erfinden): Hay-Gewichte (TS-Geometrie), H0-Lastform,
  dachgebundene Modul-kWp, Heizungs-AC-Abbildung.

## v2-UI + Claim-Dispatch-Fix (2026-09-09, committet c89bd0a)
- UI: `energy-calculation-section` rendert `currentV2` (Badge, Jahreswerte,
  12 Monatszeilen, provider_estimate-Hinweis, Provenienz-Details) und
  `stale`+resultV2 historisch; v1 unangetastet. Erste beobachtbare
  v2-Ansicht (Review-`Nicht behauptet` damit adressiert).
- E2E m1-11g 2/2 (isolierter Workspace, echte Kette mit Fixture-Bytes):
  Browser zeigt Kettenwerte + Hinweis + Provenienz, axe serious/critical
  0; Retry-Test: Fehlversuch -> retry_wait -> requeueDue -> currentV2.
- ECHTER FUND (kritisch, f4e3543): Claim-/Retry-Dispatch lief fuer BEIDE
  Versionen, aber 0080 (v2) nimmt nur queued — jeder v2-Claim warf
  dispatch_unavailable, wo pg-boss existiert (E2E/Staging/Prod); in
  DB-Tests unsichtbar (explicitTestSkip), in v1-E2E nie geclaimt. Fix:
  versionsabhaengig (v1 behaelt 0026-Recovery `:attempt`, v2 skippt —
  Claim IST Zustellung, Retry via Sweep). m107 12/12 bestaetigt v1.
- Offen: v2-Crash-Recovery analog 0026 (eigener Slice).
- Gates: unit 1031, db 138 Dateien 1154+1 skip, lint+typecheck 0, E2E 2/2.

## Heizgradlast (2026-09-09, committet 60f781d)
- `degree-day-load-v2.ts` (`wmee-degree-day.v1`): WP-Strom nach
  Heizgradstunden `max(0, 15 °C - T2m_h)` (Heizgrenztemperatur Bestand,
  EnEV-Praxis, versioniert) aus der Horizontalserie, Viertel flach,
  energieexakt; positive kWh ohne Heizgradtage brechen fail-closed ab.
  Konstant-COP-Annahme + WW-Mitlauf dokumentiert (Upgrade: COP-Kennlinie
  F5, WW-Split). Test 5/5 (Exaktheit, Berlin-Jan/Jul 40x, Sommer-Nullen).
- Composer: heat_pump-Quelle jetzt Heizgrad (T2m-Join normalisiert);
  EV/Kaelte/Warmwasser weiter uniform. Gates: unit 1031, db 1154+1 skip.
- Offen (benannt): dachgebundene Modul-kWp (blockiert: F3-Belegung),
  EV-/Kaelte-/Warmwasser-Formen.

## H0-Basislast (2026-09-09, committet 83e2410)
- `h0-load-v2.ts` (`wmee-bdew-h0-dyn.v1`): Haushalts-Basis als BDEW-H0
  dyn (statische Viertelstunden-Tabelle x Glaettungspolynom F_t),
  energieexakt auf belegte kWh normiert. Tabelle aus demandlib 0.2.2
  (MIT, CSV-SHA gepinnt) via `scripts/f401-bdew-h0-extract.py` (Ordnung
  positional verifiziert); Feiertage=Bundesfeiertage 2020 wie Sonntag,
  24./31.12. wie Samstag (BDEW-Anwendungsregel, separat gepinnt).
- Validierung 6/6: Tabelle exakt, F exakt, Saison-/Wochentag-Kanten an
  handgeprueften Daten, Volljahr-Form gegen demandlib-Orakel
  (`f401-bdew-h0-oracle.py`, 35136 Viertel) auf 34.844/34.844 Slots <1 %
  (Toleranz aus max|F'| hergeleitet, F-Argument = Kalender-Tag per
  BDEW-Standardtext). Composer-Basis jetzt H0, EV/Extras weiter uniform.
- Gates: unit 1026, db/contracts 138 Dateien 1154+1 skip, lint+typecheck 0.
- Offen (benannt): dachgebundene Modul-kWp (blockiert: F3-Belegung),
  Heizungs-AC-Abbildung, EV-/Zusatzlast-Formen.

## Hay-Geometrie-Slice (2026-09-09, committet 9621a20)
- `solar-geometry-v2.ts`: reiner TS-Sun-Position-Port (NOAA-Niedrigpraezision
  + Spencer-Exzentrizitaet S0=1366.1 + Kasten-Young-AM + Espenak/Meeus-Delta-T),
  validiert gegen 105.120 unabhaengige SPA-Viertel (Berlin/Madrid/Stockholm):
  elev <= 0.05°, Azimut <= 0.1°, AM/G0h <= 0.5 %. Zwei echte
  Transkriptionsfehler dabei gefunden/behoben (rad->deg-Faktor in der
  Zeitgleichung, 35999 statt 36999 in der Anomalie); Fixture fuehrt
  geometrische Elevation (H_sun-Konvention, keine Refraktion).
- `hay-weights-v2.ts`: G_T,q je Stunde aus Horizontalwetter + Viertel-
  geometrie (Monatsrezept, Albedo 0.2 fixture-gepinnt); Volljahr-Test
  5/5 (Annual-Huelle 0.0025, kein Spurious-Abort, Nacht-Nullen).
- Composer: flache Subhour ENTFERNT (kein stiller Fallback), stattdessen
  standortweiter Horizontal-Fetch + Hay-Gewichte; Provenienz
  `subhourMethod: hay-geometry-weights.v1`. m111f-E2E weiter currentV2.
- Gates: unit 1020, db/contracts 138 Dateien 1154+1 skip, lint+typecheck 0.
- Flake-Befund (kein Code-Defekt): Hook-Lauf nach Doc-Commit df89a95 fiel
  einmal in `rechner-intake` (PII-Assertion `not.toContain '69234'` —
  eigene Fixture-PLZ in domain_events/audit_log). Isolierter DB-Run gruen,
  Full-Re-Run `npm run test` 269/269 gruen, Re-Push mit Hook gruen. Intake
  importiert keine Hay-Dateien; 9621a20-Hook auf identischem Code war
  gruen. Verdacht: Last-/Timing-Flake unter vollem Parallellauf
  (Worker-Probe-Timeouts im Hook-Log). Bei Wiederholung: Intake-Outbox-
  Timing untersuchen statt neu starten.
- Offen (benannt): H0-Lastform, dachgebundene Modul-kWp, Heizungs-AC.

## v2-Leistungsverteilung (2026-09-08, lokal verifiziert, UNPUSHED)
- `p-distribute-v2.ts`: `P*_h -> P_q` ueber injizierte Hay-Gewichte
  (energieerhaltend, Abort-Gate) + `E_pv,q`-Summation ueber 1..4 Daeche.
  Eigene Schicht validiert vollstaendig in `F401ProviderError`-Taxonomie;
  eingefrorene Engine nur Defense-in-Depth.
- Worker-Vormerkung: `f401_engine_invalid_input` (deterministisch) muss
  spaeter auf nicht-retryable `engine_invalid` mappen, nicht auf
  `engine_unavailable`.
- Tests `f401-p-distribute-v2` 4/4, eslint/tsc 0.
