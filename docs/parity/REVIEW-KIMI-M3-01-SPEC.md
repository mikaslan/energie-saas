kimi version 0.40.1
• Hier ist der unabhängige Review-Befund zur Slice-Spec **M3-01** und **ADR 0023**.

  ---

  ### Befunde

  #### P0 (muss vor CONTRACTED geschlossen werden)

  1. **Erasure-Graph vs. Immutable-Snapshot: PII-Leak im Hash-geschützten Snapshot**
     - *Zitat:* `M3-01 §10`: „`draft`/`voided` oder bereits `paid`/`uncollectable` → PII im `recipientSnapshot` […] wird gescrubbt; Beträge, Nummern und Status bleiben erhalten“ vs. `§4`: `snapshotSha256 (bytea, 32 byte)`.
     - *Problem:* Wenn der `recipientSnapshot` Teil des `issued_snapshot` ist, führt Scrubbing zu Hash-Divergenz oder bricht die DB-Trigger-Immutability (`§12`). Wenn er separat liegt, ist unklar, ob er im versiegelten Snapshot enthalten ist.
     - *Fix:* In `§4` und `§10` festlegen: Entweder wird PII im `issued_snapshot` als pseudonymisierter Verweis/gesonderter Key geführt, oder Erasure für `issued` führt ein definiertes `tombstone`-Verfahren am versiegelten Snapshot durch, das den Integritäts-Hash gezielt invalidiert/dokumentiert, ohne die DB-Immutability-Trigger zu verletzen.

  2. **Fehlende Typ-Spalte für Gutschriften im Datenmodell**
     - *Zitat:* `M3-01 §7`: „Gutschrift: […] Filter: Status, Typ, Ausstellungsdatum…“ und `§15 UNKNOWN 4`.
     - *Problem:* `commercial_document` (`§4`) definiert zwar typ-spezifische Datumsfelder, aber kein Feld `credit_note_type` (weder Spalte noch Typ-Zuweisung in CHECKs).
     - *Fix:* In `§4` Spalte `credit_note_type text null` (oder enum) ergänzen, in CHECKs binden (`type = 'credit_note' ∨ credit_note_type is null`) und als ESTIMATE/UNKNOWN markieren.

  3. **Archivierungs-Achse am Dokument fehlt im Schema**
     - *Zitat:* `M3-01 §7`: Filter „Archiviert“ bei Rechnung, Gutschrift, Auftragsbestätigung, Bestellung, Lieferschein, Brief.
     - *Problem:* `§4` hat `archivedAt` an `commercial_document_group`, aber **nicht** an `commercial_document`. Filterung nach archivierten Einzeldokumenten ist im Schema unmöglich.
     - *Fix:* `archivedAt timestamp with time zone null` in `commercial_document` (`§4`) aufnehmen; Index `(workspaceId, type, archivedAt)` definieren.

  #### P1

  4. **Nummernkreis-Präfixe: Mangelnde Trennung zwischen Reonic-Evidenz und System-Defaults**
     - *Zitat:* `M3-01 §6`: „Vorschlags-Präfixe (DECIDED): RE, GU, AB, BE, LS, BR. Exakte Reonic-Präfixe UNKNOWN.“
     - *Problem:* Es fehlt der 7. Typ (`credit-notes`, `offer-confirmations`, `purchase-orders`, `deliver-notes`, `letters`, `all-invoices` — was ist der 7.? In `§4`/ADR 0023 sind es 6 Dokumenttypen + 1 Gruppe, aber `§3 M301-01` spricht von „7 Typen“).
     - *Fix:* Zählung bereinigen: Entweder 6 Dokumenttypen + 1 Gruppe oder den fehlenden 7. Dokumenttyp explizit benennen und präfixieren.

  5. **`goebd_retention_until` vs. CHECK-Integrität**
     - *Zitat:* `M3-01 §10`: „`goebd_retention_until` (nullable `date`, bei Ausstellung aus Workspace-Default gesetzt)“.
     - *Problem:* In `§4` (Datenmodell-Skizze) ist das Feld `goebd_retention_until` in der Spaltenaufzählung von `commercial_document` vergessen worden.
     - *Fix:* Feld in `§4` ergänzen inkl. CHECK `(status = 'issued' ∧ goebd_retention_until is not null)`.

  6. **Zahlungsachse: Fehlende Validierung für Überzahlung**
     - *Zitat:* `M3-01 §5.3`: „`paid ⇒ paidCents ≥ grossCents`“ vs. `§3 M301-08`: `gross = net + tax`.
     - *Problem:* Erlaubt `paidCents > grossCents` (Überzahlung)? Wenn ja, wie schlägt sich das im Reporting nieder?
     - *Fix:* Regelung präzisieren: `paid ⇔ paidCents == grossCents` (Standard) oder Überzahlung explizit als Variante/ESTIMATE definieren.

  7. **Capability-Matrix: M301-05 doppelt vergeben**
     - *Zitat:* `M3-01 §14`: Zwei Zeilen mit Kürzel `M301-05` (Zahlungsachse und Nummernkreise).
     - *Problem:* Nummernkreise gehören zu `M301-02` (Ausstellen).
     - *Fix:* In §14 Zeile 6 auf `M301-02` korrigieren.

  #### P2

  8. **ADR 0023: Fehlendes Rollen- und Migrationskonzept für Schema-Upgrades**
     - *Zitat:* ADR 0023 Konsequenzen/Risiken.
     - *Problem:* Die Migration von CHECK-Constraints bei neuen Dokumenttypen in Postgres erfordert exklusive Tabellensperren (`ALTER TABLE ... ADD CONSTRAINT`).
     - *Fix:* Im ADR festhalten, dass künftige Typ-Erweiterungen mit `NOT VALID` + `VALIDATE CONSTRAINT` geplant werden müssen.

  ---

  ### Verdict: GO MIT AUFLAGEN für CONTRACTED

  **Begründung:**  
  Die Spezifikation und ADR 0023 bieten ein exzellent durchdachtes, modulares Fundament mit vorbildlicher Clean-Room-Disziplin und konsistenter Wiederverwendung des M2-Geldvertrags. Vor dem Übergang zu CONTRACTED müssen jedoch der DSGVO-Erasure-Konflikt am Hash-versiegelten Snapshot gelöst sowie die fehlenden Spalten `archived_at`, `credit_note_type` und `goebd_retention_until` im Schematext nachgezogen werden. Zudem ist die Diskrepanz zwischen der Zählung „7 Typen“ und den 6 dokumentierten Belegarten formell zu bereinigen.

To resume this session: kimi -r session_77324f63-912b-4c1f-8fc5-5aefe4719d6e
