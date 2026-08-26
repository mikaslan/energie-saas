# Integrations- und Regulatorik-Anforderungskarte (Reonic-Nachbau, funktional)

Legende je Feld: **PFLICHT** = nötig für Funktionsparität mit Reonic · **KÜR** = Differenzierung/später · **Machbarkeit** = selbst bauen / zukaufen / später · konkrete Datenquellen/APIs.

---

## 1. Großhandel / Beschaffung

**Pflicht für Parität: praktisch NICHTS.** Reonic bewirbt keine einzige Großhändler-Integration (kein Sonepar, Memodo, Krannich; keine Live-Preise, kein Warenkorb). Parität heißt nur:
- Eigene **Komponenten-DB** (Module, WR, Speicher, WP, Wallboxen) mit vom Nutzer gepflegten EK-/Montagepreisen + CSV/Excel-Import. → **selbst bauen**, Stufe 0, null externe Abhängigkeit. Datenbasis über Hersteller-Datenblätter/ETIM-Kataloge kuratieren (nie aus Reonic entnehmen — §§ 87a f. UrhG).

**Kür (Überholspur gegenüber Reonic):**
1. **DATANORM 4/5-Import** (kundenindividuelle Preisdateien; BayWa r.e. bietet DATANORM-Download explizit an, ebenso UNI ELEKTRO). → selbst bauen, sofort, keine Verhandlung nötig.
2. **IDS-Connect v2.5** (Spezifikation kostenlos bei itek.de inkl. Schemas): Warenkorb-Roundtrip Software↔GH-Shop + Artikel-Deep-Links mit Live-Preis/Verfügbarkeit; läuft über das Kundenkonto des Installateurs, kein Partnervertrag nötig. Der einzige Live-Preis-Standard, der skaliert — funktioniert aber nur bei Elektro-Großhandel (Sonepar, Rexel, UNI ELEKTRO, GC), nicht bei PV-Pure-Playern. → selbst bauen, Stufe 2.
3. **Open Masterdata** (REST-Stammdaten inkl. Preisen on demand): Doku hinter Verbandszugang (Mitglieder kostenlos, sonst Gebühr), je Händler Freischaltung. → später.
4. **Bilaterale PV-Distributor-Feeds** (Memodo, Krannich, Tepto — Präzedenz: Krannich↔Eturnity, Segen↔OpenSolar): Verhandlungssache, erst mit Nutzerbasis. → später.
5. EDIFACT/EDITEC nur für Bestellautomatisierung großer Kunden; **ELBRIDGE/OCI ignorieren**.

**Team-Einschätzung:** Stufe 0+1 in Wochen machbar; IDS-Connect ~1 Personenmonat. Alles darüber ist Vertrieb, nicht Technik.

---

## 2. Buchhaltung / E-Rechnung

**Der regulatorisch härteste Pflichtblock — hier gibt es kein „später".**

**Pflicht:**
- **Eigene GoBD-feste Fakturierung** (Reonic fakturiert nativ): Kette Angebot → Auftrag → kumulierte **Abschlagsrechnungen** → ggf. Teilschluss- → **Schlussrechnung mit erzwungenem offenen Anzahlungsabzug** (sonst § 14c UStG: USt doppelt — der Praxis-Hauptfehler, den die Software verhindern muss) → Gutschrift/Storno. Nummernkreise, Festschreibung, Audit-Trail, 8 Jahre Archiv (§ 147 AO), Z3-Export, Muster-Verfahrensdokumentation als Beilage.
- **Steuerlogik pro Position:** 0 % (§ 12 Abs. 3 UStG für PV+Speicher ≤ 30 kWp inkl. Betreiber-Erklärung als Checkbox im Auftragsflow), 19 % (Wallbox, WP, Wartung), § 13b-Reverse-Charge-Modus je Kunde (USt-1-TG-Flag + Pflichtvermerk), Kleinunternehmer-Modus, „einheitliche Leistung"-Kennzeichen (UStAE 12.18 Abs. 10).
- **E-Rechnung:** Empfang/Visualisierung seit 2025 Pflicht beim Kunden; Erzeugung ab 2027 (> 800 T€ Umsatz) bzw. 2028 für alle. Intern EN-16931-Datenmodell, daraus **ZUGFeRD** (PDF/A-3+CII, Handwerker-Standard) und **XRechnung** (UBL/CII, B2G); Validierung gegen KoSIT-Validator. Schlussrechnungs-Anzahlungsabzug bis Ende 2027 per unstrukturierter Anlage (BMF-Übergangsregel).
- **Abfluss-Adapter wie Reonic:** Push von Kontakt + Beleg bei Angebotsunterschrift an **Lexware Office** (api.lexware.io, API-Key, 2 req/s — Achtung: Abschlagsrechnungen nur lesend, eigene Fakturierung muss führen) und **sevDesk** (my.sevdesk.de/api/v1, `POST /Invoice/Factory/saveInvoice`). Plus **Steuerberater-ZIP** (Monats-CSV + PDFs) — Reonic-Parität.

**Kür (Reonic hat es NICHT — Differenzierung):**
- **DATEV-EXTF-Export** (CSV-Buchungsstapel, SKR03/04, korrekte BU-Schlüssel für 0 %/19 %/§ 13b) — ohne DATEV-Vertrag baubar, starkes Verkaufsargument. → selbst bauen, früh.
- DATEV **Buchungsdatenservice/Rechnungsdatenservice** (developer.datev.de, OAuth) → später; Marktplatz-Partner erst ab 25 produktiven Nutzern.
- bexio/Xero/weclapp-Adapter → später, nach DACH-Expansion.

**Team-Einschätzung:** Fakturierung + Steuerlogik + ZUGFeRD/XRechnung ≈ 2–3 Personenmonate Kernaufwand; Bibliotheken (Mustang/ZUGFeRD-Libs) nutzen. Nichts davon zukaufbar ohne die Bau-Spezifika (Abschlagslogik) zu verlieren.

---

## 3. Förderung

**Pflicht (Parität):**
- **Regelwerk der ~10 Bundesprogramme** mit Zeitscheiben-Logik: KfW 458 (30 % Grund + Klimabonus 16 % ↓4 pp/Halbjahr + Einkommensbonus 10–40 % + Familienzuschlag, Deckel 70/80 %, förderfähige Kosten 28 T€ EFH), KfW 459/270, BAFA-EM (15 % + 5 % iSFP), **EEG-Vergütungssätze datumsabhängig** (halbjährliche Degression — Tariftabelle mit Gültigkeitszeiträumen), 0 %-USt-Logik. Fließt in Wirtschaftlichkeits-/Amortisationsrechnung im Angebot. → **selbst bauen** als handgepflegtes Regelwerk (wenige Programme, hohe Regelkomplexität); Gerätelisten aus dem **BAFA-WEP-Portal** als strukturierte Quelle.
- **Förder-Statusmaschine im Projekt** (beantragt/BzA/zugesagt/BnD/ausgezahlt) inkl. Kundenportal-Sichtbarkeit — Reonic monetarisiert Förderung als Service (BzA in 24 h, 210 €/Projekt), nicht als Datenbank.

**Wichtige Erkenntnis: Es gibt KEINE Antrags-APIs.** „Meine KfW" und BAFA-Portal sind die einzigen Antragswege. Der Antragsteil ist ein **Dienstleistungsprodukt**: Energieberater-Netzwerk (EEE-Liste) erstellt BzA/BnD, Software liefert die strukturierten Daten. → Service-Layer aufbauen (Preisanker: Reonic 210 €, febis 399 €) — **später/Partner**, aber das ist das Umsatzmodul.

**Kür:**
- Long-Tail Länder/Kommunen/EVU: **zukaufen** — co2online FördermittelCheck (White-Label/iFrame, Konditionen auf Anfrage) oder febis/foerderdata; Alternative: Redaktion + Förderdatenbank des Bundes (kostenlos, aber keine API → Scraping/Handpflege). PLZ/AGS→Programm-Matching.
- AT (KPC/umweltfoerderung.at, EAG-Förderkalender mit Call-/Zeitfenster-Logik), CH (Pronovo EIV, Gebäudeprogramm kantonal, energiefranken.ch als Vorbild) → später, erst bei Expansion.

---

## 4. Netzbetreiber / MaStR / § 14a EnWG

**Kernbefund: kein API-Problem, sondern ein Daten- und Prozessproblem.** > 800 VNB, keine einheitliche Einreichungs-API; VNBdigital (§ 14e EnWG) ist faktisch nur ein Router auf individuelle Portale. Reonic löst es als **Full-Service mit Menschen im Loop** (349 €/PV, 219 €/WP, inkl. Fertigmeldung durch konzessionierten Meister, Zählerantrag, MaStR).

**Pflicht (Parität, Software-Teil):**
- **Kanonisches Anlagen-Datenmodell**: ein Projekt generiert alle Zielformate (Netzanmeldung, § 14a-Angaben, IBN-Protokoll, MaStR-Meldung, Förderantrag) + Dokumentenmappen-Generator (Datenblätter, Einheitenzertifikate 4105/4110, Stringpläne, Zählerplatzskizze). → selbst bauen.
- **VNB-Verzeichnis als Datenprodukt**: Portal-URL, Prozessvariante (Portal/PDF/Mail), Formular-Mapping, TAB-Besonderheiten. Laufende Redaktionspflege — **das ist der Moat, nicht der Code**. → selbst aufbauen, inkrementell (Top-50-VNB zuerst).
- **Fristen-/Statustracking**: 1-Monats-Zustimmungsfiktion ≤ 30 kW (§ 8 EEG), 8 Wochen NVP, 2 Monate § 19 Abs. 2 NAV (Wallbox > 12 kVA), MaStR-Monatsfrist. → selbst bauen, billig, hoher Nutzwert.
- **MaStR-SOAP-Client** (offizieller Webdienst, WSDL v26.x, 100k Calls/Tag, TLS 1.2; Registrierung durch Dritte/Installateur zulässig; Community-Wrapper open-mastr). Nur PV/Speicher, nicht Wallbox/WP. → selbst bauen (SOAP, aber dokumentiert).
- **§ 14a-Felder im Anmelde-Workflow** (SteuVE > 4,2 kW ja/nein, Steuerung, Modulwahl 1/2/3 mit Beratungslogik 110–190 €/a vs. −60 % AP): kein Wettbewerber automatisiert das durchgängig — kleine Mühe, echte Differenzierung.

**Pflicht (Parität, Service-Teil):** Einreichung + Fertigmeldung erfordert **konzessionierten Meister** → Partner/Freelancer-Modell als bezahltes Add-on (200–350 €/Vorgang, Reonic-Preismodell). Vollautomatisierung ist mangels VNB-APIs derzeit **nicht erreichbar** — nicht versuchen.

**Kür:** IBN-Protokoll-Formulare (VDE-AR-N 4105 Anhang, je VNB-Vordruck) digital in der Field-App; RPA auf epilot/envelio-basierte VNB-Portale (fragil, später).

---

## 5. PV-/WP-Auslegung

**Pflicht (Parität):**
- **PV-Ertragsrechnung**: pvlib python (BSD-3) + **PVGIS-API** (keylos, `re.jrc.ec.europa.eu/api/v5_3`, PVcalc/seriescalc/tmy/printhorizon; 30 Calls/s; CC BY 4.0 — Usage-Conditions einmalig prüfen; TMY je Rasterzelle cachen) + **DWD TRY 2017** (1-km-Raster, stündlich, kostenlos). Fernhorizont-Verschattung via `printhorizon` gratis. → **selbst bauen**, 2–4 Wochen.
- **3D-Dachplanung mit Modulbelegung** (Reonic-Kernfeature): Schnellstart mit **Google Solar API `buildingInsights`** (10.000 Req/Monat frei, dann ab 10 $/1k; EEA-ToS ab 07/2025 vorher verifizieren!) → **zukaufen als Stufe 1**; parallel **LOD2-CityGML-Pipeline** der Länder (NRW + Bayern zuerst, Open Data, Lizenz je Land prüfen) + **simshady** (Apache-2.0, WebGL-Raytracing) für Nahverschattung → **selbst bauen als Stufe 2** — dauerhaft kostenlose DE-weite Datengrundlage, eigener Burggraben. `dataLayers` (75 $/1k) nur für Premium-Fälle.
- **WP-Heizlast-Schätzung** (Reonic: DIN EN 12831/VDI 4645): drei Verfahren nach BWP-Vorbild — Verbrauchs-, Volllaststunden- (DIN/TS 12831-1), Hüllflächenverfahren (TABULA-Baualtersklassen); Normaußentemperatur aus DWD/TRY; **hplib** (MIT, > 500 WP-Modelle aus Keymark) für COP/Bivalenz/JAZ. → **selbst bauen**, 2–4 Wochen. Grenze kommunizieren: Schätzung ≠ förderfähige raumweise Norm-Rechnung.
- **Komponenten-Katalog** (siehe Feld 1) als Planungsgrundlage — Reonics 150k-Einträge-Katalog ist Kuratierung, keine Hersteller-API.

**Kür:** raumweise DIN-12831-Heizlast + hydraulischer Abgleich (autarc-Messlatte; Norm-Lizenzen nötig) → später; Photogrammetrie/Drohne → Service; Whitelabel-Fallbacks: Eturnity, OpenSolar (Abhängigkeitsrisiko), PV*SOL-API (845 €/a) — nur wenn Time-to-Market alles schlägt.

---

## 6. Recht / Compliance

**Pflicht ab Tag 1 (nicht verhandelbar):**
- **Clean-Room-Regeln fürs Bauen selbst:** Funktionen, Workflows, Dateiformate nachbauen ist frei (§ 69a Abs. 2 UrhG, EuGH SAS); tabu: Code, UI-Gestaltung, Texte/Doku, Datenbestände. **Kein Reonic-Test-/Demozugang** (AGB Ziff. 6.4 verbietet Konkurrenzentwicklung; Verstoß triggert GeschGehG + § 4 Nr. 3 c UWG); Erkenntnisquelle ausschließlich öffentlich. Abstand in Name/Optik/Copy (§ 4 Nr. 3 a/b UWG); Markenlage „Reonic" vor Naming prüfen (DPMA/EUIPO — noch offen). Keine Daten aus Reonics Komponenten-DB (§§ 87a f. UrhG).
- **Vertragswerk:** SaaS = Mietrecht (BGH) → AGB mit SLA (Reonic-Referenz: 99,0 % p. a.), Haftungscap (Referenz 100 T€/Fall, zwingende Ausnahmen), Laufzeit/Kündigung, Vertraulichkeit.
- **DSGVO:** AVV nach Art. 28 Abs. 3 (Anbieter ist Auftragsverarbeiter für Endkundendaten der Installateure) + TOM-Katalog + Subprozessorenliste (Reonic-Vorbild: Hetzner/AWS Frankfurt, KI-Anbieter nur mit Opt-in, SCC für US-Transfers); Impressum, Datenschutzerklärung, Cookie-Consent (§ 25 TDDDG), VVT.
- **GoBD-Konformität des Rechnungsmoduls** (siehe Feld 2) — rechtlich Anwenderpflicht, produktseitig Verkaufsvoraussetzung.

**Kür:** ISO-27001/Hosting-Zertifizierungen, BFSG-Barrierefreiheit (Anwendbarkeit auf reines B2B ungeklärt — beobachten), OIDC-SSO (Reonic hat es; für Enterprise-Kunden später).

**Machbarkeit:** Vorlagen + 1× Fachanwalt-Review (AGB/AVV) zukaufen; Rest ist Disziplin, kein Aufwandstreiber.

---

## Priorisierte Gesamtreihenfolge fürs kleine Team

1. **Sofort selbst bauen (Pflichtkern):** Komponenten-DB + Fakturierung mit Bau-/PV-Steuerlogik + ZUGFeRD/XRechnung + Angebots-Wirtschaftlichkeit mit Bundesförder-Regelwerk + PV-Grobauslegung (pvlib/PVGIS/buildingInsights) + Heizlast-Schätzer + kanonisches Anlagen-Datenmodell mit Fristen-Tracking + MaStR-SOAP + Rechts-Grundausstattung.
2. **Früh dazu (billige Differenzierung):** DATEV-EXTF, DATANORM-Import, § 14a-Beratungslogik, Lexoffice/sevDesk-Push.
3. **Mit Nutzerbasis (Service-Umsatz):** Netzanmeldungs-Service mit konzessioniertem Meister, Förderservice mit Energieberater-Netz, VNB-Verzeichnis ausbauen.
4. **Später/zukaufen:** IDS-Connect, LOD2+simshady-Pipeline, co2online/febis-Lizenz, DATEV-Datenservices, PV-Distributor-Deals, AT/CH.

Die zwei echten Moats sind **Datenpflege-Produkte, kein Code**: das VNB-Verzeichnis (> 800 Netzbetreiber) und das Förder-Regelwerk mit Zeitscheiben — beides von Tag 1 als redaktionellen Prozess aufsetzen.