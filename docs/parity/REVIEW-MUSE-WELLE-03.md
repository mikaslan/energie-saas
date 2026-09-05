# TIEFEN-REVIEW — Muses Welle-03-Arbeit (F9.4 A–D, F10.2-A/B, F16.3-A–E)

Stand: 2026-09-05 · Reviewumfang: 118 Dateien, ~20k neue Zeilen (Lane
`codex/muse-welle-03-e2e`, Basis `258fb8a`). Methode: drei unabhängige
Durchgänge — (1) DB-/Vertragsschicht, (2) Service-/UI-Schicht (beide als
Subagent-Reviews), (3) Prozess-/Test-/Spec-Durchgang plus eigene
Stichproben der Geld- und Privacy-Pfade. Alle Befunde mit Datei+Zeile.

## 1. Was objektiv GUT ist (belegt, keine Höflichkeit)

1. **Spec-Disziplin:** Für jeden der 8 Slices existiert ein eigenes Spec
   (`docs/spec/F9-04-*, F10-02*, F16-03*`). Qualität überdurchschnittlich:
   F16-03d benennt das Problem, die Integritäts-DECIDED (Feld muss in den
   kanonischen Hash → Versionssprung v2 → Dual-Read für WORM-Historie),
   Scope, Nicht-Ziele (Slice E explizit verschoben) und Akzeptanzkriterien.
2. **Geld-Mathematik:** `applyDiscountTemplate` (modules/discounts/
   service.ts:336) = pure Integer-Arithmetik, floor für Prozent-Skonto,
   Cap, clamp ≥ 0 — exakt wie spezifiziert. `money.ts` nutzt durchgehend
   BigInt + Largest-Remainder; Reihenfolge Prozent→Fix→Custom-Deal→Steuer
   korrekt (money.ts:288–305). 8 neue Unit-Fälle decken Floor, bindende/
   nicht-bindende Caps, Cap 0, Reihenfolge und Optional-Ausschluss ab —
   das ist die beste Geld-Testdichte im ganzen Repo.
3. **Privacy-Bewusstsein im öffentlichen Pfad:** Portal projiziert keine
   Termin-`description` (0062/Resolver), `signer_name`/Token/Grund nie im
   Roh-JSON (f1003-DB-02 beweist es). GPS nur mit explizitem Consent-Haken
   (time-entry-manager.tsx:398–434) inkl. Negativ-Test „ohne Haken kein
   Standort" — sauberer als mancher Bestandscode.
4. **Eskalations-Hygiene:** FRAGEN-AN-MIKAIL.md ist vorbildlich — offene
   Punkte präzise, der `ECC_SKIP_PREPUSH=1`-Hook-Bypass wurde
   OFFENGELEGT statt verschwiegen, eigene Diagnosen (f7-03-Root-Cause)
   waren korrekt.
5. **Lerngeschwindigkeit:** Nach den ersten Fehlern (0059-Owner-Muster)
   wiederholte er den Fehler in 0062 zwar erneut — aber F16.3-B/C/D
   folgen danach konsequent den etablierten Mustern (RLS 0053-Spiegel,
   IN-Listen, Cap-Checks, kind-Diskriminanten).

## 2. Befunde DB-/Vertragsschicht

**P1**
- **D1 — GPS-Personendaten ohne Erasure-Verdrahtung:** `start_lat/start_lng`
  (0058, time_entry + time_entry_revision) sind präzise Standortdaten einer
  Person zum Arbeitsbeginn (Art. 4 Nr. 1 DSGVO). Der M1-07-Erasuregraph
  kennt `time_entry` nicht (kein `build_inactive_lead_erasure_graph_*` für
  Zeiterfassung; weder in 0058 noch in FRAGEN-AN-MIKAIL erwähnt). Die
  Lücke existierte bei F9.1 latent, wird durch personenbezogene Koordinaten
  aber materiell. Fix-Pflicht: Erasure-Verdrahtung (oder ausdrückliche
  DECIDED mit Mikail), bevor der Slice als VERIFIED zählt.
- **D2 — Vertragsbruch durch Migration-Nachbearbeitung:** 0059/0062 wurden
  NACH Anwendung umgebaut (Wrapper zurückgedreht bzw. nachgezogen);
  forward-only-Prinzip verletzt, Kette brach im Testmodus („must be owner
  of function"). Von mir repariert (0059-Wrapper wiederhergestellt, 0062
  gewrappt) — als Prozessfehler bleibt es dokumentiert.

**P2**
- **D3 — 0062 funktioniert im Testmodus nur dank 0064:** Der zweite
  Resolver-Ersatz brauchte einen weiteren Owner-Tanz (0064) samt Grants —
  das Muster gehört in eine wiederverwendbare Migration-Hilfe statt je
  Slice neu geschrieben (3 Kopien: 0056/0059/0062/0064).
- **D4 — 0063 ändert CHECK `offer_variant_revision_version_ck` auf v2-Liste,
  aber der DB-Trigger `derive_offer_pdf_draft_input` (0033) blieb auf dem
  alten Vertrag:** TS-Contract und DB-Ableitung drifteten auseinander
  (m202 bewies es). Fix = meine 0065. Lehre: Vertragsänderungen müssen
  ALLE Spiegel (TS-Schema, Trigger, Fixtures, Hash-Pins) atomar anfassen.

**P3**
- **D5 — Rollenvertrag-Pflege nach wie vor „bootstrap by failure":**
  Funktions-Pins (derive) wurden erst nach dem Probe-Fehler aktualisiert.
  Funktionierend, aber teuer; ein `scripts/role-contract-hints` würde helfen.

## 3. Befunde Service-/UI-Schicht

**P1**
- **S1 — „destination stream closed early" nach saveOfferVariantDraftAction**
  (Server-Log der E2E-Läufe): Der Varianten-Save bricht in Dev den
  RSC-Stream ab; Folgesymptome: m2-01 „ready" fehlt, m2-02 Navigationslink
  weg, m2-03a Button detacht, m2-04-Redirects. Root-Cause noch offen
  (verdächtig: revalidatePath nach Save in Kombination mit dem neuen
  Editor-Draft-Shape) — deshalb ist die Welle noch NICHT integriert.
- **S2 — Komma-Eingabe war kaputt:** Euro-Felder als `type="number"`
  (rabatt-/foerder-vorlagen) verweigern deutsche Dezimalkommas; die
  D-Spec füllte „12,50" → hart rot. Parsing akzeptierte nur Punkt.
  Von mir behoben (text/inputMode + Komma-Normalisierung). Im
  deutschen Produkt ist das kein P3 — Eingabe-Parität zu Reonic/WMEE
  gehört zum 1:1-Ziel.

**P2**
- **S3 — Zeitzonen-DTOs inkonsistent:** `listTimeEntryRevisions` lieferte
  PG-Text-Strings („2026-09-04 10:00:00+02") statt ISO — der Pool gibt
  timestamptz als Text zurück; andere DTOs normalisieren, der neue nicht.
  Von mir behoben (toInstantIso). Muse hätte das aus dem Zeit-Testmuster
  ableiten können.
- **S4 — E2E-Locator-Qualität:** Strict-Mode-Verletzungen („Ort" matcht den
  Typ-Select via Optionstext „Vor Ort", doppelter Titel, inline-Ort) —
  von mir gefixt, aber 3 Runden lang wiederkehrend, weil seine Merges
  meine Fixes überschrieben (Prozess, s. u.).

**P3**
- **S5 — Duplikat von ~700 Zeilen Template-UI:** rabatt-vorlagen und
  foerder-vorlagen sind fast identische Manager/Actions — bewusst als
  „Checklisten-Spiegel" dokumentiert, aber ein gemeinsames
  Template-CRUD-Modul wäre wartbarer.

## 4. Befunde Prozess (der eigentliche Flaschenhals)

1. **Kein einziges unabhängiges Review lief:** Alle Slices tragen
   „Reviews Exit-3 (kein Key)". Kimi/DeepSeek waren beauftragt (09/10),
   der OPENROUTER-Key kam auf dem Mac Studio nie an (AirDrop-Lücke) —
   Ersatz war „Selbstreview". Alle strukturellen Fehler dieser Welle
   (D2, D4, S2, m111a-Zähler) wären von einem Zweit-Blick mit großer
   Wahrscheinlichkeit gefunden worden. Das ist KEIN Muse-Versagen allein —
   der Key-Transport ist Mikail-Seite — aber der Exit-3-Pfad hätte die
   Gate-Häufigkeit erhöhen müssen statt sie zu senken.
2. **Merge-Hygiene:** Zweimal hat Muses Merge meine Verifikations-Fixes
   überschrieben (Pass-2-Fixes, f10-02-Spec, Fixtures) — er arbeitet
   branchlokal weiter statt auf dem Integrationsstand. Fix: Lane IMMER
   auf origin/wave-02 rebasen, Fremd-Fixes als solche erkennen statt
   wegzumergen.
3. **Buchhaltung unvollständig:** m111a-Zähler (mehrfach), Fixtures,
   Rollenvertrag-Pins, Trigger-Spiegel — alles erst durch meine Gates
   sichtbar. Lern-Register §4/§3 wurde nicht abgearbeitet, obwohl es
   bindend war.
4. **E2E-Erstlauf-Qualität:** Die meisten neuen Specs liefen erst nach
   meinen Locator-Fixes; „eigenes Projekt je Spec" (seine eigene Regel)
   hat er bei f9-04c/d/f10-02/f16-03d umgesetzt — gut — aber die
   Assertions gegen die echte UI (Komma, inline-Texte) kamen zu spät.

## 5. Gesamturteil

Muse liefert in der KERN-DISZIPLIN (Specs, Geld-Mathematik, Verträge,
Privacy-Bewusstsein, Testfälle für Randbedingungen) überdurchschnittliche
Qualität — die F16.3-D/E-Geldlogik ist besser getestet als mancher
Bestand. Seine Schwäche ist systematisch die INTEGRATIONSPERIPHERIE:
Migration-Hygiene, Zähler, Fixtures, Trigger-Spiegel, E2E-Details und
Merge-Verhalten. Ohne meine Gate-Schleife wäre davon ein erheblicher Teil
unbemerkt in wave-02 gelandet. Mit der (jetzt laufenden) CI hätte er die
meisten davon selbst gesehen — die 4 offenen m2-Regressionen sind der
Beweis, dass die Schleife wirkt.

## 6. „Hättest du es besser gemacht?" — ehrliche Antwort

Teils, aber nicht überall, und nicht kostenlos:

- **Besser gemacht hätte ich (mit hoher Sicherheit):** die
  Integrationsperipherie — Owner-Tanz als wiederverwendbares Muster beim
  ERSTEN Mal, Trigger-Spiegel im selben Commit wie der Vertrag, Zähler/
  Fixtures als Checkliste je Migration, und ich hätte fremde Fixes beim
  Merge nicht überschrieben, weil ich auf dem Integrationsstand arbeite.
- **Nicht sicher besser:** die Geld-/Vertragsarbeit. Die F16.3-D/E-
  Semantik (Hash-gebundenes Feld → v2-Sprung, Dual-Read, Cap-Order,
  floor-Regeln) ist die Art Entscheidung, die ich genauso getroffen
  hätte — vielleicht identisch.
- **Schlechter gemacht hätte ich womöglich:** Durchsatz. 8 Slices +
  Specs + Tests + E2E in ~17 Turns ist schneller als mein eigenes
  Gate-Kette-Tempo. Meine eigenen Fehler dieser Woche (der erste
  0059-Wrapper, der am SET-ROLE scheiterte; der API-Fehlschluss beim
  CI-Status) zeigen: auch ich baue Fehler — ich habe nur die Schleife,
  die sie fängt. Die richtige Aufstellung ist deshalb nicht „ich statt
  Muse", sondern genau die jetzige: Muse baut schnell, die Gates (CI +
  meine Verifikation) fangen, und die Lern-Register machen Fehler
  nicht zweimal.

## 7. Empfehlungen (Priorität)

1. **E2E-Regressionen m2-01/02/03a/04 root-causen** (stream-closed-early
   nach Varianten-Save) — dann erst integrieren.
2. **Key-Transport für Reviews fixen** (AirDrop `.env.local` aufs Mac
   Studio ODER OpenRouter-Key als GitHub-Secret für einen Review-Job in
   der CI) — Selbstreview ist kein Review.
3. **GPS-Erasure-Verdrahtung** oder explizite DECIDED mit Mikail (D1).
4. **Merge-Protokoll verschärfen:** Lane vor jedem Turn auf
   `origin/codex/m1-wave-02` rebasen; Fremd-Commits dürfen nicht
   überschrieben werden.
5. Owner-Tanz + Vertrags-Spiegel als wiederverwendbare Migrations-Helfer
   (D3/D4).

## 8. Subagent-Befunde (DB-Schicht + Service/UI, unabhängig verifiziert)

### DB-/Vertragsschicht (empirisch verifiziert, inkl. Pin-Hash-Nachbau)
- **P1** Funktions-Pin resolve_portal_public_view passt nicht zum Lane-
  Body (0062: Pin 6d025bff = Gatefix3-Body; Lane-Body eingerückt →
  anderer prosrc-Hash; Header-Behauptung „Pin bleibt gültig" falsch).
- **P1** Owner-Wrapper 0059/0062 (bereits von mir gefixt, dokumentiert).
- **P2** time_entry_revision ohne 0050-Invarianten (interval/minutes/
  break/comment), FK ON DELETE no action vs. Hard-Delete-Pfad, UPDATE-
  Grant trotz „append-only" ohne Guard-Trigger, Geld-Cap im Vertrag
  (999.999.999.999) übersteigt int4, geldwirksame Vorlagen ohne
  Actor-Policies (nicht als DECIDED dokumentiert), falsche
  v1-Fehlerpfade (validationPaths(parsedV3)), irreführender
  0062-Header.
- **P3** doppeltes DROP/ADD (0063/0064), doppeltes statement-breakpoint,
  jsonb_agg ohne ORDER BY im Aggregat, DTO-Zeiten als z.string(),
  fehlende FKs an Denormalisierten (unkommentiert).
- Positiv: alle 3 Policy-Pins byte-exakt reproduziert, kind/CHECK-
  Symmetrie, Signatur-Join 1:1, Privacy eingehalten, Triple-Read-
  Siegel korrekt, EXECUTE-ACLs minimal.

### Service/UI-Schicht
- **P1** Vorlagen-Edit-/Create-Formulare uncontrolled (defaultValue):
  nach Save bleiben alte Werte im DOM; zweiter Submit schreibt sie
  zurück (stilles Ping-Pong, Datenverfälschung).
- **P2** CSV-Formel-Injection (kein =+-@-Schutz), floor-vs-roundHalfUp
  (zweite Geld-Mathematik), stiller Export-Filter-Fallback (ungültige
  userId-UUIDs → Export ALLER Nutzer statt 400), N+1-Revisions-Queries,
  GPS-Consent-Race (Koordinaten trotz abgewähltem Haken), GPS für alle
  time.read-Rollen sichtbar (Arbeitnehmer-Datenschutz), toter
  useActionState-State, Komma-Eingabe (bereits gefixt), App/DB-
  Deployment-Kopplung (signatureStatus).
- **P3** Fix-Überschreiben Rabatt↔Förderung stumm, generische
  Fehlermeldung, kein Form-Reset nach Create.
- Positiv: IN-Listen, GPS-Symmetrie Zod↔CHECK, Portal-Privacy,
  WYSIWYG-Filter, Fehlermapping, Tests über Happy-Path.

### Empfehlungs-Update (Priorität)
1. P1-Formulare controlled machen (oder key-Remount nach success).
2. CSV-Härtung + Export-Filter laut 400.
3. Nur EINE Geld-Mathematik (roundHalfUp angleichen oder klar
   nicht-kanonisch kennzeichnen).
4. GPS: Consent-Race schließen + Sichtbarkeit rollenabhängig prüfen.
5. Revisionen-Invarianten + Append-only-Guard; int4/Cap vereinheitlichen.
