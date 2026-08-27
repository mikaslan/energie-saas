# Bedarfslandkarte Tooling (Phase A der Tooling-Mission)

Stand: 2026-08-27 · Abgeleitet aus `docs/blaupause/01-modulkatalog.md` (F-Nummern) und
`docs/blaupause/05-roadmap.md`. Prioritäten: **P1** = nötig für M1–M4 (Pilot-Gate),
**P2** = M5–M8, **P3** = nice-to-have. Gekauft/installiert wird jetzt nur P1.

Bereits vorhanden (nicht erneut evaluiert): Next.js 16 + TS + Tailwind 4 + shadcn,
Drizzle + Neon, better-auth, pg-boss v12, @aws-sdk/client-s3 (+ Presigner),
Vitest + embedded-postgres, dependency-cruiser, Resend-SDK, Chrome-PDF-Pipeline
(Muster erprobt), Vercel CLI, Codex CLI, context7-MCP, Playwright-MCP.

## P1 — für M1–M4 nötig

| Fähigkeit | Modul (F-Nr.) | build/buy/lib | Bemerkung |
|---|---|---|---|
| Kanban-Drag&Drop | M1 (F1.5) | lib | Board mit konfigurierbaren Spalten, Touch |
| Data-Grid/Tabellen | M1 (F16.1, Listen) | lib | Katalog + Rechnungslisten, Virtualisierung |
| Formulare + Validierung | M1–M3 (überall) | lib | react-hook-form + zod (Versions-/v4-Frage) |
| CSV-/Excel-Import | M1 (F1.2, F16.1) | lib | Parser; Mapping-UI ist build |
| Karte + Pin-Bestätigung | M1 (F1.3) | lib + buy | MapLibre; Tiles + Geocoding = Dienst |
| Geocoding (DE, hausnummerngenau) | M1 (F1.2/F1.3) | buy | Anbieter + Kosten = Rechercheergebnis |
| Datei-Upload/Dropzone | M1 (Querschnitt Dateien) | lib | presigned S3-URLs, Foto-Batch |
| Rich-Text (Notizen, @-Mentions) | M1 (F1.9) | lib | später auch KI-Anschreiben (M2) |
| Kalender-Ansicht (Termine) | M1 (F1.9) | lib | Wahl darf M5-Plantafel nicht verbauen |
| Charts (KPI, Cashflow, Sankey) | M1/M4 (Querschnitt, F4.5) | lib | Sankey-Fähigkeit ist das harte Kriterium |
| PDF-Viewer im Browser | M2 (F2.7/F2.8, Portal) | lib | eigene Worker-PDFs anzeigen |
| Angebots-/Rechnungs-PDF | M2–M3 (F2.7, F8) | build | Engine-Entscheid: Chrome vs. Typst vs. react-pdf |
| E-Signatur-Pad | M2 (F2.8) | lib | signature_pad; Rest ist build (M2-Spec) |
| E-Rechnung (EN 16931 → ZUGFeRD/XRechnung) | M3 (Integrationskarte 2) | lib | node-zugferd vs. Mustang; PDF/A-3-Pfad klären |
| KoSIT-Validator im CI | M3 | tool | Golden-File-Gate für jede erzeugte Rechnung |
| DATEV-EXTF-Export | M3 (Kür früh) | build | Formatspez. beschaffen; keine Lib erwartet |
| Steuerberater-Monats-ZIP | M3 (F8.6) | build + lib | kleiner Baustein (Archiv-Lib) |
| PV-Simulation (pvlib + PVGIS) | M4 (F4.1–F4.5) | build (OSS) | Python-Sidecar auf Worker; TMY-Cache |
| Förder-/EEG-Regelwerk | M4 (F5.6-Teil) | build (Daten) | Zeitscheiben-Tabellen, Redaktion — kein Zukauf in P1 |
| Worker-Server | Infra (Architektur §2) | buy | Hetzner-Produktwahl = Rechercheergebnis |
| Object Storage mit WORM | Infra (ADR 0002 offen) | buy | Object-Lock + If-None-Match = Entscheidungskriterium |
| Fehler-Monitoring (EU) | Infra | buy/lib | Sentry o. Alternative; Init hinter Env-Flag |
| Uptime-/Dead-Man-Alarm Worker | Infra (Runbook) | buy (free) | Healthcheck meldet sich, Ausbleiben alarmiert |
| Backup-Automatisierung | Infra (backup-dr.md) | build | pg_dump-Cron → Storage `backups/` |
| Neon-Plan | Infra | buy | Free vs. Launch — Grenzen = Rechercheergebnis |
| Vercel-Plan | Infra | buy | Hobby-Kommerzklausel prüfen |
| Anthropic-API-Key | KI (F14.5 ab M4/M8) | buy | Bill Reading, Angebotstexte; Kosten je Vorgang |
| Resend Produktions-Setup | Kommunikation | buy | Domain, DKIM/SPF, Planwahl |
| GitHub-Repo + CI scharf | Infra | build | privates Repo `mikaslan`, Push, CI-Lauf fixen |

## P2 — für M5–M8 (jetzt nur dokumentieren)

| Fähigkeit | Modul | build/buy/lib | Bemerkung |
|---|---|---|---|
| Ressourcen-Plantafel | M5 (F7.5) | lib | Timeline/Resource-View; Lizenzfrage FullCalendar |
| 2D-Dach-Editor-Canvas | M6 (F3.3/F3.4) | lib | Konva vs. Fabric vs. r3f — Richtungsentscheid |
| Google Solar API | M6 (F3.2) | buy | Preise + EEA-ToS + Cache-Regeln |
| WP-Bibliothek hplib | M6 (F5.1) | lib (OSS) | selber Sidecar |
| LOD2-CityGML NRW/Bayern + simshady | M6 Stufe 2 | build (Daten) | Moat-Pfad, Lizenz je Land |
| Orthofoto-Layer | M6 | buy | Satellit/DOP für Dach-Editor |
| Förderdaten-Zukauf (co2online/febis) | M4-Ausbau/M7 | buy | Long-Tail Länder/Kommunen; Kontakt dokumentieren |
| ETIM / Hersteller-Datenblätter | M1-Ausbau (F16.1) | buy/Daten | Klassifikation vs. Produktdaten klären |
| DATANORM-Beispieldateien + Spez | M8 (Kür) | Daten | BayWa r.e./UNI ELEKTRO-Downloads |
| DIN EN 12831(-1) | M8 (F5.1 raumweise) | buy (Norm) | erst wenn WP-Modul Umsatz trägt |
| OCR-Fallback | M8 (F14.5) | lib | Tesseract o. Cloud |
| Transkription (Sprachmemos) | M8 (F11.3/F14.6) | buy | später |
| WhatsApp Business API | M8 (F14.3) | buy | Anbieter + Preise nur dokumentieren |
| Broker-APIs (Wattfox …) | M7 (F1.2) | build | Inbound-Muster, je Broker Mapping |
| Kalender-Sync Google/MS | M8 (F1.9) | build + OAuth | Infrastruktur-Integration |
| OIDC-SSO | M8 (Querschnitt) | lib | better-auth-Plugin, Enterprise |

## P3 — nice-to-have

IDS-Connect v2.5 (Großhandel), DATEV-Datenservices (OAuth, ab 25 Nutzern),
AT/CH-Förderprogramme, eigene Photogrammetrie, Rust-Simulationskern,
bexio/Xero/weclapp-Adapter, Open Masterdata.
