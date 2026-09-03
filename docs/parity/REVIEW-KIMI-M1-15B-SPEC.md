kimi version 0.40.1
• The user wants a spec review of M1-15b. "Keine Dateioperationen" — no file operations. So I should review purely from the pasted content. But wait — the prompt says "Keine Dateioperationen" (no file operations). So I review the spec text as given, without reading files. That's fine; the spec is fully included.

  Let me do a careful review. Max 120 lines, German, P0/P1/P2 findings with quote + fix, verdict GO / GO MIT AUFLAGEN / NO-GO.

  Let me analyze thoroughly.

  Key issues I can spot:

  1. **Widerspruch Migrationsnummer**: Header sagt "Geplante Migration: `0047_m1_15b_calendar_scopes.sql` (Root-Arbitrage 2026-09-03: nächste frei nach `0046`/M3-01; M3-02 rückt auf `0048`)", aber §0.1 sagt "Die konkrete Migrationsnummer wird daher **nicht** festgelegt; sie ist eine offene Frage an den Root (O1)". Und §15 sagt O1 RESOLVED → 0047. §0.1 ist veraltet/inkonsistent. P1 (Dokumentationsinkonsistenz, Verwirrung bei Implementierung). Fix: §0.1 streichen/aktualisieren.

  2. **Backfill-Reihenfolge-Risiko / M1-15-Kollaps**: M1-15 hat `category_id` am Termin (0043). M1-15b entfernt `appointment.category_id` und setzt `calendar_id not null`. Backfill: Bestands-Termine → persönlicher Kalender des created_by. Problem: M1-15 ist noch nicht implementiert? Spec sagt "M1-15 (0043) bleibt als gelieferter Stand unverändert gültig". Falls M1-15 und M1-15b beide vor Produktivdaten integriert werden, wäre category_id drop harmlos. Aber die Migration 0047 muss: (a) calendar-Tabelle anlegen, (b) Auto-Provisionierung pro membership ausführen (Daten-Migration!), (c) calendar_id nullable add, backfill, then set not null, (d) category_id migrieren: Termin-Kategorie geht verloren! Termin hatte category_id; jetzt wandert Kategorie an Kalender. Beim Backfill aller Bestands-Termine in den persönlichen Kalender des created_by: welche category_id bekommt dieser Kalender? Wenn Termine unterschiedliche Kategorien hatten, geht die Zuordnung verloren, weil ein Kalender nur eine Kategorie hat. Das ist ein Datenverlust-/Semantik-Bruch: M1-15-Termine mit category_id ≠ null können nicht verlustfrei auf (calendar.category_id) abgebildet werden, wenn mehrere Termine desselben created_by unterschiedliche Kategorien haben. Das ist ein echtes P1 (oder P0?) — die Spec adressiert die Kategorien-Migration im Backfill nicht. §4.2 sagt "ENTFÄLLT category_id ... ersetzt" aber kein Migrationspfad für Bestandsdaten der Kategorie. Testmatrix erwähnt "`category_id`-Migration (Kategorie am Kalender, nicht am Termin)" — aber keine Regel für Konflikte. Fix: Backfill-Regel ergänzen (z. B. pro (created_by, category_id) ein Kalender? oder Kategorie-Verlust explizit als ACCEPTED markieren mit Datenbestand=leer-Begründung). Wenn M1-15 noch keine Produktivdaten hat (alles auf tooling branch, noch nicht implementiert?), eigentlich — Status von M1-15? Die Spec sagt "falls vor M1-15b bereits gebaut". Wenn M1-15 noch nicht deployed ist, könnte man 0043 gleich korrigieren. Aber additive Politik... P1.

  3. **Auto-Provisionierung & membership-Löschung / RESTRICT**: FK `membership_id ON DELETE RESTRICT` — wenn Membership entfernt wird (revoked), blockiert der Kalender das Löschen. Wie wird mit off-boarding umgegangen? Nicht spezifiziert. P2.

  4. **RLS je Scope**: Die Spec sagt FORCE-RLS + Scope-Policies (§7), aber konkrete Policy-Logik (User-Scope: membership_id = current actor's membership) ist nur prosa. RLS-Policy für "Owner" braucht Mapping user → membership. OK, Muster existiert. Aber: "Admin sieht alle internen Kalender" — Admin-Zugriff auf persönliche Kalender anderer Nutzer ist datenschutzrechtlich sensibel (privater Terminkalender von Mitarbeitern). DECIDED WMEE, aber als P2 Privacy-Hinweis markieren: Admin-Sicht auf persönliche Kalender ist eine bewusste Abweichung, sollte mit Begründung/DSGVO-Check versehen werden (Beschäftigtendatenschutz). Eher P2.

  5. **revision-CAS**: DEC-M115B-15 sagt revision-CAS, aber §4.1 Tabellenliste enthält **keine `revision`-Spalte**! Die Tabelle hat id, workspace_id, name, color, category_id, calendar_type, membership_id, team_id, active, created_by, created_at, updated_at — kein revision. §6 sagt "Revision/CAS optional — ... O5" und §14 U4 resolved zu revision-CAS. ADR sagt auch "revision-CAS nach Hausmuster". Also Inkonsistenz: Datenmodell ohne revision-Spalte, Entscheidung mit. P1 — Fix: `revision integer not null default 1` + Update-Trigger in §4.1 ergänzen, §6 update_calendar Signatur von "expectedRevision?" (optional) auf Pflicht ändern. Das ist ein klarer P1-Befund.

  6. **unique(workspace_id, lower(btrim(name)))**: gilt für alle Kalender inkl. auto-provisionierter User-Kalender. Wenn zwei Mitglieder gleiche Namen haben und User-Kalender nach Mitgliedsname benannt werden → Konflikt. Namensgebung für Auto-Kalender nicht spezifiziert (z. B. "Kalender von <Name>"?). unique-Constraint über alle Scopes verhindert z.B. persönlichen Kalender "Allgemein" wenn Unternehmenskalender "Allgemein" existiert. P2. Auch: unique(workspace_id, membership_id) für type='user' — in §6 "ensure_personal_calendar ... Idempotenz über unique(workspace_id, membership_id) auf type='user'" — das erfordert einen **Partial Unique Index** `WHERE calendar_type='user'` (bzw. auch team). Ein voller unique(workspace_id, membership_id) würde verhindern, dass eine membership mehrere Kalender hat (aber persönlich soll 1:1 sein, ok) — aber mehrere tenancy-Kalender haben membership_id NULL → ok bei unique da NULLs distinct. Aber Client-Scope? Egal. Trotzdem: Die Spec beschreibt in §4.1 Constraints keinen solchen Partial-Unique-Index; nur in §6 erwähnt. P1/P2: Index fehlt in §4.1-Constraint-Liste. P2.

  7. **Erasure**: Termine im Erasure-Graphen, Kalender außerhalb. Aber: User-Kalender trägt `membership_id` → personenbezogen? Kalender-Name könnte Personennamen enthalten (auto-provisioniert "Kalender von Max"). Erasure-Graph löscht Kontakt-PII; membership gehört zu User, nicht Kontakt. Bei User-Löschung (nicht Kontakt-Erasure) — was passiert mit persönlichem Kalender? Nicht spezifiziert. Erasure-Grenze: Spec sagt "Kalender bleibt außerhalb des Kontakt-Erasure-Graphen" — konsistent mit workspace-Stammdaten. Aber `membership_id` am Kalender ist ein Personenbezug; wenn die Kontakt-Erasure auch den zugehörigen User/Lead löscht? Erasure betrifft Leads/Kontakte, nicht Memberships. Ok. Aber Tombstone-Hash-Test erwähnt. P2-Hinweis: Name des Auto-Kalenders darf keine Personen-PII enthalten oder muss in den Erasure-/Retention-Vertrag.

  8. **Race: "Kalender-Archivierung vs. paralleler Termin-Create"** in Testmatrix — gut. Aber Semantik: create_appointment validiert Sichtbarkeit, aber nicht `active`-Status? Termin auf archivierten Kalender? §10: archivierter Kalender in Auswahl ausgeblendet — aber serverseitige Validierung? Fix: Validierung `active=true` in create_appointment spezifizieren. P2.

  9. **Testmatrix-Lücken**: 
     - Kein Test für Backfill (0047: Bestands-Termine → Kalender; Kategorie-Migration; Fresh vs Legacy-Pfad zwar in Abschlussgates, aber kein konkreter Backfill-Testfall mit Daten). P1? Testmatrix-Vollständigkeit wurde explizit gefragt. Fehlende Fälle: Backfill-Test (Legacy-Migration mit Bestandsdaten), Auto-Provisionierung-Idempotenz (doppelter ensure-Aufruf, Concurrent), Scope-Invarianten-CHECKs teils da, team_id-FK-fehlt-Test, RESTRICT bei membership_delete, Kalender-Archiv mit bestehenden Terminen (Termine bleiben sichtbar), Revision-CAS-Test (da jetzt resolved). Auch `M115B-DB-03` (Auto-Provisionierung) referenziert, aber Testmatrix-Tabelle listet nicht explizit Idempotenz/Race. P1: Backfill/Legacy-Daten-Test fehlt; P2: CAS-Test, Archiv-Sperr-Test.
     
  10. **"keine — reine Spezifikation (Branch tooling, nur Doku; Root committet)"** — "Ziel: keine" komisch formuliert, egal.

  11. **Disziplin/Scope**: DEC-M115B-13 zieht die workspaceweite /calendar-Route in den Slice ("Scopes ohne Route nicht bedienbar") — Scope-Creep-Risiko: Kalenderansicht (Planungsmodus, Monats/Woche/Tag/Agenda) ist groß; U3 sagt Planungsmodus nicht spezifiziert, aber Route ist im Scope. Widerspruch: Route Teil des Slices, aber ihr zentrales Feature (Planungsmodus) UNKNOWN/nicht spezifiziert. P1: Entweder Route-Umfang präzisieren (nur Ansicht mit Scope-Filter, ohne Planungsmodus) oder Aufspaltung. Auch: Kalender-Kategorien-CRUD ist Nichtziel, aber `category_id` am Kalender setzt Kategorien voraus — read-only wie M1-15 ok.

  12. **Evidenzlücken**: OAS aus `/tmp/reonic-openapi.json` — nicht reproduzierbar archiviert? Quellenlegende sagt "neu geladen per curl" — für Review ok, aber kein Hash/Snapshot-Referenz. P2. Außerdem: `Appointment.calendarId` "im Update-Body nicht änderbar" — Beleg fehlt in dieser Spec (Verweis auf M1-15 §2.1). Ok als Verweis. 4 Scopes belegt. Portal-Zuordnung INFERRED ehrlich markiert — gut. "Allowed API keys: Read-only, Read and Write" ok.

  13. **`calendar_type` vs API `type`**: DTO nutzt `type`, DB `calendar_type` — ok.

  14. **Client-Scope**: CHECK erlaubt 'client', aber Nichtziel — strukturell erlaubt, kein Insert-Pfad. RLS-Policy für client? Nicht definiert ("Nichtziel") — fail-closed muss explizit: Policy lässt client-Zeilen für niemanden sichtbar? Wenn nie Zeilen existieren, egal; aber CHECK erlaubt sie. P2: explizit "keine Policies für client ⇒ fail-closed per Default" dokumentieren (ist implizit durch FORCE RLS ohne Policy — default deny. ok, eigentlich fine). Lassen als P2-Anmerkung oder weglassen.

  15. **Lock-Ordnung**: "Kalender-Mutationen sperren zuerst den Workspace-Kontext (bzw. calendar FOR UPDATE)" — vage ("bzw."). Termin-Mutation: Project FOR KEY SHARE → Calendar FOR KEY SHARE → Appointment. M1-15-Ordnung ohne Calendar war Project → Appointment; jetzt Calendar dazwischen. Deadlock-Risiko bei Auto-Provisionierung (ensure_personal_calendar legt Kalender an = INSERT während Termin-Create?). Termin-Create mit neuem persönlichem Kalender: erst ensure (insert calendar) dann appointment. Konsistent? P2: ensure-Aufruf-Reihenfolge in Lock-Hierarchie festnageln.

  16. **Event-Payload**: calendar.events minimal — ok. `domain_events_calendar_activity_idx` "optional" — Entscheidung offen lassen in Spec ist unsauber; P3/nicht erwähnen oder P2. Eher weglassen (120 Zeilen Limit).

  17. **Header vs §0.1 vs DEC-M115B-11**: wie in #1. Auch: "Basis-Branch: 01b52e9 (M1-12a)" aber baut auf M1-15 (0043) auf — Basis-Branch-Angabe veraltet/inkonsistent: wenn es auf M1-15 aufbaut, ist die Basis M1-15-Branch, nicht M1-12a. P2.

  18. **Status-Zeile**: "DISCOVERED → SPECIFIED · noch nicht CONTRACTED" — Review ist für CONTRACTED-Übergang, ok.

  19. **§6 update_calendar**: "expectedRevision?" optional vs DEC-M115B-15 CAS — Inkonsistenz (Teil von #5).

  20. **RBAC-Matrix vs RLS**: "Admin sieht alle internen Kalender (decided)" — Widerspruch zu §7 Tabelle User=Owner+Admin ok konsistent. Editor sieht eigenen user-Kalender; §3.1 sagt calendar.read Viewer+ — Viewer sieht tenancy, nicht user. ok.

  21. **Termin-DTO**: categoryId entfällt am Termin — M1-15-UI zeigt Kategorie am Termin? M1-15-Kollaps bedeutete Termin trug Kategorie. Jetzt über Kalender — Farb-/Label-Logik: Termin in Kalender ohne Kategorie verliert Kategorie-Anzeige. Fachlich ok.

  22. Testmatrix: Kein Vertragstest `M115B-CONTRACT-02/03` Details? Tabelle listet sie. E2E: "Viewer sieht nur Tenancy-Kalender" ok. Fehlt: RLS-Test User-Scope Fremd-Zugriff (Editor sieht fremden User-Kalender nicht) — RBAC-01/02 referenziert aber Testmatrix-Tabelle RLS-Zeile nennt nur Tenancy + fail-closed; User-Scope-Owner-Test fehlt explizit. P2.

  Priorisieren: P0? Gibt es einen echten P0 (Blocker)? Die revision-Spalte fehlt im Datenmodell während CAS entschieden — das ist ein harter interner Widerspruch, der CONTRACTED blockieren sollte: P1 hoch oder P0? Ich würde sagen: Widerspruch zwischen beschlossenem CAS und Datenmodell = muss vor CONTRACTED gefixt sein, aber ist einfach zu fixen. Kategorie-Backfill-Verlust ist unadressierte Datenverlust-Semantik. Ich tendiere zu GO MIT AUFLAGEN, mit P1-Befunden, kein P0 — oder ein P0? Verdict-Kriterien: P0 = Vertrag bricht/unklar. Der Kategorie-Verlust beim Backfill ist ein unterspezifizierter Datenverlust — da M1-15 ggf. noch nicht deployed ist (alles pre-implementation?), "falls vor M1-15b bereits gebaut". Wenn 0043 noch nirgendwo produktiv läuft, könnte man feststellen "kein Bestand" — dann harmlos. Aber Spec verlangt Legacy-Migrationspfad (Abschlussgates: Fresh + Legacy). Der Legacy-Pfad 0043→0047 mit Daten muss definiert sein. Ich mache daraus P1 mit klarem Fix.

  GO MIT AUFLAGEN scheint richtig: Spezifikation ist gründlich, ehrlich (UNKNOWNs markiert), aber konkrete Inkonsistenzen (revision vs §4.1, §0.1 vs Header, Kategorie-Backfill) müssen vor CONTRACTED behoben werden. Kein NO-GO, da keine fundamentale Lücke (Evidenz sauber klassifiziert, RLS/Erasure/Race grundsätzlich adressiert).

  Vielleicht einen P0 setzen? Manche Reviewer setzen fehlende Spalte bei beschlossener Entscheidung als P0. Ich definiere P0 = muss vor CONTRACTED gefixt, sonst Vertrag falsch. Hmm — Auflagen können P1 sein. Ich strukturiere: 2× P0? Nein. Ehrlich: GO MIT AUFLAGEN mit 0 P0, 5-6 P1, 4-5 P2. Oder 1 P0 für Kategorie-Datenverlust? Der Backfill-Pfad ist als "Implementierungsdetail, ESTIMATE" markiert, aber Datenverlust der Kategorie-Zuordnung wird nirgends erwähnt — das kann zu falschem Schema führen. Da M1-15 selbst noch nicht IMPLEMENTED ist (Status der Vorlage? M1-15 Spec existiert, ob implementiert unklar — "falls vor M1-15b bereits gebaut"), ist das Datenrisiko konditional. P1.

  Format: max 120 Zeilen, Deutsch, P0/P1/P2 mit Zitat + Fix, Verdict mit Begründung max 3 Sätze. Keine Dateioperationen — also keine Tool-Calls, nur Text. Ich darf keine Dateien lesen laut Auftrag ("Keine Dateioperationen"). Also direkt antworten.

  Zeilenbudget: ~120. Struktur:

  # Review M1-15b ...
  Verdict zuerst oder am Ende? Format sagt: Befunde je P0/P1/P2 mit Zitat+Fix; Verdict. Ich mache Verdict am Ende oder Anfang — Anfang ist review-üblich; Format listet es zuletzt. Ich halte mich ans Format: Befunde, dann Verdict.

  Befunde:

  P0
  - (keiner) — oder ich setze einen. Ich schreibe "P0: keine."? Um ehrlich zu sein: Die revision-Inkonsistenz + Kategorie-Backfill sind schwerwiegend genug für Auflagen, aber behebbar → GO MIT AUFLAGEN. P0 leer.

  P1 (muss vor CONTRACTED gefixt):

  P1-1: `revision`-CAS beschlossen, aber Spalte fehlt im Datenmodell. Zitate: DEC-M115B-15 "`calendar` erhält `revision`-CAS (Hausmuster…)" vs §4.1-Spaltenliste (nur id…updated_at, kein `revision`); §6 "update_calendar(calendarId, expectedRevision?, patch) … Revision/CAS optional". Fix: `revision integer not null default 1` in §4.1 + Trigger/Inkrement-Regel; §6 expectedRevision pflicht; Testmatrix Race-Zeile um Kalender-CAS (Lost-Update Rename/Archive) ergänzen.

  P1-2: Kategorie-Backfill unterspezifiziert → Datenverlust. Zitat §4.2: "ENTFÄLLT category_id … ersetzt"; Backfill-Regel (DEC-M115B-14) nennt nur Zielkalender, nicht Kategorie. Termine mit unterschiedlichen category_id je created_by können nicht auf einen Kalender mit einer category_id abgebildet werden. Fix: Backfill-Regel ergänzen (z.B. ein Kalender je (created_by, category_id) oder expliziter ACCEPTED_EXCEPTION-Verlust mit Nachweis, dass 0043-Bestand leer ist); Testfall Legacy-Migration mit Bestandsdaten.

  P1-3: Widerspruch Migrationsnummer: Header/DEC-M115B-11/§15 "0047 … M3-02 rückt auf 0048" vs §0.1 "Die konkrete Migrationsnummer wird daher nicht festgelegt; sie ist eine offene Frage an den Root (O1)". Fix: §0.1 streichen oder auf RESOLVED-Stand ziehen.

  P1-4: Scope-Creep/Unklarheit /calendar-Route: DEC-M115B-13 "Workspaceweite /calendar-Route … ist Teil von M1-15b" vs U3 "Planungsmodus und Wochen-/Tages-/Agenda-Details … nicht spezifiziert" und §10 enthält keine Route-Spezifikation (nur Dialog+Admin). Fix: Route-Umfang in §10 konkretisieren (Ansicht, Scope-Filter „Alle/einzeln", ohne Planungsmodus als Nichtziel) oder eigenen Slice; Abschlussgates/E2E um Route erweitern.

  P1-5: Partial-Unique für Auto-Provisionierung fehlt im Constraint-Katalog. Zitat §6: "Idempotenz über unique(workspace_id, membership_id) auf type='user'" — §4.1 Constraints listen diesen Index nicht. Fix: `calendar_ws_membership_user_uniq` partial unique `(workspace_id, membership_id) where calendar_type='user'` (analog team) in §4.1 aufnehmen; DB-Test Idempotenz/Race für ensure_personal_calendar.

  P1-6? Erasure-Grenze: §9 sagt "Erasure löscht Termine, nicht Kalender" — aber Kalender mit membership_id und evtl. personenbezogenem Namen (Auto-Kalender). Hmm, P2.

  P1-6: Zustandsmaschine vs Validierung: archivierter Kalender + Termin-Create. §10 blendet archivierte nur in der Auswahl aus; §6 create_appointment validiert nur Sichtbarkeit, nicht active. Race-Test existiert ("Kalender-Archivierung vs. paralleler Termin-Create") aber erwartetes Ergebnis nicht spezifiziert. Fix: Regel "create_appointment verlangt active=true" (oder bewusst erlaubt) + Ergebnis des Race (eine Seite gewinnt, welche?) in §6/§9 festlegen. Das würde ich P1 geben? Es ist Race-Semantik unklar → P1. Oder P2. Ich mache P1-6 draus? Platz… 120 Zeilen. Lass mich P1 auf 6 beschränken, P2 ~6.

  P2:
  - P2-1: globaler Name-Unique `unique(workspace_id, lower(btrim(name)))` kollidiert mit Auto-Provisionierung (Namenskonvention für User-Kalender fehlt; zwei gleichnamige Mitglieder). Fix: Namensschema für Auto-Kalender definieren oder Unique auf tenancy-scope beschränken.
  - P2-2: `membership_id … ON DELETE RESTRICT`: Offboarding/Revoke-Pfad unspezifiziert (Membership kann nicht gelöscht werden, solange User-Kalender existiert). Fix: Verhalten bei Membership-Entzug (Kalender archivieren/übertragen) in §5/§7 ergänzen.
  - P2-3: Admin-Sicht auf persönliche Kalender (§7 "User … Owner + Admin") ist datenschutzsensibel (Mitarbeiter-Privatkalender); als DECIDED ok, aber Begründung/DSGVO-Vermerk fehlt. Fix: kurze Datenschutz-Notiz in §7 oder Einschränkung.
  - P2-4: Evidenz-Reproduzierbarkeit: OAS-Quelle `/tmp/reonic-openapi.json` flüchtig, kein Hash/Snapshot-Verweis. Fix: Commit-Hash/Datum oder Ablage des Snapshots (ohne Reonic-Texte? naja OpenAPI ist öffentlich) referenzieren.
  - P2-5: Basis-Branch-Inkonsistenz: Header "Basis-Branch: 01b52e9 (M1-12a)" während "additiv auf M1-15 (0043)" — tatsächliche Basis ist der M1-15-Stand. Fix: korrigieren.
  - P2-6: RLS-Testmatrix: User-Scope-Negativfall (Editor sieht fremden User-Kalender nicht) und team/client-Policies (fail-closed) nicht explizit; Index `domain_events_calendar_activity_idx` "optional" unentschieden. Fix: Testfälle konkretisieren, Index-Entscheidung festnageln.
  - P2-7: Lock-Ordnung "bzw." vage; ensure_personal_calendar-INSERT vs. Termin-Lock-Hierarchie nicht einsortiert. Fix: eindeutige Ordnung.

  Positives kurz: Evidenzklassifikation sauber, UNKs ehrlich, Nichtziele klar, Erasure/RLS/Audit-Grundmuster konsistent, ADR 0025 sauber begrenzt (nur E2).

  Verdict: GO MIT AUFLAGEN. Begründung max 3 Sätze: Keine P0; Evidenz sauber klassifiziert, Sicherheits-/Erasure-Grundgerüst konsistent; aber revision-CAS ↔ Datenmodell-Widerspruch, unterspezifizierter Kategorie-Backfill und §0.1/Header-Widerspruch müssen vor CONTRACTED behoben sein (P1-1…P1-6).

  Zeilen zählen — ich halte mich kompakt, ~110 Zeilen. Zitate kurz. Deutsch. Keine Tool-Calls nötig — "Keine Dateioperationen" heißt: ich soll nichts lesen/schreiben; die Spec ist vollständig im Prompt. Also direkte Antwort ohne Tools.

• # Spec-Review M1-15b + ADR 0025 — Befunde

  Geprüft ohne Dateioperationen, ausschließlich auf Basis der vorgelegten Texte.

  ## P0

  Keine. Das Grundgerüst (Evidenzklassifikation, Scope-Invarianten, RLS-/Erasure-Prinzip, ADR-Begrenzung auf E2) ist tragfähig.

  ## P1 (muss vor CONTRACTED behoben sein)

  **P1-1 — revision-CAS beschlossen, aber im Datenmodell nicht vorhanden.**
  Zitat DEC-M115B-15: „`calendar` erhält `revision`-CAS (Hausmuster; billig, schützt Rename/Archive vor Lost Updates — Root O5)" — doch §4.1 listet die Spalten `id … updated_at` **ohne** `revision`, und §6 relativiert: „Revision/CAS optional — … nur wenn günstig, sonst `updated_at`-basiert → O5". Drei widersprüchliche Stände für denselben Vertrag.
  *Fix:* `revision integer not null default 1` + Inkrement-Regel in §4.1 ergänzen; `update_calendar(calendarId, expectedRevision, patch)` zur Pflicht machen; §6-Relativierung streichen; Race-Test „Kalender-CAS: paralleles Rename/Archive, einer gewinnt mit `conflict`" in §11 aufnehmen.

  **P1-2 — Kategorie-Backfill unterspezifiziert → stiller Datenverlust.**
  Zitat §4.2: „**ENTFÄLLT** `category_id` … wird durch `calendar→category` ersetzt". DEC-M115B-14 regelt nur den Zielkalender („persönlicher Kalender des `created_by`, sonst Unternehmenskalender"), nicht die Kategorie. Bestands-Termine desselben `created_by` mit **unterschiedlichen** `category_id`-Werten können nicht verlustfrei auf einen Kalender mit genau einer `category_id` abgebildet werden — die Spec benennt diesen Verlust weder als ACCEPTED_EXCEPTION noch löst sie ihn.
  *Fix:* Backfill-Regel präzisieren (z. B. ein Kalender je `(created_by, category_id)`, oder expliziter DEC-Eintrag „Kategorie-Zuordnung der Bestands-Termine verwirft sich", begründet durch nachgewiesen leeren 0043-Bestand); Legacy-Migrationstest mit Bestandsdaten (≥2 Kategorien je Creator) in §11 ergänzen.

  **P1-3 — Widerspruch Migrationsnummer.**
  Zitat Header/DEC-M115B-11/§15: „`0047_m1_15b_calendar_scopes.sql` … M3-02 rückt auf `0048` … RESOLVED" — vs. §0.1: „Die konkrete Migrationsnummer wird daher **nicht** festgelegt; sie ist eine offene Frage an den Root (O1)". §0.1 ist veraltet und widerspricht dem Rest des Dokuments.
  *Fix:* §0.1 löschen oder auf den RESOLVED-Stand (0047, nach M3-Welle) ziehen.

  **P1-4 — Scope der `/calendar`-Route inkohärent.**
  Zitat DEC-M115B-13: „Workspaceweite `/calendar`-Route („Alle/vier Kalender", Planungsmodus) ist **Teil von M1-15b**" — vs. U3: „„Planungsmodus" und Wochen-/Tages-/Agenda-Details … nicht auswertbar beobachtet, nicht spezifiziert" — und §10 spezifiziert nur Termin-Dialog + Admin-Verwaltung, keine Route. Eine unspezifizierte Route ist im Slice, ihr Kernfeature ist zugleich UNKNOWN.
  *Fix:* Route-Umfang in §10 konkret festlegen (Monatsansicht mit Scope-Filter „Alle/einzeln", Kalender-Einfärbung; Planungsmodus explizit Nichtziel) oder Route abspalten; §11 um E2E/A11y für die Route erweitern.

  **P1-5 — Idempotenz-Constraint der Auto-Provisionierung fehlt im Schema.**
  Zitat §6: „`ensure_personal_calendar` … Idempotenz über `unique(workspace_id, membership_id)` auf `type='user'`" — §4.1 Constraints/Indexe enthalten diesen (partialen) Unique-Index nicht; ohne ihn ist die 1:1-Invariante racy nicht durchsetzbar.
  *Fix:* `calendar_user_membership_uniq` als partial unique `(workspace_id, membership_id) WHERE calendar_type='user'` (analog `team`) in §4.1 aufnehmen; DB-/Race-Test „zwei parallele `ensure_personal_calendar`-Aufrufe → genau ein Kalender".

  **P1-6 — Archivierungs-Race ohne definiertes Ergebnis.**
  §11 nennt „Kalender-Archivierung vs. paralleler Termin-Create" als Testfall, aber §6/§9 definieren die Erwartung nicht: `create_appointment` validiert nur Sichtbarkeit („muss für den Actor sichtbar sein"), nicht `active=true`; §10 blendet Archivierte nur clientseitig aus.
  *Fix:* Serverregel festlegen (Empfehlung: Create auf `active=false` → `conflict` bzw. `invalid`; im Race gewinnt die Archivierung) und in §6/§9 + Testmatrix verankern.

  ## P2 (sollte vor RED adressiert werden)

  **P2-1 — Globaler Namens-Unique vs. Auto-Provisionierung.**
  Zitat §4.1: „`unique(workspace_id, lower(btrim(name)))` (Namensduplikat je Workspace)". Kein Namensschema für Auto-User-Kalender definiert; zwei gleichnamige Mitglieder oder ein persönlicher Kalender „Allgemein" neben dem Unternehmenskalender „Allgemein" kollidieren.
  *Fix:* Namenskonvention für Auto-Kalender (z. B. „Persönlich — <Membership-Anzeigename>") definieren oder Unique auf manuell verwaltete Scopes beschränken.

  **P2-2 — Offboarding-Pfad blockiert.**
  Zitat §4.1: „`foreignKey (workspace_id, membership_id) → membership … ON DELETE RESTRICT`". Bei Membership-Entzug (revoked) blockiert der persönliche Kalender jede Membership-Löschung; Verhalten (archivieren? übertragen?) unspezifiziert.
  *Fix:* Regel in §5/§7 ergänzen (z. B. Revoke ⇒ User-Kalender `active=false`, Owner-Feld bleibt historisch).

  **P2-3 — Admin-Sicht auf persönliche Kalender ohne Datenschutz-Vermerk.**
  Zitat §7: „`user` (persönlich) | Owner (`membership_id`) + Admin". Admin-Lesezugriff auf Mitarbeiter-Privatkalender ist beschäftigtendatenschutzrechtlich sensibel; als DECIDED zulässig, aber unbegründet.
  *Fix:* Kurze Begründung + DSGVO-Hinweis in §7, oder Einschränkung auf Metadaten.

  **P2-4 — Erasure-Grenze formal sauber, aber Personenbezug am Kalender unkommentiert.**
  `membership_id` und ggf. personenbezogener Auto-Kalender-Name liegen außerhalb des `ErasureGraphIds`; die Begründung „workspace-Stammdaten ohne Kontakt-PII" (§9) greift für den User-Scope nur teilweise. Konsistent zur Kontakt-Erasure, aber lückenhaft für User-Löschung.
  *Fix:* Ein Satz in §9: Kontakt-Erasure unberührt (korrekt), User-/Membership-Löschung folgt dem Offboarding-Pfad (P2-2).

  **P2-5 — Evidenz-Reproduzierbarkeit.**
  Zitat Quellenlegende: „`/tmp/reonic-openapi.json` … neu geladen per `curl -sL …`" — flüchtiger Pfad, kein Datum/Hash des Snapshots; §2.1-Feldtabelle ist so nicht nachprüfbar.
  *Fix:* Abrufdatum + Version (`3.11.0`) als Beleg vermerken oder Snapshot-Referenz in `docs/parity/` (inventarisiert, ohne Textübernahme).

  **P2-6 — Kleinere Inkonsistenzen/Offenheiten.**
  (a) Header „Basis-Branch: `01b52e9` (M1-12a)" widerspricht „baut **additiv** auf M1-15 auf" — tatsächliche Basis ist der M1-15-Stand. (b) RLS-Matrix (§11) testet User-Scope-Negativfall („Editor sieht fremden User-Kalender **nicht**") und client-fail-closed nicht explizit. (c) §8: Index `domain_events_calendar_activity_idx` „optional" — unentschieden. (d) §9 Lock-Ordnung „(bzw. `calendar` `FOR UPDATE`)" vage; Einsortierung des `ensure_personal_calendar`-Inserts in die Hierarchie fehlt.
  *Fix:* (a) korrigieren; (b) zwei Testfälle ergänzen; (c) Entscheidung festnageln; (d) eindeutige Ordnung formulieren.

  ## Positiv (kurz)

  Evidenzdisziplin vorbildlich (UNKNOWN/INFERRED ehrlich markiert, U1–U3 offen statt erfunden); Nichtziele scharf (Client/F10, Sync, Vorlagen); ADR 0025 supersedet sauber nur E2 und lässt M1-15/0043 unberührt; Scope-Invarianten-CHECKs, RESTRICT auf Termin-FK, Erasure-Trennung Kalender/Termine und Event+Audit-in-Tx sind konsistent zum Hausmuster.

  ## Verdict: GO MIT AUFLAGEN

  Keine P0-Befunde; Evidenz-, Sicherheits- und Integritätsgerüst (RBAC je Scope, FORCE-RLS, Erasure-Grenze, Termin-CAS) sind vertragsfähig. Vor CONTRACTED müssen jedoch die sechs P1-Auflagen erfüllt sein — insbesondere der revision-CAS↔Datenmodell-Widerspruch (P1-1), der unterspezifizierte Kategorie-Backfill mit Datenverlust-Risiko (P1-2) und der §0.1-Widerspruch (P1-3). P2-Punkte sind bis RED nachzuziehen; danach steht dem CONTRACTED-Übergang nichts im Weg.

To resume this session: kimi -r session_7840465f-317b-41e9-9290-a29c0b28fe3a
