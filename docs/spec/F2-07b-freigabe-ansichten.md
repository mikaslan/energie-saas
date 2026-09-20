# F2-07b · Freigabe-Ansichten (readonly Ledger, Historie, Chronik)

Status: **SPEC-DRAFT · Lane 7 · Welle 2**
Vorgänger: M2-03a (Freigabekandidat), M2-03b1 (Ausstellungsfassung, 4-Augen).
Lesebefund: Candidate-Panel zeigt je Kandidat Status/`approvedAt`/Download —
keine Bindungs-Revisionen, keine Prüfpunkte. Issuance-Panel zeigt je Fassung
Status (0/1/2 von 2), `approvalCount`, Withdraw-Grund+Zeitpunkt — keine
Einzel-Einträge pro Freigabe, keine Zeitpunkte, keine Prüfpunkte.

## Scope (nur LESENDE Ansichten)

1. **D4-02 4-Augen-Ledger**: je Issuance ein Eintrag pro gespeicherter
   Freigabe (1/2, 2/2 nach `approvedAt, id`), ohne Personenbezug.
2. **D4-07 Offer-weite Chronik**: zeitlich sortierte Liste aller
   Freigabe-/Withdraw-Ereignisse des Offers, PII-frei.
3. **D4-01 Candidate-Approval-Historie**: je Candidate-Freigabe ein Eintrag
   mit Varianten-, Profil- und Empfänger-Revisionsbindung.
4. **D4-03 Withdraw-Historie**: offer-weite Liste aller Withdrawals mit
   strukturiertem Grund und Zeitpunkt.
5. **D4-04 Prüfpunkte-Protokoll (readonly)**: je gespeicherter Freigabe die
   bestätigten Prüfpunkte als reine Leseliste (kein Formular, keine Inputs).
6. **D4-05 Rechtstexte-Anzeige: VERWORFEN** — echte, verantwortete
   WMEE-Rechtstexte fehlen (M2-03a-Gate, keine Defaultinhalte);
   `offer_release_profile_revision.snapshot.legalDocuments` enthält nur
   Admin-eingegebene, nicht verantwortete Inhalte. Eine Anzeige würde
   Unverantwortetes als verbindlich darstellen und den PDF-Inhalt doppeln.
   Ersatz: D4-01/D4-04 zeigen nur die Profilrevisions-Referenz.

## Nicht-Ziele

- Kein Template-, Register- oder Badge-Konzept (5d-TABU); keine neuen
  Status-Übergänge, kein Lock, kein Versand, keine Archivierung.
- Keine Änderung an versiegelten Pfaden: keine neuen Writes, keine
  Migration, keine Änderung an bestehenden Panels/Actions/Services.
- Keine Actor-Identitäten, keine Hashes/Bytes, keine Preise, Adressen
  oder Rechtstext-Inhalte in einer Anzeige (PII-/Privacy-Regel).
- Kein Freitext, keine Kommentar- oder Notizfunktion.

## Datenmodell (nur Reads, keine Migration)

- D4-02: `offer_issuance_approval` →
  `issuance_id, approved_at, has_zero_tax_treatment, approval_version`.
  Verboten im DTO: `approved_by`, alle `*_sha256`, `artifact_*`,
  `approval_command` (Rohdump), `candidate_approved_by`.
- D4-01: `offer_release_candidate_approval` →
  `candidate_id, variant_revision, profile_revision, recipient_revision,
  has_zero_tax_treatment, approved_at`. Verboten: `approved_by`, Hashes,
  `approval_command`, Empfänger-/Profilsnapshots.
- D4-03: `offer_issuance_withdrawal` →
  `issuance_id, reason_code, withdrawn_at`. Verboten: `withdrawn_by`,
  `withdrawal_command`, Hashes.
- D4-04: BOOLEAN-Spalten beider Approval-Tabellen
  (`recipient_billing_reviewed`, `commercial_content_reviewed`,
  `active_profile_reviewed`, `not_issued_status_understood` bzw.
  `recipient_and_scope_reviewed`, `commercial_totals_reviewed`,
  `legal_profile_reviewed`, `final_pdf_for_archive_understood`,
  `zero_tax_treatment_reviewed`); Labels aus den bestehenden Panels
  übernehmen (Microcopy-konsistent).
- D4-07: `domain_events` mit `aggregate_type='offer'`,
  `aggregate_id=offerId`, `event_type` in
  `offer.release_candidate_requested`,
  `offer.release_candidate_approved_not_issued`,
  `offer.issuance_requested`, `offer.issuance_first_approval_recorded`,
  `offer.issuance_approved_for_archive_not_issued`,
  `offer.issuance_withdrawn_before_archive`.
  `*_replayed`-Events werden ausgeblendet (No-op-Disziplin wie F2-02).
  Verboten im DTO: `actor`, Roh-`payload`; Referenzlabels werden
  serverseitig aus Payload-IDs abgeleitet (gleiche Ableitung wie
  `listOfferIssuances`/`listOfferReleaseCandidates`).
- Referenzlabels (`issuanceReference`, `candidateReference`) und
  Withdraw-Grundlabels aus dem Issuance-Panel wiederverwenden, nicht
  neu erfinden.

## Semantik

- Anzeigeort: Offer-Detailseite
  (`app/w/[workspaceId]/angebote/[offerId]/`), neue Sektionen UNTERHALB
  der bestehenden Panels. Neue Komponenten-Dateien (bevorzugt):
  `offer-release-chronik-panel.tsx` (D4-07),
  `offer-approval-ledger-panel.tsx` (D4-02 + D4-04 Issuance-Teil),
  `offer-candidate-history-panel.tsx` (D4-01 + D4-03 + D4-04
  Candidate-Teil). Einbindung in `page.tsx`/`offer-detail-view.tsx`;
  bestehende Panels bleiben unangetastet.
- Neue Reader in `modules/offers` (Muster `listOfferIssuances`):
  ein Reader je Ansicht, DTOs strikt PII-frei (Whitelist obiger Spalten).
- Statt Identität: Ordinale („Erste Freigabe", „Zweite Freigabe").
  Sortierung: Chronik nach `occurred_at, id`; Ledger nach
  `approved_at, id`; Historien nach Zeitpunkt absteigend.
- 0-%-Prüfpunkt erscheint nur bei `has_zero_tax_treatment = true`.
- Leere Zustände: „Noch keine Freigaben protokolliert." /
  „Noch keine Rücknahmen." (kein Fehler, kein leeres Panel ohne Text).
- Recht: internes `project.read` (Lesen wie Status lesen);
  `external_only` blockiert; kein neues Capability-Matrix-Delta.
- Nach Withdrawal bleibt der Ledger sichtbar (Historie!), nur der
  Download bleibt gesperrt (M2-03b1-Regel, unverändert).

## Tests (IDs F207B-*)

- `F207B-CONTRACT-01`: DTO-Whitelist je Reader — kein `actor`,
  `approved_by`, `withdrawn_by`, `*_sha256`, `artifact_*`, kein
  Roh-`payload`/`approval_command` (Snapshot/Golden).
- `F207B-CHRONIK-01`: Vollständigkeit (alle 6 Event-Typen), Sortierung,
  `*_replayed` ausgeblendet, Fremd-Offer-Events ausgeschlossen.
- `F207B-LEDGER-01`: Ordinale 1/2 + 2/2 nach `approved_at, id`;
  zweite Freigabe ohne erste ist unmöglich (DB-Invariant, Negativtest).
- `F207B-PRIVACY-01` (adversarial): PII-/Hash-/Preis-/Adress-Freiheit
  aller neuen DTOs, Events und Logs; Ordinale statt Identität.
- `F207B-RBAC-01`: Viewer/Editor/Admin lesen; External/Cross-Tenant
  blockiert; `external_only` blockiert.
- `F207B-PRUEF-01`: D4-04 zeigt exakt die gespeicherten Prüfpunkte,
  0-%-Punkt nur bei `has_zero_tax_treatment`; keine Inputs/Forms.
- `F207B-WITHDRAW-01`: D4-03 listet alle Withdrawals offer-weit mit
  korrektem deutschem Grundlabel; Ledger bleibt nach Withdraw sichtbar.
- `F207B-A11Y-01`: echte Listen (`ul`/`ol`), Zeitpunkte in `time`,
  200/400-%-Reflow, keine interaktiven Schein-Elemente.

## Offene Punkte

- O1: Referenzlabel-Ableitung für Chronik-Einträge — exakten Helper aus
  `listOfferIssuances`/`listOfferReleaseCandidates` in GREEN benennen.
- O2: Falls Offer-Detailseite zu lang wird: Chronik einklappbar
  (`details`)? Entscheidung in GREEN, Default: offen.
- O3: D4-05 bleibt verworfen, bis verantwortete Rechtstexte + eigener
  Anzeige-Slice beauftragt werden (neue Spec nötig).
