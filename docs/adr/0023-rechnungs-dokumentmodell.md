# ADR 0023 — Rechnungen: ein generisches Document-Modell statt einer Tabelle je Dokumenttyp

- Status: VORGESCHLAGEN (im Rahmen der M3-01-Spec DISCOVERED→SPECIFIED)
- Datum: 2026-09-03
- Betroffene Slice-Spec: `docs/spec/M3-01-rechnungen-kern.md`
- Basis: `codex/m2-integration` HEAD `e5a9c5d` (Spec-/ADR-Ablage; M3-01 ist reine Spezifikation, kein Code)

## Kontext

F8 verlangt sieben kaufmännische Dokumenttypen (Rechnung, Gutschrift,
Auftragsbestätigung, Bestellung, Lieferschein, Brief, plus Dokumentgruppen).
Die Portal-Beobachtung (`PORTAL-DEEP.txt`, OBSERVED) zeigt je Typ fast
identische Listenspalten und Filter — Unterschiede sind im Wesentlichen eine
Handvoll typ-spezifischer Datumsfelder:

| Typ | zusätzliche Datumsfelder (Portal-Spalten) |
|---|---|
| Rechnung | Fälligkeitsdatum; Zahlungsstatus |
| Gutschrift | Lieferdatum; Zahlungsstatus; Typ |
| Auftragsbestätigung | geplantes Lieferdatum, geplantes Leistungsdatum |
| Bestellung | Gültigkeitsdatum |
| Lieferschein | Lieferdatum |
| Brief | Gültigkeitsdatum; **kein** Betrag |

Alle Typen teilen Status (Entwurf|Ausgestellt|Storniert), Versand-Achse,
Nummernkreis, Betragsachse (außer Brief), Archivierung und die
Immutable-Ausstellung. Die siebenfache Duplikation eigener Tabellen, RLS-
Policies, Erasure-Pfade, Nummernkreis-Sperren und Snapshot-/Hash-Logik wäre
hoch und fehleranfällig.

## Entscheidung

Wir modellieren **ein** generisches `document`-Aggregat mit einem
`type`-Diskriminator und **typisierten, nullable Spalten** für die
typ-spezifischen Datumsfelder, abgesichert durch CHECK-Constraints je Typ.
Daneben stehen `document_group` (Dokumentgruppen), `document_line`
(Positionen, M2-01-Geldvertrag) und `document_number_series`
(workspaceweiter Nummernkreis je Typ). Nur echte typ-eigene Zusatzfelder ohne
Filter-/Indexbedarf landen in einem kleinen `type_specific`-JSONB. Die
Immutable-Ausstellung wird als gespeicherter `issued_snapshot`-JSONB plus
`snapshot_sha256` (bytea, 32 Byte) am Document umgesetzt — analog
`offer_variant_revision`.

## Alternativen betrachtet

### Alternative 1: eine Tabelle je Dokumenttyp
- **Pros:** keine nullable Spalten, typ-saubere CHECKs, keine Diskriminator-Bedingungen.
- **Cons:** 6–7fache Duplikation von Status-/Versand-/Zahlungs-/Betrags-/Snapshot-/
  RLS-/Erasure-/Nummernkreis-Logik; Berichte (`/backoffice/reports`) müssen über
  7 Tabellen aggregieren; spätere Typ-Hinzufügung (z. B. neue Briefart) braucht
  eine neue Tabellenfamilie.
- **Warum nicht:** Die Portal-Evidenz zeigt eine gemeinsame Tab-/Spalten-Semantik;
  der Wartungs- und Review-Aufwand skaliert linear mit der Typanzahl, ohne
  fachlichen Gewinn.

### Alternative 2: generisches Modell mit vollem JSONB („document payload")
- **Pros:** maximale Flexibilität, keine Spaltenmigration je Typ.
- **Cons:** Datums-/Betrags-/Statusfilter (Portal-Filter `Status`, `Zahlungsstatus`,
  `Ausstellungsdatum`, `Fälligkeitsdatum`, `Lieferdatum`, `Archiviert`) werden
  unindexierbar bzw. erzwingen generierte Spalten; Integritäts-Garantien wandern
  aus dem Schema in die Anwendung.
- **Warum nicht:** Die Filter- und Berichtsachse ist Kern des Slices; typisierte
  Spalten sind hier die robustere Wahl.

### Alternative 3: geteilte Supertabelle + je Typ-Subtabelle (Table-Per-Type)
- **Pros:** saubere Normalisierung, keine Null-Spalten.
- **Cons:** Join-Komplexität, 7 zusätzliche Tabellen, RLS/FK-Graph vervielfacht.
- **Warum nicht:** Over-Engineering für eine im Kern gleichförmige Belegfamilie.

## Konsequenzen

### Positiv
- Eine RLS-/Rollenfläche, ein Erasure-Graph-Eintrag (`documentIds`/`groupIds`),
  ein Nummernkreis-Sperrvertrag und eine Snapshot-/Immutable-Maschinerie für alle Typen.
- Cross-Type-Berichte (Einnahmen, Ausstehend, Überfälligkeit) lesen aus einer Tabelle.
- Neue Typen/Felder sind additiv (Migration + CHECK) statt neue Tabellenfamilien.

### Negativ
- CHECK-Constraints werden pro Typ bedingt (`type = 'invoice' → due_date not null`
  etc.) und sind ausführlicher als eine spezialisierte Tabelle.
- Einige Spalten sind je Typ strukturell leer (z. B. `gross_cents` bei `letter`).

### Risiken
- **Typ-Drift:** spätere Typen könnten stärker divergieren. Mitigation: `type_specific`
  JSONB als Ventil + additive Spalten; bei echter Divergenz ist ein späterer
  Austrittspunkt (eigene Tabelle) weiterhin möglich und per ADR zu begründen.
- **CHECK-Komplexität:** Fehler in bedingten Constraints fallen erst im DB-Matrix-Test
  auf. Mitigation: exhaustive DB-Matrix je Typ (frisch + Legacy + Verletzungsfälle)
  als Pflicht-Gate in der Spec.
