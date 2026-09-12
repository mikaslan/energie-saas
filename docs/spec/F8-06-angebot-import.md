# F8-06 Angebot als Rechnung übernehmen (Varianten-Import, Katalog F8.4)

Status: **SPECIFIED** · Lane: `codex/m1-wave-02` · Stand 2026-09-12

## Ziel und Abgrenzung

Modulkatalog F8.4 verlangt die Belegerstellung „aus signiertem Angebot“.
F8-04b hat die AB-Übernahme geliefert und diesen Slice ausdrücklich
offengelassen. Dieser Slice übernimmt die **signierte Variante** eines
Angebots als Rechnungs-Entwurf: gleiche Gruppe gibt es angebotsseitig
nicht (gruppenlos, Projekt/Kontakt aus dem Angebot), Positionen aus dem
versiegelten Varianten-Snapshot in Reihenfolge, Summen über die
Zeilenanlage neu gerechnet.

## ESTIMATE (reversibel, Referenzfrage offen)

- Signiert = `signature_request` mit `status = 'signed'`, dessen
  `variant_revision_id` auf die **aktuelle** Varianten-Revision zeigt.
  Exakte Reonic-Übernahmesemantik UNKNOWN.
- Zeilenbasis: versiegelte `finalSalesNetCents` je Zeile (enthalten alle
  Rabattstufen: Zeile → Sektion → global → Fix → Deal-Allokation).
  Summe der Rechnung = `basisNetCents` des Snapshots.
- Nur `required` + `additional`, nicht versteckt; `optional`-Zeilen
  bleiben außen (preislich getrennt als `optionalNetCents` ausgewiesen —
  dokumentierte v1-Grenze). Versteckte Zeilen mit Wert ≠ 0 brechen als
  Validation ab (bepreist, aber nicht darstellbar); Summe der
  importierten Zeilen muss exakt `basisNetCents` ergeben (Abbildungswache).
- Deal-Override (`totalPriceOverrideNetCents`) ist pro Zeile nicht
  darstellbar → fail-closed (kein stiller Preiswechsel).
- Fälligkeit: heute + 14 Tage Europe/Berlin (F8-04b-Muster, ESTIMATE);
  Skonto/Konditionen werden wie dort NICHT kopiert.
- Rechnungsname: `Rechnung zu Angebot <Angebotsnummer> – <Variantenname>`.

## Evidenz

- Bestehende Pfade: `createDocument`, `createDocumentLine`,
  `getDocumentDetail` (keine neue Permission: `invoicing.write`).
- Angebotsseite: versiegelter Snapshot je Revision
  (`offer_variant_revision.revision_snapshot`), Content-Lock-Muster
  `readVariantContentLock` (Module `offers`, öffentlich nur
  `getOfferDetail` — der Import liest mandantengebunden per SQL wie
  `readVariantContentLock`, keine Index-Erweiterung nötig).
- Einheiten/Steuern sind schnittstellenidentisch
  (`piece/set/meter`, `0/1900 bps`); Mengen ≥ 1 Milli beidseitig.

## Datenmodell (keine Migration)

Kein neues Feld: Herkunft steht in Event
(`commercial_document.offer_imported`) + Audit
(`invoicing.document.offer_import` mit Angebots-/Varianten-/
Revisions-/Request-ID, Zeilenzahl und `basisNetCents`).

## Validierung (fail-closed, keine stillen Defaults)

- Angebot/Variante unbekannt oder fremder Workspace → NotFound
  (Mandantenschranke wie `readDocument`, kein Orakel).
- Kein signierter Request (fehlend/`pending`/abgelaufen) → Validation
  (nur signierte Varianten sind importfähig).
- `revoked_by_customer` → Conflict (Kundenwille wie Storno).
- Signierte Revision ≠ aktuelle Revision → Conflict (veralteter Stand,
  kein stiller Altpreis).
- Deal-Override aktiv → Validation (Preiswahrheit).
- Keine importierbaren Zeilen (alle `optional`/versteckt) → Validation.
- Snapshot korrupt (Siegel-Schema verletzt) → IntegrityError-Pfad,
  nie Teilimport (vor jeder Zeilenanlage geprüft).
- Zeilen-Mapping verletzt das Rechnungs-Schema → Validation
  (kein stilles Runden/Umschreiben).
- Viewer/ohne `invoicing.write` → denied (Schreibpfad wie F8-04b).

## Anzeige

Angebotsdetailseite (schreibberechtigt, Variante signiert und aktuell):
Panel „Als Rechnung übernehmen“ → Erfolgsmeldung mit Link auf den
neuen Rechnungs-Entwurf. Nicht importierbare Zustände zeigen den
ehrlichen Grund (nicht signiert / veraltet / Override), kein Panel.

## Akzeptanz

- `F806-DB-01`: signierte Variante (Tenant-Basis + required/additional
  mit Rabatt + 1 optional) → Entwurf mit 2 Positionen in Reihenfolge,
  Netto = `basisNetCents`, Fälligkeit +14, kein Skonto, Event/Audit
  belegt.
- `F806-DB-02`: unsigniert → Validation, revoked → Conflict.
- `F806-DB-03`: Override → Validation, nur-optional → Validation,
  fremdes Angebot → NotFound, Viewer → denied.
- `F806-DB-04`: Siegel-Parität — versiegelte Snapshots parsen,
  manipulierte nicht (der Parse ist die einzige Import-Voraussetzung
  neben der Signatur).
- `F806-E2E-01`: signiertes Angebot (Fixture) → übernehmen → Rechnung
  mit Positionen und Summen sichtbar.
- Gates: tests grün, typecheck/lint/depcruise grün, Nachbarn
  (F8-04b/m3-01) lokal.

## Trigger-Verankerung (kein Test-Ersatz, sondern Begründung)

- Veraltete Revision ist per Trigger ausgeschlossen (0075 sperrt
  `current_revision`/Name/Beschreibung bei lebendiger Signatur); die
  Revisionsbindung im Service ist Defense-in-Depth und als DB-Zustand
  nicht herstellbar, ohne die Domäneninvariante zu brechen.
- Korrupte Snapshots sind per `json_ck` + Spiegel-Trigger in v4 nicht
  speicherbar; `InvoicingIntegrityError` sichert Schema-Drift und die
  Summen-Abbildung ab.
- Versteckte Wertzeilen erreichen den Import nicht: das Release-Gate
  (`hidden_line_present`) blockt sie vor der Freigabe; der
  Service-Branch bleibt defensiv bestehen.

## Bewusst offen

- `optional`-Zeilen (Wahlpositionen), Skonto je Rechnung (F5-01-Pfad am
  Entwurf), Portal-Sicht, E-Rechnung/DATEV, mehrstufige Ketten.
