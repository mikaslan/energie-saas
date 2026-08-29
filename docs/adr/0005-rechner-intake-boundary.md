# ADR 0005: Signierte, synchrone Rechner-Intake-Grenze

- Status: angenommen
- Datum: 2026-08-29
- Bezug: `docs/spec/M1-04-rechner-intake-v1.md`

## Kontext

Rechner V3 wird parallel in einem anderen Repository gebaut. Der heutige
Kontaktendpunkt verschickt E-Mails, besitzt aber keine CRM-Persistenz,
Idempotenz oder tenantgebundene Server-Authentifizierung. Seine Preise sind
Marktschätzungen. Der Clone hat seit M1-03 getrennte Datenbankrollen; der Worker
darf ausschließlich `pgboss` verwenden und erhält bewusst kein Runtime-Secret.

Eine Browser-Integration würde ein Secret veröffentlichen. Eine asynchrone
Mapping-Pipeline würde dagegen zuerst einen neuen, eng begrenzten
Job-Domain-Principal, dessen Secretverteilung und eine weitere Recovery-Grenze
benötigen.

## Entscheidung

Der erste vertikale Schnitt ist ein synchroner, HMAC-signierter
Server-zu-Server-Endpunkt im Clone.

Die verifizierte Key-ID bestimmt Workspace und Scope. Der Payload kann keinen
Tenant wählen. Eine eigene opaque Integration Identity öffnet den
Tenant-Kontext; es wird kein künstlicher Nutzer-`ServiceCtx` konstruiert.

Idempotenzreservierung, Contact, Site, Project, Rechner-Snapshot, Requirements,
Events und Erfolgs-Audit committen in genau einer Tenant-Transaktion. Der
Rechner bekommt erst danach `processed`. Ein Exact Replay erhält dieselbe
Receipt. Eine Receipt-spezifische Advisory-Sperre liegt vor Rate-Limit und
Contact-Dedupe, damit Key-Rotation einen Replay weder doppelt verarbeitet noch
als neue Anfrage limitiert.

Das Payload-Schema ist ein eigenständiges Draft-2020-12-Artefakt. OpenAPI
referenziert dieses Artefakt, damit kein zweites Schema auseinanderlaufen kann.

## Konsequenzen

- Rechner V3 kann unabhängig weitergebaut werden; Clone und Provider koppeln
  erst nach Vertragsfreigabe über Fixture und Schema-SHA.
- Kein Queue-/CRM-Zukauf ist für M1-04 nötig.
- Der HTTP-Aufruf dauert bis zum Datenbank-Commit. Dafür ist sein Erfolg fachlich
  eindeutig und es gibt keinen `202`, der später unbemerkt scheitern kann.
- Bei dauerhaftem hohen Volumen kann später eine Outbox-/Queue-Variante folgen.
  Vorher braucht sie einen eigenen Job-Domain-Principal und eine neue ADR.
- Rechnerpreise bleiben unverifizierter Snapshot; echte Angebote dürfen nur
  aus dem Workspace-Katalog entstehen.
- Exakte Adressen erhalten einen versionierten, contactgebundenen Fingerprint;
  regionale Richtwerte besitzen bewusst keinen Fingerprint.
- Regionale Standardkoordinaten erzeugen immer provisorische Sites und dürfen
  nie als reale Kundenadresse dedupliziert werden.
- Ungültige Key-IDs erzeugen kein Tenant-Audit. Sonst könnte ein Angreifer in
  einen von ihm gewählten append-only Mandantenbereich schreiben.

## Verworfene Alternativen

### Direkt aus dem Browser in den Clone

Verworfen, weil HMAC-Secrets im Browser nicht geheim bleiben und der Browser
keinen vertrauenswürdigen Tenant-Kontext liefert.

### E-Mail als CRM-Transport

Verworfen, weil E-Mail keine atomare, maschinenlesbare Idempotenz-, Dedupe- oder
Tenant-Garantie liefert.

### Sofort `202 Accepted` und Mapping über den vorhandenen Worker

Verworfen für M1-04. `app_worker` ist absichtlich auf `pgboss` begrenzt. Ihm
Fachtabellen oder das Intake-Secret zu geben würde den gerade abgenommenen
Rollenvertrag aufweichen. Eine spätere Queue-Lösung ist eine eigene
Principal-/Recovery-Entscheidung.

### Externes CRM als Zwischensystem

Verworfen für diesen Schnitt. Es würde eine zusätzliche Datenkopie,
Auftragsverarbeitung, Kosten und Fehlergrenze einführen, ohne eine Fähigkeit zu
liefern, die PostgreSQL und die bestehenden Module hier nicht abdecken.
