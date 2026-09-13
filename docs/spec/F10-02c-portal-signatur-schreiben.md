# F10-02c Portal-Signatur schreiben (Annehmen + Widerrufen)

F10-02b projiziert den Signatur-Status lesend und stellt fest: Schreiben
(signieren/widerrufen) bleibt eigener Slice. Dieser Slice liefert ihn —
Katalog F10.2 „Angebot (E-Signatur + Widerruf)".

## Vertrag

- Zwei neue `SECURITY DEFINER`-Kapseln (Migration 0140, `REVOKE ALL FROM
  PUBLIC`, Owner-Tanz nach Muster `post_subsidy_message` F13-10 —
  ohne app_owner-Ownership scheitert der Invite-Lookup an der
  Actor-Restrictive-Policy (`portal_invite`, FORCE RLS), belegt per
  wortgleicher Kapsel-Kopie):
  `sign_signature_by_invite(invite_token_hash, issuance_id)` und
  `revoke_signature_by_invite(invite_token_hash, issuance_id)`.
- Jede Kapsel prüft: Invite über `portal_token_locator` gefunden, Status
  `active`, nicht abgelaufen; `signature_request` zu
  `(workspace, issuance_id)` gehört zum Invite-Projekt. Sonst uniform
  `not_found` (kein Orakel über Invite-, Beleg- oder Request-Existenz).
- Bei Treffer delegiert die Kapsel an die verifizierte Terminalkante
  (`sign_signature_by_token` mit Modus `click`, NULL-Artefakt bzw.
  `revoke_signature_by_customer`) und reicht deren jsonb-Antwort
  unverändert durch. Won-Kopplung, Events und Audit entstehen per
  Attestierungs-Trigger (F2.8b) — keine zweite Terminalimplementierung.
- Service-Wrapper (`modules/signatures`, pool-basiert wie
  `signSignatureByToken`): `signSignatureByInviteToken`,
  `revokeSignatureByInviteToken`. Toter Invite → `SignatureNotFoundError`
  (Muster `confirmServiceCaseByToken`); Kapsel-Statusse werden wie die
  Token-Pendants gemappt (`already_signed`→Replay-ok,
  `revoked_by_customer`+replayed→Replay-ok, sonst Fehlerklassen der
  M2-04-Familie).
- Portal-Route `POST /p/[token]/signatur` (Muster
  `service-cases/route.ts`): `action=sign|revoke` + `issuanceId`,
  Ergebnis per `?sign=ok|bereits|fehler` bzw. `?revoke=ok|bereits|fehler`
  (beobachtbar ohne JS). Fremd/abgelaufen/falscher Stand fällt uniform
  auf `fehler`.
- UI: Dokumentzeile mit `signatureStatus` = `pending` zeigt „Annehmen",
  mit `signed` zeigt „Widerrufen" (DE/EN, ohne JS per Form-POST).
  Kein Signatur-Token verlässt je den Server (F10-02b-Privacy gilt).

## Regeln

1. Modus ist fest `click` (Vertragsmodus ohne Artefakt; `draw`/`analog`
   bleiben den internen Pfaden). Kein Namensfeld: Signatur-Name löst die
   Kapsel aus dem Angebots-Contact (M2-04-Semantik).
2. Widerruf nur aus `signed` (14-Tage-Fenster der Basiskapsel gilt);
   `pending` widerruft allein intern (Reonic-Beleg F2.8b).
3. Keine neue Permission, keine Migration jenseits 0140, kein Provider.

## Tests

- DB (`f1002c-portal-signature-write`): Kette wie M2-04-DB (Fixture →
  Issuance → Request → Invite): sign pending→signed (Modus click,
  Attestierung vorhanden), Double-sign→bereits, revoke signed→
  revoked_by_customer, Double-revoke→bereits, revoke pending→fehler,
  fremde Issuance→NotFound, entzogener Invite→NotFound.
- E2E (`F10-02c-E2E-01`): isolierter Workspace, Lead→Projekt→Invite per
  UI, Issuance+Request per SQL-Seed (F10-07-Muster), Portal zeigt
  Annehmen → Klick → Status signiert; danach Widerrufen → Status
  widerrufen. Keine Konsolenfehler.
