# ADR 0010: Angebots-PDF-Entwurf über isolierten Chromium-Worker und DB-Staging

- Status: entschieden für M2-02
- Datum: 2026-08-30

## Kontext

M2-01 besitzt unveränderliche Angebotsvariantenrevisionen, aber weder
Rechnungsadress-/Rechtsdaten noch einen produktiv geprüften Object-Lock-Bucket.
Ein PDF wird für den nächsten Golden-Path-Schritt gebraucht, darf jedoch nicht
als ausgestelltes oder revisionssicher archiviertes Vertragsdokument erscheinen.

Das vorhandene Worker-Gerüst nutzt pg-boss und einen getrennten `app_worker`-
Principal. Playwright ist bereits gepinnt. Die bestehende S3-Abstraktion ist
noch nicht produktiv provisioniert und ihre Workspace-Autorisierung muss an
jeder aufrufenden Boundary hergestellt werden.

## Entscheidung

1. M2-02 erzeugt ausschließlich interne, deutlich markierte PDF-Entwürfe.
2. Der autorisierte App-Service versiegelt einen minimierten
   `offer-pdf-draft-input.v1` aus einer exakten Variantenrevision.
3. pg-boss transportiert nur Workspace- und Job-ID. Der Worker lädt unter RLS
   neu, baut HTML aus einer reinen escapenden Funktion und rendert es mit
   offline geschaltetem, sandboxed Chromium. Chromium erhält ein explizit
   minimiertes Environment ohne Worker-Secrets. Zusätzlich setzt ein
   root-owned Preload-Konstruktor den Node-Elternprozess vor Anwendungscode
   mit `PR_SET_DUMPABLE=0`; damit darf der Same-UID-Browser weder Environment
   noch offene Deskriptoren des DB-Workers über ptrace-geschützte `/proc`-
   Pfade lesen.
   Die produktive Rezept-ID bindet zusätzlich `linux/amd64`, Playwright
   1.62.1 und den vollständigen OCI-Child-Digest. Compose und Renderer prüfen
   diese Plattform fail-closed; jeder Architektur-/Digestwechsel erzeugt eine
   neue Rezeptversion und damit einen neuen fachlichen Job.
4. Erfolgreiche Draft-Bytes werden bis 8 MiB zusammen mit SHA-256 in derselben
   tenantgeschützten Postgres-Relation atomar gestaged. Sie sind nach Erfolg
   unveränderlich, werden bei Draft-Erasure aber mit dem Offer gelöscht.
5. Der Next-Route-Handler liest Bytes ausschließlich nach erneuter
   `project.read`-, Tenant- und Hashprüfung und antwortet privat/no-store.
6. Issuance/Signatur erhalten einen eigenen Promotions- und Retentionvertrag:
   exakt gehashte Bytes → empirisch geprüfter Object-Lock-Bucket. Dieser ADR
   behauptet ausdrücklich kein WORM.

## Gründe

- Der Slice bleibt ohne Providerkauf lokal und fachlich vollständig prüfbar.
- Draft-PII bleibt in der bereits FORCE-RLS-geschützten Datenbank und kann mit
  dem bestehenden Erasuregraph transaktional gelöscht werden.
- Ein S3-Outbox-/Delete-Race wird nicht vorzeitig in den Draft-Slice gezogen.
- Renderer, fachlicher Input und Artefakt sind trotzdem versioniert und
  gehasht; die spätere Promotion kann exakt dieselben Bytes übernehmen.
- Das Portal bleibt bei Worker-Ausfall verfügbar.

## Verworfene Alternativen

### PDF synchron in einer Next-Request rendern

Verworfen: Chrome-Laufzeit und Abstürze würden Portalrequests blockieren;
Timeouts und Concurrency wären schwer kontrollierbar.

### Worker navigiert zu einer internen/öffentlichen HTML-URL

Verworfen: Auth-, DNS-/SSRF-, Cache- und Drift-Risiko. `setContent` mit einer
geschlossenen Datenstruktur und komplett deaktiviertem Netzwerk ist kleiner.

### Draft sofort unter `immutable/` in S3 speichern

Verworfen: produktive Credentials/Object Lock fehlen; Draft-Erasure und
fehlende Rechnungs-/Retentionentscheidung widersprechen einem unlösbaren
Archivobjekt. App-Level-`putImmutable` allein ist keine WORM-Evidenz.

### PDF im Browser des Nutzers erzeugen

Verworfen: nicht reproduzierbar, manipulierte Clientdaten, keine zuverlässige
Hash-/Auditbindung und Browserunterschiede.

### `@react-pdf/renderer`

Verworfen: zweite Layoutengine, schwächere CSS-/Tabellen-/Seitenbruchkontrolle
und keine Übereinstimmung mit dem bereits entschiedenen Chrome-Pfad.

## Konsequenzen

- Postgres trägt temporär PDF-Bytes; deshalb gilt ein harter 8-MiB-Cap und
  dieser Pfad ist nur für interne Entwürfe gedacht.
- Der Worker-Container braucht eine exakt passende Chromium-Installation und
  muss unprivilegiert/sandboxed laufen.
- Die Prozessisolation ist Linux-spezifisch und fail-closed: Kann der
  Non-Dump-Preload nicht geladen oder gesetzt werden, darf der Worker nicht
  starten. Der Zielhost-Smoke muss Same-UID-Leseversuche auf Eltern-Environment
  und offenen Eltern-FD ablehnen.
- Byte-Reproduzierbarkeit gilt nur innerhalb der exakt gepinnten
  Linux-/Architektur-/OCI-Rezeptversion; ein Rezeptwechsel erzeugt einen neuen
  fachlichen Job. Lokale macOS-Render dienen nur der Diagnostik und sind keine
  Cross-Platform-Bytegarantie.
- Vor Versand, Signatur oder rechtsverbindlichem Status sind weiterhin
  Rechnungsadresse, Firmen-/Rechtsdaten, Claim-/Steuerreview, Retention,
  Object-Lock-Readback und ausdrückliche Produktfreigabe erforderlich.
