# M2-04b — Token-Orakel-Härtung der öffentlichen Signatur-Kapseln

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-13

Basis: Katalog F2.8/M2-04 (E-Signatur) · Anlass: TODO M2-04b (Kimi-P2 b2) in
`lib/integrations/offers/signature-contract.ts`.

## Ziel und Abgrenzung

Deformiertes Roh-Token fällt an den vier öffentlichen Roh-Token-Kapseln
(`signSignatureByToken`, `revokeSignatureByCustomer`, `recordSignatureView`,
`resolveSignatureByToken` in `modules/signatures/service.ts`) uniform auf
NotFound — nie `TypeError`/500. Wohlgeformt-unbekannt und deformiert sind
ununterscheidbar (kein Orakel über Existenz, Stand oder Token-Format).

Nicht-Ziele (bleiben BLOCKED): öffentliches Rendern `/s/[token]` bis
M2-03b2/`issued` (DEC-M204-04, extern: Object-Lock/Storage); E-Mail-Versand
(Resend-Slice); keine neue Migration, keine neue Permission, kein Provider.

## Umsetzung

- `hashPublicSignatureToken` (service-lokal): mappt `TypeError` aus
  `hashSignatureToken` auf `SignatureNotFoundError`; andere Fehler passieren
  durch. Keine Schichten-Verletzung (Contract wirft weiter roh).
- `recordSignatureView` gibt bei deformiertem Token das zum unbekannten Token
  byte-identische `not_found`-Payload zurück (`{requestId: null,
  status: "not_found", viewCount: 0, firstViewedAt: null}`) statt zu werfen —
  belegt an `record_signature_view` (0044: `IF NOT FOUND → {status:not_found}`).
- Sign/Revoke/Resolve werfen `SignatureNotFoundError` — identisch zum
  unbekannten Hash (Kapseln melden `{status:"not_found"}` als Rückgabe,
  Service mappt per `mapNonSuccess`/Row-Check).

## Akzeptanz

- `tests/db/m204b-token-orakel.test.ts`: M204B-DB-01 (3 deformierte Formen ×
  4 Kapseln), M204B-DB-02 (wohlgeformt-unbekannt, Uniformität). RED belegt
  (Alt-Code: DB-01 rot), GREEN mit Fix.
- Nachbarn 47/47 (m204-Service/Strict, f1002c, f1003, f208b-Upgrade, f806),
  tsc/eslint/depcruise grün. Kein E2E (Kapseln ungeroutet bis M2-03b2).
