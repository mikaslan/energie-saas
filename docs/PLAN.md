# Plan: Reonic funktional nachbauen — „unser Reonic", dann besser

## Kontext

Mikail baut ein eigenes SaaS im Markt von Reonic (reonic.com): Software für Installateure
erneuerbarer Energien (PV, Wärmepumpe, Wallbox, Speicher). Ziel in dieser Reihenfolge:
**(1) Funktionsparität mit Reonic, (2) danach gezielt verbessern.** Marktzugang übers
WMEE-Umfeld (Elektriker-Kontakte). Entscheidungsmaßstab (Vorgabe): maximale Qualität der
funktionalen Kopie.

Grundlage dieses Plans: Ultracode-Schwarm `reonic-blueprint-swarm` (44 Agenten, 30/30
Recherchen erfolgreich, Reonic-Hilfe-Center 10 von 37 Bereichen tief gelesen) + K3-Gegenprobe.
**Vollständige Ergebnisdokumente** (Modulkatalog ~24 kB, Marktbild, Integrationskarte,
Architektur, Roadmap, Kritik, K3): als `result`-Feld im Task-Output
`/private/tmp/claude-501/-Users-mikailaslan/5d2ac444-2403-48f9-804c-d3a6bb42e7af/tasks/wrwlh1rr3.output`
sowie dauerhaft in
`~/.claude/projects/-Users-mikailaslan/11bfcfdb-79f6-4345-882f-824908757f77/subagents/workflows/wf_07661901-2f7/journal.jsonl`.
**Erster Umsetzungsschritt ist, diese 7 Dokumente ins Projekt-Repo zu persistieren** (`docs/blaupause/`).

## Fixierte Leitplanken

- **Clean-Room:** Funktionen/Workflows nachbauen ist frei (§ 69a Abs. 2 UrhG, EuGH SAS).
  Tabu: Reonics UI-Gestaltung, Texte, Code, Komponenten-Datenbank (§§ 87a f. UrhG),
  **kein Reonic-Test-/Demozugang** (AGB verbieten Konkurrenznutzung → GeschGehG/§ 4 Nr. 3 UWG).
  Erkenntnisquelle bleibt ausschließlich öffentlich + eigene Anwender-Interviews.
  Als CONTRIBUTING-Grundsatz ins Repo. Markencheck (DPMA/EUIPO) vor Naming.
- **Positionierungs-Konflikt aufgelöst:** Das Marktbild empfahl einen Wallbox-Keil; die
  Zielvorgabe ist aber Reonic-Parität. Entscheidung: **Baureihenfolge = Reonic-Kern
  (PV-Residential)**, aber **Pilotkunden aus dem WMEE-/Elektriker-Umfeld** und die
  „Besser-als-Reonic"-Top-10 (öffentliche Preise, Self-Service-Start ohne Setup-Gebühr,
  Offline-App, WhatsApp-Eingang, interaktives Web-Angebot …) als fixe Phase-2-Liste im
  Marktbild-Dokument.

## Blaupause (Kurzfassung — Details mit F-Nummern im Modulkatalog)

Reonics Kern: **ein Projekt-Datensatz über drei Phasen** (Request → Offer → Installation),
Contact als Spine, Kanban-Spalte getrennt vom Outcome. 16 Module:
M1 CRM/Leads · M2 Angebote+E-Signatur · M3 PV-3D-Planung · M4 Simulation/Wirtschaftlichkeit ·
M5 WP-Heizlast/LiDAR · M6 Schaltplan · M7 Installation/Checklisten/Plantafel · M8 Rechnungen
(GoBD, bewusst ohne Buchhaltung) · M9 Zeiterfassung · M10 Kundenportal · M11 Mobile App
(offline-first Capture) · M12 Endkunden-Funnel · M13 Service-Marktplatz (Netzanmeldung 349 €,
KfW 210 € …) · M14 KI-Schicht · M15 Gewerbe/Mieterstrom · M16 Katalog/Vorlagen.
Querschnitt: passwortlose Auth, 4-schichtige Rechte, Events/Activity-Feed, 8 Mail-Automatiken,
REST v3 + Webhooks. 9 dokumentierte Quellen-Widersprüche + „nur per Interview klärbar"-Liste
stehen im Katalog.

## Architektur (entschieden; Richter-Votum 2:1 für Pragmatik-Entwurf, Grafts eingearbeitet)

- **Modularer Monolith:** Next.js 16 + TS + Tailwind/shadcn auf Vercel, Neon Postgres +
  Drizzle, **Modulgrenzen technisch erzwungen** (dependency-cruiser/ESLint, CI rot).
  Alle Mutationen durch Service-Funktionen; Server Actions nur dünne Wrapper.
- **Ein Hetzner-Worker** (Docker Compose): pg-boss-Queue, Chrome-PDF, pvlib-Python-Sidecar
  (FastAPI, PVGIS-Cache), E-Rechnungs-Serialisierung. Degradation: Worker-Ausfall verzögert
  Jobs, blockiert nie das Portal. Für den in M2-02 implementierten internen PDF-Draft ist
  das Produktionsrezept exakt an `linux/amd64`, Playwright 1.62.1 und den vollständigen
  OCI-Child-Digest gebunden; der produktive Deploy bleibt ein separates Gate.
- **Nicht nachrüstbare Tag-1-Investitionen** (je Stunden bis Tage): `workspace_id` überall +
  **RLS + `withTenant` doppelt** · `domain_events`-Outbox (in derselben Transaktion) getrennt
  vom `audit_log` (beide append-only) · **Site-Entität** (Gebäude) zwischen Contact und
  Project · **Snapshot-Semantik** an jeder kommerziellen Grenze (BOM kopiert Katalogwerte,
  „Outdated"-Banner statt stiller Propagation) · Statusmaschinen explizit · WORM/Object-Lock
  + Content-Hash für festgeschriebene Belege (GoBD, 8 Jahre) · Zeitscheiben-Tabellen für
  Förder-Regelwerk + VNB-Verzeichnis (**der Moat ist Datenpflege, nicht Code**).
- **Auth:** better-auth (Magic Link/OTP/Passkeys), Kundenportal/Funnel strikt getrennte
  Token-Routen. Rechte: 3 Schichten mit zentraler `can()`; Membership-Schema so, dass
  Reonics Bereichs-Toggles/Teams additiv nachrüstbar sind.
- **E-Rechnung:** intern EN-16931-Modell, ZUGFeRD + XRechnung nur Serialisierungen;
  node-zugferd prüfen, Mustang-Container als Fallback; KoSIT-Validator im CI.
- **E-Signatur selbst bauen** (einfache elektronische Signatur, Token-TTL, View-Tracking,
  Hash, append-only-Attestierung) — eIDAS-Einordnung vor Pilot einmal anwaltlich prüfen.
- **Mobile: PWA zuerst**, Offline-Fläche hart begrenzt (nur Checklisten-Antworten, Fotos,
  Zeiterfassung; IndexedDB-Outbox, idempotente Mutationen, LWW). Capacitor-Hülle erst,
  wenn WP-Modul (LiDAR) Umsatz trägt.
- **Simulation:** pvlib + PVGIS + hplib hinter `SimulationEngine`-Interface, Ergebnisse als
  versionierte Snapshots; kein Eigenbau der Physik.

## Roadmap (jeder Meilenstein einzeln nutzbar; je Meilenstein eigene Spec → eigener Plan)

- **M0 Fundament:** Multi-Tenant-Skeleton, Auth, `can()`, Events/Audit, Site, Storage/WORM-
  Vorbereitung, Worker, CI (Modulgrenzen + generische Tenant-Isolations-Suite über alle
  Tabellen), ADRs, Rechtsgrundausstattung (AGB/AVV-Vorlagen → 1× Anwalts-Review).
  **Parallel ab Woche 1:** Redaktion Förder-Regelwerk + VNB-Verzeichnis (Top-50).
- **M1 Stammdaten-Kern + CRM:** Komponenten-DB (Zod-typisierte JSONB, CSV-Import), Kontakte,
  Kanban, Outcomes, Aufgaben/Notizen/Termine, Suche/Tags, Activity Feed, erste KPIs.
- **M2 Angebot + E-Signatur:** M2-01 liefert lokal verifizierte Varianten mit
  Snapshot-BOM und Rabatt-/Steuer-Stack. M2-02 liefert als lokal technisch
  verifizierten Slice einen internen, nicht verbindlichen PDF-Draft aus exakt einer
  unveränderlichen Revision: asynchron, offline/sandboxed gerendert, tenantgeschützt
  gestaged und privat herunterladbar. Ausstellung, Versand und Signatur → WORM +
  Phasenwechsel bleiben eigene Folge-Slices. **Dazu (K3-Punkt
  übernommen): Nachtrags-/Änderungs-Workflow nach Signatur (Fork-UX, Preisdifferenz)
  konzipieren, bevor der Pilot startet** — noch kein volles Order-Modell.
- **M3 Rechnung/GoBD:** volle Fakturierung inkl. 4 Teilrechnungstypen, erzwungener
  Anzahlungsabzug (§ 14c-Schutz), Steuerlogik (0 % § 12 Abs. 3 / 19 % / § 13b /
  Kleinunternehmer), ZUGFeRD/XRechnung, Steuerberater-ZIP, Lexware/sevDesk-Push,
  DATEV-EXTF früh (Kür). Vor Pilot: 1× Steuerberater-Review + Verfahrensdoku.
- **M4-light Wirtschaftlichkeit (K3-Punkt übernommen — vor Pilot-Start):** pvlib/PVGIS-
  Ertrag + Amortisation/Cashflow + EEG-Kaskade + Förder-Schätzung im Angebots-PDF.
  **Pilot-Gate = M0–M4-light**; Pilot-Akquise (WMEE-Umfeld) läuft parallel ab M3.
- **M5 Baustelle:** Checklisten-Engine (als eigenes Teilprojekt behandeln — laut Kritik
  der meistunterschätzte Block), Plantafel, Workbook, Handover, Zeiterfassung, PWA-Offline,
  Portal-Ausbau.
- **M6 Auslegung:** Google Solar buildingInsights (Cache, ToS prüfen) + 2D-Dach-Editor +
  Stringplanung + WP-Schätzverfahren (hplib). LOD2+simshady als späterer eigener Datenpfad.
- **M7 Anlagen-Lifecycle/Services:** `plant_record` + generisches `filing`-Muster,
  Netzanmeldung (Dokumentenmappen, Fristen, § 14a, MaStR-SOAP; Einreichung als Partner-
  Service mit konzessioniertem Meister — Haftungsgefüge vorher vertraglich klären),
  Förderservice, Schaltplan, Funnel, Broker-Inbound, Mail-Automatiken.
- **M8 Parität-Rest nach Umsatz:** KI-Schicht (Bill Reading zuerst), raumweise Heizlast +
  LiDAR/Capacitor, Commercial/Mieterstrom, REST-API v1 + Webhooks, restliche Kür.
- **Ehrliche Zeitachse (aus der Kritik übernommen):** M0–M4-light ≈ 6–12 Monate solo mit
  KI-Unterstützung. Keine Parallel-Illusionen; Moat-Redaktion kostet feste Wochenstunden.

## K3-Zusammenführung (Zweitblick, nicht Autorität)

- **Übernommen:** M4-light vors Pilot-Gate (Simulation ist Reonics Verkaufskern — konsistent
  in beiden K3-Pässen, deckt sich mit Marktbild); Nachtrags-Workflow vor Pilot konzipieren
  (verstärkt Richter 3; Nachträge sind im Handwerk Normalfall).
- **Nicht übernommen (gegen den Text geprüft):** Worker-„SPOF"-Dramatik (Degradations-
  Semantik existiert; zusätzlich PDF-Notpfad dokumentieren), Foto-LWW-Kritik (Fotos sind
  append-only, faktisch falsch), DSGVO-Einwand (wirr; EU-Storage/AVV stehen im Plan).
- **Offen markiert:** K3s Selbstwiderspruch zum Tag-1-Stack („Standard" vs. „Overengineering");
  mein Befund: Stack bleibt — als Stunden-Investition dimensioniert. Ungeprüfte Fragen
  (better-auth-Reife, RLS-Performance, Solo-Vertrieb) nach Guthaben-Aufladung nachziehen.

## Aus der Vollständigkeitskritik in den Plan gezogen

1. **Phase 0 (vor M0, parallel möglich):** 5–10 Anwender-Interviews im WMEE-Umfeld
   (rechtlich sauber, ersetzt den verbotenen Demozugang; klärt die „nur per Interview"-Liste
   und die 9 Quellen-Widersprüche) + Naming/Markencheck + Repo-Setup mit Blaupause-Docs.
2. **Backup/DR-Konzept** (RPO/RTO, Restore-Test) als Teil von M0 — für ein GoBD-System
   Existenzfrage.
3. **DSGVO-Löschung vs. WORM/Events:** Krypto-Shredding-/Pseudonymisierungs-Konzept in
   M0-Spec aufnehmen.
4. **Haftungs-Disclaimer-Architektur** für Wirtschaftlichkeits-/Förderaussagen (M4-light)
   + Aktualitäts-Prozess fürs Förder-Regelwerk; AI-Act-Transparenzpflichten bei M14.
5. **Migration/Import für Wechselkunden** (Excel/HERO/Reonic-Export) als M5+-Backlog.

## Verifikation

- Pro Meilenstein: superpowers-Workflow (Spec → writing-plans → TDD), Codex-Review
  (`/codex:review --background`), K3-Gegenprobe bei Architekturentscheidungen (nach
  Aufladung).
- Testschwerpunkte wie Architektur §8: Geldpfad-pure-Functions, Golden-Files
  (PDF via PyMuPDF, XRechnung/ZUGFeRD gegen KoSIT im CI), generische Tenant-Isolations-
  Suite bei jeder Migration, Rechte-Matrix-Test, ~6 Playwright-E2E-Flows.
- Abnahme je Meilenstein gegen die F-Nummern des Modulkatalogs.

## Aktueller Ausführungsstand

- Ehrlicher Gesamtstand der F1–F16-Mission nach M1-11a und der lokalen
  M2-03b1-Basis: ca. **23–24 %**. Das technische Fundament liegt bei ca.
  **97–98 %**, die heute nutzbare Produktbreite bei ca. **16–17 %**.
- M1-11a ist lokal `REVIEWED/VERIFIED`; das technische Gate 2 ist `GO`.
  Won/Lost/Reopen, administrierbare Verlustgründe, geschlossene Liste,
  Rollen-/Privacy-, Race-, Evidence- und Erasure-Grenzen sind belegt.
- M2-01 bis M2-03b1 sind lokal technisch verifiziert. Ihre menschlichen
  Portal-/PDF-Visual-Gates und M2-03b2 Object Lock bleiben davon unabhängig
  `INCONCLUSIVE` beziehungsweise extern blockiert.
- M2-02 kennt ehrlich nur `queued`, `running`, `retry_wait`, `succeeded` und
  terminal `failed_final`. Viewer dürfen Status und erfolgreiche interne Drafts
  lesen/downloaden; Editor/Admin dürfen mit `project.write` anfordern/replayen;
  External erhält keinen Zugriff und `app_worker` nur minimale tenantgebundene
  Claim-/Finalize-/Recovery-Rechte.
- M2-02 führt bewusst kein Rollout-Flag ein. Bestehende Feature-Flags ersetzen nie
  Membership, Rolle oder Einzelrecht.
- Nicht als geliefert zählen: `issued`, Versand/E-Mail, Annahme/Signatur,
  öffentlicher Link/Kundenportal, Rechnung, Object Lock/WORM oder produktiver
  Worker-Deploy. Diese Grenzen werden erst in eigenen, belegten Slices geöffnet.

## Betriebsnotizen (sofort, außerhalb des Builds)

- Kimi K3 über OpenRouter bleibt eine deadline-begrenzte parallele
  Implementierungsunterstützung, niemals ein Freigabe-Gate. Aktivierung erst
  mit lokal sicher hinterlegtem, rotiertem `OPENROUTER_API_KEY`; ohne Schlüssel
  läuft der Hauptpfad unverzögert weiter.
