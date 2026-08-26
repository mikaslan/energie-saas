# ADR 0002: Object-Storage-Anbieter mit WORM-Unterstützung

Datum: 2026-08-26 · Status: vorgeschlagen

## Kontext

Das System muss GBD-konformes Vollarchivieren (Write-Once-Read-Many / WORM) für signierte PDFs und ausgestellte Belege ab M2/M3 umsetzen. M0 etabliert eine S3-kompatible API als Abstraktion (`lib/storage/`); die App implementiert WORM auf Applikationsseite mit SHA256-Hashing. Für echten Datenschutz ist mittelfristig ein Anbieter erforderlich, der Object-Lock (aws:object-lock) nativ unterstützt.

## Entscheidung

1. **EU-Regionen-Anforderung**: Datenspeicherung in der EU (DSGVO/GBD-Konformität)
2. **S3-API-Kompatibilität**: Standard `@aws-sdk/client-s3` v3; ermöglicht Provider-Austausch ohne Code-Änderungen
3. **WORM-Vorbereitung**: 
   - M0: App-seitige WORM-Semantik via `putImmutable()` + Existenz-Prüfung (HeadObject 404)
   - M2/M3: Echter Object-Lock beim Provider wird vor Release geprüft
4. **Hetzner-Evaluierung ausstehend**: Vor M2-Start muss an Hetzner Object Storage (docs.hetzner.com) verifiziert werden, ob Object-Lock unterstützt wird
   - Falls **Ja**: Hetzner-Endpunkt `eu-central` verwenden
   - Falls **Nein**: AWS S3 `eu-central-1` für immutable/-Bucket als Fallback

## Konsequenzen

- Alle mutable Uploads verwenden `put()`, immutable Uploads (PDFs, Belege) nutzen `putImmutable()`
- SHA256-Hash ist Pflichtfeld; wird in DB gespeichert (Integrität, Audit-Trail)
- Env-Vars: `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`
- Signierte URLs gelten für 5 min (Read) / 10 min (Upload) – Konfigurierbar
- Provider-Wechsel setzt nur Env-Vars neu; Code ändert sich nicht (S3-API-Kompatibilität)
- Provider muss `If-None-Match`-conditional writes unterstützen (PutObject-Header zur TOCTOU-Abwehr) und Object-Lock für echte Unveränderlichkeit ab M2/M3
