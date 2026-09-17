# M3-02a Siegel-Voraussetzungen: Zeilen-Freeze + Empfänger-Snapshot

Status: **SPEZIFFIZIERT/KONTRAHIERT** · Lane: `codex/muse-fleet-4-rechnungen` · Migration **0191**

Ziel: GoBD-lücken schließen, bevor M3-02b/c Rechnungs-PDFs rendern.
Selbstverifiziert auf `ded7581`: (1) `commercial_document_line` hat
keinen Freeze-Trigger — nur Service-Gates (`draft`); direktes SQL kann
Zeilen ausgestellter/stornierter Belege ändern. (2)
`recipient_snapshot` wird nie geschrieben (nur Schema + Siegel-Select);
die Ausstellung friert keine Empfängeradresse ein. (Korrektur ggü.
Entwurf: Das Siegel deckt Zeilen DOCH ab — der Trigger bleibt als
Drift-Schutz an der Quelle wertvoll.)

## DECIDED (bindend, begründet)

- Zeilen-Guard (0191, additiv, kein Schema-Delta): neue Funktion
  `_m301_guard_line_parent_immutable()` + BEFORE-INSERT/UPDATE/DELETE-
  Trigger auf `commercial_document_line`. Liest den Elternstatus;
  Eltern `issued`/`voided` → `23514` (`line_parent_immutable`);
  Eltern unsichtbar/fehlend → `23514` (fail-closed, auch ohne
  Tenant-Kontext — Wartung muss Kontext setzen wie überall).
  `commercial_document_partial_line` bewusst ausgenommen: reine
  Link-Zeilen ohne Geld, werden nach Anlage nie mutiert (Service
  schreibt sie nur bei Kettenanlage an Entwürfen).
- Empfänger-Snapshot bei Ausstellung: `issueDocument` liest bei
  gesetzter `contactId` den Kontakt (gleicher Workspace) und friert
  `{displayName, street, houseNumber, postalCode, city, country}`
  (NFC/Space-Trim + Codepoint-Längen = exakte PG-btrim/length-
  Semantik, Caps = Kontakt-CHECK-Spiegel, strict-Zod) in
  `recipient_snapshot` ein;
  das Siegel übernimmt die Spalte (bestehende Selects unverändert).
  Kein Kontakt → null (Legacy-sicher). Kontakt gelöscht
  (`deleted_at`, Referenz stale) → `Validation` (fail-closed;
  Fremd-Workspace ist per FK unerreichbar). Keine Kanäle
  (Mail/Telefon) im Snapshot
  (M2-02-Privacy-Spiegel); Adressfelder optional, weil Kontakte oft
  unvollständig sind und Pflichtfelder Bestandsflüsse brächen
  (rechtliche Vollständigkeit bleibt Absenderverantwortung).
- Geld unberührt; keine neue Permission; kein UI (Voraussetzungs-
  Slice — E2E-Abdeckung über F8-Nachbarläufe, kein neues Spec).

## CONTRACTED (bindend)

- DB (0191): Funktion + 3 Trigger, schreibt keine Daten um, kein
  Backfill. Rollenvertrag: Funktions-Pin (prosrc-Hash, Methode gegen
  Bestand kalibriert) + 3 Trigger-Pins. Journal-Tail-Pins + Count
  (151) nachziehen.
- Zod (`contract.ts`): `commercialRecipientSnapshotV1Schema`
  (strict, displayName 1..200 Pflicht, Adresse optional mit Caps,
  NFC/Trim-Refine) — nur Service-intern + Tests, kein DTO-Feld.
- Service: Snapshot-Aufbau in `issueDocument` vor dem Siegel-Update
  (gleiche Transaktion, `FOR UPDATE`-Lock bleibt); Fehler mapping
  invalid → `InvoicingValidationError`.

## Geschlossene Testmatrix

- `M302A-DB-01`: INSERT/UPDATE an Zeilen ausgestellter UND
  stornierter Belege (roh-SQL) → je `23514` + Meldung
  `line_parent_immutable`; DELETE ohne Policy → RLS-0-Zeilen (Zeile
  bleibt), Trigger-DELETE-Ast per Superuser → `23514`; Orphan-INSERT
  (zufällige document_id) → `23514` + `line_parent_not_found`;
  Umzugs-Angriffe versiegelt→Entwurf und Entwurf→versiegelt →
  `23514`, Entwurf→Entwurf gelingt; Entwurf-Zeilen weiter schreibbar
  (Service + roh); Geld unverändert.
- `M302A-DB-02`: Ausstellung mit Kontakt friert Adresse ein
  (Spalte + Siegel-JSON gleich, NFC/Trim belegt); ohne Kontakt →
  Spalte + Siegel null; unvollständiger Kontakt (nur Name) →
  Snapshot mit nulls (Spalte + Siegel gleich); gelöschter Kontakt →
  `Validation`; alle Caps an der CHECK-Grenze stellen erfolgreich
  aus (kein False-Reject); Summen stabil. Überlängen sind per
  Kontakt-CHECK unerreichbar — Service-Validierung ist Defense-in-
  Depth, bewiesen in CONTRACT-01 (dort auch Blank→null).
- `M302A-CONTRACT-01`: Snapshot-Schema (strict, Caps als exakter
  Kontakt-CHECK-Spiegel mit Accept-an-der-Grenze je Feld,
  NFC/Space-Trim-Transform, Emoji-150 + Tab-Akzeptanz (PG-Semantik),
  Required/Optional-Matrix, Blank→null, Unknown-Key-Reject,
  Lone-Surrogat/NUL-Reject auf Pflicht- und Optionsfeldern,
  Optional-Normalisierung).
- Kein neues E2E (kein UI); F8-Nachbar-E2E müssen grün bleiben.

## Bewusst offen

- Zeilen stehen bereits im GoBD-Siegel (Service-Seal); der Trigger
  schützt die Quelle vor Drift. Partial-Link-Freeze,
  Pflicht-Adressvalidierung, Portal-Sicht.
- Bekannte Grenze (kein Handlungsbedarf): Der Kontakt-Pfad
  normalisiert nicht NFC — ein CHECK-legaler 200-Zeichen-Wert aus
  NFC-expandierenden Zeichen (z. B. U+0390 → 3 Zeichen) könnte die
  Snapshot-Cap reißen und die Ausstellung mit `Validation` stoppen.
  Absurd selten; fail-closed.
