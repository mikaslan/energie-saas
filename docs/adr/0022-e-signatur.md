# ADR 0022 — E-Signatur: Hash-Bindung, TTL und Zustandsmodell für F2.8

- Status: VORGESCHLAGEN (im Rahmen der M2-04-Spec DISCOVERED→SPECIFIED)
- Datum: 2026-09-02

> **Nummern-Kollision (Root-Klärung nötig):** In derselben Arbeitsfläche liegt
> bereits die parallele, uncommittete Lane `docs/adr/0021-termine-kalender.md`
> (M1-15 „Termine & Kalender", F1.9). Beide ADRs beanspruchen die Nummer `0021`.
> Dieser Entwurf folgt dem expliziten Slice-Auftrag („0021-e-signatur.md,
> 0019/0020 vergeben"), überlässt die finale Vergabe aber dem Root-Integrator:
> eine der beiden Lanes muss auf `0022` ausweichen. Die hier genutzte Nummer
> wird in `docs/spec/M2-04-e-signatur.md` als `ADR 0022 (E-Signatur)`
> referenziert; bei Umnummerierung ist diese Referenz mitzuziehen.
- Betroffene Slice-Spec: `docs/spec/M2-04-e-signatur.md`
- Basis: Spec-/ADR-Ablage `tooling` HEAD `788d142`; funktionale Hash-/Issuance-Basis
  M2-03b1 `a06f961` (Worktree `energie-saas-m203b-issuance-archive`, **noch nicht**
  in `tooling`/`main` integriert — siehe Konsequenzen)

## Kontext

F2.8 (Modulkatalog Zeile 37) verlangt die E-Signatur: Signaturlink mit TTL,
View-Tracking, Click-to-sign oder Zeichnen, Attestierung (Signer, Timestamp,
Content-Hash), Status `pending/signed/expired/withdrawn`, analogen Upload,
Tablet-Signatur und Kunden-Widerruf (§356a, 14-Tage-Fenster, einmalig).

Die öffentliche Reonic-OpenAPI v3.11.0 (`SRC-API-SPEC`, DOCUMENTED) exponiert die
Signatur nur **lesbar**: `GET /residentialProjects/{projectId}/signatureRequests`
mit Schema `ResidentialProjectSignatureRequest`. Erzeugung ist Portal-only
(`API-MAP`, UNKNOWN). Das Schema liefert fünf Statuswerte
(`awaitingSignature|signed|expired|withdrawn|revokedByCustomer`), ein
`offerDocuments[]`-Array (je Variante/Zahlart ein PDF mit „URL valid 24 hours"),
`expiresAt`, `signedAt`, `withdrawnAt`, `revokedByCustomerAt` und die
Unterscheidung „Team widerruft einen noch nicht signierten Link"
(`withdrawn`) vs. „Kunde widerruft einen bereits signierten Vertrag"
(`revokedByCustomer`).

Die öffentliche Reonic-Dokumentation (Zugriff 2026-09-02, DOCUMENTED) belegt
zusätzlich: Link-Gültigkeit „typisch 14, 30 oder 60 Tage", Freeze bei Versand,
Click-to-sign **oder** Zeichnen (Workspace-Setting „draw-to-sign"),
Tablet-Signatur = digitale Kundensignatur (kein „on behalf of"), Attestierungsseite
mit „who signed, when, from where, and a content check", View-Count statt
Einzel-Timestamps, Analog-Upload (PDF, Datum „max. 1 Tag in der Zukunft") und
Signatur → automatisch `Won`.

M2-03b1 (ADR 0012) hat bereits eine bytegebundene Freigabe eines finalen
Angebots-PDF mit SHA-256 und dem Maximalzustand `approved_for_archive_not_issued`
gebaut. ADR 0012 legt fest: „Versand und Signatur dürfen erst auf einem echten
`issued`-Artefakt aufbauen"; M2-03b2 (`issued`) ist extern BLOCKED.

Dieses ADR klärt die Architekturfragen, die M2-04 für einen Implementierer ohne
Rückfragen lösen muss: (1) woran der Content-Hash bindet, (2) wie die TTL
umgesetzt wird, (3) welches Zustandsmodell gilt, (4) wie das Vorbereitungs-Gate
zu ADR 0012 steht, (5) wie View-Tracking ohne Fingerprinting funktioniert.

## Entscheidung 1 — Content-Hash bindet an die Ausstellungsfassungs-Bytes, nicht an Candidate-Bytes

**Gewählt:** Die Signatur-Attestierung bindet den Content-Hash an die **exakten
Bytes der freigegebenen Ausstellungsfassung** (`offer_issuance`-Artefakt,
`approved_for_archive_not_issued`, SHA-256 aus M2-03b1). Die `signature_request`
trägt `content_sha256` + `issuance_id`/`artifact_ref` als unveränderliche
Bindung. Vor jeder Signierung und vor jeder Attestierung wird der Hash der
tatsächlich gespeicherten Bytes erneut gerechnet und gegen die Bindung geprüft
(Rehash, Muster M2-03b1-Freigabe).

**Verworfen:** Bindung an die M2-03a-Candidate-Bytes oder an einen
Varianten-Snapshot. Der Candidate ist per ADR 0012 ausdrücklich nicht
ausstellbar („Candidate-Bytes werden nie kopiert, umbenannt oder promotet"); die
Ausstellungsfassung ist diejenige Bytefolge, die der Kunde später signiert und
die attestiert werden muss. Eine Bindung an den Candidate würde die
Revisionskette der Ausstellung umgehen und einen nicht ausstellbaren Stand als
Signaturgrundlage behaupten.

**Begründung:** Der „content check" der Referenz-Doku ist genau dieser
Byte-Nachweis. M2-03b1 hat die freigegebenen Bytes samt SHA bereits; M2-04
rehashiert sie (nicht neu gerendert) und bindet sie append-only.

## Entscheidung 2 — TTL serverseitig über `expires_at`; Default 14 Tage, Bereich 1–60

**Gewählt:** Die Link-Gültigkeit ist ein serverseitiger `expires_at`-Zeitstempel
(timestamptz, DB-Zeit) am `signature_request`. Der Status `expired` wird **nie**
vom Client gesetzt, sondern aus `expires_at <= now()` **abgeleitet** (sichtbarer
Lesestatus) beziehungsweise von einem definierten Übergangs-Check terminal
materialisiert, sobald eine Aktion (Signieren, Lesen des Links) auf eine
abgelaufene Request trifft. Default `14 Tage`, erlaubter Bereich `1..60 Tage`.

**Verworfen:** TTL im Client (Uhrzeit-/Zeitzonenfehler, manipulierbar) oder eine
Client-Ablaufanzeige als Autorität. Ein rein abgeleiteter Status ohne
materialisierte Terminierung wäre für Audit/Race schlechter prüfbar.

**Begründung:** Die Doku nennt „typisch 14, 30 oder 60 Tage"; der Modulkatalog
fixiert „Link 1–60 Tage gültig" (`MODKAT:F2.8`). Der **Default** ist öffentlich
nicht als Einzelwert belegt („typisch" nennt drei Werte) → `DECIDED` 14 Tage,
kongruent zum dokumentierten Widerrufsfenster-Default (14 Tage). 1–60 Tage ist
`DOCUMENTED` (Modulkatalog).

## Entscheidung 3 — Fünf-Zustands-Modell; Team-Widerruf und Kunden-Widerruf getrennt

**Gewählt:** Internes Zustandsmodell mit exakt den fünf API-Zuständen (Werte
intern snake_case):

```text
pending → signed | expired | withdrawn
signed  → revoked_by_customer
```

- `pending` (= API `awaitingSignature`) — Request angelegt, Link (Token) erzeugt,
  wartet auf Signatur.
- `signed` — digitale oder analoge Signatur erfasst, Attestierung gespeichert.
- `expired` — TTL abgelaufen ohne Signatur (terminal, kein Withdraw mehr).
- `withdrawn` — Team widerruft einen noch nicht signierten Link (terminal).
- `revoked_by_customer` — Kunde widerruft einen **signierten** Vertrag
  (terminal, §356a-Fenster, einmalig).

`expired`, `withdrawn` und `revoked_by_customer` sind terminal und
nicht umkehrbar. `signed` ist für M2-04 der Endzustand; der automatische
`Won`-Übergang ist NICHTZIEL (eigener Outcome-/Installations-Slice, s. Spec §12).

**Verworfen:** Ein Vier-Zustands-Modell nur nach der Kürzelliste
`pending/signed/expired/withdrawn` ohne `revoked_by_customer`. Die Doku und die
API unterscheiden ausdrücklich zwei verschiedene „Widerrufe": Team zieht einen
noch nicht signierten Link zurück (`withdrawn`, kein Kundenmail) vs. Kunde
widerruft den bereits signierten Vertrag (`revokedByCustomer`, beidseitige
Benachrichtigung, Deal bleibt `Won`). Beide im selben Status zu verschmelzen
würde die §356a-Semantik verlieren.

**Begründung:** Das API-Enum ist die autoritative, maschinenprüfbare Quelle;
Modulkatalog und Doku nennen die vier Hauptzustände plus „Kunden-Widerruf" als
eigenes Konzept. Fünf Zustände bilden beides exakt ab.

## Entscheidung 4 — Vorbereitungs-Gate: kein `issued`/`sent` ohne M2-03b2-Gate

**Gewählt:** M2-04 baut die komplette Signatur-Domäne (Request-Erzeugung,
Token-Route, TTL, Signierfluss, Attestierung, View-Tracking, Withdraw,
Analog-Upload) und verifiziert sie Ende-zu-Ende, bindet die Request aber an das
`approved_for_archive_not_issued`-Artefakt und **behauptet kein `issued`**. Die
öffentliche Signierroute ist ein hoch-entropischer Token-Link (kein interner
Login), technisch erreichbar und voll testbar; die **Auslieferung** (E-Mail,
Resend) ist NICHTZIEL. Die interne UI kennzeichnet eine Request bis zur
Send-/Issued-Freigabe ehrlich als „vorbereitet · nicht versendet" — analog zur
M2-03b1-Microcopy „noch nicht ausgestellt".

**Verworfen:** Ein stiller `issued`-/`sent`-Zustand oder ein Mock, der
Ausstellung/Versand behauptet. Das widerspräche ADR 0012 („Versand und Signatur
dürfen erst auf einem echten `issued`-Artefakt aufbauen") und der M2-03b2-Blockade.

**Begründung:** M2-03b1 hat dieselbe Disziplin etabliert: alles bauen, alles
testen, ehrlich „noch nicht ausgestellt" bis zum Live-Gate. M2-04 folgt dem.
Die Token-Route selbst ist keine Artefakt-Ausstellung; die kundengerichtete
Aktivierung bleibt hinter dem Send-/Issued-Gate (M2-03b2 + Resend-Slice).

## Entscheidung 5 — View-Tracking minimal: Zeitstempel + Zähler, kein Fingerprinting

**Gewählt:** Append-only `signature_view_log` mit `request_id` + serverseitigem
`viewed_at` (DB-Zeit). Daraus werden `first_viewed_at` und `view_count` abgeleitet
und (nur) als Zähler + Erstöffnung nach innen angezeigt. Es werden **keine** IP,
User-Agent, Referrer, Fingerprint- oder Gerätedaten persistiert.

**Verworfen:** IP-/UA-/Fingerprint-Logging oder eine reine Zählerspalte ohne
Zeitbezug. Ersteres verletzt die Vorgabe „kein Fingerprinting" und erzeugt
unnötige PII im Erasure-Graphen; letzteres liefert keinen „Zeitstempel"-Beleg
(Vorgabe des Slice-Auftrags) und erschwert Audit/Replay.

**Begründung:** Die Doku belegt öffentlich nur einen **View-Count** („increments
every time the public link is loaded", „carries forward across resends"). Der
Zeitstempel ist eine minimale WMEE-Eigenentscheidung (Vorgabe Slice-Auftrag),
ausdrücklich ohne identifizierende Daten.

## Entscheidung 6 — Attestierung minimal: Signer, Zeitpunkt, Content-Hash, Modus

**Gewählt:** Die Attestierung speichert append-only: Signer-Identität (aus dem
Kontaktdatensatz des Angebots), serverseitigen Signierzeitpunkt,
`content_sha256` (Entscheidung 1) und den Signatur-Modus
(`click` | `draw` | `analog`; Tablet-Zeichnen = `draw`). Gezeichnete Signatur
als gerendertes PNG (aus `signature_pad`-SVG/Canvas) und der Analog-PDF-Scan
werden als Artefakt mit eigenem Storage-Key und eigenem SHA gespeichert.

**Verworfen:** Übernahme der Reonic-Formulierung „from where" als IP-/Geo-Feld
oder Geräte-Fingerprint. Die öffentliche Doku spezifiziert **nicht**, wie „from
where" technisch erfasst wird → `UNKNOWN`; eine IP-/Geo-Erfassung wäre
Fingerprinting und PII-Ausweitung ohne Beleg.

**Begründung:** „who, when, content check" ist dokumentiert und durch Name +
Timestamp + Hash abgedeckt. „from where" bleibt UNKNOWN und wird bewusst nicht
repliziert; die Attestierung bleibt datensparsam und erasure-fähig.

## Konsequenzen

- Migration additiv (Nummer bei CONTRACTED nach M2-03b- und M1-wave-01-Integration
  vergeben; nach heutigem Stand frühestens `0043`). Neue Tabellen:
  `signature_request`, `signature_attestation`, `signature_view_log`
  (plus ggf. Analog-Artefaktfelder). Alle tenantgebunden, RLS/FORCE-RLS,
  Composite-Keys, im DSGVO-Erasuregraphen registriert (Signaturbild, Analog-PDF,
  View-Zeitstempel, Signer-Name).
- `signature_request` bindet `issuance_id`/`artifact_ref` + `content_sha256`
  append-only; Statusübergänge sind explizit erlaubt und terminal nicht umkehrbar.
- M2-04 hängt funktional an M2-03b1 `a06f961`, das **nicht** in `tooling`/`main`
  integriert ist. Implementierung setzt die vorherige (oder begleitende)
  Integration der M2-03b1-Issuance-Tabellen voraus; bis dahin ist die
  Hash-Bindung gegen das reale `offer_issuance`-Schema nicht lauffähig. Diese
  Abhängigkeit ist als offene Root-Frage in der Spec festgehalten.
- Der automatische `Won`-/Installations-Übergang ist nicht Teil von ADR 0022; die
  Signatur emittiert ein `signature.signed`-Event als Integrationspunkt.
- Keine öffentliche REST-API, kein echter Rechtsdienstleister-/Zertifikatsdienst,
  keine E-Mail-Versandkette (Resend später), kein Portal-White-Label (F10),
  kein Change-Order-Fork (eigener Slice).

## Quellen

- `SRC-API-SPEC` — Reonic OpenAPI v3.11.0, `https://api.reonic.de/rest/v3/openapi`,
  DOCUMENTED (öffentliche Spec, kein API-Call mit Key), Schema
  `ResidentialProjectSignatureRequest`.
- `SRC-REONIC-SIGN-LINK` — [Preview an offer and manage link
  validity](https://docs.reonic.com/docs/en/offers-finalise-cat-preview-variants-legal-texts-offer-link-validity),
  DOCUMENTED, Zugriff 2026-09-02.
- `SRC-REONIC-SIGN-TRACK` — [Track offer openings and
  signatures](https://docs.reonic.com/docs/en/offers-finalise-cat-track-openings-of-offer),
  DOCUMENTED, Zugriff 2026-09-02.
- `SRC-REONIC-SIGN-WITHDRAW` — [Handle a customer contract
  withdrawal](https://docs.reonic.com/docs/en/offers-finalise-cat-handle-a-contract-withdrawal),
  DOCUMENTED, Zugriff 2026-09-02.
- `SRC-REONIC-SIGN-REVOKE` — [Revoke or withdraw an offer signature
  request](https://docs.reonic.com/docs/en/offers-finalise-cat-revoke-offer),
  DOCUMENTED, Zugriff 2026-09-02.
- `SRC-REONIC-SIGN-MANUAL` — [Upload a manual signature for a
  customer](https://docs.reonic.com/docs/en/offers-finalise-cat-upload-manual-signature),
  DOCUMENTED, Zugriff 2026-09-02.
- `ADR0012` — `docs/adr/0012-angebotsausstellung-und-archivgate.md` (M2-03b-Worktree).
- `MODKAT:F2.8` — `docs/blaupause/01-modulkatalog.md`, Zeile 37.
