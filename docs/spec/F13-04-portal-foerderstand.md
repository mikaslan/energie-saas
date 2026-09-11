# F13-04 Förderstand im Kundenportal (Katalog F13.2-Folge)

Ziel: aktive Portal-Links zeigen den Stand der Förderakte
(Status/Programm/Phasen-Daten). Reine Leseprojektion des
DEFINER-Resolvers; keine Schreibpfade, keine neuen Rechte.
Bauarbeit, kein Referenzbeleg.

## ESTIMATE (reversibel, Referenzfrage offen)
- Projektion `subsidy`: status (7er-Wortschatz F13-03),
  program, bzaSubmittedAt/bzaApprovedAt/bndSubmittedAt/
  completedAt. BzA-Nummer bleibt interne Referenz und bricht
  im Allowlist-Parse fail-closed ab (Contract-Test pinnt das).
- Fehlende Akte → `subsidy: null` → kein Block (Alt-Projektionen
  parsen wie null, Muster F10-03).

## Scopes
1. Migration 0106 (resolve-Rewrite Muster 0104 + SELECT-Grant
   subsidy_case an app_owner, Rollen-Pin nachgezogen).
2. Vertrag: `portalSubsidySchema` + Parse-Allowlist.
3. Portal-Übersicht: Förderblock (Stand + Programm), Test-IDs.

## Geschlossene Testmatrix
- Contract: fehlend=null, vollständig ok, BzA-Nummer/fremde
  Schlüssel/Status → null.
- `F1304-DB-01`: Resolve zeigt Stand/Programm/Datum, JSON
  enthält weder Nummer noch Schlüsselnamen.
- `F1304-E2E-01`: Akte → BzA einreichen → Portal-Link →
  Übersicht zeigt „BzA eingereicht (BAFA)", Nummer nirgends.

## Bewusst offen
- Kundenportal-Aktivierung als Versand-Nebeneffekt: umgesetzt in
  F13-05 (`docs/spec/F13-05-portal-aktivierung.md`).
- Kunden-Rückmeldung, BnD-Beleg-Upload, Angebotsbindung,
  AI-Vorschlag.
