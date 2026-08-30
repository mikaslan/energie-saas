# M2-02 · Reproduzierbarer Angebots-PDF-Entwurf

Status: `REVIEWED/VERIFIED (lokal)` · technisches Gate `GO`
Stand: 2026-08-30
Zielbereich: F2 Angebote, Golden Path nach M2-01

## Ergebnis

Ein berechtigter Bearbeiter kann aus **genau einer unveränderlichen
Angebotsvariantenrevision** einen hochwertigen A4-PDF-Entwurf anfordern. Der
Worker rendert ausschließlich den bei der Anforderung versiegelten,
kundensicheren Dokumentstand. Nach erfolgreichem Render kann jeder zum Lesen
des Angebots berechtigte interne Nutzer exakt dieses Artefakt herunterladen.

Der Slice ist ausdrücklich eine interne Vorschau. Das Dokument trägt auf jeder
Seite sichtbar und maschinenlesbar den Status:

> Interner Angebotsentwurf · nicht versendet · nicht verbindlich

Es gibt in M2-02 kein `issued`, `sent`, `accepted`, `signed`, keinen
öffentlichen Link und keine Aussage, dass ein Vertrag zustande gekommen ist.

## Warum dieser Schnitt

M2-01 liefert bereits append-only Variantenrevisionen, serverautoritative
Geldwerte sowie einen minimierten Kontakt-/Anlagenstandortkontext. PDF ist
damit der nächste echte Schritt im Golden Path. Signatur braucht dagegen erst
ein unveränderliches Artefakt, eine Empfänger-/Rechnungsadressentscheidung,
Rechtstexte, Retention und Object Lock. Das vollständige Kundenportal bleibt
gemäß Roadmap F10/M10.

Historische Rechner-PDFs sind keine Evidenz für diesen internen
Angebotsprozess. Reonic-Marke, -Texte, -UI, private Daten und private
Rundungsregeln werden nicht übernommen.

## Nicht-Ziele und harte Grenzen

- keine Ausstellung, Versendung, E-Mail, Freigabe oder Signatur;
- kein Kundenkonto, Magic Link oder vollständiges Kundenportal;
- keine Rechnungs-, ZUGFeRD-, XRechnung- oder DATEV-Funktion;
- keine Finanzierung, Rendite- oder Förderzusage;
- keine erfundene Firmenanschrift, Vertretungsberechtigung, AGB, Widerrufs-
  oder Gültigkeitsfrist;
- keine Rechnungsadresse: der vorhandene Standort wird ausschließlich als
  **Anlagenstandort** bezeichnet;
- keine EK-, Margen-, Einkaufsquellen-, internen Hash- oder Actor-Leaks;
- kein Remote-HTML, kein URL-Render, keine externen Fonts, Bilder, CSS, Skripte
  oder sonstigen Netzwerkressourcen;
- keine Behauptung eines produktiven WORM-/Object-Lock-Gates;
- keine stillen Käufe, Deployments oder Providerzugriffe.

## Quellen und Klassifikation

- `CONTRIBUTING.md`: bindende Clean-Room-Constitution (`DOCUMENTED`).
- `docs/spec/M2-01-angebotsvarianten-snapshot-bom.md`: implementierter
  Varianten-/Snapshot-/Geldvertrag (`DOCUMENTED`, lokal verifiziert).
- `docs/adr/0009-angebotsvarianten-snapshot-bom.md`: PDF als separater
  Worker-/Chromium-/Storage-/SSRF-Slice (`DECIDED WMEE`).
- öffentliche Reonic-Dokumentation im Quellenregister: PDF/Finalisierung als
  beobachtbare Capability, nicht als Layout- oder Implementierungsvorlage
  (`DOCUMENTED`, Clean Room).
- eigene Vault-Interviews: hochwertiger, sofort nutzbarer Angebotsentwurf und
  menschliche Prüfung (`OBSERVED stakeholder statement`).
- installierte offizielle Next-16.3.3-Dokumentation: dynamische Route Handler,
  Promise-Params, DAL/Autorisierung und nicht gecachte private Antworten
  (`DOCUMENTED`).
- lokaler Claude-Code-Opus-Lesereview: nur Designinput, keine Produktwahrheit
  (`INFERRED`).

## Capability-Vertrag

### M202-01 · PDF-Entwurf anfordern

Der Client sendet ausschließlich:

```text
workspaceId, offerId, variantId, expectedVariantRevision
```

Alle Dokumentdaten werden innerhalb der autorisierten Transaktion erneut aus
Postgres geladen. Vorbedingungen:

- authentifizierte aktive Membership im Workspace;
- nicht `external_only`;
- `project.write` für die Mutation;
- kein neues M2-02-Rollout-Flag: bestehende Workspace-Flags koennen weder
  fehlende Rolle noch fehlendes Recht ersetzen;
- Offer, Variante und Revision gehören zur selben Workspace-/Project-Kette;
- `expectedVariantRevision` ist die aktuelle Revision;
- Offer und Quellrevision bestehen und ihr versiegelter Snapshot ist exakt
  hashvalid;
- höchstens ein Job je
  `(Workspace, Variante, Revision, Template-Version, Renderer-Rezept)`.

Ein Replay repariert bei `queued` den Dispatch und liefert denselben Job. Ein
Parallelaufruf erzeugt nie zwei fachliche Jobs. Eine spätere Variantenänderung
mutiert den alten Dokumentstand nicht; für die neue Revision entsteht ein
eigener Job.

### M202-02 · Kundensicheren Renderstand versiegeln

Der gespeicherte `offer-pdf-draft-input.v1` enthält nur:

- Angebotsnummer, Variantenname und Variantenrevision;
- festen DB-Zeitpunkt der Vorbereitung;
- Anzeigename des Kontakts;
- formatierte Adresse mit der expliziten Bezeichnung `Anlagenstandort`;
- alle Kundenpreispositionen mit Titel, Beschreibung,
  Menge/Einheit, Positionstyp, Verkaufs-/Rabatt-/Steuer- und berechneten
  Endwerten sowie dem Flag `intern ausgeblendet`;
- Basis- und optionale Summen in EUR;
- feste Dokument-, Template-, Canonicalization- und Renderer-Versionen.

E-Mail, Telefon, Koordinaten, Geocoderwerte, Consent-/Acquisitiondaten,
Katalog-IDs, Purchase Pricing, Margen, Provenienz, interne Vollhashes und rohe
Rechnerpayloads bleiben außerhalb. `hidden` verändert gemäß M2-01 die
Mathematik nicht. Deshalb bleibt eine solche Zeile im **internen** Dokument
enthalten und wird deutlich als `Intern ausgeblendet · nicht für das spätere
Kundendokument freigegeben` markiert. Ein späterer Kundenslice darf sie erst
unterdrücken, wenn eine arithmetisch geschlossene Aggregations-/Ausgleichszeile
definiert ist. `optional` wird getrennt ausgewiesen und nicht in die
Basissumme gerechnet.

Das Input-JSON wird strikt validiert, kanonisiert und mit SHA-256 versiegelt.
Spätere Workerläufe dürfen es nicht ergänzen oder ändern.

### M202-03 · Isoliert rendern

Der pg-boss-Job enthält nur
`{ schemaVersion, workspaceId, jobId }`. Der Worker vertraut weder dem
Queue-Payload noch HTML aus der Datenbank, sondern lädt den versiegelten
fachlichen Job unter RLS erneut und baut HTML über eine reine, escapende
Templatefunktion.

Rendervertrag:

- Playwright/Chromium in einer gepinnten Worker-Rezeptversion, die
  `linux/amd64`, Playwright 1.62.1 und den vollständigen OCI-Child-Digest
  benennt; Architektur-, Browser- oder Digestwechsel verlangen eine neue
  Rezeptversion;
- `page.setContent()` statt Navigation zu einer URL;
- BrowserContext offline und Request-Interception fail-closed;
- ein Netzwerkversuch wird nach `setContent()` und erneut nach `page.pdf()`
  verworfen, damit auch print-only CSS keinen akzeptierten Byteoutput erzeugt;
- Chromium erbt keine Worker-Secrets; der Linux-Elternprozess ist vor
  Anwendungscode non-dumpable, sodass der Same-UID-Child keine Eltern-
  Environment-/FD-Daten über `/proc` lesen darf;
- keine `file:`, `http:`, `https:`, `data:`-Assets oder dynamischen
  `url(...)`-Quellen im Template;
- kein `--no-sandbox`; Worker läuft als unprivilegierter Container-User;
- A4, `printBackground`, CSS-Seitengröße, tagged PDF und Outline;
- feste Locale/Timezone/Farb- und Reduced-Motion-Einstellungen;
- normalisierte PDF-Zeitmetadaten aus dem versiegelten `preparedAt`;
- Ergebnis beginnt mit `%PDF-`, endet strukturell gültig, ist nicht leer und
  höchstens 8 MiB;
- SHA-256 und Bytezahl werden vor dem Commit berechnet.

Ein gleicher Input unter exakt derselben gepinnten Linux-/OCI-Rezeptversion
muss denselben normalisierten Artefakthash ergeben. Hostdiagnostik auf macOS
ist ausdrücklich kein Produktionsrezept-Beleg. Ein anderer Hash ist ein
`renderer_nondeterministic`-Integritätsfehler, kein still akzeptiertes Update.

### M202-04 · Jobzustand und Retries

```text
missing -- request --> queued
queued -- claim --> running
running -- success --> succeeded
running -- retryable failure --> retry_wait -- due claim --> running
retry_wait -- dispatcher recovery --> queued -- claim --> running
running -- final/integrity failure --> failed_final
running -- expired lease --> running (new lease) | failed_final at max attempts
```

- drei fachliche Versuche, zweiminütige Lease;
- exponentieller Backoff, maximal 15 Minuten;
- DB-Zeit ist autoritativ;
- Lease-Token plus Attempt-CAS schützt jeden Abschluss;
- Browserstart/-crash ist retryable;
- ungültiger Input, Template-/PDF-Integritätsfehler, Größenüberschreitung oder
  nichtdeterministischer Replay sind final;
- Portal bleibt bei Worker-Ausfall verfügbar und zeigt `queued`, `running`,
  `retry_wait` oder `failed_final` ehrlich an;
- Events/Audit enthalten IDs, Revision, Zustand und Fehlercode, aber keine
  Kundendaten, Preise, Bytes oder Hashvollwerte.

### M202-05 · Entwurfsartefakt speichern

M2-02 speichert erfolgreiche **Entwurfsartefakte** größenbegrenzt in einer
separaten, tenantgeschützten Postgres-Relation. Das ist eine bewusste
Staging-Grenze, kein Archiv:

- maximal 8 MiB, `application/pdf`, SHA-256 und exakte Bytezahl;
- Byteinhalt und Hash werden nur beim atomaren `running → succeeded` gesetzt
  und danach nie aktualisiert;
- kein PDF-Byteinhalt in Listen-/Detail-DTOs, Events, Audit oder Logs;
- Draft-Erasure löscht Job und Bytes kaskadierend mit dem Offer;
- App-Worker darf nur unter gesetztem Tenantkontext claimen/finalisieren;
- Auth-Principal und andere Workspaces erhalten keinerlei Tabellenrecht.

Damit ist weder ein Object-Storage-Kauf noch eine falsche WORM-Behauptung für
den Entwurfs-Slice nötig. Vor `issued`/`signed` muss ein eigener Folgeslice die
exakt gehashten Bytes in einen empirisch geprüften Object-Lock-Bucket
promoten, Retention/Erasure entscheiden und den produktiven Readback belegen.

### M202-06 · Geschützter Download

Ein dynamischer Next-16-Route-Handler lädt das Artefakt über den bestehenden
autorisierten DAL-Pfad. Er prüft bei jedem GET:

- gültige Promise-Route-Params;
- Session, Membership, `project.read`, Workspace und Offer-/Job-Besitz;
- Jobzustand `succeeded`;
- Bytezahl, MIME und SHA-256 erneut vor der Antwort.

Antwort:

```text
Content-Type: application/pdf
Content-Disposition: attachment; filename="ANG-…-Variante-R….pdf"
Cache-Control: private, no-store, max-age=0
Pragma: no-cache
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

Fremder Tenant, fehlendes Objekt und fehlendes Leserecht bleiben ohne
Existenzoracle. Der Dateiname wird ausschließlich aus serverseitig
allowlist-validierten Bestandteilen gebildet.

## Dokumentaufbau

1. WMEE-Wortmarke als Text, Dokumentstatus und Angebotsnummer.
2. Empfängername und ausdrücklich `Anlagenstandort`; Hinweis, dass eine
   Rechnungsadresse noch nicht Bestandteil des Entwurfs ist.
3. Variantenname, Revision und fester Vorbereitungszeitpunkt.
4. Leistungsumfang nach Sektionen; Tabellenkopf wiederholt sich nach
   Seitenbruch. Zeilen werden nicht mitten im Text getrennt.
5. Basissumme netto, Steuer nach im Snapshot vorhandenen Sätzen und brutto.
6. Optionale Positionen und optionale Summe in einem klar getrennten Block.
7. Transparenter interner Hinweis zu fehlenden Firmen-/Rechtsangaben und
   menschlicher Prüfung.
8. Seitenfuß mit Angebotsnummer, Revision, Seitenzahl und Entwurfsstatus.

Die Gestaltung verwendet ausschließlich eigene WMEE-Tokens, Systemfonts,
hohen Kontrast und keine fremden Markenassets. Bei 1–500 Positionen darf der
Renderer keine Position abschneiden; ein Dokument darf viele Seiten haben.

## Berechtigungen

| Fähigkeit | Viewer | Editor | Admin | External |
|---|---:|---:|---:|---:|
| Jobstatus lesen | ja | ja | ja | nein |
| vorhandenen PDF-Entwurf herunterladen | ja | ja | ja | nein |
| PDF-Entwurf anfordern | nein | mit `project.write` | ja | nein |
| Job claimen/finalisieren | nein | nein | nein | nur `app_worker`-Principal |

M2-02 führt bewusst kein eigenes Workspace-Rollout-Flag ein. Bestehende Flags
koennen fehlende Rollen oder Rechte nicht erteilen. Sobald eine Aktion ein
Feature-Flag deklariert, bleibt dieses über den zentralen `can()`-Pfad auch für
Admin bindend. UI-Sichtbarkeit ist nie die Autorisierung.

## Datenbank-Invarianten

- jede Relation besitzt `workspace_id`, zusammengesetzte FKs und FORCE RLS;
- Quellbindung umfasst Offer, Project, Variante, Variantenrevision-ID,
  Revisionsnummer und Snapshot-SHA;
- die Relation traegt diese exakten Quellbindungen; der minimierte
  Dokumentinput spiegelt nur Angebotsnummer, Variantenrevision und den
  kundensicheren Revisionsinhalt und ist durch strikte
  Anwendungskonsistenzpruefung plus kanonischen SHA an die Relation gebunden;
- pro Rezept und Quellrevision höchstens ein Job;
- Artifact-Spalten sind genau bei `succeeded` vollständig und sonst vollständig
  `NULL`;
- der in der Relation gespeicherte Artifact-SHA muss dem SHA-256 der
  gespeicherten PDF-Bytes entsprechen;
- Lease-Spalten sind genau bei `running` gesetzt;
- Fehlerfelder sind nur bei `retry_wait`/`failed_final` gesetzt;
- `app_runtime` kann unter FORCE RLS keinen fremden Tenant lesen; die Ausgabe
  von Artefaktbytes erfolgt zusätzlich ausschließlich nach erneuter
  `project.read`-Autorisierung im Service-/Route-Pfad;
- `app_worker` kann keinen Job ohne Tenantkontext und keine Auth-/Katalogdaten
  außerhalb der erlaubten Relation lesen;
- direkte Änderung von Input, Bindungen oder erfolgreichem Artefakt wird durch
  DB-Trigger abgewiesen;
- ein Erasure-Tombstone darf die optionale, kanonisch sortierte
  `offerPdfDraftIds`-Liste tragen; alte Tombstones ohne PDF-Jobs bleiben
  bytekompatibel replaybar.

## Geschlossene Testmatrix

| ID | Ebene | Muss beweisen |
|---|---|---|
| `M202-CONTRACT-01` | Contract/Golden | striktes Inputschema, Canonicalizer, Golden Hash, unbekannte Felder, 1/500 Zeilen, Reject 501 |
| `M202-PRIVACY-01` | Contract/Integration | exakt erlaubte PII; keine E-Mail/Telefon/EK/Marge/IDs in Input, HTML, DTO, Event, Audit; Hidden nur als boolesche interne Kennzeichnung |
| `M202-TEMPLATE-01` | Unit/Golden | HTML escaping, Status auf jeder Seite, Required/Additional/Optional, 19/0 %, Summen, kein Remote-Asset |
| `M202-RENDER-01` | Chromium | gültiges tagged A4-PDF, feste Metadaten, gleicher Input→gleicher SHA, 1/mehrseitig/500 Zeilen, ≤8 MiB |
| `M202-SSRF-01` | Adversarial | keinerlei Navigation/Netzwerk/File-Zugriff; URL-/HTML-Payloads werden nur als Text gerendert |
| `M202-DB-01` | Migration/RLS | fresh+upgrade, FKs, FORCE RLS, app_runtime/app_worker/app_auth-Grants, immutable Input/Artifact, Erasure-Cascade |
| `M202-DB-02` | Concurrency | Doppelrequest, Dispatch-Reparatur, Claim/Lease/Races, stale completion, Retry/Max-Versuche, Erfolg-Replay |
| `M202-SVC-01` | Integration | aktuelle Revision→versiegelter Job→Event/Audit; alte Revision bleibt gebunden, Katalog-Livewerte irrelevant |
| `M202-RBAC-01` | Integration | Viewer/Editor/Admin/External, Flags ohne Rechte-Eskalation (kein M2-02-Rollout-Flag), Cross-Tenant, NotFound/Denied ohne Oracle |
| `M202-WORKER-01` | Unit/Integration | strikter Payload, DB-Reload, Fehlerklassifikation, Browser-Cleanup, kein Rohfehler-/PII-Log |
| `M202-ROUTE-01` | Next/Route | Promise-Params, Reauth, no-store/nosniff/Disposition, Hash-/Längenprüfung, sichere Dateinamen |
| `M202-E2E-01` | Browser | Offer öffnen→PDF anfordern→queued→Workerabschluss→Reload→Download exakt gehashter Bytes |
| `M202-A11Y-01` | Browser/Document | Keyboard, Statusmeldungen, Kontrast, semantische Dokumentstruktur, 200/400-%-Portal-Reflow |
| `M202-VISUAL-01` | Visual | maskierte Portalzustände und gerasterte A4-Seiten; menschliche Baseline bleibt separat |

## Abnahmegates

Technisches Gate ist lokal `GO`: Contract-, DB-, Worker-, Route-, Browser-,
Security-, Build-, Lint-, Typecheck- und Gesamtregressionen sind grün; der
unabhängige Abschlussreview enthält keine offenen P0–P2. Der exakte Nachweis
steht in `docs/parity/TEST-EVIDENCE.md`.

Getrennt bleiben:

- `M202-VISUAL-01`: bis zur menschlichen Baseline-Freigabe `INCONCLUSIVE`;
- produktiver Worker-/Chromium-Container: bis autorisiertem Deploy
  `BLOCKED/NOT RUN`;
- Object Storage/Object Lock: für Draft nicht erforderlich, für Issuance
  `BLOCKED` bis Kauf, Konfiguration und empirischem Readback;
- Rechtsdaten, Rechnungsadresse, Steuerberater-, Claim- und DSGVO-Retention:
  `BLOCKED` vor Issuance/Signatur.
