# ADR 0002: Object-Storage-Anbieter mit WORM-Unterstützung

Datum: 2026-08-26 · Entschieden: 2026-08-27 · Status: **akzeptiert** (mit Test-Gate vor Produktivbetrieb)

## Kontext

Das System muss GoBD-konformes Vollarchivieren (Write-Once-Read-Many / WORM) für
signierte PDFs und ausgestellte Belege ab M2/M3 umsetzen. M0 etabliert eine
S3-kompatible API als Abstraktion (`lib/storage/`); die App implementiert WORM
auf Applikationsseite mit SHA256-Hashing. Für echten Schutz braucht der Anbieter
natives Object-Lock. Recherche + unabhängiger Faktencheck gegen Primärquellen
am 2026-08-27 (Tooling-Mission, docs/tooling/entscheidungen.md §15).

## Entscheidung

**Hetzner Object Storage (NBG1/FSN1), Archiv-Bucket mit Object Lock im
COMPLIANCE-Mode.** Begründung:

1. **Object Lock ist offiziell dokumentiert** — Modi GOVERNANCE und COMPLIANCE
   plus Legal Hold; Compliance-Retention kann auch vom Account-Owner nicht
   verkürzt werden (genau das GoBD-Profil).
   Quelle: docs.hetzner.com/storage/object-storage/howto-protect-objects/
   protect-object-lock-retention/ (Stand 2026-08-27).
2. **DE-Standort, deutscher Anbieter, AVV vorhanden**; 4,99 €/Monat netto
   inkl. 1 TB Storage + 1 TB Egress, Requests kostenlos — deckt das Archiv auf
   Jahre.
3. **Bucket-Versioning** wird unterstützt und ist bei Object-Lock-Buckets
   erzwungen.

Verworfene Alternativen:
- **Cloudflare R2**: S3 Object Lock nachweislich unimplemented (API-Kompatibilitätsliste);
  proprietäre „Bucket Locks" sind vom Owner entfernbar — keine revisionssichere WORM-Garantie.
- **Backblaze B2 EU**: Object Lock ja, aber US-Gesellschaft (CLOUD Act) ohne
  Preis-/Feature-Vorteil.
- **Scaleway**: fachlich gleichwertig (Compliance-Mode, EU) — designierter
  EU-Fallback, verliert nur wegen fehlendem DE-Standort und Anbieter-Zoo.
- **AWS S3 eu-central-1**: einziger mit dokumentierten Conditional Writes,
  aber US-Anbieter beim sensibelsten Datenbestand; bleibt dokumentierter
  Fallback (~2–3 €/M bei <100 GB), falls das Test-Gate scheitert.

## Einschränkungen und Test-Gate (vor Produktivbetrieb, nach Credential-Erhalt)

1. **If-None-Match/Conditional Writes sind bei Hetzner undokumentiert**
   (weder zugesichert noch ausgeschlossen; Ceph-RGW-Basis unterstützt es in
   aktuellen Versionen). `lib/storage/s3.ts` sendet `IfNoneMatch: "*"` bereits
   mit dokumentierter Fallback-Semantik (HeadObject-Vorprüfung, Restfenster
   akzeptiert); Eindeutigkeit wird zusätzlich in Postgres erzwungen.
   **Test:** PutObject mit `If-None-Match: *` gegen existierenden Key → 412
   erwartet. Ergebnis hier nachtragen. Scheitert der Test UND wird die
   S3-seitige Garantie später hart benötigt → AWS-S3-Fallback für den
   Archiv-Bucket.
2. **Object Lock muss bei Bucket-Erstellung aktiviert werden**
   (`x-amz-bucket-object-lock-enabled`) — nachträglich unmöglich. Anlage-
   Kommandos stehen in docs/tooling/einkaufsliste.md.
3. **COMPLIANCE-Mode erst nach Testlauf mit 1-Tages-Retention produktiv
   setzen** — Fehlkonfiguration ist 8 Jahre unumkehrbar.
4. **Kein serverseitiges Default-Encryption (nur SSE-C):** Backups werden vor
   dem Upload clientseitig verschlüsselt (age). Archiv-PDFs bewusst
   unverschlüsselt im WORM-Bucket (SSE-C-Key-Verlust = Totalverlust;
   CopyObject auf SSE-C-Objekte wird von Hetzner nicht unterstützt).

## Konsequenzen

- Alle mutable Uploads verwenden `put()`, immutable Uploads (PDFs, Belege)
  nutzen `putImmutable()`; SHA256-Hash ist Pflichtfeld in der DB.
- Zwei Buckets: `S3_BUCKET` (Archiv, Object Lock) und `S3_BUCKET_BACKUP`
  (DB-Dumps, Versioning + Lock-Retention 30 Tage Governance).
- Env-Vars: `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_BUCKET_BACKUP`.
- Signierte URLs 5 min (Read) / 10 min (Upload) — konfigurierbar.
- Provider-Wechsel = Env-Wechsel; Code bleibt S3-kompatibel.
