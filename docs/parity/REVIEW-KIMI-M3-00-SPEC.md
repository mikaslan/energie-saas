kimi version 0.40.1
• The user wants a spec review of M3-00 slice spec + ADR 0024. No file operations — everything is in the prompt. I need to produce findings P0/P1/P2 with quotes + concrete fixes, and a verdict GO / GO MIT AUFLAGEN / NO-GO, in German, max 120 lines.

  Let me carefully analyze the spec for issues.

  Key areas to check:

  1. **Parity/evidence gaps (OBSERVED vs DECIDED vs ESTIMATE separation)**

  Looking for inconsistencies:
  - §2 Gap says: "konkrete Feldnamen, Validierungen, Nummernformate und Textvorlagen-Inhalte wurden **nicht ausgewertet** (`PDEEP` §7 „OFFEN“)". But §13 UNKNOWN 1 says field names ARE OBSERVED from `M3-UNKNOWN-RECON.md` §1a–1c. And §4 Datenmodell marks many fields as OBSERVED ("Name des Unternehmens", "Email", "Behörde", "USt-IdNr.", "Land", "Buchhaltungsmethode", "Name des Kontoinhabers", "BIC / SWIFT"). This is a contradiction between §2 ("nicht ausgewertet", "UNKNOWN") and §4/§13 (OBSERVED via M3-UNKNOWN-RECON). §2 seems stale — it references PDEEP §7 "OFFEN" but the recon doc has since provided the field names. Also §2 Gap says "Exakte Reonic-Nummernformate/-Präfixe ... sind UNKNOWN" but §12 DECIDED 4 says they're RESOLVED/OBSERVED. So §2 is stale relative to the rest. P1 finding: evidence classification contradiction.

  - M300-02 Confidence says "OBSERVED (Formate/Labels)". But the OBSERVED formats include German template strings like `Rechnung-{YEAR}-{MONTH}-{NUMBER}` — using Reonic's default template strings as our defaults. Clean-room says "keine Reonic-Texte/Assets". Is copying a template string like "Rechnung-{YEAR}-{MONTH}-{NUMBER}" a Reonic-Text? It's arguably a functional format, and "Rechnung" is a generic German word. But the user prompt says "keine Reonic-Texte/Assets" — the template literal strings could be considered text snippets from Reonic UI. This is a borderline point worth flagging as P2 (clean-room hygiene: mark as OBSERVED-derived defaults, confirm "Rechnung-" prefix is generic enough; or note license-mode implication). Actually DECIDED 4 explicitly supersedes own prefixes RE/GU/... with OBSERVED ones. The strings "Rechnung" and "Abschlagsrechnung" are generic German business terms, not distinctive creative text. CRN/OFC/PO/DN/LE are functional codes. I'd flag as P2 for explicit clean-room justification.

  2. **Security/integrity contract**

  - DTO-Minimierung: `getInvoicingSettings` returns DTO without companyTaxId/paymentIban unless Issuing-Details-Berechtigung. OK. But note: `invoicing.write` vs "Issuing-Details-Berechtigung" — the relationship is fuzzy. M300-01 says Berechtigung: `invoicing.write` + Issuing-Details-Berechtigung. §5 says full DTO "nur bei Issuing-Details-Berechtigung". Is Issuing-Details-Berechtigung a separate permission from invoicing.read/write? M3-01 §10 defines it apparently. There's a spec dependency: M3-00 references M3-01 §10 for the permission that gates its own DTO. Circular/forward dependency — M3-00 is the precondition for M3-01, but its security model depends on a permission defined in M3-01 spec. Worth flagging P1: the permission `invoicing.issuing_details` (or however named) must be defined in M3-00's own contract or explicitly imported, otherwise CONTRACTED can't pin the schema/role checks. Also the Rollenprobe "88/88 + neue Blöcke" — needs the new permission in the role matrix.

  - Singleton race: addressed via PK + idempotent retry. OK.

  - revision-CAS: `upsertInvoicingSettings(workspaceId, input, baseRevision)` — Insert when missing. Race: two concurrent inserts → unique_violation → retry as update with CAS. Fine.

  - Number format table has no `revision` — concurrent upserts of number formats: last-write-wins, no CAS. §8 says "getrennte Zeilen, kein gemeinsamer Lock nötig". But lost-update on formatTemplate per type is possible. Minor — P2 (either accept last-write-wins explicitly or add revision/updatedAt CAS).

  - §5 Command signature mismatch: `upsertNumberFormat(workspaceId, type, prefix, padding)` — but the data model (§4) has `formatTemplate`, not prefix/padding! This is a leftover from the old RE/GU prefix/padding design (DECIDED 4 superseded prefix+padding with templates). Test matrix M300-02 also says "Präfix-Regex; Padding 1–9" — stale from the superseded design. This is a real internal inconsistency: P1 (contract-level: API signature contradicts data model and DECIDED 4). Also M201 reference `offer_number_series` (prefix/padding/seriesYear) as "Nummernserien-Muster" is now misleading since the new model is template-based.

  - §4 counter: "nur M3-01 inkrementiert (M3-00 setzt/liest, kein manueller Reset)". But M3-01 seeding contract says M3-01 renders from `commercial_document_number_series`... wait: "Seeding-Vertrag M3-01: `commercial_document_number_series` rendert die Belegnummer ... aus `workspace_document_number_format.formatTemplate` ... `{NUMBER}` = fortlaufender `counter`". Which counter — the one in workspace_document_number_format or one in commercial_document_number_series? Ambiguous: two tables named. If M3-01 has its own series table (commercial_document_number_series) and M3-00's format table also has a counter, there's ambiguity about which counter is authoritative. Also concurrency: counter increment in M3-01 needs SELECT ... FOR UPDATE or atomic UPDATE ... RETURNING; not M3-00's problem but the contract handoff should be pinned. P1 or P2. I'd say P1 because M3-00 defines the counter column and its ownership; ambiguity between "counter in workspace_document_number_format" vs series table in M3-01 must be resolved before CONTRACTED since M3-01 builds directly on it.

  Also: counter semantics with {YEAR}/{MONTH} in template — does the counter reset per year/month? Template includes YEAR/MONTH; typically numbering restarts per period. Spec doesn't define whether counter is global-monotonic or per-period. GoBD requires lückenlose, einmalige Nummern; if format has {YEAR} but counter never resets, uniqueness is still fine but conventions differ; if user expects yearly reset, duplicates could arise if counter resets while template lacks YEAR? Actually if counter resets per year but template lacks {YEAR}, duplicates occur. Validation allows templates without {YEAR} (only {NUMBER} required). If counter is per-workspace-per-type global, then no duplicates ever — fine. But spec should state counter is global per (workspace,type), never resets, to guarantee uniqueness. P1/P2. I'll fold into the counter finding.

  - Precondition gate M300-04: checks Pflichtfelder; DECIDED 11 says non-DE country blocks money documents fail-closed. But M300-04's Validierungen list doesn't mention the country gate (only Pflichtfelder + IBAN). §4 accountingMethod note mentions cash-method note for DE/FR/CH/UK. Inconsistency: the Land-Gate (O4/DECIDED 11) is a DECIDED behavior of the gate but missing from M300-04 capability + test matrix (test matrix M300-04 only tests "vollständig → ok; fehlende Pflichtfelder → PreconditionConflict; Geld vs. Brief (IBAN)" — no country test). P1: DECIDED 11 not reflected in capability/test matrix. Also wait — is DECIDED 11 consistent with F8.2 which lists DE/AT/CH/FR/UK/Jersey as allowed countries for money documents? MODKAT says gates: Länder (DE/AT/CH/FR/UK/Jersey for Geld-Dokumente). DECIDED 11 says non-DE blocks money issuance until tax slice. That means F8.2's multi-country support is effectively deferred — spec should mark the country list beyond DE as ESTIMATE/Non-Goal-forward-reference. Non-Goals mention "Mehrstaatliche Steuersatzlogik" as Non-Goal, which aligns. But then why is accountingMethod cash-note specified for DE/FR/CH/UK when non-DE can't issue money documents anyway? Minor inconsistency — the cash note applies to FR/CH/UK which can't issue. P2.

  - CHECK `companyCountry in ('DE','AT','CH','FR','UK','JE')` — 'UK' vs ISO 'GB'; Jersey 'JE' is ISO-3166 alpha-2, but 'UK' is not ISO (GB is). Mixed coding. Minor P2 — decided format is fine as DECIDED but note ISO exception reservation (UK is exceptionally reserved in ISO 3166-1, so it's acceptable). Probably skip or P2.

  - `companyEmail` is `not null` OBSERVED Pflicht — but M300-04's gate validation list doesn't include companyEmail. Not necessarily a problem (gate checks legal completeness), but companyEmail NOT NULL means the singleton can't exist without email, so gate fine. But note: M300-01 Eingabefelder lists "Firmenname (Pflicht), ... Steuernummer/USt-ID (optional), Adresse..., Land (Pflicht), Kontoinhaber/IBAN/BIC (Pflicht für Geld-Dokumente)" — companyEmail missing from M300-01 field list though it's NOT NULL in §4! Inconsistency between capability M300-01 and data model: email is required in DB but absent from capability fields and from gate checks. P1.

  - Also `companyLegalForm` vs `companyAuthority` renaming: "companyLegalForm text nullable (1–80) — OBSERVED „Behörde“ (Bezeichnung der zuständigen Behörde; nicht „Rechtsform“ — Feldname angepasst: `companyAuthority`)". Confusing: column listed as `companyLegalForm` but note says renamed to `companyAuthority`. Which is it? Must be pinned before CONTRACTED. P1 (schema ambiguity). Also M300-01 lists "Rechtsform (optional)" — OBSERVED says it's actually "Behörde", so the capability field "Rechtsform" contradicts §4 note. Same finding.

  - accountingMethod: OBSERVED with German labels "Periodengerecht"/"Zahlungsbasiert" — using observed labels is fine as paraphrase? These are generic accounting terms. OK.

  - IBAN validation "1–34" — too weak; IBAN has country-specific length and checksum (MOD97). DECIDED validations are ESTIMATE; but for money documents an invalid IBAN passes. P2: add MOD97 checksum validation as DECIDED or defer explicitly. Also BIC 8–11: BIC is 8 or 11, not 9/10 — CHECK should be `char_length in (8,11)`. P2.

  - `paymentAccountHolder`/`paymentIban`/`paymentBic` "gemeinsam null oder vollständig" — CHECK ensures all-or-nothing. But gate requires IBAN for money documents; if holder+IBAN+BIC must all be set together, fine. But BIC is optional in SEPA (since 2016 BIC not required for SEPA transfers). Requiring BIC when IBAN set might be stricter than needed. Minor P2 — skip maybe. Actually the CHECK says all three together null or complete, meaning BIC mandatory with IBAN. For SEPA, BIC is optional. Flag as P2.

  - DTO-Minimierung: `paymentBic` not listed as sensitive? BIC without IBAN is harmless. companyTaxId/paymentIban minimized — fine. But `getNumberFormats` etc. fine.

  - Audit: M300-04 rejections audited with allowed=false — good. But who is the actor for issueDocument precondition failures — fine.

  - §6 Erasure: claims workspace master data are "keine Kontakt-PII". But `paymentAccountHolder` name and `companyEmail` could be personal data for sole proprietors (Einzelunternehmer). DSGVO applies to personal data of sole traders. The claim "Firmendaten, keine Kontakt-PII → kein Erasure-Eintrag" is legally shaky for sole proprietors where the account holder name = natural person. DECIDED 7. This deserves a P1 or P2: at minimum document the risk / require legal sign-off; the workspace is the tenant, erasure at workspace lifecycle, but DSGVO Auskunft/Löschung could still apply. I'd flag P1 or strong P2. Given it's a spec for invoicing data with GoBD retention obligations (retention overrides erasure during retention period, Art. 17(3)(b)), it's defensible, but the blanket "keine PII" claim should be qualified. P2 with fix: qualify statement + note GoBD retention vs. erasure conflict handled in retention slice. I'll make it P2.

  3. **Migration/integration risks (0045, additive chain)**

  - Migration 0045 reserved at root; additive. Risks: RLS policies on new tables must be in same migration (pattern from earlier migrations 0008 site_rls etc.). Spec says "Policies nach Muster der verifizierten RLS-Kern-Rollen; Rollenprobe erweitert (88/88 + neue Blöcke)". OK. 
  - Seed data: 6 default format rows per workspace — when are they inserted? Lazy on first read? Migration backfill for existing workspaces? Spec doesn't say: are existing workspaces backfilled with default settings/number formats in 0045, or lazily created on first access? "Empty" UI state "noch keine Stammdaten" suggests lazy for settings. For number formats, defaults are OBSERVED strings — are the 6 rows pre-seeded per workspace or only created when user edits? §4 lists "Defaults (OBSERVED...)" — ambiguous whether DB DEFAULT or app-level seed. M3-01 seeding contract depends on rows existing. P1: seeding/backfill strategy for existing + new workspaces undefined (lazy vs. migration backfill vs. insert-on-workspace-create), affects M3-01 rendering.

  - `counter` bigint default 0 — counter ownership, covered above.

  - Drizzle schema-hash pinning at CONTRACTED — fine.

  - Migration chain: 0045 additive, M3-01 0046 — no overlap risk noted; fine.

  4. **Test matrix completeness**

  - Missing tests: (a) Land-Gate non-DE block (DECIDED 11) — missing in M300-04 row. (b) Template validation tests: unknown placeholder rejection, {NUMBER} required, duplicate date placeholders rejected, max length 120 — partially covered ("Präfix-Regex" is stale/wrong). (c) DTO-Minimierung exists. (d) Counter read-only in M3-00 (no manual reset) — no test. (e) Email CHECK validation — no test (email not even in capability). (f) accountingMethod enum + cash note behavior (M3-01) — note is M3-01's; enum test missing. (g) Singleton unique violation retry — covered in Race. (h) Migration backfill/idempotent — "frisch + idempotent + Legacy-Upgrade-Pfad" mentioned. OK.
  - Test matrix M300-02 mentions "Padding 1–9" — stale from superseded prefix/padding design (DECIDED 4). P1 together with the API signature mismatch.

  5. **Scope creep/discipline**

  - accountingMethod cash-note for M3-01 invoices: specifying M3-01 behavior ("bei cash ergänzt M3-01 die Notiz ... in Rechnungen/Teilrechnungen/Gutschriften — DE/FR/CH/UK") is forward-spec inside M3-00; borderline scope creep into M3-01's rendering. P2: move to M3-01 spec or mark as handoff note only.
  - Teilrechnungs-Format `Abschlagsrechnung-{YEAR}-{MONTH}-{NUMBER}` "wird für den Teilrechnungs-Folgeslice mitgeführt" — but type CHECK has only 6 types; where is the Teilrechnung template stored? "mitgeführt" in spec but no 7th type value. If M3-01 Non-Goal, carrying the observed string is documentation only — fine, but ensure it doesn't sneak into CHECK. Actually it's fine as documentation. Minor.
  - Textvorlagen as disabled placeholder in UI — arguably scope creep to render a disabled group; but marked Non-Goal; fine as placeholder. Skip.

  Also §0 sources: spec cites `M3-UNKNOWN-RECON.md` for OBSERVED formats — user says evidence comes from that recon doc with 4 sub-tabs and number templates. Spec mentions "Unter-Tab „Zahlenkreise“, tab=number-circles — OBSERVED via M3-UNKNOWN-RECON.md §1d" — 4 sub-tabs mentioned by user; spec references issuing-details + number-circles. Fine.

  - §2 says "Exakte Reonic-Nummernformate/-Präfixe und die exakte Aufbewahrungsfrist sind UNKNOWN" — stale (contradicts DECIDED 4 / §13 UNKNOWN 2 struck through). Already covered in finding 1 (stale §2).

  - DECIDED 12 vs DECIDED 4 duplication (both about OBSERVED formats superseding RE/GU). Redundant entries 4 and 12 (Root O5) — editorial duplication; P2. Also §14 O5 says "RESOLVED → dokumenttyp-eigene Prefixe RE/GU/AB/BE/LS/BR" — that contradicts DECIDED 4/12 which say OBSERVED formats REPLACE RE/GU! §14 O5 text is stale (it describes the OLD resolution before Root O5 was superseded). DECIDED 12 says "Root O5 superseded". So §14 O5 resolution text is directly contradictory. P1: §14 O5 must be updated to reflect supersession, otherwise a reader sees conflicting resolutions.

  Wait, let me re-read: "## 12. DECIDED ... 12. **OBSERVED-Formate statt eigener Prefixe** (Root O5 superseded): ... nutzt ab sofort die OBSERVED-Templates". And §14: "5. **O5 — Nummernserien-Default:** RESOLVED → dokumenttyp-eigene Prefixe `RE/GU/AB/BE/LS/BR`; `offer_number_series` (ANG) unangetastet." Yes — direct contradiction between §12.12 and §14.5. P1.

  - §5 `getInvoicingSettings` returns DTO minimized "nur bei Issuing-Details-Berechtigung vollständig" — but M300-01 write requires invoicing.write + Issuing-Details-Berechtigung; viewer with invoicing.read gets minimized DTO. Can someone with invoicing.write but WITHOUT Issuing-Details-Berechtigung write taxId/IBAN but not read them back? M300-01 says write needs both; §6 Rechte says invoicing.write = Editor+/Admin mit Invoicing-Recht. The permission model is unclear: is "Issuing-Details-Berechtigung" = "Invoicing-Recht"? Terminology: F8.2 "Rolle Editor + Invoicing-Recht"; M301 §10 "Issuing-Details-Berechtigung". Spec uses both interchangeably without defining the mapping. P1 (permission term undefined in this slice; must pin permission key name for CONTRACTED + Rollenprobe).

  - Precondition gate audit: "Ablehnung als audit_log allowed=false" with resource 'document.issue' — resource naming in M3-00 for an M3-01 action; fine.

  - §7 events: number_format.updated only — no .created for formats (first upsert creates row). Minor P2: created/updated distinction for number formats.

  - Migration naming: `0045_m3_00_workspace_master_data.sql` — drizzle migrations in repo have names like 0008_site_rls.sql; fine.

  - UI route German `/einstellungen/rechnungsstellung` vs existing app routes? Can't verify without file ops; skip.

  - Empty state text "Für die Rechnungsausstellung erforderlich" — own text, fine.

  - §10 gates: "db:roles:verify 88/88 + PG18 5/5" — consistent with repo scripts (db-role-contract.mts). Fine.

  - M300-03 audit: "(in workspace_invoicing_settings.updated)" fine.

  - revision CHECK >= 1 with default 1; CAS update increments. Insert with baseRevision? upsert signature includes baseRevision for insert case — should be ignored/absent on insert; define behavior when row doesn't exist and baseRevision provided (treat as insert regardless? conflict?). P2: pin insert-vs-CAS semantics.

  - Also `upsertNumberFormat(workspaceId, type, prefix, padding)` — besides template mismatch, there's no concurrency control for format updates (no revision). Last-write-wins should be explicit DECIDED. P2.

  - One more: §4 "6 Zeilen je Workspace" and CHECK type 6 values — invoice, credit_note, order_confirmation, purchase_order, delivery_note, letter. But M300-02 variants list Rechnung/Gutschrift/Auftragsbestätigung/Bestellung/Lieferschein/Brief — consistent 6. Good. The "Hinweis Typanzahl" explains 7 vs 6. Good.

  - `{MONTH}`/`{DAY}` zero-padding semantics unspecified (09 vs 9?). Rendering is M3-01, but template semantics should be pinned at least as ESTIMATE. P2 maybe. Skip or fold.

  - Country 'UK' for money documents + GoBD retention default 10 years — German-centric; fine as DECIDED.

  Priority assignment:
  P0: none? Check for any P0... A P0 would be a blocker like security hole or parity violation. The contradictions are significant but fixable editorially; the permission dependency is the biggest. DTO minimization is specified. RLS specified. I'd say no P0, but let me double-check security: paymentIban stored plaintext, DECIDED 10 defers field-level encryption to SECURITY slice — documented, owner-accepted (Root O3). Fine.

  Actually one more potential P0/P1: §4 companyTaxId marked "OBSERVED „USt-IdNr.", sensitive" but M300-01 field list says "Steuernummer/USt-ID (optional)" — Steuernummer vs USt-IdNr are different fields in German law; §4 has only companyTaxId. OBSERVED lists "USt-IdNr" — fine, one field. But M300-01 says "Steuernummer/USt-ID" implying maybe two. Minor; fold into email/field-list inconsistency finding (capability field list out of sync with §4 model: email missing, Rechtsform mislabeled, Steuernummer/USt-ID ambiguous).

  Verdict: GO MIT AUFLAGEN — the contradictions are fixable without redesign; no P0. Conditions: fix stale §2/§14 O5, align §5 signatures + test matrix with template model, pin counter semantics + seeding/backfill, define Issuing-Details-Berechtigung mapping, add Land-Gate + email to capability/tests.

  Format: max 120 lines, German, P0/P1/P2 each with quote + concrete fix, verdict with max 3 sentences justification. No file operations — pure review. Let me write it.

  Line budget: aim ~100-115 lines.

• # Review M3-00 (Spec + ADR 0024) — Befunde auf dem Weg zu CONTRACTED

  ## P0 — keine

  Keine blockierenden Sicherheits- oder Paritätsverstöße. Die Architektur (Singleton + Kind-Tabelle, revision-CAS, DTO-Minimierung, fail-closed Gate) ist tragfähig; ADR 0024 ist sauber begründet.

  ## P1

  **P1-1 — Widerspruch §14 O5 vs. §12 DECIDED 4/12 (Nummernserien).**
  §14.5: „O5 — Nummernserien-Default: RESOLVED → dokumenttyp-eigene Prefixe `RE/GU/AB/BE/LS/BR`" — §12.12 sagt dagegen: „OBSERVED-Formate statt eigener Prefixe (Root O5 superseded)". Beides steht unaufgelöst im selben Dokument.
  Fix: §14.5 als superseded markieren und durch den OBSERVED-Template-Entscheid (§12.4/12) ersetzen; Redundanz DECIDED 4 ↔ 12 zusammenführen.

  **P1-2 — §5-API-Signatur und Testmatrix widersprechen dem Template-Datenmodell.**
  §5: „`upsertNumberFormat(workspaceId, type, prefix, padding)`" — §4 modelliert aber `formatTemplate`; Testmatrix M300-02 prüft „Präfix-Regex; Padding 1–9". Beides ist Rest des verworfenen Präfix/Padding-Designs; auch die Quellenangabe `M201` (`offer_number_series`, prefix/padding/seriesYear) als „Nummernserien-Muster" ist damit irreführend.
  Fix: Signatur auf `(workspaceId, type, formatTemplate)` ändern; Testmatrix auf Template-Validierung umstellen (`{NUMBER}` Pflicht, unbekannte Platzhalter, doppelte Datums-Platzhalter, Länge 1–120); M201-Verweis streichen oder als „nicht maßgeblich" kennzeichnen.

  **P1-3 — Counter-Semantik und Seeding-Vertrag zu M3-01 ambig.**
  §4: „`counter` … **nur M3-01 inkrementiert**" und zugleich „`commercial_document_number_series` rendert … `{NUMBER}` = fortlaufender `counter`" — unklar, welcher Zähler (Format-Tabelle vs. M3-01-Serien-Tabelle) führt. Zusätzlich undefiniert: Reset-Verhalten (pro Jahr/Monat oder global monoton?) und Seeding der 6 Format-Zeilen (Migration-Backfill für Bestands-Workspaces? Lazy bei erstem Zugriff? Insert bei Workspace-Anlage?). `{MONTH}`/`{DAY}`-Padding (9 vs. 09) ist ebenfalls offen.
  Fix: Vor CONTRACTED festlegen — empfohlen: counter global pro `(workspaceId, type)`, nie zurückgesetzt (GoBD-Eindeutigkeit), atomares Inkrement per `UPDATE … RETURNING` in M3-01; Seeding-Strategie (Backfill in 0045 vs. Lazy) explizit als DECIDED aufnehmen; Platzhalter-Rendering-Semantik zumindest als ESTIMATE pinnen.

  **P1-4 — „Issuing-Details-Berechtigung" ist in M3-00 nicht definiert.**
  M300-01 verlangt „`invoicing.write` + Issuing-Details-Berechtigung", §5 DTO-Minimierung hängt daran, M300-04 referenziert „M3-01 §10". Der Slice, der VOR M3-01 liegt, hängt sicherheitskritisch an einer erst in M3-01 definierten Permission; das Verhältnis zu „Invoicing-Recht" (F8.2) bleibt ungeklärt. Ohne Permission-Key kann weder das Schema noch die erweiterte Rollenprobe („88/88 + neue Blöcke") gepinnt werden.
  Fix: Permission-Key (z. B. `invoicing.issuing_details.write`) in M3-00 selbst definieren inkl. Rollen-Mapping (Admin/Editor+Invoicing-Recht) und als Vertrag für M3-01 exportieren.

  **P1-5 — Land-Gate (DECIDED 11) fehlt in Capability und Testmatrix.**
  DECIDED 11: „Nicht-DE-Land blockt Geld-Ausstellung fail-closed … `letter` bleibt möglich". M300-04 „Validierungen" nennt nur Pflichtfelder + IBAN; Testmatrix M300-04 prüft nur „vollständig → ok; fehlende Pflichtfelder; Geld vs. Brief" — kein Länderfall. Ein DECIDED-Verhalten ohne Capability-/Testanker.
  Fix: M300-04 um „`companyCountry` ≠ DE → `PreconditionConflict` für Geld-Dokumente" ergänzen; Testfälle DE-Rechnung ok / AT-Rechnung blockiert / AT-Brief ok hinzufügen.

  **P1-6 — Feldliste M300-01 ungleich Datenmodell §4.**
  §4 verlangt `companyEmail` **not null** (OBSERVED Pflicht), M300-01 listet kein E-Mail-Feld; §4 benennt `companyLegalForm` um in „`companyAuthority`" (OBSERVED „Behörde"), lässt aber den alten Spaltennamen stehen, während M300-01 „Rechtsform (optional)" führt; „Steuernummer/USt-ID" (M300-01) vs. nur `companyTaxId` (§4). Welcher Spaltenname und welche Felder gelten, ist vor dem Schema-Pinning unklar.
  Fix: §4-Spaltenname final auf `companyAuthority` setzen; M300-01 um E-Mail (Pflicht) ergänzen, „Rechtsform" durch „Behörde" ersetzen, Steuerfeld eindeutig benennen; E-Mail-CHECK in Testmatrix aufnehmen.

  ## P2

  **P2-1 — §2 Gap-Analyse stale.**
  §2: Nummernformate „UNKNOWN", Feldnamen „nicht ausgewertet (`PDEEP` §7 OFFEN)" — während §4/§13 dieselben Felder als OBSERVED via `M3-UNKNOWN-RECON.md` §1a–1d führen.
  Fix: §2 aktualisieren (Felder OBSERVED, nur Validierungsregeln UNKNOWN/ESTIMATE; Formate RESOLVED).

  **P2-2 — IBAN/BIC-Validierung fachlich schwach.**
  „IBAN-Format 1–34" lässt ungültige IBANs durch; „BIC 8–11" erlaubt Länge 9/10; CHECK „Zahlungsdaten gemeinsam null oder vollständig" macht BIC zwingend, obwohl SEPA BIC-frei ist.
  Fix: MOD-97-Prüfung + länderspezifische Länge als DECIDED (Service-Ebene), BIC-CHECK `in (8,11)` und optional.

  **P2-3 — Erasure-Begründung zu pauschal.**
  §6: „Firmendaten, keine Kontakt-PII" — bei Einzelunternehmern sind `paymentAccountHolder`/`companyEmail` sehr wohl personenbezogen.
  Fix: Aussage qualifizieren (GoBD/AO-§147-Aufbewahrung vs. Art.-17-Ansprüche, Verweis auf Retention-Folgeslice), DECIDED 7 entsprechend nachschärfen.

  **P2-4 — Inkonsistenz cash-Methode vs. Land-Gate.**
  §4: cash-Notiz „in Rechnungen … DE/FR/CH/UK" — DECIDED 11 blockiert aber genau diese Nicht-DE-Ausstellung; die Notiz-Spezifikation gehört zudem in M3-01 (Rendering), nicht M3-00.
  Fix: Notiz auf DE einschränken bzw. als Handoff-Hinweis nach M3-01 verschieben.

  **P2-5 — Clean-Room-Vermerk zu OBSERVED-Default-Strings.**
  Templates wie `Rechnung-{YEAR}-{MONTH}-{NUMBER}` werden als Defaults übernommen; Begriffe sind generisch-funktional, aber der Lizenz-Modus verlangt die Begründung explizit.
  Fix: Ein Satz in §0/DECIDED 4: Strings sind funktionale Platzhalter-Schemata mit generischen Fachbegriffen, keine Reonic-Textübernahme.

  **P2-6 — Kleinigkeiten.**
  `workspace_document_number_format` ohne `revision` → Lost-Update bei Format-Upserts (Last-Write-Wins als DECIDED festhalten oder CAS ergänzen); Events nur `.updated`, kein `.created` bei Erst-Upsert; Insert-Pfad von `upsertInvoicingSettings` mit gesetzter `baseRevision` semantisch undefiniert; „Abschlagsrechnung"-Template „mitgeführt" ohne 7. `type`-Wert (als reine Doku kennzeichnen, nicht in CHECK); Ländercode `UK` statt ISO `GB` bewusst begründen.

  ## Verdict: GO MIT AUFLAGEN

  Keine P0-Befunde — Architektur, RLS-/CAS-/DTO-Vertrag und Evidenztrennung im Kern (§4 OBSERVED-Markierungen, §13 UNKNOWN-Liste) sind contractfähig, und ADR 0024 trägt die Modellierung sauber. Vor CONTRACTED müssen jedoch die sechs P1-Widersprüche beseitigt werden, insbesondere O5-Widerspruch, Template-vs-Präfix-Divergenz, Counter-/Seeding-Pinning und die selbst definierte Issuing-Details-Permission, da sonst Schema-Hash und Rollenprobe nicht festgezogen werden können. Danach ist der Slice ohne erneutes Full-Review freizugeben (Stichprobe P1-Fixes genügt).

To resume this session: kimi -r session_2643719e-a2d8-4425-b6af-e1f2f5210bf1
