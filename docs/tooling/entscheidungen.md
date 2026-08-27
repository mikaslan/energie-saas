# Tooling-Entscheidungen (Phase C der Tooling-Mission)

Stand: 2026-08-27 · Grundlage: Parallel-Recherche (10 Felder) + 5 unabhängige
Faktenchecks mit Primärquellen. Jede Kostenangabe mit Quelle und Datum. Verlierer
jeweils mit einem Satz. Prioritäten wie in `bedarfslandkarte.md`.
K3-Gegenprobe entfällt begründet: OpenRouter-Guthaben leer (siehe PLAN.md
Betriebsnotizen); die einzige Architekturentscheidung (ADR 0002) ist faktengetrieben
und durch zwei unabhängige Agenten-Pässe gegen Primärquellen geprüft.

## 1. Kanban-Drag&Drop (M1)

**Entscheidung: `@atlaskit/pragmatic-drag-and-drop`** (+ hitbox, auto-scroll,
react-accessibility). Apache-2.0, Core 3.0.0 (08/2026), von Atlassian in
Trello/Jira/Confluence produktiv betrieben — aktive Pflege genau im
Kanban-Use-Case, Core ohne React-Peer-Dependency (React-19-neutral).
Etwas mehr Eigenbau (Drop-Indikatoren) ist der Preis für ein wartungssicheres
Fundament unter dem M1-Kernfeature.

- ~~dnd-kit~~: Stabiles Paket seit 12/2024 ohne Release, dokumentierter
  Maintenance-Stillstand (Issue #1194); Nachfolger @dnd-kit/react erst 0.5.0.
- ~~@hello-pangea/dnd~~: 18 Monate ohne Release; erbt die Architektur, die
  Atlassian selbst zugunsten von pragmatic-dnd aufgegeben hat.

Merkposten: `@atlaskit/pragmatic-drag-and-drop-react-drop-indicator` hat noch
offene React-19-Peer-Deps (Issue #181) — vor Nutzung prüfen; Kernpakete sind sauber.

## 2. Data-Grid / Tabellen (M1–M3)

**Entscheidung: TanStack Table v9 (headless) + `@tanstack/react-virtual` +
shadcn/ui-Table.** MIT, 0 €, sehr aktiv (9.2.3 vom 26.08.2026); eine
Design-Sprache mit shadcn/Tailwind 4, Virtualisierung für große Kataloge.
**Achtung beim Bauen:** v9 ist ein API-Bruch (useTable statt useReactTable) —
v8-Tutorials/Snippets laufen nicht.

- ~~AG Grid~~: Community bringt ein zweites Theme-System neben shadcn; die
  relevanten Extras (Row Grouping, Excel-Export) sind Enterprise-only
  (999 USD/Entwickler, ag-grid.com/license-pricing, 27.08.2026) — als
  Eskalationsoption notiert, für M1–M4 unnötig.
- ~~Mantine DataTable~~: setzt @mantine/core voraus — komplettes zweites
  Komponentensystem, Ein-Maintainer-Projekt.

## 3. Formulare (überall)

**Entscheidung: react-hook-form 7.x + zod v4 + `@hookform/resolvers` +
`drizzle-zod`.** Die zod-v4-Kette ist stack-konsistent (better-auth 1.7 hängt
direkt an zod ^4, drizzle-zod 0.8.3 und resolvers 5.9.1 erlauben ^4) — eine
einzige zod-Instanz im Tree; alle shadcn-Form-Bausteine sind RHF-basiert.

- ~~TanStack Form~~: typsicher, aber kleineres Ökosystem und alle
  shadcn-Patterns müssten nachgebaut werden — kein Vorsprung, der das rechtfertigt.

## 4. Datei-Upload (M1, Fotos/Dokumente)

**Entscheidung: Uppy** (`@uppy/core` + `@uppy/aws-s3` + `@uppy/react` +
`@uppy/dashboard` + `@uppy/status-bar`). MIT, v6 (08/2026), Transloadit als
Firma dahinter; einzige Option mit Multi-Upload+Fortschritt+Retry **und**
presigned-S3-Pfad ohne eigenen Companion-Server (Signierung via Next-Route-Handler).

- ~~react-dropzone~~: nur eine Dropzone — Transport, Fortschritt, S3 wären Eigenbau.
- ~~FilePond~~: React-Adapter seit 12/2024 ohne Release; presigned-S3 ohne
  offiziellen Pfad.

## 5. CSV-/Excel-Import (M1) — Lücke aus der Bedarfslandkarte, inline entschieden

**Entscheidung: papaparse (+ @types/papaparse) für CSV jetzt; Excel-(xlsx)-Import
erst in der M1-Spec entscheiden.** CSV deckt den Pilot-Pfad (F1.2 CSV-Bulk,
Katalog-Import) ab; papaparse ist der unumstrittene Standard (MIT). Für xlsx ist
SheetJS wegen seines Distributions-/Lizenzmodells unattraktiv — wenn Excel nötig
wird, ist exceljs der Kandidat (dann prüfen).

## 6. Rich-Text / Notizen mit @-Mentions (M1)

**Entscheidung: Tiptap** (`@tiptap/react`, starter-kit, extension-mention,
suggestion). Benötigtes ist MIT-frei inkl. Mention; headless passt zu
shadcn/Tailwind; HTML/JSON-Output geht später direkt in die Chrome-PDF-Pipeline
(KI-Anschreiben M2). Nur Tiptap-Cloud-Features kosten — werden nicht genutzt.

- ~~Lexical~~: weiterhin 0.x; Mention-UI komplett Eigenbau.
- ~~Plate~~: Notion-Framework — Overkill mit hoher Major-Frequenz.

## 7. Charts inkl. Sankey (M1-KPIs, M4-Wirtschaftlichkeit)

**Entscheidung: Recharts 3.x, gestylt über shadcn/ui-charts-Patterns.** Eine Lib
für alles: shadcn-charts basieren offiziell auf Recharts v3, und Recharts bringt
eine eigene Sankey-Komponente mit (im Quellcode verifiziert) — der
M4-Energiefluss braucht keine zweite Chart-Lib. MIT, Release 23.08.2026.
Vor M4: 1-Tages-Spike, ob das Sankey-Layout für den PV-Energiefluss reicht;
Fallback wäre `@visx/sankey` nur für diesen einen Chart.

- ~~Nivo~~: @nivo/sankey fertig, aber >15 Monate ohne Release.
- ~~visx~~: low-level — Achsen/Tooltips/Legenden überall Eigenbau.

## 8. PDF-Viewer im Browser (M2/M3, Kundenportal)

**Entscheidung: react-pdf (wojtekmaj) mit Lazy-Load + Download-Button auf die
presigned URL.** Eigene wohlgeformte Chrome-PDFs sind der Idealfall für pdf.js;
react-pdf kapselt Worker/Canvas/TextLayer fertig (MIT, 10.5.0 vom 20.08.2026).
Der nackte iframe versagt auf iOS Safari — fürs mobile Kundenportal untauglich.

- ~~pdfjs-dist direkt~~: react-pdf von Hand nachbauen, kein Gegenwert.
- ~~iframe/object~~: je Browser andere UI, iOS-Mehrseiten-Rendering kaputt.

## 9. Karte + Pin-Bestätigung (M1, F1.3)

**Entscheidung Rendering: `maplibre-gl` + `@vis.gl/react-maplibre`.** Offizieller
MapLibre-React-Wrapper aus dem vis.gl-Stack (OpenJS Foundation); seit
react-map-gl v8 der vorgesehene Weg. (Der Recherche-Agent „Karten" nannte noch
react-map-gl — der Detail-Check des UI-Agenten ist aktueller: react-map-gl v8
ist Mapbox-fokussiert mit mapbox-gl-Peer; aufgelöst zugunsten
@vis.gl/react-maplibre.)

**Entscheidung Tiles: Stadia Maps Starter (20 USD/M) ab Pilot; OpenFreeMap
(0 €, ohne Key) für Dev/Preview.** Stadia: kommerzielle Nutzung, EU-Endpunkte
(Frankfurt), DPA/AVV vorhanden, 1 Mio. Credits decken Tiles+Geocoding
(stadiamaps.com/pricing, 27.08.2026). Free-Tiers von Stadia/MapTiler sind
non-commercial — für Dev reicht OpenFreeMap.

**Entscheidung Geocoding: Geoapify Free-Tier** (3.000 Credits/Tag, kommerzielle
Nutzung im Free-Tier erlaubt, EU-Firma; geoapify.com/pricing, 27.08.2026) für
Pin-Vorschlag + CSV-Auto-Geocoding; Attribution einbauen. Die Pin-Bestätigung
durch den Nutzer ist der Qualitäts-Backstop für OSM-Hausnummern-Lücken.

- ~~MapTiler Flex~~: teurer (30 USD), kein auffindbares DPA; bleibt Kandidat für
  M6-Satellit (DE-Auflösung vorher mit Testkey prüfen; Alternative: amtliche
  DOP20-WMS der Länder).
- ~~Nominatim/Photon public~~: Usage Policy verbietet den SaaS-Fall faktisch.
- ~~OpenCage~~: DSGVO-top (Berlin), aber kleinster Plan 45 €/M für 10k Req/Tag —
  überdimensioniert; Kandidat bei starkem Wachstum.
- ~~Google Geocoding~~: ToS-Doppelproblem (kein dauerhaftes Koordinaten-Caching,
  Anzeige nur auf Google-Karten) kollidiert mit CSV-Import + MapLibre.
- ~~Protomaps self-host~~: bester Langfrist-Preis, für P1 unnötiger Betrieb —
  als Kostenhebel ab Volumen vorgemerkt.

## 10. Kalender (M1) / Plantafel (M5)

**Entscheidung: FullCalendar Core v7 (MIT) jetzt** — Monats-/Wochen-/Tages-/
Listen-View + Drag&Drop via `@fullcalendar/interaction` decken F1.9 komplett
gratis ab; v7.0.2 unterstützt React 19 explizit. **M5-Plantafel-Pfad (P2, nur
dokumentiert): FullCalendar Premium resource-timeline** (480 USD/Jahr für 1–10
Devs, fullcalendar.io/pricing, 27.08.2026) — gleiches API-Modell, nur Plugin +
Lizenzschlüssel; Sparalternative: Eigenbau CSS-Grid, falls die Plantafel simpel
bleibt. Bei M5-Start prüfen: Premium-Pakete sind Stand 27.08.2026 erst v7-RC.

- ~~Schedule-X~~: Core MIT, aber Interaktions-Features und Resource-View sind
  Premium (479 €/Jahr) — zahlt früher, kleineres Ökosystem, Bus-Faktor 1.
- ~~react-big-calendar~~: keine Resource-Timeline — Sackgasse Richtung M5.
- ~~Bryntum/Mobiscroll~~: Enterprise-Preise bzw. Preis nur auf Anfrage.

## 11. PDF-Erzeugung (M2/M3) inkl. ZUGFeRD-Pfad

**Entscheidung Engine: Chrome/Playwright-Pipeline auf dem Worker (Status quo).**
Kapitel-Toggles, Sankey-SVG und Tailwind-Wiederverwendung sind genau die Stärke
von HTML/CSS; Golden-File-Tests mit PyMuPDF sind erprobtes Muster. `playwright`
wird jetzt installiert (Browser-Download erst im Worker-Docker-Build).

**Entscheidung ZUGFeRD-Lücke (kritisch, M3): Ghostscript-Nachbrenner auf dem
Worker.** Chrome erzeugt kein PDF/A-3; Ghostscript ist der einzige geprüfte
Kandidat, der ein normales Chrome-PDF nach PDF/A-3 **konvertiert** und im
ZUGFeRD-Modus (−dPDFA=3, zugferd.ps) Konvertierung + XML-Attach + XMP in einem
Aufruf erledigt (Muster produktionserprobt durch ChromicPDF). Das XML erzeugt
**node-zugferd** typisiert in TS (nur XML-Erzeugung, nicht dessen
PDF/A-Embedding — dort dokumentierter XMP-Bug); **Validierungs-Gate im CI:
Mustang `--action validate` + veraPDF + KoSIT-Validator.** Vor M3-Einfrieren:
1-Tages-Spike Chrome-PDF→GS→veraPDF/Mustang mit echtem Template.

- ~~Typst~~: zweite Template-Sprache, Doppelpflege; bleibt dokumentierter Plan B
  (natives PDF/A-3-Embedding seit 0.14), falls die AGPL-Frage Ghostscript ausschließt.
- ~~@react-pdf/renderer~~: eigene Layout-Engine ohne Browser-CSS, fragile
  Tabellen-Umbrüche, kein PDF/A — kombiniert die Nachteile.
- ~~node-zugferd als Konverter~~: setzt PDF/A-3-Input voraus, konvertiert nicht.
- ~~Mustang als Konverter~~: `combine` verlangt PDF/A-1-Quelle — für
  Chrome-Output ungeeignet; bleibt als **Validator** gesetzt.

Offen dokumentiert: AGPL-Einordnung Ghostscript-als-Subprozess im SaaS gilt
verbreitet als unproblematisch — vor M3-Launch einmal juristisch bestätigen
lassen oder bewusst akzeptieren; Artifex-Kommerzlizenz (Preis auf Anfrage) nur
als P3-Absicherung notiert.

## 12. E-Rechnung / E-Signatur / DATEV (M2/M3)

**E-Rechnung:** node-zugferd (MIT, TS, Zod-typisiert, 20k Downloads/Woche) für
die EN-16931-CII-XML-Erzeugung — aber Beta (0.1.1-beta.1 vom 08/2025, Bus-Faktor
1): jede erzeugte Datei läuft durch das CI-Gate. **KoSIT-Validator v1.6.3 +
validator-configuration-xrechnung v2026-01-31** (XRechnung 3.0.x) als
GitHub-Actions-Job in M3: setup-java (temurin 17) + gecachte Release-ZIPs —
**kein** offizielles Docker-Image (verifiziert; Fremd-Images = Supply-Chain-Risiko
für ein Compliance-Gate). **Mustang-CLI 2.26.0** (Apache-2.0, sehr aktiv) als
eigenes ~15-Zeilen-Docker-Image im Worker-Compose für validate/a3only/XRECHNUNG-
Fallback. XRechnung-Profil fehlt node-zugferd — Entscheidung (Eigenbau-Zusatzfelder
vs. Mustang-Route) erst, wenn ein Pilotkunde B2G beliefert.

**E-Signatur-Pad: signature_pad 5.1.4 direkt** als eigene ~50-Zeilen-React-
Komponente. 2,65 Mio. Downloads/Woche, MIT, eingebaute TS-Typen; Beweiswert
(Hash, Zeitstempel, Audit-Trail, WORM) baut die App (M2-Spec).
- ~~react-signature-canvas~~: hängt seit 03/2025 in einer Alpha.
- ~~DocuSign/Yousign/Skribble~~: SES per Pad reicht für Angebotsannahme; SaaS
  ab ~25 €/M/Nutzer erst relevant, falls je QES nötig.

**DATEV-EXTF: Selbstbau in TS (~2–4 PT)** nach offizieller Spezifikation
(developer.datev.de, kostenlose Registrierung — auf der Einkaufsliste);
Golden-File-Tests gegen das offizielle CSV-Prüfprogramm. Es gibt keine reife
npm-Lib (datev-extf tot/proprietär; @invoicekit/datev-export 4 Downloads/Woche —
nur Lese-Referenz).

## 13. Energie-Fachkern (M4; M6 dokumentiert)

**Entscheidung M4: pvlib python 0.15.x im FastAPI-Sidecar + PVGIS v5.3 als
Wetterdatenquelle.** BSD-3/NumFOCUS; PVGIS ist kostenlos (JRC, CC BY 4.0,
30 Calls/s) — TMY je gerundeter Koordinate dauerhaft cachen (CC BY erlaubt das),
damit ist das Rate-Limit irrelevant und der Cache zugleich die
Ausfall-Absicherung. Sidecar-Aufwand ~1–2 Tage (python:3.12-slim ins Compose).
**DWD TRY 2017 wird für M4-light nicht gebraucht** (eigener Parser, nur DE) —
als Ausbauoption dokumentiert.

**P2 dokumentiert:** hplib (MIT, FZ Jülich, 6.141 WP-Modelle aus Keymark) im
selben Sidecar für M6 · **Google Solar API**: buildingInsights 10.000
Calls/Monat frei, danach 10 $/1k; dataLayers nur 1.000 frei, dann 75 $/1k —
gedeckelt und nur on-demand; EEA-Terms seit 08.07.2025: Use-Case (Feasibility,
Design, Angebot) ausdrücklich erlaubt, Roh-Cache max. 30 Tage (TTL-Job), in
Angebots-PDFs eingeflossene Daten dürfen bleiben; buildingInsights liefert im
EWR keine postalCode/regionCode-Felder mehr (Quellen:
developers.google.com/maps/billing-and-pricing/pricing + /comms/eea/solar,
27.08.2026). Kein Kauf jetzt — M4 kommt mit manueller Dacheingabe aus.
**2D-Dach-Editor (M6): Konva + react-konva** (einzige Canvas-Lib mit offiziellem
React-19-Binding); Editor-State als reines Datenmodell trennen, dann ist
späteres 2.5D via react-three-fiber ein Rendering-Detail. **simshady + LOD2**
(NRW: opengeodata.nrw.de, Bayern: geodaten.bayern.de, beide Open Data — exakte
Lizenz-IDs vor M6 prüfen) als Stufe-2-Moat-Pfad notiert.

## 14. Daten-Zukäufe

**Entscheidung: In P1 wird nichts gekauft.**
- **Förderdaten:** Eigenpflege der ~10 Bundesprogramme als Zeitscheiben-Tabellen
  (amtlich publiziert, wenige Änderungen/Jahr). co2online/febis liefern
  gebrandete Frontends statt Daten-APIs, Preise nur auf Anfrage — P3-Pfad mit
  dokumentiertem Kontaktweg (vertrieb@fe-bis.de, kooperationen@co2online.de).
- **Komponenten-Stammdaten:** manuelle Pflege (20–50 Komponenten des
  Pilot-Sortiments) aus Hersteller-Datenblättern; das freie internationale
  ETIM-Modell nur als Schema-Vorlage. ~~ETIM-Mitgliedschaft~~ (~3.300 €/Jahr,
  unverifiziert): Klassifikation ohne Produktdaten — löst das Problem nicht.
- **DATANORM (P2):** KFE-Service-Musterdaten (Sonepar) als freie Test-Fixtures;
  echte Kataloge kostenlos übers Großhändler-Konto des Pilotkunden (Rexel:
  datanorm.support@rexel.de). Formatdoku frei via datanorm.de; Krammer-Taschenbuch
  (79,16 €) nur bei Parser-Lücken.
- **DIN EN 12831 (P3):** nicht kaufen — M6-Schätzverfahren läuft auf TABULA +
  BWP (frei); Normkauf (209,50 € + 270,00 € bei dinmedia.de, 27.08.2026) erst
  für raumweise Normheizlast, und dann Neuausgabe-Status prüfen (Entwurf 2025-06).

## 15. Betrieb / Infra

**Object Storage → ADR 0002 entschieden: Hetzner Object Storage** (Details und
Test-Gate im ADR). Kern: Object Lock GOVERNANCE+COMPLIANCE offiziell
dokumentiert (docs.hetzner.com, 27.08.2026), 4,99 €/M inkl. 1 TB, DE-Standort,
AVV; If-None-Match ist undokumentiert → empirischer Test nach Kauf (Code hat
dokumentierte Fallback-Semantik, Eindeutigkeit zusätzlich in Postgres). AWS S3
eu-central-1 bleibt dokumentierter Fallback.
- ~~Cloudflare R2~~: kein S3 Object Lock (verifiziert unimplemented), nur
  entfernbare Bucket-Locks — keine revisionssichere WORM-Garantie.
- ~~Backblaze B2~~: Object Lock ja, aber US-Gesellschaft ohne Vorteil.
- ~~Scaleway~~: gleichwertig, kein DE-Standort — designierter EU-Fallback.

**Worker-Server: Hetzner CX33** (4 vCPU x86, 8 GB RAM, NBG1/FSN1) — 8,49 €/M
netto + IPv4 (hetzner.com/cloud/pricing, 27.08.2026; **Preisanpassung
15.06.2026: alte Namen CX32/CX42 existieren nicht mehr**). x86 statt ARM wegen
Playwright/Chrome; 8 GB tragen pg-boss + Sidecar + 2 Chrome-Instanzen
(PDF-Concurrency in pg-boss auf 2 begrenzen); Live-Resize auf CX43 (15,99 €)
als Upgrade-Pfad. ~~CAX21 (ARM)~~: seit 06/2026 teurer als CX33 UND
Chrome-Reibung. ~~CPX-Serie~~: nach Preisanpassung 35–62 €/M.

**Neon: Free für Dev (M1–M3), Launch spätestens zum Pilot-Go-Live.** Free =
100 CU-h/Monat, 0,5 GB, 10 Branches (neon.com/pricing, 27.08.2026) — reicht,
wenn CI Preview-Branches löscht. **Launch ist heute usage-based ohne
Grundgebühr** (0,106 $/CU-h, 0,35 $/GB-M; der alte 19-$-Fixpreis ist veraltet),
realistisch 5–20 $/M. Trigger: Pilot live (PITR!), >0,5 GB, >10 Branches.

**Vercel: Hobby nur Dev — Pro (20 $/M) verbindlich VOR dem Pilotkunden.**
Hobby ist per FAQ „personal, non-commercial use" (vercel.com/pricing,
27.08.2026); ein Pilotkunde ist kommerzielle Nutzung, Verstoß riskiert
Suspendierung zum schlechtesten Zeitpunkt.

**Fehler-Monitoring: Sentry SaaS, Developer (Free), EU-Region Frankfurt.**
5.000 Errors/M frei (sentry.io/pricing, 27.08.2026); EU-Region muss **bei
Org-Anlage** gewählt werden (nachträglich nur via Support). @sentry/nextjs
unterstützt Next 16, @sentry/node deckt den Worker; Init hinter Env-Flag ist
installiert. Wechsel zu Bugsink/GlitchTip bleibt möglich (Sentry-Protokoll).
- ~~GlitchTip~~: Self-Host = 4 Container Ops-Last; Hosted-Free nur 1.000 Events.
- ~~Bugsink~~: bester Self-Host-Plan-B (1 Container), Bus-Faktor 1 — notiert.
- ~~highlight.io~~: Dienst zum 28.02.2026 eingestellt.

**Uptime/Dead-Man-Switch: healthchecks.io Free** (20 Checks, E-Mail+Push;
gehostet auf Hetzner-Servern in DE, EU-Betreiber, BSD-Code als Exit-Option;
healthchecks.io/pricing, 27.08.2026). Worker pingt nach jedem
Heartbeat-Zyklus; Ausbleiben alarmiert. Env-Flag-Gerüst ist eingebaut.
- ~~UptimeRobot~~: Heartbeat-im-Free widersprüchlich dokumentiert, kein
  EU-Nachweis. ~~Better Stack~~: solide Nr. 2 (10 Heartbeats frei).
- ~~Cronitor~~: teuerste Option.

**Backup: nächtlicher pg_dump vom Worker → zstd → age-Verschlüsselung →
aws-cli-Upload in separaten Bucket mit Object-Lock-Retention (30 Tage).**
pg_dump gegen Neon ist offiziell unterstützt; clientseitige Verschlüsselung ist
Pflicht, weil Hetzner nur SSE-C bietet. Script-Gerüst liegt in
`worker/backup/`. ~~Restic~~: Prune kollidiert mit Object-Lock, Dedup-Nutzen
bei kleinen Dumps minimal. ~~Nur Neon-PITR~~: schützt nicht vor
Anbieter-/Account-Verlust.

## 16. KI-Schicht (P1 klein)

**Entscheidung: Anthropic API direkt (`@anthropic-ai/sdk`): Claude Haiku 4.5
für Bill Reading (~0,005 $/Vorgang bei 1/5 $ pro MTok), Claude Sonnet 5 für
Angebotstexte (~0,012 $/Text bei 2/10 $ pro MTok)** (platform.claude.com bzw.
Anthropic-Pricing-Doku, 27.08.2026). Pilotbetrieb realistisch 1–10 $/M,
Prepaid mit Spend-Limit. DSGVO: DPA/SCCs Teil der Commercial Terms; keine
First-Party-EU-Inference — für den Pilot AVV+SCC+Transparenz, EU-Pfad später
via Bedrock Frankfurt (+10 %) nachrüstbar. OCR-Fallback (P2): Tesseract lokal
auf dem Worker (deu-Traineddata), dokumentiert, nicht installiert.

## 17. Kommunikation

**Resend: Free bis Pilot (3.000/M, 100/Tag), dann Pro 20 $/M** (resend.com/
pricing, 27.08.2026). Produktions-Setup = eigene Sende-Domain mit Region
eu-west-1 + DKIM/SPF/DMARC (Schritte auf der Einkaufsliste). Ehrlich benannt:
EU-Region betrifft nur den Versand, Account-Daten/Logs liegen in den USA —
gehört in AVV/Datenschutzerklärung. **WhatsApp Business API (P2, nur
dokumentiert):** Meta Cloud API direkt oder BSP 360dialog (Berlin, Flat-Fee);
seit 07/2025 Per-Message-Pricing (DE-Marketing grob 0,05–0,14 $/Msg,
Rate-Card vor M5 direkt bei Meta abrufen); Opt-in + AVV nötig.

## 18. Claude-Code-Ausrüstung (Bestand geprüft 27.08.2026)

Vorhanden und ausreichend für M1–M4: superpowers (Spec→Plan→TDD), codex
(Reviews), context7 (Doku), playwright- + chrome-devtools-MCP (E2E/Verifikation),
vercel-Plugin, frontend-design, code-review, eigene Skills
(responsive-verifikation, website-golive-de u. a.).

**Konkrete Empfehlungen:**
1. **gh-Token um `workflow`-Scope erweitern** (P1, blockiert CI-Push —
   Einkaufsliste #1).
2. **Neon-MCP verbinden** (P1): Plugin installiert, aber nicht authentifiziert —
   `/neon` → authenticate (Browser-OAuth, ~1 Min.). Danach DB-Branches/Queries
   direkt aus Claude Code.
3. **GitHub-MCP-Plugin**: verbindet aktuell nicht („Authorization header badly
   formatted") — kein Blocker, gh CLI deckt alles ab; bei Gelegenheit Plugin
   re-authentifizieren oder deaktivieren.
4. **Stripe-Plugin**: bleibt ungenutzt bis eigenes Billing (P3) — nichts tun.
5. Kein neues Plugin nötig; Sentry-/Storage-Bedienung läuft über CLI/Env.

## 19. GitHub + CI

Privates Repo **`mikaslan/energie-saas`** angelegt (27.08.2026), `main`
gepusht, Default-Repo gesetzt. `m0-fundament` und `tooling` werden vom
OAuth-Token **abgewiesen** (`.github/workflows/ci.yml` braucht `workflow`-Scope)
— Freischaltung + Push + CI-Verifikation stehen als Schritt 1 der
Einkaufsliste; die Verifikationskommandos stehen in STATUS.md.
