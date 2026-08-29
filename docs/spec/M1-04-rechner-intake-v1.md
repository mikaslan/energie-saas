# M1-04 — Rechner-V3-Intake v1

Status: **umgesetzt, unabhängig geprüft und lokal verifiziert**

Scope: Clone-seitige, versionierte Übergabe `Rechner V3 → Contact → Site → Project(request/open)`

Provider-Baseline: `wmee-remake-magic` / `rechner/v3` / `7be46ad6b10f783bd17c1d06f74f0efd9ce63e3f`

## Ziel

Eine Angebotsanfrage aus Rechner V3 landet genau einmal und vollständig im
richtigen Workspace. Die Aufnahme bewahrt die Recheneingaben, Herkunft und
Ergebnisse als unverifizierten Snapshot, erzeugt aber weder Katalogartikel noch
BOM- oder Angebotspositionen aus den heutigen Marktpreisschätzungen.

Der vertikale Pfad ist synchron und atomar:

```text
Browser
  → bestehender Rechner-V3-Server
  → HMAC-signiertes POST /api/inbound/rechner/v1
  → Receipt/Idempotenzreservierung
  → Contact-Dedupe
  → Site-Dedupe bzw. provisorische Site
  → Project(phase=request, outcome=open)
  → Rechner-Snapshot + versionierte Requirements
  → PII-freie Domain-Events/Audit
  → 201 processed oder 200 exact replay
```

Ein eigenes `Request`-Objekt wird nicht eingeführt. In der kanonischen
Architektur ist die Anfrage die Projektphase `request`.

## Vertrag als einzige Wahrheit

- Payload: `contracts/rechner-intake.v1.schema.json`
- HTTP/HMAC/Responses: `contracts/rechner-intake.v1.openapi.yaml`
- Golden Fixture: `contracts/examples/rechner-intake.v1.json`

Alle Objekte sind geschlossen (`additionalProperties: false`). Alle Felder sind
vorhanden; fachlich fehlende Werte sind explizit `null`. Rechner V3 darf keine
handgeschriebene, abweichende Kopie des Schemas pflegen. Der spätere
Provideradapter pinnt den SHA-256 des kanonischen Schema-Artefakts.
Die Privacy- und Deploymentwerte des Golden Fixtures sind ausschließlich
Vertragstestdaten und keine Freigabe für die produktive Anbindung.

Nicht übertragen werden PDF/Base64, 8.760-Stundenarrays, Cashflow-Jahreslisten,
Share-URLs oder Querystrings. Die heutige Share-URL enthält die Adresse in einem
unsignierten Base64-JSON und ist ausdrücklich kein Integrationsformat.

## Authentifizierung und Signatur

Nur der Rechner-V3-Server sendet an den Clone. Das Secret ist nie im Browser.

Pflichtheader:

```text
Idempotency-Key: <submissionId UUID>
X-Rechner-Key-Id: <opaque key id>
X-Rechner-Timestamp: <unix seconds>
X-Rechner-Content-SHA256: <lowercase SHA-256 über rohe Body-Bytes>
X-Rechner-Signature: v1=<base64url HMAC-SHA256>
```

Die HMAC-Nachricht ist bytegenau:

```text
v1
POST
/api/inbound/rechner/v1
<keyId>
<timestamp>
<idempotencyKey>
<bodySha256>
```

Regeln:

- maximal 256 KiB; die Grenze gilt beim Stream-Lesen, nicht erst nach dem Parsen;
- ausschließlich `application/json` mit optionalem Charset;
- jedes `Content-Encoding` einschließlich `identity` wird abgelehnt, damit
  signierte und verarbeitete Bytes exakt derselbe Datenstrom bleiben;
- Zeitfenster ±300 Sekunden;
- Body-Hash und HMAC werden constant-time verglichen;
- Signatur, UUID, Hash, Zeitstempel und Key-ID müssen kanonisch kodiert sein;
- Key-ID wird serverseitig auf genau einen Workspace und den Scope
  `rechner-intake.write` abgebildet;
- `workspaceId` kommt niemals aus dem Payload;
- aktive und vorherige Key-ID können parallel für Rotation hinterlegt sein;
- unbekannter Key, falsche Signatur und falscher Hash liefern dieselbe generische
  `401`-Antwort ohne Tenant-Audit aus Angreiferdaten.

Runtime-Konfiguration:

```text
RECHNER_INTAKE_KEYS_JSON=[
  {
    "keyId":"wmee-rechner-v3-2026-08",
    "workspaceId":"<uuid>",
    "scope":"rechner-intake.write",
    "secretBase64":"<mindestens 32 Zufallsbytes, Base64>"
  }
]
```

Fehlende oder ungültige Konfiguration ist fail-closed. Secrets werden weder in
Logs noch Fehlerantworten geschrieben.

## Idempotenz und Parallelität

Kanonischer Transportschlüssel ist
`(workspace_id, source_key, submission_id)`, mit `source_key = wmee-rechner-v3`.

- Der Receiver reserviert die Receipt-Zeile als erste fachliche Mutation.
- Eine transaktionsweite Receipt-Sperre auf Workspace, Source und Submission
  serialisiert Replays auch über zwei rotierende Keys, bevor das Fachlimit zählt.
- Identischer Schlüssel und identischer Raw-Body-SHA liefern dieselbe Receipt
  mit `200`, `duplicate: true` und erzeugen keine zweite Zeile.
- Derselbe Schlüssel mit anderem Hash liefert `409 idempotency_conflict`.
- Die Reservierung und sämtliche Fachmutationen laufen in einer Transaktion.
  Ein Fehler hinterlässt weder halben Contact noch Site, Project, Event oder
  Receipt.
- `INSERT … ON CONFLICT DO NOTHING` serialisiert parallele Wiederholungen am
  eindeutigen Schlüssel. Ein abgebrochener erster Versuch gibt die Reservierung
  vollständig frei.

Der Body, `submissionId` und `submittedAt` bleiben über Retries stabil. Ist ein
Retry später als das Signaturzeitfenster, darf der Transport-Zeitstempel neu
erzeugt werden; Body-Bytes und Idempotenzidentität ändern sich dadurch nicht.

## Contact-Mapping und Dedupe

Der Receiver normalisiert die E-Mail auf Kleinschreibung. Eine Telefonnummer
wird nur dann für Dedupe verwendet, wenn sie eindeutig als gültiges E.164
normalisiert werden kann; im deutschen Rechner-Kontext wird eine führende `0`
mit `+49` normalisiert. `phone_raw` bleibt für die fachliche Prüfung erhalten.

1. Suche innerhalb des verifizierten Workspace nach normalisierter E-Mail und,
   falls vorhanden, E.164-Telefon.
2. Genau ein widerspruchsfreier Treffer wird wiederverwendet. Nur bisher leere
   Felder dürfen ergänzt werden.
3. Zeigen E-Mail und Telefon auf verschiedene oder mehrere Kontakte, oder
   widerspricht der zweite Identifikator einem Treffer, wird nichts gemergt.
   Ein neuer Contact erhält `dedupe_review_required = true`.
4. Name wird nicht heuristisch in Vor-/Nachname zerlegt.
5. Die Rechner-Adresse wird nicht in eine Contact-Postadresse kopiert: Standort
   und Wohn-/Rechnungsadresse sind nicht zuverlässig dasselbe.

Marketing bleibt `false`. Art. 6 Abs. 1 lit. b DSGVO ist die Rechtsgrundlage
der konkreten Angebotsanfrage und keine Marketing-Einwilligung.

## Site-Mapping

- `selected`: nur unter demselben Contact und bei exakt derselben normalisierten
  Adresse wiederverwenden.
- Der SHA-256-Fingerprint trägt eine persistierte Algorithmusversion; V1 hasht
  Land, PLZ, Ort, Straße und Hausnummer nach konservativer Unicode-/Whitespace-
  Normalisierung. Ein späterer Algorithmus kann dadurch ohne falsche Treffer
  parallel eingeführt werden.
- `regional_estimate`: niemals anhand der gemeinsamen Rhein-Neckar-Koordinate
  deduplizieren; immer eine neue provisorische Site mit
  `address_follow_up_required = true` erzeugen.
- `pin_confirmed` ist immer `false`. Ein Geocoding-Treffer ist keine
  kundenseitige Planungsfreigabe.
- Angebot/Fachplanung verlangen später eine bestätigte reale Adresse und einen
  bestätigten Pin; ein regionaler Richtwert reicht dafür nie aus.

## Project, Requirements und Rechner-Snapshot

Jede neue `submissionId` erzeugt ein Project:

- `phase = request`
- `outcome = open`
- `source_key = wmee-rechner-v3`
- keine stillschweigende Zuweisung an einen Nutzer
- `catalog_resolution_status = pending`

`requestedProducts` wird als immutable, geschlossen versionierte
`project-requirements.rechner.v1`-Anforderung gespeichert. Bestandsanlagendaten
bleiben ausschließlich im Rechner-Snapshot. Es entstehen keine SKU, Marke,
Stückliste, Katalogreferenz, Preis- oder kommerzielle Position.

Der Rechner-Snapshot speichert `calculation` ohne Customer- und Site-Kopie. Die
Integritätskennzeichnung bleibt `client_reported_unverified`. Der aktuelle
Rechner verwendet `market_estimate`; erst ein späterer Angebotsservice löst
echte Workspace-Katalogprodukte auf und friert Preise, Steuer und
Leistungsumfang als kommerziellen Snapshot ein.

## Datenschutz und Protokollierung

- Contact/Site sind löschbare Fachtabellen.
- Domain-Events und Audit enthalten ausschließlich IDs und technische
  Klassifizierungen, nie Name, E-Mail, Telefon, Adresse, Koordinaten oder den
  Rechner-Payload.
- 422 nennt höchstens JSON-Pfade, nie fehlerhafte Werte.
- Request-/Error-Logs enthalten `requestId`, Status und technische Fehlerklasse,
  nicht Body oder Signaturheader.
- Die Fehlertelemetrie läuft mit deaktivierter Standard-PII-Übertragung und
  entfernt Request-Body, Cookies, Auth-, Signatur- und Idempotenzheader; am
  Intake-Endpunkt werden zusätzlich Querystring und Fragment verworfen.
- Der produktive Provideradapter bleibt gesperrt, bis der veröffentlichte
  Datenschutzhinweis Rechner/Clone korrekt beschreibt und eine echte
  `noticeVersion` feststeht.

## HTTP-Antworten

```json
{
  "contractVersion": "rechner-intake-receipt.v1",
  "receiptId": "uuid",
  "submissionId": "uuid",
  "status": "processed",
  "duplicate": false
}
```

- `201`: neu, vollständig verarbeitet
- `200`: bit-identischer Replay
- `400`: Header-/JSON-Konsistenz
- `401`: generisches Auth-/Signaturversagen
- `409`: Idempotenzkonflikt
- `413`: Body zu groß
- `415`: falscher Media Type
- `422`: Schemafehler, nur Feldpfade
- `429`: authentifiziertes Aufnahmelimit, mit `Retry-After`
- `500/503`: retryable; Fachtransaktion vollständig zurückgerollt

V3 wiederholt nur Netzwerkfehler, `429` und `5xx` mit exponentiellem Jitter.
`4xx` und `409` werden nicht automatisch wiederholt.

## Datenbankinvarianten

Jede neue Tenant-Tabelle erfüllt ohne Ausnahme:

- `workspace_id NOT NULL`
- validierter FK `workspace_id → workspace.id`
- `UNIQUE (workspace_id, id)`
- ausschließlich zusammengesetzte FKs zu Tenant-Entitäten
- `ENABLE ROW LEVEL SECURITY` und `FORCE ROW LEVEL SECURITY`
- genau eine permissive Policy `tenant_isolation` mit identischem `USING` und
  `WITH CHECK`
- explizite Fixture und explizites Runtime-ACL-Manifest

Die Web-Runtime erhält nur die für Contact/Site/Project/Intake nötigen
`SELECT/INSERT/UPDATE`-Rechte. Worker, Auth und System erhalten keinen neuen
Fachzugriff.

## Abnahmekriterien

- Golden Fixture validiert gegen das kanonische Draft-2020-12-Schema.
- Contract-SHA ist gepinnt; Drift wird im Test sichtbar.
- HMAC-Golden-Vektor sowie falsche Bytes, Route, Methode, Key, Timestamp,
  Rotation und Größenlimit sind getestet.
- `Idempotency-Key === submissionId` ist erzwungen.
- Exact Replay, Conflict und paralleler Replay sind getestet.
- Contact-Dedupe-Matrix einschließlich Split-Match ist getestet.
- Regionaler Richtwert legt nie Sites verschiedener Leads zusammen.
- Cross-Tenant-FKs, RLS, Fixtures und Rollen-ACLs sind katalogbasiert geprüft.
- Ein absichtlicher Fehler nach der Reservierung beweist vollständigen Rollback.
- Existing-Installation-Union einschließlich `retrofit: null` validiert.
- Events/Audit/Fehler enthalten keine PII.
- Kein Katalogprodukt, keine BOM und kein Angebot entsteht aus Rechnerpreisen.
- `npm run check` und `npm run build` sind grün.

## Bewusst offen nach M1-04

Diese Entscheidungen werden nicht stillschweigend getroffen:

1. Ziel-Workspace und Key-Rotation werden erst beim echten Secret-Provisioning
   gesetzt; es gibt keine hart codierte Produktions-ID.
2. Kanban-Spalte und Default-Zuständiger bleiben leer, bis der Vertrieb sie
   festlegt.
3. Der veröffentlichte Datenschutzhinweis und seine Aufbewahrungsfrist brauchen
   fachliche Freigabe vor Provider-Wiring.
4. Der bestehende Kunden-PDF-Mailpfad bleibt unangetastet, bis Source-Outbox und
   fachliches Erfolgsversprechen gemeinsam entschieden sind.
5. Ein Edge-/WAF-Limit für ungültige Requests ist ein Betriebs-Gate. Das
   authentifizierte Fachlimit kann ohne zusätzliche CRM- oder Queue-Lizenz in
   PostgreSQL laufen.

Für diesen Slice ist kein zusätzliches CRM-System und kein Kauf-Plugin nötig.
Next.js, Node-Crypto und PostgreSQL reichen aus.
