# F10-07 Portal-Dokument-Download (My-Files-Rest)

Nächster fehlender Portal-Pfad (STATUS F10: „My-Files-Rest" offen):
Dokumente (freigegebene Ausstellungsfassungen) sind im Portal lesbar
gelistet (F10.1/F10.2B), aber nicht herunterladbar. Dieser Slice schließt
Anzeige → Download durchgängig an. Versand (E-Mail, Provider) bleibt
getrennt offen.

## ESTIMATE (reversibel, keine Reonic-Referenz für den Portal-Download)

- Dateiname `{offer_number}-Ausstellungsfassung.pdf` (ASCII,
  deterministisch); Inhalt exakt das versiegelte Final-Artefakt.
- Download-Wort DE „Herunterladen"/EN „Download" (F10-06-Muster).

## Vertrag

- Migration `0116_f10_07_portal_document_download` (nur Funktion, Journal
  von Hand, kein Snapshot — F10-02b-Muster):
  `read_portal_issuance_artifact(token_hash, issuance_id)` (SECURITY
  DEFINER): Invite gültig (aktiv, nicht abgelaufen) + Issuance in
  Mandant+Projekt + Portal-Projektion (2/2 Freigaben, kein Rückzug —
  gleiche Bedingungen wie `resolve_portal_public_view`) → Artefakt-Zeile,
  sonst null Zeilen (kein Orakel). Read-only (kein Event/Touch).
- Service `readPortalDocumentArtifactByToken(pool, {token, issuanceId})`
  (modules/offers, `file-requests`-Muster: Portal-Import ohne Zyklus):
  Projektion auflösen (uniform NotFound) → Zugehörigkeit zur
  `view.documents`-Liste (gleicher Fehler, Commercial fällt hier
  automatisch heraus) → DEFINER-Funktion → SHA256/Größe wie interner Pfad
  (Mismatch → Integrity). Keine neue Permission (rollenloser Token-Pfad).
- Route `GET /p/[token]/dokumente/[issuanceId]`: private Header +
  Attachment wie interner Ausstellungsfassungs-Pfad; 404 uniform,
  503 bei Integrität. Keine `lang`-Pflicht (stateless Link trägt sie).
- UI: Download-Link je Dokument (Übersichts-Tab, commercial
  unverändert ohne Dokumente-Bereich).

## Regeln

1. Fail-closed ohne Orakel: toter Link, fremde/unfreigegebene/
   zurückgezogene Issuance, Commercial → identisch 404.
2. Nie Draft-/Candidate-Bytes: nur versiegelte Final-Artefakte
   freigegebener Issuances.
3. Kein Caching sensibler Dokumente (`private, no-store`).

## Tests

- DB (`f1007-portal-document-download`, Builder nach F1003-Muster):
  freigegeben → Bytes/Name/Mime/Datum; Rückzug → NotFound; Fremdprojekt
  → NotFound; toter Token/unbekannte Issuance → NotFound (kein Orakel);
  halbe Freigabe (1/2, nicht projiziert) → NotFound; deformierte Eingaben
  → Validation. Bytes/SHA/Größe sichert zusätzlich der DB-Check
  (`offer_issuance_artifact_ck`); `%PDF`/EOF prüft die Route.
- E2E (`F10-07-E2E-01`): Portal mit freigegebenem Dokument zeigt
  Download-Link; GET liefert PDF (Content-Type + `%PDF`); unbekannte
  Issuance → 404; keine Browser-Fehler.
- Nachbarn: Portal-Specs (F10-01..06, F13-04..09), m111a-Pins (0116),
  m203b1, f1003, generate ohne Drift.

## Bewusst offen

- Versand (E-Mail, braucht Provider), Angebotsbindung F13
  (Q-F13-ANGEBOTSBINDUNG-M2), Download-Protokollierung/Audit.
