# Kanonischer Modulkatalog Reonic — Blaupause für den funktionalen Nachbau

## Kernarchitektur (Vorbemerkung)

**Ein Projekt-Datensatz, drei Phasen:** `Request → Offer → Installation` — Installation ist kein eigener Datensatz, sondern dieselbe Karte mit neuem Verhalten. **Contact als Spine** (1 Kontakt : n Projekte). **Zwei Achsen pro Karte:** Kanban-Spalte (workspace-konfigurierbar) getrennt vom Outcome (`Open/Won/Lost/Cannot fulfill`). Residential (360H) und Commercial (360B) sind **getrennte Datenmodelle ohne Konvertierung**. App = Capture-Client (offline-first), Portal = Kalkulation/Kommerz. Stack-Referenz: TypeScript durchgängig, React/Tailwind, Node+GraphQL intern, REST v3 extern (Express/Lambda), PostgreSQL/Prisma, AWS, Simulationskern in Rust.

---

## M1 — CRM & Leads (Requests)

**Zweck:** Lead-Eingang, Qualifizierung, Pipeline-Steuerung bis Angebotsreife.

- F1.1 Kontaktverwaltung (Name, 2 E-Mails, Telefon+Erreichbarkeitsfenster, 1 Hauptadresse, B2B-Flag, Anrede, Marketing-Consent mit Policy-Version, UTM-Kampagnenfelder, DSGVO-Löschzeitstempel)
- F1.2 Request-Anlage: 6 Intake-Pfade — manuell (Modal, Kontakt-Vorbefüllung), Mobile App, Excel/CSV-Bulk (Auto-Geocoding, nur Residential), Webformular/Energiehaus (einziger Pfad mit Welcome-Mail), 6 Broker-APIs (Wattfox, Aroundhome, DAA, Eza, Interlead, Bitrix; Dedupe über Broker-Record-ID, cross-broker nur kontaktbasiert), REST-API
- F1.3 Projektadresse ≠ Kontaktadresse; Karten-Pin-Bestätigung Pflicht (Lat/Lng zählt fürs Planen)
- F1.4 Gebäude-/Energiedaten am Lead: Eingabemodus consumption/property/roomwise/manual, Bestandsanlagen (PV/Speicher/Wallbox/EV), Zielpakete (Solar/Speicher/Wallbox/Heizung, je Purchase/Lease/Financing), Verbrauch/Strompreis/Eskalation/Lastprofil
- F1.5 Kanban-Boards mit frei definierbaren Spalten + Spalten-Typen (`Lead/Offer/Won/Lost`, steuern Automatik wie Angebotsnummern-Vergabe), optionale Conversion-Ratio je Spalte → gewichtete Pipeline
- F1.6 Outcome-Aktionen: Mark as Won (Close-Date), Mark as Lost (strukturierter Grund + Freitext), Cannot fulfill (Einweg, mailt Kunden, sperrt Signatur), Reopen (löscht Grund, re-triggert keine CRM-Syncs)
- F1.7 AI Lead Score 0–100 (asynchron, Ampel, Filter-Presets, Signale: Objekt-/Kontaktqualität/Intent)
- F1.8 Lead Sources (Name+Farbe, archivierbar statt löschbar, Auto-Zuweisung per Broker/Funnel-Variante)
- F1.9 Aufgaben (Titel, Rich-Text, absolutes Fälligkeitsdatum, n User + n Teams, Labels, Sub-Checklisten, Templates mit relativen Daten; keine Recurrence/Dependencies), Kalender (4 Scopes, Google/MS-Sync, Terminvorlagen, keine Serientermine), E-Mail-Anbindung (Gmail/M365, projektbezogener Read-only-Drawer), Notizen mit @-Mentions, Duplikat-Triage manuell

**Objekte:** Contact, Request, KanbanBoard/Column, Task, LeadSource, Tag, Note, Appointment.
**Rollen:** Editor+ legt an (sieht alles), Viewer read-only, External-User sieht nur Zugewiesenes, Admin konfiguriert Boards/Integrationen. Pro Projekt: genau 1 Key Account Manager (Mail-Absender, PDF, CRM-„Bearbeiter") + n User + n Teams.

## M2 — Angebote (Offers)

**Zweck:** Von Planung zu unterschriftsreifem Vertragsdokument.

- F2.1 Offer-Anlage aus Request („Converted to offer"-Tag) oder direkt; Angebotsnummer auto (Format konfigurierbar), Deal-Wert (Forecast ≠ Kundenpreis), Anlagenart Wohnen/Gewerbe bei Anlage fix
- F2.2 **Varianten** (n pro Offer, PDF-Nummer „1024-2"): eigene Stückliste, Preise, Finanzierung, 3D-Layout; Duplizieren kopiert alles; signierte Variante = unveränderliches Vertragsartefakt, Änderung nur per Fork
- F2.3 Stückliste (BOM): Position mit Katalog-Artikel, Menge, EK/VK, Rabatt %, MwSt., Positionstyp `required/additional/optional`, „ausblenden"-Flag, Drag-Reorder, Sektionen
- F2.4 Rabatt-Stack in fester Reihenfolge: Zeile → Sektion/Paket → Gesamt (Templates) → Custom Deal Value (Festpreis); Total-Cap 0
- F2.5 Zahlarten pro Komponente: Kauf / Finanzierung (Bees&Bears mit Status-Rückmeldung, „Classic" als reine Anzeige) / Leasing; Reonic wickelt keine Zahlungen ab
- F2.6 Optionale Komponenten als Upsell-Checkboxen auf der Signaturseite (Live-Summenupdate, nie in Simulation)
- F2.7 PDF-Engine: Kapitel togglen/sortieren (Cover mit 6 Varianten, Firmenvorstellung, Testimonial, Sankey/KPI, Economics, Stückliste, Datenblätter als QR/Anhang, Signaturseite), Fremd-PDF-Einbettung, Rechtstexte (AGB/Widerruf), KI-generierbares Anschreiben; Snapshot-Semantik mit Badges (rot=Fehler, amber=Template neuer, blau=custom)
- F2.8 **E-Signatur:** Link 1–60 Tage gültig, Öffnungs-Tracking (View-Count), Click-to-sign oder Zeichnen, Attestierung (Signer, Timestamp, Content-Hash), Status `pending/signed/expired/withdrawn`, analoger Upload, Tablet-Signatur, Kunden-Widerruf (14-Tage-Fenster §356a, einmalig); Signatur setzt automatisch Won + Umzug aufs Installations-Board
- F2.9 Export signierter Angebote per Button an Lexoffice/Sevdesk/Bexio/Hero/K2/WeClapp/Photovate (manuell, kein Retry)

**Objekte:** Offer, Variant, BOMLine, SignatureRequest, DiscountTemplate, SubsidyLineItem.
**Rollen:** Editor erstellt; Einzelrechte gaten Preis-/EK-Edit, Rabatte, Financing Provider; Marge nie kundensichtbar.

## M3 — PV-Planung (3D-Editor)

**Zweck:** Dachplanung als Angebots-Engine, <15 Min.

- F3.1 Drei Modi pro Variante: Quick (nur Komponenten+Preise), 2D, 3D; Workspace-Default
- F3.2 Gebäudequellen: Orthofoto, Google Solar/Earth 3D, Building-AI, Drohnen-Photogrammetrie, eigener Upload mit Referenzlinien-Skalierung, Selbstzeichnen; Neigung nie automatisch aus Google
- F3.3 Dach-Editor: Smart Roof (Neigung pro Kante 0–90°) + Flachdach, Gauben, Sperrzonen (Schornstein mit Höhe+Schattenwurf, Fenster, Sonstige), Randabstände pro Kante, Validierungen (keine Selbstschnitte)
- F3.4 Modulbelegung: Auto-Fill je Dachseite, „Optimieren"-KI, manuelle Panel-Gruppen (H/V/zweiseitig, Gaps, Tilt), Einzelmodule abwählbar, Performance-Mode ab 400 Modulen
- F3.5 Stringplanung: Wechselrichter mit MPP-Tracker-Slots, Auto-Generierung (gleiche Ausrichtung, max. Länge) oder manuell, Optimierer pro String/Panel, Mikro-WR 1:1; Advisory-Warnungen (Stromstärke, Mischausrichtung)
- F3.6 Verschattung: Sonnenbahn mit Datum/Uhrzeit-Player, Jahres-/Monatsverlust, Ertrags-Heatmap, Score pro Panel 0–10, Kamera-Snapshots fürs PDF
- F3.7 Photogrammetrie-Jobs: ≥15 Fotos (60–100 empfohlen), Status `Not started→Running→Completed/Failed`, 15–45 Min., ±1 cm, nur Desktop-Upload

**Objekte:** Planning, Roof/RoofSide, RestrictedZone, PanelGroup, String, Inverter, PhotogrammetryJob.

## M4 — Simulation & Wirtschaftlichkeit

**Zweck:** Multi-Energie-Simulation als Verkaufsargument; läuft automatisch bei jeder Änderung (kein Button).

- F4.1 15-Minuten-Raster übers Jahr, Priorität Last → Batterie → Einspeisung; Muneer-Diffusstrahlungsmodell (gegen PVGIS validiert)
- F4.2 Lastprofile: synthetisch (Haushaltstyp), custom (12 Monatswerte + Stundenprofil), Lastgang-CSV (nur Commercial), Länderspezifika (Linky-Pull FR, F1/F2/F3 IT, Net Metering BR)
- F4.3 Zusatzlasten: Wallbox+EV (kuratierte EV-DB, Jahres-km), Wärmepumpe (COP, Bivalenzpunkt)
- F4.4 Speicher-Simulation inkl. Arbitrage/Ladefahrplan; Tarifvergleich alt/neu, dynamische/TOU-Tarife
- F4.5 Outputs: Ertrag, Autarkie, Eigenverbrauchsquote, Sankey-Energiefluss, Amortisation/IRR/Break-even, 20-Jahres-Cashflow (Horizont einstellbar), Einspeisevergütungs-Kaskade (Override > Post-EEG > Länderdefault)
- F4.6 Workspace-Simulationsdefaults (Strompreis, Eskalation, Öl/Gas-Preise), leere Felder → Länderreferenz

## M5 — Wärmepumpe: Heizlast, Aufmaß & hydraulischer Abgleich

**Zweck:** Normkonforme WP-Auslegung (DE/AT/FR/BE; UK-Parallelrechner); Standalone-Produkt „360heating" (Freemium).

- F5.1 Drei Methoden: Simple Simulation, Heat-Load-Indication (U-Werte nach Baujahr), Room-by-room nach **DIN EN 12831**
- F5.2 **LiDAR-Scan** (iPhone 12 Pro+/iPad Pro 2020+, Apple RoomPlan): Raum-für-Raum, Stitching über Türdurchgänge zu einem Koordinatensystem, Tracking-Warnungen; manuelle Eingabe als Android-Fallback (identische Datensätze); Grundriss-Tracing nur Portal
- F5.3 Raummodell: Geschosse (1 Keller, 1 Dach, n Zwischengeschosse), Räume mit Typ/Solltemperatur/Luftwechsel, Wände mit „Towards"-Enum (Außenluft/beheizt/unbeheizt/Fremdgebäude/Erdreich), Fenster/Türen als Wand-Properties, Dach mit Gauben-Validierung, Materialdatenbank mit Baujahres-U-Wert-Lookup + Custom-Materialien (eingefroren pro Planung, manueller Update-Button)
- F5.4 Berechnung raumweise + gebäudebezogen, WP-Dimensionierung nach VDI 4645 mit Herstellerkatalogen, Bivalenzpunkt (Default −6 °C)
- F5.5 Hydraulischer Abgleich Verfahren B: Ventileinstellwerte je Heizkörper, Volumenströme; Heizkörper-Ampel (grün/gelb/rot) mit Tauschvorschlägen → automatische BOM-Zeilen
- F5.6 BEG/GEG/KfW-konforme Berichte; Förder-Schätzkarte (30 % Basis + Boni, Deckel 70/80 %, WE-Staffel)

**Objekte:** Building → Story → Room → Wall/Floor/Roof/Heating; Material.

## M6 — Digitaler Schaltplan (nur Residential)

- F6.1 Auto-Generierung aus Systemkonfiguration beim ersten Öffnen; normtauglich für Netzanmeldung (FR: Consuel-Einliniendiagramm)
- F6.2 Zwei Modi: Konfigurieren (Formular) + freier Editor (Bibliothek: Erdungspunkt, Abzweigdose, Generik, Textbox; Konnektoren)
- F6.3 Vorlagen workspace-weit speichern/importieren; „Ask AI"-Bearbeitung per Freitext (Beta); Export JPG/PDF, Einbettung ins Angebots-PDF, als dynamisches Checklist-Element auf der Baustelle

## M7 — Installation & Baustelle

**Zweck:** Ausführungsphase mit Doku, Disposition, Übergabe.

- F7.1 Phasenwechsel per Signatur (auto) oder Direkterstellung (Modal, überspringt Signatur); Tabs: Basic, Workbook, Order Parts, Grid Registration, Subsidy, Handover, Services, Checklist, Files, Kalender
- F7.2 **Checklisten-Engine** (Kernstück): 5 Ebenen Container→Block (zuweisbar, Fälligkeitsdatum)→Segment→Item→Item-Part; 12+ Item-Typen (checkbox, radio, multi-select, freetext mit Diktat, image, signature mit Typ Kunde/Techniker/Dritter, description, planned-layout, datasheets, component-list, circuit-plan); Pflichtfelder, „Mark as irrelevant" mit Begründung, **if/then-Konditionallogik**, Auto-Platzhalter (Kunde, Komponenten, Datum)
- F7.3 Template-Versionierung: Kopie pro Installation; Update per **Merge** (erhält alle Werte) oder Reset (Admin-only bei angepassten); AI-Builder bootstrappt Templates aus PDF/Bild/CSV
- F7.4 Segment-Complete mit Zeitstempel; Unlock Admin-only (kein Auto-Rollback von Folgeprozessen)
- F7.5 **Plantafel**: Ressourcen-Grid je Person/Team, Drag-to-create, Event-Drawer mit Projekt-Link; zweistufige Zuweisung (Block-Ebene: mehrere Teams parallel; Installations-Ebene: Lead Installer)
- F7.6 **Workbook** (Residential): „Variant to be installed" (Auto-Selektion bei erster Signatur), kWp/kWh-Rollups, Stückliste nach Kategorie, Layout + Schaltplan read-only
- F7.7 **Handover**: Auto-PDF (Solar-/WP-Template), On-Screen-Kundenunterschrift, Status → Completed, öffentliche Status-Timeline ohne Login
- F7.8 Order Parts (Nachbestellungen mit Message-Thread je Zeile); Fotodoku mit Batch-Aufnahme und Markup

**Rollen:** Installation-Lizenz (Blocks, Segmente, Fotos, Zeiterfassung — kein Offer/Invoicing); Variantenwechsel nur Installation-Admin/Offer-Editor.

## M8 — Rechnungsstellung

**Zweck:** Belegerstellung bis Steuerberater-Übergabe; bewusst keine Buchhaltung.

- F8.1 Dokumenttypen: Rechnung, 4 Teilrechnungstypen (Anzahlung/Abschlag/Teil/Schluss), Gutschrift, Auftragsbestätigung, Bestellung, Lieferschein, Brief; Document Groups je Projekt
- F8.2 Gates: Länder (DE/AT/CH/FR/UK/Jersey für Geld-Dokumente), Rolle Editor + Invoicing-Recht, Issuing Details Pflicht
- F8.3 Status `Draft → Issued (Nummer+PDF unveränderlich) → Sent → Void`; orthogonale Zahlungsachse Unpaid/Partially/Paid/Overdue(auto)/Uncollectable; Nummernkreise pro Typ (verbrannte Nummern bleiben verbrannt)
- F8.4 Erstellung aus signiertem Angebot (Varianten-Import), aus AB („Duplicate into type") oder frei; Line-Item-Grouping create-time-only; Live-PDF-Preview, Auto-Save
- F8.5 Teilrechnungen: 3 Modi (Percentage/Scheme 30-40-30/Remaining), Vererbung von Positionen (nicht editierbar), Eltern-Editor sperrt, centgenauer Rundungsausgleich, >100 % abgelehnt; Eltern-Zahlungsstatus berechnet
- F8.6 Korrektur nur Void oder Gutschrift (Festliste an Gründen); Versand mit separatem Zahlungs-PDF (EPC-QR); Monats-ZIP (summary.csv + PDFs) für DATEV/Steuerberater; Sync zu Lexoffice/SevDesk/Bexio
- F8.7 Bewusste Nicht-Features: kein Mahnwesen, keine E-Rechnung (XRechnung/Factur-X), kein Bankabgleich, keine wiederkehrenden Rechnungen

## M9 — Zeiterfassung

- F9.1 Live-Timer in der App (floating, überlebt Neustart, kein Auto-Stop) + manueller Eintrag (Datum, Start/Ende, Pausen, Projekt optional, Kommentar; >0 min, ≤24 h)
- F9.2 Admin-Kategorien (Travel/On-site/Office/Other + custom), Auto-Tag Residential/Commercial über Projekt
- F9.3 Portal: Team-Ansichten, Auslastungs-Dashboards, Excel/CSV-Export, Subunternehmer-Abrechnung; GPS am Start-Event, Versionshistorie bei Edits

## M10 — Kundenportal (White-Label)

- F10.1 Pro Projekt aktivierbar (Editor+), Zugang per Einladungslink ohne Konto, 11 Sprachen, 1 Empfänger
- F10.2 Datengetriebene Tabs: Overview, Angebot (E-Signatur + Widerruf), Installations-Fortschritt (Admin mappt interne Status auf Kundennamen + Sichtbarkeit, FAQ je Status), Netzanmeldung (DE), KfW (mit Chat + Upload-Dropzone), My Files („Visible to customer"-Flag), File Requests (Templates: Titel, Dateityp, „Allow many"), Termine
- F10.3 Kein Preis-/Signatur-Tab im Commercial-Portal

## M11 — Mobile App (iOS/Android)

- F11.1 5 Tabs: Home (Dashboard/Agenda), Projects (Filter Typ/Status/Tag/Nutzer), Tasks, Calendar, More (AR, Chats, Sales Assistant)
- F11.2 Projekt-Anlage vor Ort (Phase wählbar nach Rechten, Pflicht: Name, E-Mail, Adresse+Pin); Quick Actions (Anruf/SMS/WhatsApp/Navigation)
- F11.3 Erfassung: Foto-Batch + Bild-Editor, Sprachmemos mit KI-Transkription, Datei-Upload via Share-Sheet, Checklisten offline, LiDAR-Scan, AR-Komponenten (WP als 3D-Modell im Kundenraum, .usdz), Team-Chat, Firmen-Wiki
- F11.4 **Offline-first-Sync**: Queue + Auto-Replay für Fotos/Checklisten/Uploads; last-write-wins; Projektfelder/Tasks/Kalender online-only
- F11.5 Web-only bleibt: Angebotsbau, Rechnungen, Heizlast-Auswertung, Admin, Commercial

## M12 — Lead-Funnel „Energiehaus" (White-Label-Endkunden-Konfigurator)

- F12.1 8-Screen-Flow: Start → Adresse+Dach-Pin → Verbrauch/Strompreis → Bestand (PV/EV) → Paketwahl (nur „öffentliche" Pakete) → Kennzahlen → Kontaktdaten → Foto-Upload-Liste (Dach, Zähler); erzeugt automatisch Request
- F12.2 Embed per Script/iframe; Varianten pro Kampagne (Partnerlogo, zugewiesener User = Auto-Routing, eigene Lead Source), Per-Rep-Deeplinks, QR-Codes, GA/Matomo-Events
- F12.3 Zusatz-Funnels: Contact Form (kurz), Energy Company (B2B→Commercial), Energy Tenant (Mieterstrom); Texte/FAQ konfigurierbar, Erinnerungsmail für fehlende Fotos

## M13 — Service-Marktplatz (transaktionale Erlöse)

Gemeinsames Muster: **Filing-Objekt am Projekt** — Formular (CRM-/Planungsdaten vorbefüllt) → Draft/Submit-Sperre → Statusmaschine → Chat mit typisierten Datei-Slots → E-Mail je Übergang → Abrechnung pro Vorgang.

- F13.1 **Netzanmeldung DE** (~349 € PV / 219 € WP): 2-stufig (Anmeldung mit Vollmacht/Zählerfoto/Planungs-PDF; Fertigmeldung mit 16+ Fotos, Zählernummer, 6-Monats-Frist), Status Draft→Submitted→Rückfrage→VNB accepted→Einspeisezusage→Closed/Rejected, MaStR + Wallbox als Add-ons, Auto-Ordner „Netzanmeldung Unterlagen"; IT/BR-Varianten
- F13.2 **KfW/BAFA-Förderservice** (210 €/Projekt): BzA (Angebotsphase, ~3 AT) → BnD (Installationsphase, ~5 AT, manuelle BzA-Nummern-Verknüpfung), Korrekturrunden inklusive, AI Asset Picker (Typenschild-Foto), Kundenportal-Aktivierung als Versand-Nebeneffekt
- F13.3 **Planungsservice** (9,90–19,90 €/Planung): Fristwahl (24 h/48 h/Datum), Status Requested→In progress→Finished→Accepted, Revision über signierte Notizen, 1 Anfrage pro Angebot
- F13.4 **Finanzierung**: Bees & Bears Ratenkauf (1–25 J., bis 70.000 €, Echtzeit-Bonität) + PSD-Bankkredit; Antrag im Kundenportal, Statusverfolgung, Betrieb ohne Vermittlerrolle
- F13.5 **Factoring** (3,2 %, Auszahlung 2 Banktage, Limit 25.000 €), **Smart Meter** (SpotmyEnergy, API-Rückmeldung), **Baustellenservice/Öltank-Ausbau** (Partner), FR-Selbst-Filing (ENEDIS-Mandat, Cerfa, Consuel + Linky-Abruf)

## M14 — KI-Schicht

- F14.1 **AI Chat**: liest UND schreibt mit den Rechten des Nutzers (Angebote planen, Belege, Auswertungen als Diagramm, Aufgaben/Notizen), 4 Gedächtnis-Ebenen, Spracheingabe, Cmd+J
- F14.2 **Agents**: Trigger (Events: neuer Request, Statuswechsel, Signatur / Zeitplan) + Klartext-Instruktion; Aktionen: Tasks, CRM-Updates, Lead-Routing, Reports, Kundennachrichten; Run-Reporting (Success/Partial/Failed/Skipped); per Chat erstellbar
- F14.3 **WhatsApp-Assistent** (pro Nutzer): Leads anlegen, Sprachmemos → Projekt, Checklisten füllen, Foto-Zuordnung, Termin buchen, Angebots-PDF in den Chat
- F14.4 **Call Agent**: 24/7-Inbound, Qualifizierung nach eigenen Regeln, CRM-Anlage, Dringlichkeits-Routing, Rückruf-Briefings
- F14.5 **Sales AI**: Lead-Scoring (M1), Angebotstexte, Projekt-Summaries, **Bill Reading** (Stromrechnung-Foto → Verbrauch/Tarif), **Competitor AI** (Konkurrenzangebot-Foto → Analyse)
- F14.6 **Meeting-KI**: Hintergrund-Aufnahme, Transkript mit Sprungmarken, Zusammenfassung, Aufgabenvorschläge
- F14.7 **Komponenten-KI**: RAG über eigene Datenblätter/Handbücher, Fehlercode-Antwort mit Quelle+Seitenzahl
- F14.8 **Validierungs-KI**: Firmenregeln in Klartext; prüft 6 Kategorien (Anlagengröße, Verschattung, Stringing, Modulzahl, Speichergröße, Komponentenkompatibilität) vor Versand, Issue-Liste mit Fix-Empfehlung

## M15 — Gewerbe (360B) & Mieterstrom

- F15.1 360B: Lastgang-Import (15-Min-CSV), Peak-Shaving mit Gewerbespeichern, Auto-Verstringung, Freiflächen, TOU-Tarife, CO2-Bilanz, Kostenprofile (degressive Preisstaffeln), Netzbelastungsanalyse; ohne E-Signatur/Schaltplan/Services/Handover
- F15.2 Mieterstrom: 20-Jahres-Cashflow getrennt Vermieter/Mieter, alle Modelle (Marktprämie, Zuschlag), wohneinheitsgenaue Lastprofile, Indikation <60 s; Betrieb via metergrid-Partner
- F15.3 Stadtwerke/Enterprise: Multi-Team, White-Label-Konfigurator, API zu CRM/ERP

## M16 — Katalog & Vorlagen (Stammdaten)

- F16.1 Komponentenkatalog: zentrale DB (150.000+ Komponenten) + eigene Komponenten (Name, Marke, Typ [nach Anlage fix], EK/VK, technische Daten, Bild, Datenblatt, Key-Points); gesteuerte Änderungs-Propagation in Angebote („Outdated components"-Banner + Bulk-Update) → Snapshot-Architektur
- F16.2 Pakete/Planning Packages (ersetzen Stückliste eines Targets), Offer Templates, Planning Templates (additiv), „Linked amounts" (mengenverknüpfte Positionen), Öffentlich-Flag fürs Energiehaus
- F16.3 Vorlagentypen gesamt: Angebot, Planung, Rabatt, Förderung (Fix/Prozent mit Cap/Steuerabzug), Checkliste, Task, Termin, E-Mail, File-Request

---

## Querschnittsfunktionen

**Auth:** Komplett passwortlos — Magic Link, 8-stelliger OTP via E-Mail/WhatsApp, QR-Device-Pairing (~10 Min. TTL), Same-Device-Handoff, OIDC-SSO (workspace-weit all-or-nothing, kein SAML, kein MFA dokumentiert). E-Mail = unveränderlicher Schlüssel; eine Identität in mehreren Workspaces mit je eigener Rolle.

**Rechte:** 4 geschichtete Prüfungen: Workspace-Feature aktiviert → Bereichs-Toggle pro User (Requests/Offers/Installations/Components/Settings, Res/Com getrennt) → Rolle Viewer/Editor/Admin → ~20 Einzelrechte (Konvertierung Request→Offer→Installation, Preise, EK, Rabatte, Rechnungen, Netzanmeldung, Förderung, Photogrammetrie …). External-User-Flag = sieht nur Zugewiesenes. Lizenzfamilien sitzbasiert (Collaborator Res/Com, Residential Installer, Viewer) mit Self-Service-Proration. Teams verschachtelbar (Leader-Sicht transitiv), 1:1-Teamkalender.

**Suche/Filter:** Freitext (Name, Projektname, Adresse) + kombinierbare Filter (Status, Outcome, Datum, Assignee/Team, Source, Score, Tag, Closed/Archived-Toggles); Tags workspace-weit, rein visuell (keine Automationen/Rechte); Custom Dashboard-Views teilbar; Archivieren ≠ Schließen.

**Benachrichtigungen:** 8 fixe Kunden-Mail-Automatiken (New lead, Need information, New/Edited proposal, File request, Signature completed, Portal link, Cannot fulfil — editierbar, Variablen, nur 1 Sprachset); Push für Tasks/Chat; E-Mail je Filing-Statusübergang; eigener SMTP nur für Kundenmails; alles Weitere über AI Agents (keine freie Automations-Engine).

**Dokumente/Dateien:** Dateien/Ordner pro Projekt, Fotos mit Markup, „Visible to customer"-Flag, File-Requests mit Templates, Auto-Ordner durch Services, Datenblätter am Katalog, Firmen-Wiki (auch mobil).

**Aktivitätshistorie:** Read-only Activity Feed pro Projekt (Signatur-Events, Lifecycle-Übergänge, Integrations-Syncs, Score-Updates, Portal-Aktivierung) — Events ohne Wertdetails; Zeitstempel auf Segmenten/Zahlungen; Delivery-Log mit Replay bei Webhooks.

**Dashboard/Reporting:** 6 KPI-Kacheln (Closed-Won, Time-to-Signature/-Offer, Conversion), 9 Charts, gewichtete Pipeline; Invoicing-Reports (Invoiced/Collected/Outstanding/Overdue).

**API/Integrationen:** REST v3 (~100 Endpunkte, 29 Ressourcen, API-Keys mit 3 Scopes, Header-Auth, Delta-Pull); Webhooks (leichte signierte ID-Payloads, Retries); 4 Integrations-Archetypen: Lead-Import (Broker), CRM-Push bei Anlage (Snapshot, one-way), Push-nach-Signatur (Button, manuell), Infrastruktur (Google/MS, SMTP, OIDC, Zapier).

---

## Offene Widersprüche zwischen den Quellen (nicht geglättet)

1. **360heating-Freemium:** Website sagt „2 Projekte/Monat gratis", Presse (07/2025) „4 Projekte/Monat" — vermutlich geändert, Stand unklar.
2. **App-Angebotserstellung:** Store-Listing „create new offers" vs. Doku explizit „Offer building stays in the Portal" (App legt nur Projekt/Anfrage an).
3. **LiDAR offline:** Marketing/App-Beschreibung „offline"; docs-9 „Scans cachen offline"; docs-6 listet LiDAR-Scans als online-only; App-Review (03/2026) beklagt fehlenden Offline-Scan. Wahrscheinlich: Erfassung teilweise, Verarbeitung online — real prüfen.
4. **Signatur → Installation:** docs-4 „signiertes Offer erzeugt automatisch ein Project"; docs-1 lässt Auto vs. manuellen Move (Recht „Convert offers into installation") offen.
5. **Service-Preise:** Website nennt 349/219/210/9,90–19,90 €; Docs sagen durchgehend „Preise via Support-Chat".
6. **Rollenmodell:** Legacy-Doku „Produkt-Berechtigungen pro Nutzer", neue Doku „~20 Einzelrechte + Lizenzen" — Umfang divergiert, Liste nirgends vollständig.
7. **Gründung 2021 (Presse) vs. 2023 (About-Seite)**; Kundenzahl „13 Länder" vs. „>10 Länder".
8. **Meeting-KI/AR:** nur EN-Website; DE-Homepage erwähnt Meeting-KI ohne Seite — Marktverfügbarkeit unklar.
9. **Angebots-Gültigkeit:** Legacy-Doku „max. 60 Tage" (Angebot) vs. neue Doku „Signaturlink 1–60 Tage" — evtl. dasselbe, evtl. zwei Dinge.

## Nur per Demo-Zugang oder Anwender-Interviews klärbar

- **Preise/Lizenzmodell 360H/360B** (Basispreis, Staffeln, Vertragsminima; Schätzung $60–120/User/Monat unbestätigt)
- Vollständige **Rechtematrix** (~20 Einzelrechte, capability-abhängig erst sichtbar) und wer voiden/issuen darf
- **Default-Kanban-Spalten** aller drei Bereiche und Loss-Reason-Werteliste
- Interna der **Simulations-Engine** (Ertragsformeln, Wetterdatenquelle, Reonic-Score-Berechnung) und des Lead-Score-Modells
- **Commercial-Workflow im Detail** (eigenes UI, Task-Kanban, Dokumente)
- Konkretes **UI-Verhalten der KI-Agenten** (Editor, Grenzen, Rechte), „Sales Assistant" im App-More-Tab, Umfang „Competitor AI"
- **Excel-Import-Spaltenschema**, Broker-Feld-Mappings, exakte REST-/Webhook-Schemata, Angebotsnummern-Formatregeln
- **Mieterstrom operative Abwicklung** (Messkonzept/Abrechnung via metergrid), 360B-Abgrenzung (eigenes Produkt vs. Modus)
- Handover-PDF-Template-Anpassung, Conditional-Logic-Editor der Checklisten-Templates, Benachrichtigungslogik bei Disposition
- E-Rechnungs-Roadmap (XRechnung/ZUGFeRD fehlt Stand 08/2026), Zeiterfassungs-Freigabe-Workflow, Passwort-Reset/MFA-Existenz
- Reale **Nutzungs-Schmerzpunkte** (nur 3,6/5 im App Store bei dünner Review-Basis; Play-Rezensionen nicht einsehbar)