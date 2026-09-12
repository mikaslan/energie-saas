# F8-15 Portal-Rechnungssicht (Katalog F8.5 „Portal-Sicht“)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12 (DB F815 2/2, Contract F1001 15/15, E2E F815-E2E-01 1/1, tsc/eslint/depcruise/db:generate grün, lokal beobachtet; kein Push während CI läuft).

Ziel: Die in F8-05/07/08/12/13/14 als „Bewusst offen: Portal-Sicht“
geführte Lücke schließen. Das Kundenportal zeigt je Invite-Projekt
die ausgestellten Geldbelege (Rechnung/Gutschrift): Nummer, Art,
Ausstellung, Brutto, Zahlstand — lesend, ohne Download.

## ESTIMATE (reversibel, Referenzfrage offen)

- Projektion im Portal-DEFINER (Migration 0135, `CREATE OR REPLACE`
  wie 0120, nur `invoice_list` dazu, keine neue Tabelle, RLS
  unverändert): `commercial_document` je Invite-Projekt mit
  `status = 'issued'` und `type IN ('invoice','credit_note')`.
  Entwürfe/stornierte bleiben intern; neueste Ausstellung zuerst.
- Felder je Beleg: `id`, `number` (nullable, ehrlich „–“), `kind`,
  `issuedAt`, `grossCents` (Cent-ganzzahlig ≥ 0), `paymentStatus`
  (5er-Wortschatz, nullable → „–“). NIE Positionen, Skonto,
  Snapshots, Zahlbeträge, Kontakte.
- Commercial-Portal: `invoices` leer wie `documents` (F10-03c:
  kein Preis-Bereich im Gewerbe-Portal).
- Contract: `portalInvoiceSchema` (strikt) + `invoices` in V1;
  Resolve-Schema `invoices: unknown().optional()` (Alt-Projektion →
  ehrlich leer, F10-03-Präzedenz); Fremdes bricht fail-closed ab.
- Seite: Abschnitt „Rechnungen“/„Invoices“ im Wohnbau-Portal
  (DE/EN-Worte + Locale-Betrag, kein Download-Link in v1).
- Berechtigung: Token-Pfad (DEFINER wie documents, GRANT SELECT an
  app_owner, Muster file_request). KEINE neuen Keys/Provider.

## Scopes

1. Migration 0135 (DEFINER-Replace + Grant, db:generate driftfrei).
2. Contract: Schema + Parse + Commercial-Strip.
3. Sprache: DE/EN-Worte + Euro-/Zahlstand-Format.
4. Portalseite: Rechnungs-Abschnitt (read-only, kein Download).

## Geschlossene Testmatrix

- `F815-DB-01`: ausgestellte Rechnung am Projekt sichtbar (Nummer/
  Art/Brutto/Zahlstand), Entwurf unsichtbar, fremdes Projekt leer.
- `F815-DB-02`: Gutschrift als `credit_note` sichtbar; Storno
  (voided) verschwindet; Commercial-Invite liefert `invoices: []`.
- Contract F1001 +2: Alt-Projektion ohne Schlüssel → `[]`;
  deformierte Einträge (fremder Key, falsche Art, krumme/negative
  Cents, falscher Zahlstand) → null; Commercial-Strip leert.
- `F815-E2E-01`: Portal-Link → Abschnitt „Rechnungen“ mit Nummer,
  Betrag und „Offen“ sichtbar (DE).
- Contract F1001 +2: belegte Projektion parst (inkl. null-Nummer/
  null-Zahlstand), Commercial-Strip leert bei belegter Liste.

## Bewusst offen

- Rechnungs-Download im Portal (F10-07 deckt nur
  Ausstellungsfassungen), DATEV-0-%-/§13b-Fälle, Versand,
  Factur-X-Einbettung.
