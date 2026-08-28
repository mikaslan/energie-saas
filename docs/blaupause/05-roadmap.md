# Baureihenfolge Reonic-Nachbau — Meilenstein-Roadmap M0 bis Funktionsparität

## Vorbemerkung: Wo die Roadmap vom Installateur-Workflow abweicht (und warum)

Der Installateur-Workflow (Stammdaten → Leads → Angebot → Auftrag → Rechnung → Förderung → Auslegung → Monitoring) ist Leitprinzip, wird aber an vier Stellen begründet gebrochen:

1. **Rechnung vor Auftrag/Baustelle.** Die Fakturierung (M8-Katalog) hängt nur am signierten Angebot, nicht an der Baustellenabwicklung — und sie ist der regulatorisch härteste Block (GoBD, § 14c, E-Rechnung), der lt. Integrationskarte „kein später" kennt. Der Pilot „CRM + Angebot + GoBD-Rechnung" (Architektur) ist ohne Checklisten-Engine verkaufbar; umgekehrt nicht.
2. **Förderung zweigeteilt.** Das Förder-*Rechenwerk* (Regelwerk mit Zeitscheiben, EEG-Kaskade) gehört ins Angebot — es ist Verkaufsargument, nicht Nachlauf. Der Förder-*Service* (BzA/BnD, F13.2) bleibt hinten, weil er Nutzerbasis und Energieberater-Netz braucht. Die *Datenredaktion* startet in Woche 1 (Moat = Datenpflege).
3. **Auslegung gestuft statt en bloc.** Reonic verkauft die Planung als Angebots-Engine — aber der Quick-Modus (F3.1: nur Komponenten + Preise) trägt das Angebot ab Tag 1; Simulation folgt kurz danach, 3D-Editor erst nach Umsatz (Architektur-Entscheid, hier bestätigt: teuerstes Einzelmodul, ersetzbar durch buildingInsights-Schnellstart).
4. **„Monitoring" ist kein Modul.** Der Modulkatalog kennt kein Energie-Monitoring; gemeint ist Projekt-/Pipeline-Sichtbarkeit (Dashboard/Reporting, Querschnitt). Das wächst inkrementell ab M1 — kein eigener Meilenstein. **Nicht über materialisierte Views:** eine Matview speichert Cross-Tenant-Ergebnisse physisch und erbt die RLS ihrer Basistabellen nicht (Codex-Review #5, abgesichert durch `MATVIEW_ALLOWLIST` in `tests/setup/tenant-fixtures.ts`). Reporting läuft daher über Aggregat-Queries unter RLS. Eine Matview ist erst zulässig, wenn sie ein explizit tenantgeschütztes Cache-Muster mitbringt (eigener Schutznachweis + Eintrag in der Allowlist) — das ist eine Optimierung nach Messung, keine Startannahme.

Stammdaten stehen wie im Workflow vorn — aber als *schmaler Kern* (Komponenten-DB), nicht als voller M16-Ausbau: Pakete, Templates und Änderungs-Propagation lohnen erst, wenn Angebote existieren, die sie konsumieren.

---

## M0 — Fundament (kein Nutzer-Feature, nicht nachrüstbar)

**Inhalt:** Multi-Tenant-Skeleton (workspace, membership, RLS + `withTenant` doppelt), passwortlose Auth (Magic Link/OTP, better-auth), zentrale `can()`-Rechteprüfung (3 Schichten), `domain_events`-Outbox + `audit_log` (getrennt, append-only), Statusmaschinen-Konvention, **Site-Entität** (schmal) zwischen Contact und Project, Storage-Abstraktion mit WORM-Vorbereitung, Worker-Host (pg-boss, Chrome-PDF), CI mit dependency-cruiser-Modulgrenzen + generischer Tenant-Isolations-Suite, ADR-Prozess. Rechtsgrundausstattung: Clean-Room-Regeln als CONTRIBUTING, Markencheck, AGB/AVV-Vorlagen zum Anwalts-Review.
**Parallel ab Woche 1:** redaktioneller Aufbau Förder-Regelwerk + VNB-Verzeichnis als Zeitscheiben-Tabellen (der Moat, kein Code).
**Danach nutzbar:** nichts kundensichtbar — bewusst. Jede Position hier kostet Stunden, Nachrüsten kostete Wochen (Events in jeder Servicefunktion, RLS auf jeder Tabelle).
**Nicht gebaut:** Teams/Bereichs-Toggles (additive Spalten reserviert), OIDC-SSO, Command-Executor.

## M1 — Stammdaten-Kern + CRM/Leads

**Module:** F16.1 minimal (eigene Komponenten mit Zod-typisierten JSONB-Daten, EK/VK, CSV/Excel-Import; kein Seed-Katalog-Anspruch à la 150k) · F1.1 Kontakte (Consent + Policy-Version, DSGVO-Zeitstempel) · F1.2 nur Pfade manuell + CSV-Bulk · F1.3 Projektadresse/Pin an der Site · F1.4 Gebäude-/Energiedaten (energy_profile) · F1.5 Kanban-Boards mit Spalten-Typen · F1.6 Outcome-Aktionen · F1.8 Lead Sources · F1.9 Aufgaben/Notizen/Termine (ohne Google/MS-Sync). Querschnitt: Suche/Filter/Tags, Activity Feed (speist sich aus M0-Events), erste KPI-Kacheln (Aggregat-Queries unter RLS — **keine** materialisierten Views, siehe Vorbemerkung 4).
**Danach nutzbar:** vollwertiges Handwerks-CRM standalone — erster Realbetrieb mit freundlichem Betrieb möglich.
**Abhängigkeiten:** komplett auf M0.
**Nicht gebaut:** Broker-APIs (F1.2-Rest — Inbound-Muster existiert erst mit Filing/Integrationsbaustein, und ohne Angebot ist Lead-Zukauf wertlos), AI Lead Score (F1.7, KI-Schicht später), Kalender-Sync (Infrastruktur-Integration, kein Kernpfad).

## M2 — Angebot & E-Signatur

**Module:** F2.1 Offer aus Request (Ein-Projekt-Spine, Phasenwechsel) · F2.2 Varianten mit Snapshot-Semantik (wichtigste Invariante: bom_line kopiert, „Outdated"-Banner statt stiller Propagation) · F2.3 BOM · F2.4 Rabatt-Stack (pure Functions, höchste Testdichte) · F2.7 PDF-Engine (Chrome-Pipeline, Kapitel-Toggles, Snapshot-Badges) · F2.8 E-Signatur selbst gebaut (Token-TTL, View-Tracking, Content-Hash, Attestierung append-only, Widerruf § 356a); signierte Variante → WORM-Storage + Lock-Trigger; Signatur setzt Won + Phase Installation (Statusmaschine) · F3.1 nur Quick-Modus · F16.2 minimal: Angebotsvorlagen. Kundenportal-Skeleton als getrenntes Token-Route-Segment (trägt die Signaturseite; F10-Basis).
**Danach nutzbar:** Lead → Angebot → rechtsgültige Signatur, komplett digital.
**Abhängigkeiten:** Katalog-Kern (M1) für BOM; Events (M0) für Signatur-Automatik.
**Nicht gebaut:** 2D/3D-Planung (F3.2–F3.7), Simulation im PDF, optionale Upsell-Komponenten (F2.6), Finanzierung (F2.5 — Partnerverträge, kein Technikproblem), Export-Buttons F2.9 (erst mit Adapter-Baustein in M3).

## M3 — Rechnung & GoBD (Pilot-Gate)

**Module:** F8.1–F8.6 vollständig: Dokumenttypen inkl. 4 Teilrechnungstypen, Status draft→issued→sent→void mit DB-Trigger-Festschreibung, Nummernkreise (`FOR UPDATE`), orthogonaler Zahlungsstatus, Erstellung aus signierter Variante, **erzwungener kumulierter Anzahlungsabzug in der Schlussrechnung (§ 14c-Schutz)**, centgenauer Rundungsausgleich · Steuerlogik pro Position: 0 % § 12 Abs. 3 (inkl. Betreiber-Checkbox), 19 %, § 13b, Kleinunternehmer · intern EN-16931-Modell, daraus ZUGFeRD + XRechnung (KoSIT-Validator im CI) · Steuerberater-Monats-ZIP · Lexware/sevDesk-Push als erste `IntegrationAdapter` + `integration_delivery_log` (öffnet zugleich F2.9) · Kür früh: DATEV-EXTF (billige Differenzierung lt. Integrationskarte).
**Danach nutzbar:** der komplette Geldpfad Lead→Angebot→Signatur→Abschlags-/Schlussrechnung→Steuerberater. **Hier startet der Pilotkunde.** Vorher: 1× Steuerberater-Review + Verfahrensdoku.
**Abhängigkeiten:** signierte Variante (M2) als Rechnungsquelle; WORM/Hash (M0) fürs 8-Jahres-Archiv.
**Nicht gebaut (dauerhaft, Reonic-Parität):** Mahnwesen, Bankabgleich, wiederkehrende Rechnungen (F8.7). E-Rechnung wird — anders als Reonic — *nicht* weggelassen: Pflicht 2027/28, und als Serialisierung des EN-16931-Kerns fast gratis.

## M4 — Wirtschaftlichkeit & Förder-Rechenwerk (Abweichung: vorgezogen)

**Module:** F4.1–F4.5 light: pvlib + PVGIS im Python-Sidecar, 15-Min-Raster, Speicher-Basissimulation, Autarkie/Eigenverbrauch/Amortisation/20-J-Cashflow, EEG-Vergütungskaskade datumsabhängig; `SimulationEngine`-Interface, Ergebnisse als versionierter Snapshot am Angebot; Auto-Rerun bei Änderung · F4.6 Workspace-Defaults · Förder-Regelwerk produktiv schalten (KfW 458/459/270, BAFA-EM, Zeitscheiben — die seit M0 gepflegten Tabellen) inkl. Schätzkarte im Angebot (Teil von F5.6) · F16.3 Fördervorlagen (Fix/Prozent mit Cap) · Sankey/Economics-Kapitel im PDF (F2.7-Ausbau).
**Warum hier, nicht im Workflow-Slot „nach Rechnung":** Die Wirtschaftlichkeitsrechnung *ist* das Verkaufsargument des Angebots (Modulkatalog M4-Zweck); ohne sie ist M2 nur ein Preisblatt. Sie kommt trotzdem *nach* M3, weil der Pilot mit manuell argumentierten Angeboten leben kann, aber nicht ohne legale Rechnungen.
**Danach nutzbar:** Angebote mit Ertrags-, Förder- und Amortisationsstory — Vertriebsparität für den Standardfall.
**Nicht gebaut:** Lastgang-CSV/Commercial (M15), Wärmepumpen-Simulation in Tiefe, Länderspezifika FR/IT/BR.

## M5 — Auftrag & Baustelle (Projektabwicklung)

**Module:** F7.1 Phasen-Tabs · F7.2 Checklisten-Engine (5 Ebenen, 12 Item-Typen, if/then, Pflichtfelder) · F7.3 Template-Versionierung mit Merge · F7.4 Segment-Complete · F7.5 Plantafel · F7.6 Workbook · F7.7 Handover mit On-Screen-Unterschrift + öffentlicher Status-Timeline · F7.8 Order Parts/Fotodoku · M9 Zeiterfassung (F9.1–F9.3) · PWA-Offline schmal (F11.4-Muster: NUR Checklisten-Antworten, Fotos, Zeiterfassung; IndexedDB-Outbox, idempotente Mutationen, LWW) · F10.2 Kundenportal-Ausbau: Installations-Fortschritt mit Status-Mapping, My Files, File Requests.
**Danach nutzbar:** durchgängige Abwicklung Signatur→Montage→Übergabe inkl. Monteur-Handy; Zeiterfassung für Nachkalkulation.
**Abhängigkeiten:** Phasenwechsel per Signatur (M2), Workbook braucht Varianten (M2).
**Nicht gebaut:** native App (F11 — PWA deckt Kernfälle; Capacitor erst für LiDAR), Team-Chat/Wiki, AR, Schaltplan (F6 — erst wertvoll mit Netzanmeldung in M7).

## M6 — Auslegung/Planung Ausbau

**Module:** F3.2 Stufe 1: Google Solar `buildingInsights` + Orthofoto (Cache je Adresse, ToS-Prüfung) · F3.3/F3.4 Dach-Editor 2D mit Auto-Belegung, Sperrzonen, Randabständen · F3.5 Stringplanung mit Advisory-Warnungen · F3.6 Verschattung light (PVGIS-Horizont, später simshady) · F5.1 WP-Schätzverfahren 1–2 (Verbrauchs-/Hüllflächenverfahren, hplib, Bivalenzpunkt) · F5.6-Berichte als Schätzung gekennzeichnet · Planning Templates/Pakete (F16.2-Rest) inkl. Öffentlich-Flag.
**Danach nutzbar:** Planung als Angebots-Engine <15 Min für den Residential-Standardfall; WP-Angebote mit belastbarer Dimensionierung.
**Abhängigkeiten:** Simulation (M4) konsumiert die Belegung; Site-Geometrie (M0/M1).
**Nicht gebaut:** volles 3D/Photogrammetrie (F3.7 — Service statt Eigenbau), raumweise DIN 12831 + hydraulischer Abgleich (F5.2–F5.5 — Norm-Lizenzen, LiDAR; erst wenn WP-Modul Umsatz trägt), LOD2/simshady-Pipeline (Stufe-2-Moat, parallel vorbereitbar).

## M7 — Anlagen-Lifecycle, Services & Lead-Zufluss

**Module:** `plant_record` (kanonisches Anlagen-Datenmodell) + generisches `filing`-Muster (einmal bauen, trägt alles) · F13.1 Netzanmeldung: Dokumentenmappen-Generator, VNB-Verzeichnis produktiv (Top-50 zuerst), Fristen-Tracking (Zustimmungsfiktion, NVP, § 19 NAV), § 14a-Felder mit Modulwahl-Beratung, MaStR-SOAP-Client; Einreichung als Partner-Service mit konzessioniertem Meister (bezahltes Add-on — Vollautomatisierung bewusst nicht versucht, keine VNB-APIs) · F13.2 Förderservice BzA/BnD über Energieberater-Netz · F6 Schaltplan (jetzt, weil Netzanmeldungs-Beilage) · F10.2 Portal-Tabs Netzanmeldung/KfW · F12.1/F12.2 Energiehaus-Funnel (einziger Welcome-Mail-Pfad) · F1.2-Rest: Broker-Inbound über generisches `inbound_event`-Muster · 8 Kunden-Mail-Automatiken (Querschnitt, event-gespeist).
**Danach nutzbar:** transaktionale Service-Erlöse + skalierter Lead-Eingang — das Reonic-Geschäftsmodell jenseits der Lizenz.
**Abhängigkeiten:** Filing braucht Events/Statusmaschinen (M0), Planungsdaten (M6) für Mappen, Nutzerbasis (Pilot ab M3) für Service-Ökonomie.

## M8 — Funktionsparität (Rest nach Umsatz)

**Module:** M14-Auswahl pragmatisch: F14.5 Bill Reading + Angebotstexte (Claude-API direkt, kein Agent-Framework) zuerst; F14.1 Chat, F14.2 Agents, F14.8 Validierungs-KI danach; WhatsApp/Call/Meeting-KI zuletzt · F5.2–F5.5 raumweise Heizlast + hydraulischer Abgleich, Capacitor-Hülle für LiDAR · M15 Commercial/Mieterstrom (getrenntes Datenmodell — bewusst letzter großer Block: eigener Markt, eigene UI) · F12.3 Zusatz-Funnels · F13.3–F13.5 (Planungsservice, Finanzierung, Factoring) · REST-API v1 + signierte Webhooks (dank Service-Funktionen + Events: Exponierung, kein Umbau) · Kalender-Sync, OIDC-SSO, White-Label · Kür: DATANORM-Import, IDS-Connect, LOD2+simshady.
**Danach:** Funktionsparität mit Reonic im Residential-Kern plus drei bewusste Überholspuren (E-Rechnung, DATEV-EXTF, § 14a) — und zwei ehrliche Lücken bis zur Nachfrage: eigene Photogrammetrie, Rust-Simulationskern.

**Roter Faden:** Jeder Meilenstein endet in einem produktiv nutzbaren Zustand; die Geld-/Rechtspfade (M2/M3) kommen vor allem Komfort; alles Nicht-Nachrüstbare liegt in M0; die beiden Daten-Moats (Förderung, VNB) reifen redaktionell über die gesamte Laufzeit statt als Code-Meilenstein.