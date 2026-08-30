# M2-03b1 · Finale Angebots-Ausstellungsfassung vor Archivierung

Status: `REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO`
Stand: 2026-08-30
Zielbereich: F2.7 PARTIAL, F16.2 PARTIAL

## Ergebnis

Aus einem M2-03a-Candidate im Zustand `approved_not_issued` entsteht ein
eigenes finales Angebots-PDF. Es wird aus dem unveraenderlich versiegelten
Candidate-Input neu gerendert und ist niemals eine umetikettierte Candidate-
Datei. Zwei unterschiedliche interne Personen geben exakt diese neuen Bytes
fuer die spaetere COMPLIANCE-Archivierung frei.

Der maximale Zustand dieses Slices lautet:

> Fuer Archivierung freigegeben · noch nicht ausgestellt

M2-03b1 erzeugt kein `issued`, versendet nichts und stellt keinen
oeffentlichen Link bereit.

## Harte Nicht-Ziele

- kein Object-Storage-Aufruf und kein WORM-/GoBD-Claim;
- kein `issued`, `sent`, `accepted`, `signed` oder `won`;
- keine E-Mail, Provider-Message-ID, Outbox oder Delivery-Automation;
- kein Kundentoken, Portal, View Counter, Expiry oder Reminder;
- keine Click-, Drawn-, Tablet- oder Analogsignatur;
- kein Offer-/Projektstatuswechsel und keine Installation;
- keine erfundenen Firmen-, Rechts- oder Retentiontexte;
- keine private Reonic-Beobachtung, API oder Asset-Uebernahme.

## M203B1-01 · Exakte Quelle und Reservation

Der Client sendet nur Workspace-, Offer- und Candidate-ID. Der Server liest
und sperrt erneut:

- aktive interne Membership und `offer.issue.prepare`;
- Offer/Project/Tenantgraph;
- Candidate, dessen append-only Approval und echte Candidate-Bytes;
- versiegelten Candidate-Input samt Input-SHA;
- aktuelle Varianten-, Profil-, Aktivierungs- und Empfaengerbindungen.

Candidate und Approval muessen hashvalide und aktuell sein. `validThrough`
darf zum DB-Zeitpunkt weder abgelaufen noch fachlich unplausibel sein.
Reservation-Key und Issuance-Input binden alle IDs, Revisionen, Hashes,
Template- und Rendererrezept. Derselbe exakte Aufruf liefert dieselbe
Issuance-ID und repariert bei Bedarf nur den Dispatch.

## M203B1-02 · Eigener versiegelter Issuance-Input

`offer-issuance-input.v1` wird serverseitig aus dem validierten Candidate-
Input aufgebaut. Er bindet zusaetzlich:

- Issuance-ID und Quell-Candidate-ID;
- Candidate-Approval-ID und deren Artifact-/Inputbindung;
- `artifactIntent = offer_issuance_final`;
- eigene Input-, Template-, Canonicalization- und Rendererrezeptversion.

Der fachliche Kundeninhalt bleibt identisch. Nicht enthalten sind Candidate-
PDF-Bytes, interne Actor-IDs, EK, Marge, Tokens, Providerdaten oder
Archiv-Credentials. Das Input-JSON wird strikt validiert, kanonisiert und
SHA-256-versiegelt.

## M203B1-03 · Renderzustand und Worker

```text
missing -- request --> queued
queued -- claim --> running
running -- success --> ready_for_approval
running -- retryable failure --> retry_wait -- due --> running
running -- final/integrity failure --> failed_final
```

- maximal drei fachliche Versuche;
- DB-Zeit, Lease/CAS und begrenzter Backoff;
- ID-only pg-boss-Payload mit Workspace- und Issuance-ID;
- Reload aller Daten unter FORCE RLS;
- offline/sandboxed Chromium unter gepinntem Rezept;
- Nichtdeterminismus ist ein terminaler Integritaetsfehler;
- Erfolg speichert PDF, MIME, Bytezahl und SHA atomar und append-only.

Der Worker kennt keinen Storageanbieter. Artefaktbytes bleiben bis M2-03b2
groessenbegrenzt in Postgres und im Offer-Erasuregraphen.

## M203B1-04 · Finale PDF-Informationsarchitektur

Die Ausstellungsfassung ist ein sauberes Kundenangebot:

1. eigene WMEE-Wortmarke, Dokumenttyp `Angebot` und Angebotsnummer;
2. Aussteller, Empfaenger/Rechnungsadresse und Anlagenstandort;
3. Dokumentdatum, Gueltigkeit und Variantenrevision;
4. Leistungsumfang, Preise, Rabatte, Steuern und geschlossene Summen;
5. optionale Leistungen getrennt von der Basissumme;
6. versionierte Angebotsbedingungen, Widerrufs- und Datenschutzhinweise;
7. Dokumentfuss mit fachlichen Revisionsreferenzen.

Im PDF selbst steht weder `Freigabekandidat` noch `Entwurf` noch `nicht
ausgestellt`. Diese temporaeren Systemzustaende duerfen nicht Teil der spaeter
unveraendert zu archivierenden Bytes werden. Bis zum Archivgate zeigt jedoch
jede interne UI und Download-Umgebung deutlich, dass das Dokument noch nicht
ausgestellt ist.

Das Template escaped alle Inhalte, laedt keine externen Ressourcen, ist A4,
mehrseitig robust und hoechstens 8 MiB gross. Tagged-PDF ist aktiviert; ein
formaler PDF/UA-Nachweis bleibt separat offen.

## M203B1-05 · Bytegebundene Vier-Augen-Freigabe

Nur `ready_for_approval` kann freigegeben werden. Eine Server Action nimmt
ausschliesslich Issuance-ID und feste Bestaetigungen entgegen:

```text
recipient_and_scope_reviewed
commercial_totals_reviewed
legal_profile_reviewed
final_pdf_for_archive_understood
```

Bei 0-%-Positionen ist weiterhin die bedingte Steuerbestaetigung erforderlich.
Der Service sperrt Quellen und Issuance, rehashiert die echten PDF-Bytes und
speichert pro Actor genau eine append-only Approval. Zwei verschiedene aktive
interne Actor-IDs sind erforderlich; mindestens eine muss vom Candidate-
Freigeber abweichen. Replay derselben Person ist idempotent und zaehlt nie
doppelt.

Erste Freigabe: `approval_pending (1 von 2)`.

Zweite gueltige Freigabe: `approved_for_archive_not_issued (2 von 2)`.

Quell-, Byte-, Profil-, Empfaenger- oder Rezeptdrift blockiert fail-closed und
verlangt eine neue Issuance-ID.

## M203B1-06 · Withdrawal vor Archivierung

Ein berechtigter interner Nutzer kann jeden noch nicht archivierten
Issuance-Stand mit einer strukturierten Ursache zurueckziehen. Die Aktion
schreibt eine append-only Withdrawal-Attestation und leitet terminal
`withdrawn_before_archive` ab. Sie loescht oder mutiert keine Approval.

Ein zurueckgezogener Stand kann weder weiter freigegeben noch spaeter
archiviert werden. Der identische Request replayt diesen terminalen Stand und
belebt ihn nicht wieder. Fuer eine Korrektur ist deshalb ein neuer Candidate
mit neuer Quellbindung erforderlich; daraus wird eine neue Issuance
angefordert.

Ursachencodes:

```text
content_error | recipient_error | legal_text_error | commercial_error | other
```

Freitext ist absichtlich nicht Teil dieses Slices und kann daher weder PII
noch Vertragsinhalt in Audit/Events tragen.

## M203B1-07 · Lesen, Download und UI

- Status lesen: internes `project.read`.
- PDF vor zwei Freigaben: nur Nutzer mit `offer.issue.approve`, solange die
  Issuance nicht zurueckgezogen ist.
- PDF nach zwei Freigaben: internes `project.read`, solange die Issuance nicht
  zurueckgezogen ist.
- Nach Withdrawal ist kein Artefaktdownload mehr erlaubt.
- Download prueft Session, Membership, Tenantgraph, MIME, Laenge und SHA bei
  jedem GET; Antwort ist `private, no-store`, `nosniff`, `no-referrer` und CSP
  `sandbox`.

Verbindliche Microcopy:

- `ready_for_approval`: `Ausstellungsfassung wartet auf Freigabe (0 von 2)`
- `approval_pending`: `Ausstellungsfassung wartet auf Zweitfreigabe (1 von 2)`
- `approved_for_archive_not_issued`:
  `Fuer Archivierung freigegeben · noch nicht ausgestellt`
- `withdrawn_before_archive`: `Vor Archivierung zurueckgezogen · nicht ausgestellt`
- Blocker: `Archivierung nicht verfuegbar: Live-Object-Lock und Retention-Policy sind noch nicht verifiziert.`

Erklaertext:

> Der Freigabekandidat wird niemals ausgestellt. Aus demselben versiegelten
> Datenstand entsteht eine neue finale PDF-Datei. Erst zwei bytegebundene
> Freigaben und ein spaeterer echter Archivnachweis duerfen daraus ein
> ausgestelltes Dokument machen.

## Berechtigungen

| Faehigkeit | Viewer | Editor | Admin | External |
|---|---:|---:|---:|---:|
| Issuance-Status lesen | ja | ja | ja | nein |
| Ausstellungsfassung anfordern | nein | mit `prepare_offer_documents` | ja | nein |
| unfertige/freizugebende PDF lesen | nein | mit `approve_offer_documents` | ja | nein |
| Ausstellungsbytes freigeben | nein | mit `approve_offer_documents` | ja | nein |
| vor Archivierung zurueckziehen | nein | mit `approve_offer_documents` | ja | nein |
| fertige PDF nach zwei Freigaben lesen | ja | ja | ja | nein |
| Job claimen/finalisieren | nein | nein | nein | `app_worker` |

Die Actions heissen `offer.issue.prepare`, `offer.issue.approve` und
`offer.issue.withdraw`. Admin-Bypass gilt nur fuer positive Einzelcapabilities,
nicht fuer External-, Tenant-, Byte-, Drift- oder Vier-Augen-Regeln.

## Datenbank-Invarianten

- neue Tabellen `offer_issuance`, `offer_issuance_approval` und
  `offer_issuance_withdrawal`;
- jede Tenantrelation mit `UNIQUE(workspace_id,id)`, Workspace-FK,
  zusammengesetzten Tenant-FKs, ENABLE/FORCE RLS und genau einer permissiven
  `tenant_isolation`-Policy;
- Issuance-Input/Bingungen und erfolgreiche Artefaktfelder sind append-only;
- Approval ist eindeutig pro Issuance + Actor und bindet exakte Bytes;
- Withdrawal ist hoechstens einmalig und append-only;
- keine Spalte und keine Funktion dieses Slices kann `issued` setzen;
- Runtime darf nur request/replay/approve/withdraw/read, Worker nur
  claim/retry/finalize/recovery;
- Events/Audit enthalten ausschliesslich IDs, sichere Status-/Ursachencodes und
  Approvalanzahl, niemals PII, Preise, Rechtstexte, Bytes oder Vollhashes.

## Geschlossene Testmatrix

| ID | Ebene | Muss beweisen |
|---|---|---|
| `M203B1-CONTRACT-01` | Contract/Golden | strict Input/Commands, JCS/SHA, Unknown reject |
| `M203B1-TEMPLATE-01` | Unit/Golden | neue finale Bytes, Escaping, kein Candidate-Status/Remote Asset |
| `M203B1-RENDER-01` | Chromium/Container | deterministisch, offline, A4, <=8 MiB, gepinnt |
| `M203B1-DB-01` | Migration/RLS | fresh+upgrade, Tenant-FKs, FORCE RLS, Append-only, genaue ACL |
| `M203B1-DB-02` | Concurrency | Request/Replay/Lease/Finalize/Approval/Withdrawal-Races |
| `M203B1-SVC-01` | Integration | approved Candidate bis 2/2 Freigaben; Drift fail-closed |
| `M203B1-APPROVAL-01` | Integration | Rehash, zwei Actors, mindestens einer != Candidate-Approver |
| `M203B1-PRIVACY-01` | Adversarial | keine PII/Bytes/Vollhashes/Secrets in DTO/Event/Audit/Log |
| `M203B1-RBAC-01` | Integration | Rollen, Capabilities, External und Cross-Tenant ohne Oracle |
| `M203B1-WORKER-01` | Unit/Integration | ID-only, Reload, Retry/Recovery, kein Storage-Secret |
| `M203B1-ROUTE-01` | Route | Reauth, Hash/Laenge/MIME, private Header, sicherer Name |
| `M203B1-E2E-01` | Browser | Candidate -> Render -> 1/2 -> 2/2 -> Download/Withdrawal |
| `M203B1-A11Y-01` | Browser | Labels, Summary, Live-Status, Keyboard, 200/400 % Reflow |
| `M203B1-VISUAL-01` | Human | Portal-/PDF-Baseline; bis Freigabe `INCONCLUSIVE` |

## Abschlussnachweis

- `npm run check`: 126/126 Vitest-Dateien, 1.184 bestanden und 1 bewusst
  uebersprungen; Rollenvertrag 88/88 plus PostgreSQL-18-Proben 5/5.
- Chromium: 17 bestanden, 1 opt-in uebersprungen, 0 fehlgeschlagen;
  Production-Build, ESLint, TypeScript und Dependency-Cruiser (248 Module,
  836 Abhaengigkeiten) sind gruen.
- Der gepinnte Renderer erzeugte zweimal bytegleich 11/11 A4-Seiten mit
  97.560 Bytes und SHA-256
  `cb989e765c0c31b8fa82b25e2151b66eabecdc33f2047c2672297a620ed27abe`;
  Tagged PDF, Outline, Offline-/Print-Netzwerk-Sperren und
  Container-Hardening sind technisch belegt.
- Unabhaengiger Code- und Security-Review sowie der finale lokale
  Claude-Code-Opus-5-Review mit Effort `max`: **GO**, keine offenen P0-P2.

`M203B1-VISUAL-01` bleibt bis zur menschlichen Portal-/PDF-Baseline
`INCONCLUSIVE`. Die technische Evidenz ist keine Rechts-, Brand- oder private
Reonic-Paritaetsfreigabe. M2-03b2 bleibt `BLOCKED`.

## Getrenntes M2-03b2-Gate

M2-03b2 bleibt `BLOCKED`, bis folgende externen Voraussetzungen vorliegen:

- echter Object-Storage-Account und bei Bucket-Anlage aktiviertes Object Lock;
- getrennte minimale Archiv-Credentials nur fuer den Worker;
- verantwortete Retention-Policy inklusive DSGVO-/Loeschkonflikt;
- Live-Test fuer Conditional Write, Versioning, COMPLIANCE-Retention,
  Ueberschreib-/Loeschverweigerung und versionierten Download-Hash;
- autorisierter produktiver Worker-Rollout.

Erst dann darf eine eigene Spec Archive-Attempts, Evidence und `issued`
oeffnen. Fake-/Emulatortests bleiben dabei `IMPLEMENTED/TESTED`, nicht
`VERIFIED`.
