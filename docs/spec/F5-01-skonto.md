# F5-01 Skonto-Konditionen (Rechnung)

Ziel: Skonto (Prozent + Frist) je Rechnung, durchgängig Entwurf -> Ausstellung -> Liste.

## ESTIMATE (reversibel, Referenzfrage offen)
- Skonto = reine Zahlungskondition in Basispunkten (200 = 2 %) + Frist in Tagen
  ab Ausstellung; keine Summenwirkung. Exakte Reonic-Skonto-Semantik UNKNOWN.
- Nur Typ `invoice`, nur im Entwurf editierbar; ab Ausstellung friert der
  M301-Guard ein, der Ausstellungs-Snapshot hält die Kondition fest.

## Scopes
1. `setDocumentTerms` (invoice, draft-only; Paar-Regel beide-oder-keins,
   0..10000 bps, 0..365 Tage). Neue Permission: keine (invoicing.write).
2. Skonto-Dialog in den Rechnungs-Zeilenaktionen (Entwurf) + Anzeige in der
   Fälligkeits-Spalte („2 % Skonto / 10 Tage").
