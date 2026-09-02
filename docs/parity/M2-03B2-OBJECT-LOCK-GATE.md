# M2-03b2 — Object-Lock-Gate: Anforderungsprofil (provider-unabhängig)

Stand: 2026-09-02 · Status: VORBEREITET · Externes Gate BLOCKED bis ein echter
S3-Object-Lock-Endpunkt bereitsteht (Eigentümer-Entscheid).

## Zweck

M2-03b2 (WORM-Nachweis für ausgestellte Angebots-Artefakte) ist extern
BLOCKED, weil lokal kein echter Object-Lock-Speicher verfügbar ist. Dieses
Profil definiert die minimalen Nachweise, damit das Gate SOFORT ablaufen kann,
wenn ein Provider-Sandbox (z. B. AWS S3 mit Object Lock, MinIO mit
Object-Lock-Unterstützung) oder ein lokaler S3-kompatibler Dienst mit
Lock-Feature bereitsteht. Es ist bewusst provider-neutral formuliert.

## Erforderliche Nachweise (alle, in dieser Reihenfolge)

1. **COMPLIANCE-Modus:** Bucket/Store mit Object Lock im COMPLIANCE-Modus
   anlegen (nicht GOVERNANCE, das durch S3:DeleteObject+bypass ausgehebelt
   werden kann).
2. **Retention:** Für ein Testartefakt eine Retain-Until-Date in der
   Vergangenheit-Zukunft setzen; Nachweis, dass
   - ein Delete-Versuch mit `409`/`AccessDenied` (je Provider) abgelehnt wird,
   - ein Overwrite/PUT desselben Keys abgelehnt wird oder eine neue Version
     erzeugt (dokumentieren, welches Verhalten der Provider zeigt).
3. **Legal Hold:** Hold setzen → Delete abgelehnt; Hold entfernen → Delete
   weiterhin durch Retention abgelehnt (COMPLIANCE); Beleg beider Schritte.
4. **Readback:** Das unter Lock gestellte Objekt byte-identisch zurücklesen
   (SHA-256 vor Upload vs. nach Readback).
5. **Retention-Verlängerung:** Retain-Until verlängern ist erlaubt und
   verändert den Hash nicht; Verkürzen wird abgelehnt.
6. **DSGVO-Kollision:** Dokumentieren, wie der bestehende Krypto-Shredding-
   beziehungsweise Pseudonymisierungs-Pfad mit WORM kollidiert und welcher
   Erasure-Vertrag gilt (Referenz: M2-03b1-Abnahme, Erasuregraph). Kein
   „Löschen" per Provider-Bypass.

## Nachweiskette im Repo

- Testscript unter `tests/` (Vitest/Node, SDK: `@aws-sdk/client-s3`, das
  bereits installiert ist) gegen die in `.env.local` bereitgestellten
  Endpoint/Credentials; Endpoint-URL und Bucket-Name NIE committen.
- Ergebnisprotokoll nach `docs/parity/TEST-EVIDENCE.md` (Abschnitt M2-03b2).
- Erst nach grünem Gate: `M203B2` aus BLOCKED auf VERIFIED (extern belegt)
  heben; ohne dieses Gate bleibt der Status BLOCKED und kein Artefakt wird als
  „issued" bezeichnet.

## Annahmen (ESTIMATE, bis Provider gewählt)

- Provider: S3-kompatibel mit Object Lock (COMPLIANCE), Region/Bucket durch
  Eigentümer.
- Kein produktiver Kunden-Artefakt-Import für das Gate; ausschließlich
  synthetisches Testobjekt.
