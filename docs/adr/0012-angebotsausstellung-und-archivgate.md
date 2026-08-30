# ADR 0012: Angebotsausstellung und getrenntes Archivgate

- Status: entschieden fuer M2-03b1; M2-03b2 extern blockiert
- Implementierungsstand: M2-03b1 `REVIEWED/VERIFIED (lokal)` · technisches
  Gate **GO**; M2-03b2 `BLOCKED`
- Datum: 2026-08-30
- Bereich: F2.7 PARTIAL, F16.2 PARTIAL

## Kontext

M2-03a endet absichtlich bei einem intern freigegebenen PDF mit der sichtbaren
Kennzeichnung `Freigabekandidat · nicht ausgestellt · nicht versendet`. Diese
Bytes koennen weder durch Umbenennen noch durch Metadaten zu einem
Ausstellungsdokument werden. Gleichzeitig sind der produktive Object-Lock-
Bucket, die Archiv-Credentials, die verantwortete Retention-Policy und der
empirische Provider-Readback noch nicht vorhanden.

Die oeffentliche Reonic-Dokumentation beschreibt den Versand zur Signatur als
Freeze-Punkt fuer den bepreisten PDF-Stand. Sie belegt weder einen eigenen
`issued`-Status noch Object-Lock-, Retention- oder Transaktionsdetails. WMEE
entscheidet deshalb eine eigene, strengere Ausstellungsgrenze und behauptet
damit keine private Reonic-Produktwahrheit.

## Entscheidung

M2-03b ist ein fachlicher Vertrag mit zwei getrennten technischen Gates:

1. **M2-03b1 · Ausstellungsfassung:** Aus dem unveraenderlich freigegebenen
   Candidate-Input wird ein neues, finales PDF gerendert. Das PDF enthaelt
   keinen Candidate-/Entwurfsstatus; die interne UI kennzeichnet den Stand bis
   zum Archivnachweis weiter als nicht ausgestellt. Zwei verschiedene interne
   Personen geben exakt diese neuen Bytes fuer die Archivierung frei. Das
   Ergebnis heisst ausschliesslich `approved_for_archive_not_issued`.
2. **M2-03b2 · Archivierung/Ausstellung:** Ein eigener Archivworker schreibt
   exakt diese freigegebenen Bytes unter einem ID-only-Key in einen echten
   Object-Lock-COMPLIANCE-Bucket. Nur ein vollstaendiger, versionsspezifischer
   Readback darf eine append-only Archivevidence und daraus `issued` erzeugen.

M2-03b1 enthaelt weder eine DB-Kante noch einen Fake-/Emulatorpfad zu `issued`.
M2-03b2 wird erst nach separater Freigabe fuer Kauf/Provisionierung und nach
dem Live-Testgate umgesetzt beziehungsweise als `VERIFIED` gewertet. MinIO,
LocalStack, Mocks und In-Memory-Adapter duerfen technische Negativ- und
Vertragstests liefern, aber niemals einen verifizierten Ausstellungsstatus.

## Zustandsmodell

M2-03b1 besitzt einen stabilen fachlichen Renderjob:

```text
missing -- request --> queued
queued -- claim --> running
running -- success --> ready_for_approval
running -- retryable failure --> retry_wait -- due --> running
running -- final/integrity failure --> failed_final
ready_for_approval -- first approval --> approval_pending
approval_pending -- second distinct approval --> approved_for_archive_not_issued
queued|running|retry_wait|failed_final|ready_for_approval|
approval_pending|approved_for_archive_not_issued
  -- withdrawal --> withdrawn_before_archive
```

`approval_pending` und `approved_for_archive_not_issued` sind aus append-only
Approvals abgeleitete Lesestaende. Withdrawal ist aus jedem bereits angelegten,
noch nicht archivierten Zustand erlaubt, ebenfalls append-only und terminal;
laufende beziehungsweise spaet eintreffende Worker duerfen danach weder
finalisieren noch freigeben. Eine Korrektur erzeugt immer eine neue
Ausstellungsfassung.

M2-03b2 ergaenzt spaeter eine getrennte Archiv-Saga:

```text
approved_for_archive_not_issued --> archive_queued --> archiving
archiving --> archive_retry_wait --> archiving
archiving --> archive_integrity_failed
archiving -- complete live readback --> issued
```

Ein Worker-Crash nach Upload, aber vor DB-Finalisierung darf nie automatisch
`issued` erzeugen. Recovery muss dieselbe konkrete Version wiederfinden und
vollstaendig verifizieren oder fail-closed enden.

## Byte- und Freigabevertrag

- Candidate-Bytes werden nie kopiert, umbenannt oder promotet.
- Der Issuance-Input bindet Candidate, Candidate-Approval, versiegelten
  Candidate-Input, Varianten-, Profil- und Empfaengerstand sowie das eigene
  Template-/Rendererrezept.
- Das Ausstellungs-PDF ist eine neue Bytefolge ohne vorlaeufige Kennzeichnung.
  Vor erfolgreichem Archivgate darf es nur intern und privat gelesen werden.
- Jede Freigabe rehashiert die tatsaechlichen gespeicherten Bytes und bindet
  Issuance-ID, Artifact-SHA, Bytezahl, Input-SHA und alle Quellrevisionen.
- Zwei unterschiedliche aktive interne Benutzer muessen freigeben. Mindestens
  eine Person muss vom Candidate-Freigeber verschieden sein. Admins umgehen
  weder diese Regel noch Byte-, Tenant- oder Driftpruefungen.
- Derselbe exakte Request bleibt auch nach einem terminalen Fehler oder
  Withdrawal auf dieselbe Issuance-ID gebunden und wird nie wiederbelebt. Eine
  neue Issuance-ID erfordert einen neuen Candidate mit neuer Quellbindung;
  alte Freigaben werden nie auf neue Bytes uebertragen.

Die Vier-Augen-Regel ist eine eigene WMEE-Sicherheitsentscheidung und keine
beobachtete Reonic-Paritaetsaussage. Sie kann spaeter nur durch einen neuen,
expliziten ADR geaendert werden.

## M2-03b2: vollstaendiger Archivnachweis

`issued` darf erst entstehen, wenn dieselbe Objektversion alle folgenden
Pruefungen besteht:

1. Bucket Object Lock ist aktiviert und Versioning ist `Enabled`.
2. Upload liefert eine nichtleere `VersionId`.
3. Objekt-Retention ist `COMPLIANCE`.
4. `RetainUntilDate` entspricht der verantworteten, serverseitigen Policy und
   liegt innerhalb eines eng begrenzten Uhrzeitfensters.
5. MIME ist exakt `application/pdf` und die Laenge stimmt.
6. S3-SHA-256-Checksumme und eigenes SHA-256-Metadatum stimmen.
7. Ein neuer `GetObject` mit genau dieser `VersionId` wird gestreamt und erneut
   SHA-256-gehasht; Ergebnis und Bytezahl stimmen mit der Freigabe ueberein.

ETag ist kein Inhaltsnachweis. Storage-Key, VersionId, Retentionmodus,
RetainUntil, Laenge, MIME, freigegebener Hash, Readback-Hash, Providervertrag
und Rezeptversion werden in einer append-only Evidence gebunden.

Die konkrete Retention-Dauer wird nicht im Code erfunden. Bis Legal/Owner die
Aufbewahrung gegen DSGVO-Erasure und die Dokumentart verantwortet entschieden
haben, bleibt der produktive Archivstart blockiert.

## Autorisierung und Secret-Grenzen

- `offer.issue.prepare`: Ausstellungsfassung anfordern/replayen.
- `offer.issue.approve`: exakte Ausstellungsbytes freigeben.
- `offer.issue.withdraw`: Freigabestand vor Archivierung zurueckziehen.
- `app_worker`: nur ID-only Render-Claim/Finalize/Recovery.
- spaeter `app_archive_worker`: nur Archive-Claim, Storage und Evidence-
  Finalisierung; keine menschliche Freigabe.

Der Next.js-Webprozess und der Chromium-Renderer erhalten keine
Archiv-Credentials. Der Archivworker darf keine Approval schreiben. Der
Approver darf keine Archivevidence schreiben. UI-Sichtbarkeit ist keine
Sicherheitsgrenze; Service, SECURITY-DEFINER-Funktionen, genaue Rollenrechte,
RLS und zusammengesetzte Tenant-FKs pruefen erneut.

## Datenschutz und Betrieb

- Queue-Payload und Dispatch bleiben ID-only. Der Worker lädt den versiegelten
  Dokumentinput unter Tenantkontext; Events, Audit und Logs bleiben redigiert
  und enthalten weder PII, Rechtstexte, Preise, PDF-Bytes, Vollhashes noch
  Provider-Secrets.
- Storage-Keys enthalten nur Workspace-/Fach-IDs und einen festen Namespace.
- Vor `issued` bleiben Ausstellungsbytes im Offer-Erasuregraphen. Das
  Verhalten nach `issued` wird erst zusammen mit der Retention-Policy gebaut.
- Kein Versand, oeffentlicher Link, View-Tracking, Signaturtoken, `Won` oder
  Installation ist Teil dieses ADRs.

## Konsequenzen

- M2-03b1 ist lokal vollstaendig pruefbar, ohne einen externen Anbieter oder
  eine irreversible Retention zu simulieren.
- Die UI kann einen finalen Dokumentstand vorbereiten, behauptet aber bis zum
  Live-Archivreadback ehrlich `noch nicht ausgestellt`.
- M2-03b2 bleibt sichtbar `BLOCKED`, statt einen Mock als Compliancebeleg zu
  verkaufen.
- Ein Widerspruch in Candidate-/Varianten-/Approval-Bindungen laesst die
  gesamte Offer-Seite bewusst fail-closed enden, statt ein scheinbar
  vollstaendiges Issuance-Panel aus einem Teilstand zu rendern. Zusammengesetzte
  FKs, DB-Guards und vollstaendige Reads in derselben Transaktion machen den
  Fall in gueltigem Zustand unerreichbar; sichtbare Korruption ist sicherer als
  ein degradierter Freigabepfad.
- Versand und Signatur duerfen erst auf einem echten `issued`-Artefakt
  aufbauen.

## Quellen

- Reonic, oeffentliche Dokumentation: [Preview an offer and manage link
  validity](https://docs.reonic.com/docs/en/offers-finalise-cat-preview-variants-legal-texts-offer-link-validity),
  Zugriff 2026-08-30.
- Hetzner, Object Lock/Retention: [Protect objects with Object Lock and
  Retention](https://docs.hetzner.com/storage/object-storage/howto-protect-objects/protect-object-lock-retention/),
  Zugriff 2026-08-30.
- AWS SDK v3, S3-Beispiele fuer Retention-/Versionsreadback: [Amazon S3 code
  examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html),
  Zugriff 2026-08-30.
