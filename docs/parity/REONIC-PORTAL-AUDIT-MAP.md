# Reonic-Portal-Audit — Beobachtungskarte (OBSERVED)

Stand: 2026-09-03 (Auswertung der Audit-CSVs vom 2026-09-02)
Quellen: `docs/parity/reonic-portal-audit/reonic_portal_audit_gesamt.csv` +
`docs/parity/reonic-portal-audit/reonic_funktionskatalog.csv` (beide `;`-getrennt, UTF-8 BOM).
Bezug: `docs/blaupause/01-modulkatalog.md` (F1–F16), `docs/parity/STATUS.md`,
`docs/parity/CAPABILITY-MATRIX.md`, `docs/spec/`.

> **Clean-Room-Klassifikation.** Reonic = funktionale Referenz, WMEE = visuelle
> Referenz. Diese Karte übernimmt **nur beobachtbare Funktionssemantik**
> (OBSERVED, read-only-Sweep). Es werden **keine** Reonic-Texte, Layouts, Icons,
> Assets, Kundendaten oder Preise übernommen. **Keine PII** aus den CSVs wird
> kopiert (Kontakt-, Projekt- und Wettbewerber-Namen sowie UUIDs/Routen-IDs sind
> im Folgenden bewusst weggelassen; die Sitzung wird nur als Kontext benannt).
> Die Audit-Sitzung hat **keine Aktionen** ausgeführt (keine Schreibzugriffe,
> keine Imports, keine Datenänderungen). `ESTIMATE`-Werte sind als solche markiert.

---

## 1. Vollständige Bereichsliste (kompakt, aus den CSVs)

Die CSVs erfassen 118 beobachtete Seiten/Bereiche (Headerzeile ausgenommen).
Gruppiert nach fachlichen Bereichen; Funktionsnamen paraphrasiert.

### Startseite (`/home`)
Begrüßung, offene Themen, Aufgaben, Projektzuweisungen für Anfragen/Angebote/
Installationen, Datei-Anfragen, Erwähnungen, Agenten- und Signaturübersicht.
Bedienelemente: globale Suche, KI-Chat, Agenten, Tabs/Filter, Öffnen, Hilfe,
Updates, Empfehlung, Webinar-Hinweis. Angemeldete Identität sichtbar.

### Aufgaben (`/tasks`)
Aufgabenliste (1 Ergebnis „Objektaufnahme“), Suche, Filter (Fälligkeit, Nutzer,
Teams, Labels), Abgeschlossen, Aufgabe hinzufügen, Zeilenaktionen.

### Dashboard (`/360h/dashboard`)
Sales-Funnel und Kennzahlen, Zeitraumfilter (05.08.–02.09.2026), 21 Angebote
und weitere Umsatz-/Pipelinewerte; Deal-/Zeitraum-/Vergleichsfilter, Nutzer,
Teams, Leadquelle, Tags, Archiviert.

### Wiki (`/wiki`)
Firmenvorlagen (Speicher-, PV-, Wärmepumpen-Grundlagen), persönlicher Bereich;
Suche, Firmen-/persönliche Seite erstellen.

### Kontakte (`/contacts`, `…/{id}`)
187 Kontakte, Listenansicht mit Seitennavigation; Suche, Sortierung
Erstellt/Bearbeitet, Kontakt anlegen, Detail öffnen. Detailseite: Kontaktformular,
Tabs Mails/Aufgaben/Dateien/Notizen/Aktivität, Duplikat-Hinweis (11 möglich),
Zusammenführen/Speichern, verknüpfte Anfrage/Projekt.

### Kalender (`/calendar`)
Monatsansicht, vier Kalender/Alle, „Heute“, neuer Termin, Kalenderauswahl,
Planungsmodus, Monat/Woche/Tag/Agenda.

### Projekte — Anfragen (`/360h/requests`, `/360b/requests`)
**Haushalt:** 17 Ergebnisse, Listen-/Kanban-Ansicht, Importieren, neue Anfrage,
Suche, Filter (Eingang, Status, Board, Nutzer, Teams, Tags, Umgewandelt,
Quellen, Vertriebsstatus, Lead-Score, Archiv).
**Gewerbe:** Listen-/Kanban, Suche, Status/Tags/Quellen/Vertriebsstatus/
Lead-Score/Archiv, Link zu Haushalt.

### Anfrage — Detail (`/360h/request/{id}/…`)
Basics: Kontakt-/Projektfelder, Karte, interne Notizen, Statuszusammenfassung,
Workflow-Navigation, Zuordnung, Notizen/Dateien/Aufgaben/Kalender/Mails,
Statusaktionen, Archivieren.
Services: Servicekarten (Förderung, Netzanmeldung, Öltankentsorgung,
Baustellenservice, Smartmeter, Finanzierung).
Lead-Informationen: Kundennachricht, Pakete/Systeme, KI-Lead-Analyse (62/100)
mit Aufschlüsselung Objekt/Kunde/Solarpotenzial.
Qualifikation: Lead-Präqualifikation, Pflichtangaben, Erreichbarkeit, Interessen
(PV/Speicher/Wallbox/Wärmepumpe/Klimaanlage), Umsetzungszeitraum, Checkliste,
„als irrelevant markieren“.

### Projekte — Angebote (`/360h/offers`, `/360b/offers`)
**Haushalt:** Listen-/Kanban, Statusgruppen (Vorbereitet, Fehlende Infos,
In Arbeit, Termin), Suche, Sortierung, Nutzer/Teams/Tags/Quellen/Vertriebsstatus/
Archiv.
**Gewerbe:** Listen-/Kanban, dieselben Filter, Link zu Haushalt.

### Angebot — Detail (`/360h/offer/{id}/…`)
Basics: Status, Objektaufnahme, Lead-Score, Workflow, Notizen/Dateien/Aufgaben/
Kalender/Mails.
Beratung: Beratungsansicht, Statusdialog, Abschnitte Allgemeines/PV.
Planung: Planungsschritte (Stromverbrauch, Gebäude, Bestand), Variante,
Bereiche Solar/Speicher/Wallbox/Wärmepumpe/Extras/Zahlung/Ergebnisse/Überprüfung,
Eingabefelder Verbrauch/Tarife.

### Projekte — Installationen (`/360h/installations`, `/360b/installations`)
**Haushalt:** Liste/Kanban mit Phasen (Machbarkeit, Auftragsbestätigung, erste
Zahlung, Netzanschluss, Bestellung/Logistik, Terminplanung, DC/AC-Installation,
Inbetriebnahme, Endrechnung, Übergabe); Installation anlegen, Filter.
**Gewerbe:** Liste/Kanban sichtbar, Anlage-Schaltfläche deaktiviert.

### Installation — Detail (`/360h/installation/{id}/…`)
Terminierung: Kalenderansicht, Workflowphasen, Kalenderauswahl.
Arbeitsheft: Varianten-/Arbeitsheft-Navigation.
Baustellendokumentation: Checklisten (z. B. Bohrungen optional, Phasen),
Pflichtfelder.

### Photogrammetrie (`/photogrammetry/jobs`, `…/{id}`)
Jobliste (2 abgeschlossene Jobs), Job erstellen, Suche, Nutzer-/Archivfilter.
Jobdetail: Bilder/Videos, Flugpfad-Prüfung, 3D-Modellkonstruktion, Schritte
(Bilder hochladen, Flugpfad prüfen, Job starten, Assets löschen/zurücksetzen,
Herunterladen, „zum Angebot hinzufügen“).

### Services (`/services/…`)
Wärmepumpenförderung: Statusübersicht (angefragt von/am, Status), neue Anfrage,
Nachrichten.
Netzanmeldung: Statusübersicht mit PV-Statusspalten, Ansichten PV/Wärmepumpe/
Wallbox, Neu, Servicehinweise.
Öltankentfernung & Baustellenservice: leere Statusübersichten, Neu/Okay,
Crew-/Abhol-/Fotodaten und Statusverfolgung.

### Verkaufsassistent (`/sales-assistant`, `…/{id}`, `…/competitors`)
Allgemein/Neue Analyse/Analysen/Wettbewerber; Analyse-Vergleich zweier Angebote
(Preis-/Leistung, Stärken/Schwächen, nächste Schritte), Wettbewerber-Detail,
Konkurrenzangebote hochladen (PDF/Bild), Zustimmung erforderlich, Analyse
erstellen (zunächst deaktiviert).

### Rechnungen (`/invoicing/…`, `/backoffice/reports`)
Dokumentgruppen (Übersicht/Rechnungen/Gutschriften/Auftragsbestätigungen/
Bestellungen/Lieferscheine/Briefe), Neu/Archiv/Gruppen-Navigation/Suche.
Je Typ Filter (Status, Zahlungsstatus, Ausstellungs-/Fälligkeits-/Lieferdatum,
Archiv). Berichte: Einnahmen/Cashflow, ausstehend/überfällig, Einnahmen nach
Status, Überfälligkeitsbericht, Daten herunterladen.

### Zeiterfassung (`/timetracking`)
Onboarding-Erklärung; Timer, manuelle Einträge, Projektverknüpfung, Pausen,
Filtern/Suchen, Excel-Export.

### Komponenten (`/settings/components/all`, `…/component/{id}/latest`)
Liste (Name, Typ, Preis), Suche, Filter (Quelle/Typ/Erstellt/Bearbeitet/Archiv),
Komponente importieren. Detail: Stammdaten, Marke/Artikelnummer/GTIN, Bauteiltyp,
Einheit, Einkaufs-/Verkaufspreis, MwSt., Eigenschaften, Beschreibung, Datenblatt,
Garantie, Bedienungsanleitung, 3D/AR.

### Updates (`/release-notes`)
Release-Notes-Liste (28 sichtbare Produktupdates), lesen.

### Einstellungen (`/portal-settings…`)
**Nutzer/Profil:** Profilfelder, Buchungslink, persönliche URL, Standort,
WhatsApp-Assistent, E-Mail-Signatur, Google-/Microsoft-Verbindungen.
**Firmeneinstellungen:** Firmendetails, Branding (Logo/Farben/Vorschau),
Pflichtfelder, Lizenzen & Rechnungen, Nutzer & Teams, Feature-Schalter,
Integrationen.
**Organisation:** Rechnungsstellung, Kalender (persönlich/Unternehmen/Benutzer),
Terminvorlagen, Kalender-Kategorien, Ordnerverwaltung, Postfächer
(persönlich/firmenweit), Zeiterfassungskategorien, Benachrichtigungen
(persönlich/firmenweit).
**Kanban Boards:** Board-Management, Kartenkonfiguration.
**Aufgaben:** Aufgabenvorlagen & Labels, Projektmanagement (Gewerbe, verweigert).
**Checklisten:** Qualifikation, Beratung, Baustellendokumentation (Editor,
Vorschau, Speichern).
**Lead-Generierung:** Energiehaus (Pakete, Anzeige, Varianten/Links, Einbindung),
Energiefirma (Anzeige, Einbindung, Kostenprofile), Energiemieter (verweigert),
Kontakt-Formular, Leadquellen.
**Planung & Angebot:** Planung, Angebotsvorlagen, Planungspakete,
Planungsvorlagen, KI-Planungsvalidierung, Förderungen, Photogrammetrie-Abo,
Rabattvorlagen, Vorlagen für laufende Kosten (verweigert), Angebot–Allgemein,
Seiten & Design, Rechtliches.
**Simulation:** Simulationsgrundlagen, Strom- & Gaspreise, Heizlast-Materialien.
**Fortschrittsverfolgung:** Installationsfortschritt, FAQ.
**Vorlagen für Dateianfragen:** Foto-Vorlagen (Zählerschrank, Dach, Wallbox …).
**Kundenkommunikation:** automatische E-Mails.
**API/Developers:** Webhooks, API-Schlüssel.

### Dateien & Datei-Anfragen (`/files`)
Tabs Dateien/Datei-Anfragen, Dropzone, E-Mail-Anfrage von Bildern/PDFs.

### Notizen (`/notes`)
Interner Notiz-Editor, Formatierungsleiste (H1–H6), Sprachaufnahme, Absenden,
@-Benachrichtigungen.

### KI & Agenten (`/agents`, Reonic-KI-Modal)
Reonic-KI-Modal („Wobei kann ich dir helfen?“, Vorschläge, Anhang, Senden).
Agenten Beta: Liste, neuer Agent, „Agenten vorschlagen“ (Workspace-Scan,
8 Karten), Agenten-Detail (Name, Ziel, Status, Jobs), Job-Konfiguration
(Name, Trigger, Beschreibung, Speichern/Testen, Läufe).

---

## 2. F-Mapping (Funktion → F-Nummer; NEU markiert)

Referenz: `docs/blaupause/01-modulkatalog.md`. „NEU“ = der Modulkatalog kennt
die Funktion nicht. „+ NEU“ = Funktion ist überwiegend abgebildet, ein Teil
fehlt im Katalog.

| Bereich / Unterbereich | Beobachtete Funktion (paraphrasiert) | F-Nr / NEU |
|---|---|---|
| Startseite | offene Themen, Aufgaben, Projektzuweisungen, Datei-Anfragen, Erwähnungen | F1.9, Querschnitt „Dokumente/Dateien“ |
| Startseite | globale Suche, Tabs/Filter | Querschnitt „Suche/Filter“ |
| Startseite | Agenten-Übersicht | F14.2 |
| Startseite | Signaturübersicht | F2.8 |
| Startseite | KI-Chat | F14.1 |
| Startseite | Updates | NEU (Release-Notes/Changelog) |
| Startseite | Hilfe, Empfehlung, Webinar-Hinweis | NEU (Onboarding/Support) |
| Aufgaben | Aufgabenliste, Suche, Filter (Fälligkeit/Nutzer/Teams/Labels), Abgeschlossen, hinzufügen | F1.9 |
| Dashboard | Sales-Funnel, Kennzahlen, Zeitraum-/Vergleichsfilter | Querschnitt „Dashboard/Reporting“ + F1.5 |
| Dashboard | Leadquelle-Filter | F1.8 |
| Wiki | Firmen-/persönliche Seiten, Suche | Querschnitt „Dokumente/Dateien“ (Firmen-Wiki) + F11.3 |
| Kontakte | Liste, Suche, Sortierung, anlegen, Detail öffnen | F1.1 |
| Kontakte – Detail | Kontaktformular, Tabs Mails/Aufgaben/Dateien/Notizen/Aktivität | F1.1, F1.9, Querschnitt „Aktivitätshistorie“ |
| Kontakte – Detail | Duplikat-Hinweis, Zusammenführen | F1.9 (Duplikat-Triage) |
| Kontakte – Detail | verknüpfte Anfrage/Projekt | F1.1 (Contact als Spine) |
| Kalender | Monat/Woche/Tag/Agenda, Heute, neuer Termin, Kalenderauswahl, Planungsmodus | F1.9 (Kalender, 4 Scopes) |
| Projekte – Anfragen (H) | Liste/Kanban, neue Anfrage, Suche, Filter | F1.2, F1.5, Querschnitt „Suche/Filter“ |
| Projekte – Anfragen (H) | Importieren | F1.2 (Excel/CSV-Bulk) |
| Projekte – Anfragen (H) | Status-/Board-/Umgewandelt-/Archiv-Filter | F1.5, F1.6 |
| Projekte – Anfragen (H) | Lead-Score-Filter | F1.7 |
| Projekte – Anfragen (H) | Quellen-Filter | F1.8 |
| Projekte – Anfragen (G) | Liste/Kanban, Filter, Link zu Haushalt | F15.1 + F1.5 |
| Anfrage – Detail | Kontakt-/Projektfelder, Karte | F1.1, F1.3 |
| Anfrage – Detail | Notizen/Dateien/Aufgaben/Kalender/Mails | F1.9 |
| Anfrage – Detail | Zuordnung, Statusaktionen, Archivieren | F1.6, F1.9 |
| Anfrage – Services | Servicekarten (Förderung, Netzanmeldung, Öltank, Baustelle, Smartmeter, Finanzierung) | F13.1, F13.2, F13.4, F13.5 |
| Anfrage – Lead-Informationen | Kundennachricht, Pakete/Systeme | F1.4 |
| Anfrage – Lead-Informationen | KI-Lead-Analyse (Score + Aufschlüsselung) | F1.7 |
| Anfrage – Qualifikation | Pflichtangaben, Interessen (PV/Speicher/Wallbox/WP/Klima), Zeitraum | F1.4 |
| Anfrage – Qualifikation | Checkliste, „als irrelevant markieren“ | F7.2 (Checklisten-Engine) |
| Projekte – Angebote (H/G) | Liste/Kanban, Statusgruppen, Suche, Sortierung, Filter | F2.1, F1.5 |
| Angebot – Detail | Status, Workflow, Notizen/Dateien/Aufgaben/Kalender/Mails | F2.1, F1.9 |
| Angebot – Beratung | Beratungsansicht, Statusdialog, Abschnitte | F2.x (Offer-Workflow) + F7.2 (Beratungs-Checkliste) |
| Angebot – Planung | Verbrauch/Tarife, Gebäude, Bestand, Variante | F1.4, F2.2, F3.x |
| Angebot – Planung | Solar/Speicher/Wallbox/WP/Extras/Zahlung/Ergebnisse/Überprüfung | F2.3, F2.5, F4.x |
| Projekte – Installationen (H/G) | Liste/Kanban mit Phasen, Installation anlegen | F7.1, F1.5, F2.8 (Signatur→Installation) |
| Installation – Terminierung | Kalenderansicht, Workflowphasen | F7.1, F1.9, F7.5 (Plantafel) |
| Installation – Arbeitsheft | Varianten-/Arbeitsheft-Navigation | F7.6 (Workbook) |
| Installation – Baustellendoku | Checklisten, Pflichtfelder | F7.2 |
| Photogrammetrie | Jobliste, Job erstellen, Suche, Filter | F3.7 |
| Photogrammetrie – Detail | Bilder hochladen, Flugpfad prüfen, Job starten, 3D-Modell, Download, zum Angebot | F3.7, F3.2 (Drohnen-Photogrammetrie) |
| Services – Wärmepumpenförderung | Statusübersicht, neue Anfrage, Nachrichten | F13.2 (+ F5.6 BEG/BAFA) |
| Services – Netzanmeldung | Statusübersicht (PV/WP/Wallbox), Neu | F13.1 |
| Services – Öltank/Baustelle | Anfrage-/Statusübersicht | F13.5 |
| Verkaufsassistent | Analyse/Wettbewerber, Konkurrenzangebote hochladen, Zustimmung | F14.5 (Competitor AI) |
| Verkaufsassistent – Analyse | Angebotsvergleich, Preis-/Leistung, Stärken/Schwächen, nächste Schritte | F14.5 |
| Verkaufsassistent – Wettbewerber | Wettbewerber-Detail, Daten aktualisieren | F14.5 |
| Rechnungen | Dokumentgruppen (Rechnung/Gutschrift/AB/Bestellung/Lieferschein/Brief) | F8.1 |
| Rechnungen | Neu, Status-/Zahlungs-/Datumsfilter, Archiv | F8.3 |
| Rechnungen – Berichte | Einnahmen/Cashflow, Forderungen, Download | Querschnitt „Dashboard/Reporting“ + F8.x |
| Zeiterfassung | Timer, manuelle Einträge, Projektverknüpfung, Pausen, Filter/Suche | F9.1 |
| Zeiterfassung | Excel-Export | F9.3 |
| Komponenten | Liste, Suche, Filter, Import, Detail | F16.1 |
| Komponente – Detail | Stammdaten, Marke/GTIN, EK/VK, MwSt., Datenblatt, Garantie, Anleitung | F16.1 |
| Komponente – Detail | 3D/AR-Bereich | F11.3 (AR-Komponenten) |
| Updates | Release-Notes-Liste | NEU (Changelog) |
| Einstellungen – Profil | Profilfelder, Buchungslink, persönliche URL | F1.9, F12.2 (Per-Rep-Links) |
| Einstellungen – Profil | WhatsApp-Assistent | F14.3 |
| Einstellungen – Profil | Google-/Microsoft-Verbindungen, E-Mail-Signatur | Querschnitt „Auth/Integrationen“, F1.9 |
| Einstellungen – Firmendetails | Firmendaten, Steuer-/Adress-/Kontaktfelder | NEU (Workspace-Stammdaten) |
| Einstellungen – Branding | Logo, Primär-/Sekundärfarbe, Angebotsvorschau | F2.7 + NEU (eigene Farb-/Logo-Konfiguration) |
| Einstellungen – Pflichtfelder | Pflichtfeld-Schalter je Bereich | NEU (Validierungskonfiguration) |
| Einstellungen – Lizenzen & Rechnungen | Lizenz-/Rechnungsverwaltung, Kündigung | Querschnitt „Lizenzfamilien/Self-Service“ + F8 |
| Einstellungen – Nutzer & Teams | Rolle, Lizenz, Berechtigungen, externe Nutzer, Archiv | Querschnitt „Rechte“ |
| Einstellungen – Features | Feature-Schalter | Querschnitt „Workspace-Feature aktiviert“ |
| Einstellungen – Integrationen | Integrationsseite (inhaltlich leer/nicht auswertbar) | Querschnitt „API/Integrationen“ |
| Einstellungen – Rechnungsstellung | Firmendaten, Steuer-/Zahlungsdetails, Textvorlagen, Nummerierung | F8.2, F8.3 |
| Einstellungen – Kalender | persönliche/Unternehmens-/Benutzer-Kalender, Google-/MS-Anbindung | F1.9 |
| Einstellungen – Terminvorlagen/Kategorien | Terminvorlage, Kalender-Kategorie | F1.9 (Terminvorlagen) |
| Einstellungen – Ordnerverwaltung | Ordner erstellen, Tabs Haushalt/Gewerbe | Querschnitt „Dokumente/Dateien“ + F16.x |
| Einstellungen – Postfächer | Microsoft-/Google-Postfach anbinden | F1.9 (E-Mail-Anbindung) |
| Einstellungen – Zeiterfassungskategorien | Kategorien anlegen/archivieren | F9.2 |
| Einstellungen – Benachrichtigungen | persönliche/firmenweite E-Mail-Schalter | Querschnitt „Benachrichtigungen“ |
| Einstellungen – Kanban Boards | Board erstellen, Status bearbeiten/archivieren | F1.5 |
| Einstellungen – Kartenkonfiguration | Tags, Warnschwellen, Anzeigeadresse | F1.5 |
| Einstellungen – Aufgabenvorlagen & Labels | Vorlage erstellen, Tabs/Archiv | F1.9, F16.3 |
| Einstellungen – Projektmanagement (G) | verweigert | F15.1/F15.3 (nicht prüfbar) |
| Einstellungen – Checklisten (Qualifikation/Beratung/Baustelle) | Editor Segment/Block/Element, Vorschau, Speichern | F7.2, F7.3 |
| Einstellungen – Energiehaus (Pakete/Anzeige/Links/Einbindung) | Pakete, öffentlich-Schalter, Texte, Snippet, Tracking | F12.1, F12.2 |
| Einstellungen – Energiefirma (Anzeige/Einbindung/Kostenprofile) | Texte, Snippet, Kostenprofile | F12.3 (Energy Company) |
| Einstellungen – Energiemieter | verweigert | F12.3 (Energy Tenant, nicht prüfbar) |
| Einstellungen – Kontakt-Formular | Vorschau, Feldkonfiguration, Snippet | F12.3 (Contact Form) |
| Einstellungen – Leadquellen | Quellenverwaltung, Tabs | F1.8 |
| Einstellungen – Planung | MwSt.-Default, Planungsmodus, String-Schalter | F3.1, F4.x |
| Einstellungen – Angebots-/Planungsvorlagen/-pakete | Vorlagen/Pakete erstellen, Aktivstatus | F16.2 |
| Einstellungen – KI-Planungsvalidierung | Validierungsvorlagen, Aktivstatus | F14.8 |
| Einstellungen – Förderungen | Förderung erstellen | F16.3 + F13.2 |
| Einstellungen – Photogrammetrie-Abo | Abo, kostenlose Jobs, Kosten/Leistung | F3.7 + NEU (Abo-/Preismodell) |
| Einstellungen – Rabattvorlagen | Rabattvorlage erstellen, Archiv | F2.4, F16.3 |
| Einstellungen – Vorlagen laufende Kosten | verweigert | NEU (laufende Kosten-Vorlagen) |
| Einstellungen – Angebot–Allgemein | Kundenansprache, Nummernformat, Preisdisplay, Signatur, Gültigkeit | F2.1, F2.7, F2.8 |
| Einstellungen – Seiten & Design | PDF-Seitenvorlage, Reihenfolge/Schalter | F2.7 |
| Einstellungen – Rechtliches | Rechtstext-Vorlage | F2.7 |
| Einstellungen – Simulation (Grundlagen/Preise/Heizlast) | Planungshorizont, Strom-/Gas-/Ölpreise, Materialien | F4.6, F5.3 |
| Einstellungen – Installationsfortschritt | Statuskonfiguration | F7.7, F10.2 |
| Einstellungen – FAQ | FAQ-Verwaltung | F10.2 |
| Einstellungen – Dateianfrage-Vorlagen | Foto-Vorlagen, Aktivschalter | Querschnitt „Dokumente/Dateien“ + F10.2 |
| Einstellungen – Automatische E-Mails | E-Mail-Inhalte je Lebenszyklus-Schritt | Querschnitt „Benachrichtigungen“ |
| Einstellungen – Webhooks | Endpunkt, Signaturschlüssel, Ereignisse, Testereignis | Querschnitt „API/Integrationen“ (Webhooks) |
| Einstellungen – API | API-Schlüssel, Scopes, Logs, cURL, Doku | Querschnitt „API/Integrationen“ (REST v3) |
| Dateien | Datei-/Datei-Anfragen-Tabs, Dropzone, E-Mail-Anfrage | Querschnitt „Dokumente/Dateien“ + F10.2 |
| Notizen | Editor (H1–H6), Sprachaufnahme, @-Benachrichtigungen | F1.9, F11.3 (Sprachmemo) |
| Reonic KI | Chat-Modal, Vorschläge, Anhang, Senden | F14.1 |
| Agenten | Liste, neuer Agent, Job-Konfiguration (Trigger/Anweisung/Läufe) | F14.2 |
| Agenten | „Agenten vorschlagen“ (Workspace-Scan, 8 Empfehlungen) | F14.2 + NEU (Vorschlags-Scan) |

### NEU-Funktionen (Zusammenfassung)

| # | Funktion | Beleg (Portal) |
|---|---|---|
| NEU-1 | Release-Notes/Changelog | `/release-notes` |
| NEU-2 | Hilfe/Support, Empfehlung, Webinar-Hinweis (Startseite) | `/home` |
| NEU-3 | Firmendetails (Workspace-Stammdaten) | `/portal-settings?settings=company-details` |
| NEU-4 | Pflichtfelder-Konfiguration | `/portal-settings?settings=required-fields` |
| NEU-5 | Photogrammetrie-Abonnement (Preis-/Job-Kontingent) | `/portal-settings?settings=photogrammetry-subscription` |
| NEU-6 | Vorlagen für laufende Kosten | `/portal-settings?settings=recurring-cost-templates` (verweigert) |
| NEU-7 | Agenten-Vorschlag via Workspace-Scan | `/agents` |
| NEU-8 | Branding (eigene Farb-/Logo-Konfiguration; teilweise F2.7) | `/portal-settings?settings=branding` |

---

## 3. Coverage-Abgleich (Status je Bereich)

**Status-Legende:**
- **VERIFIED** — mind. ein Slice gebaut & lokal REVIEWED/VERIFIED
  (M1-00…M1-13, M2-01…M2-03b1).
- **SPECIFIED** — dedizierter Slice-Spec liegt vor, noch nicht gebaut
  (M1-14, M1-15, M2-04).
- **IN_ARBEIT** — Spec liegt vor und ist aktiv in RED/IMPLEMENTED; derzeit
  leer, da die drei Specs noch nicht in die Bauphase eingetreten sind.
- **OFFEN** — kein dedizierter Slice-Spec; F-Nr existiert ggf. nur auf
  Blaupause-/Modulkatalog-Ebene (oder Funktion ist NEU/verweigert).

Basis: `STATUS.md` (VERIFIED/SPECIFIED je F1–F16), `CAPABILITY-MATRIX.md`
(M2-01), `docs/spec/`.

| Bereich | Status | Slice(s)/F-Nr | Lücke / Hinweis |
|---|---|---|---|
| Startseite | OFFEN | F1.9, F14.1, F14.2, F2.8, Querschnitt | Aggregat; Teile VERIFIED (Aufgaben M1-10/M1-12a), KI/Agenten/Übersicht offen; NEU-2 |
| Aufgaben | VERIFIED | F1.9 (M1-10, M1-12a) | Kern verifiziert; Teams-/Labels-Tiefe teils über M1-09/M1-10 |
| Dashboard | OFFEN | Querschnitt „Dashboard/Reporting“, F1.5 | kein Reporting-/KPI-Slice |
| Wiki | OFFEN | Querschnitt Firmen-Wiki, F11.3 | nicht gebaut |
| Kontakte | SPECIFIED | F1.1 (M1-14) | Liste/Dedupe/Tabs offen; Contact-Erzeugung im Intake VERIFIED |
| Kalender | SPECIFIED | F1.9 (M1-15) | Termine/Kalender-Spec liegt vor |
| Projekte – Anfragen (H) | VERIFIED | F1.2–F1.8 (M1-04…M1-08, M1-08b, M1-11a) | Broker-/Lead-Score-Tiefe offen |
| Projekte – Anfragen (G) | OFFEN | F15.1 | Commercial-Datenmodell nicht gebaut |
| Anfrage – Detail | VERIFIED | F1.1/F1.3/F1.4/F1.9 (M1-05…M1-08, M1-13) | Kontakt/Kalender SPECIFIED (M1-14/M1-15) |
| Anfrage – Services | OFFEN | F13.1/F13.2/F13.4/F13.5 | Filing-/Statusmaschinen nicht gebaut |
| Anfrage – Lead-Informationen | VERIFIED (Daten) / OFFEN (KI-Score) | F1.4 (M1-07), F1.7 | KI-Lead-Score offen |
| Anfrage – Qualifikation | OFFEN | F1.4, F7.2 | Checklisten-Engine offen |
| Projekte – Angebote (H) | VERIFIED | F2.1–F2.5 (M2-01…M2-03b1) | PDF/Issuance verifiziert; Visual INCONCLUSIVE |
| Projekte – Angebote (G) | OFFEN | F15.1 | Commercial-Angebote offen |
| Angebot – Detail | VERIFIED | F2.1–F2.4 (M2-01) | Beratung/Planungstiefe offen |
| Angebot – Beratung | OFFEN | F2.x, F7.2 | Beratungs-Checkliste offen |
| Angebot – Planung | VERIFIED (Energieprofil) / OFFEN (3D) | F1.4, F4.x (M1-07), F3.x | tiefe Dach-/String-Planung offen |
| Projekte – Installationen (H/G) | OFFEN | F7.1, F2.8 | hängt an E-Signatur (M2-04 SPECIFIED) |
| Installation – Terminierung/Arbeitsheft/Baustelle | OFFEN | F7.2, F7.5, F7.6 | Checklisten-Engine/Workbook/Plantafel offen |
| Photogrammetrie | OFFEN | F3.7, F3.2 | nicht gebaut; NEU-5 (Abo) |
| Services | OFFEN | F13.1/F13.2/F13.5 | nicht gebaut |
| Verkaufsassistent | OFFEN | F14.5 | Competitor AI nicht gebaut |
| Rechnungen | OFFEN | F8.1–F8.7 | Modulkatalog-F8 vorhanden, kein Slice-Spec |
| Zeiterfassung | OFFEN | F9.1–F9.3 | kein Slice-Spec |
| Komponenten | OFFEN (auf VERIFIED-Basis) | F16.1 (Basis M1-08) | Katalog-UI/Import/Detail offen; Basis M1-08 VERIFIED |
| Updates | OFFEN | NEU-1 | kein F-Bezug |
| Einstellungen – Profil/Rechte/Features/Lizenzen | VERIFIED (Auth/RBAC-Grundlage M1-00…M1-03) / OFFEN (UI) | Querschnitt „Rechte/Auth“ | RBAC/RLS verifiziert; Settings-Oberflächen offen |
| Einstellungen – Kanban/Checklisten/Vorlagen/Lead-Funnel/Simulation/API | OFFEN | F1.5, F7.2/F7.3, F12.x, F16.x, F4.6/F5.3, Querschnitt API | Blaupause vorhanden, kein Slice-Spec |
| Einstellungen – E-Signatur-Anteil (Angebot–Allgemein/Signatur) | SPECIFIED | F2.8 (M2-04) | Spec liegt vor |
| Dateien | OFFEN | Querschnitt „Dokumente/Dateien“, F10.2 | kein Slice-Spec |
| Notizen | VERIFIED (Projektnotizen M1-13) / OFFEN (globale Notizen) | F1.9 | Projektnotizen verifiziert; `/notes` global offen |
| KI & Agenten | OFFEN | F14.1, F14.2 (+ NEU-7) | KI-Schicht nicht gebaut |

**Kurzfassung Coverage:** VERIFIED-Kern = Golden Path
`Rechner → Lead → Kontakt (teilw.) → Standort → Energieprofil → Katalog → Angebot → Variante → BOM → PDF`.
SPECIFIED-Lanes = M1-14 (Kontakt), M1-15 (Kalender), M2-04 (E-Signatur).
Alles ab F3/F5–F16 (Planung, Wärmepumpe, Schaltplan, Installation, Rechnung,
Zeiterfassung, Kundenportal, Mobile, Lead-Funnel, Services, KI, Gewerbe,
Katalog-UI/Vorlagen) sowie Dashboard/Wiki/Dateien/Agenten = OFFEN (kein
dedizierter Slice-Spec).

---

## 4. Top-Prioritäten — 10 nächste Slices nach Wert

Bewertungskriterien: **Abdeckungslücke** (Bereich mit sichtbarem Portal-Gegenstück
und ohne Slice), **Kundenwert** (Umsatz-/Arbeitszeit-Effekt für WMEE),
**Belegbarkeit** (Portal-/API-Beleg aus den CSVs, damit vertragsfähig specbar).

| # | Slice (Arbeitstitel) | F-Nr | Abdeckungslücke | Kundenwert | Belegbarkeit (Portal) |
|---|---|---|---|---|---|
| 1 | Kontakt-Datensatz bauen (M1-14) | F1.1 | Kontakte-Bereich komplett offen; Contact = Spine | zentrale Datenachse, Dedupe-Qualität | `/contacts` + Detail (Tabs, Duplikat-Hinweis) |
| 2 | E-Signatur bauen (M2-04) | F2.8 | schließt Angebot→Signatur→Installation | Umsatzmoment, verbindlicher Abschluss | Signaturübersicht `/home`, Angebot-Signatur, Angebot–Allgemein |
| 3 | Termine & Kalender bauen (M1-15) | F1.9 | Kalender quer durch Request/Offer/Installation offen | Planungstermine, Disposition | `/calendar`, Terminierung, Terminvorlagen/Kategorien |
| 4 | Rechnungen Slice 1: Dokumenttypen + Belegkette | F8.1, F8.3 | Rechnungsbereich (8 Dokumenttypen) offen | direkter Geldbezug | `/invoicing/document-groups` + alle Typ-Routen + Berichte |
| 5 | Installation + Checklisten-Engine | F7.1, F7.2 | Kern-Differenzierer ohne Slice | größter Arbeitszeit-/Qualitätshebel auf der Baustelle | `/360h/installations`, Baustellendoku, Checklisten-Editoren |
| 6 | Dashboard & Reporting | Querschnitt + F1.5 | kein Reporting-Slice | sichtbarer Verkaufs-Funnel, Steuerung | `/360h/dashboard`, `/backoffice/reports` |
| 7 | Kontakt-Dedupe | F1.9 | Duplikat-Triage fehlt | Datenhygiene, wenige Aufwände | Duplikat-Hinweis (11 möglich) + Zusammenführen |
| 8 | KI-Lead-Score | F1.7 | Score/Filter fehlt | Lead-Priorisierung, Vertriebssteuerung | `/360h/request/…/request` (Score 62/100) + Lead-Score-Filter |
| 9 | Komponenten-Katalog-UI + Import | F16.1 | Katalog-UI/Detail/Import offen (Basis M1-08 da) | saubere Stammdaten für Angebote/BOM | `/settings/components/all` + Komponenten-Detail |
| 10 | Zeiterfassung | F9.1–F9.3 | eigenständiger Bereich ohne Slice | Arbeitszeit-/Abrechnungsbasis, klein | `/timetracking` (Timer, manuell, Excel-Export) |

**Nächste danach (Hinweis, nicht Teil der Top-10):** Netzanmeldung/Service-Filing
(F13.1, transaktionale Erlöse), Webhooks/API-Exposition (Querschnitt,
Integrations-Wert), Lead-Funnel „Energiehaus“ (F12, hohe Lead-Menge),
Kanban-Board-Management (F1.5, schneller Konfigurations-Slice).

Begründung der Rangfolge: 1–3 sind bereits SPECIFIED und setzen den verifizierten
Golden Path fort (geringes Spezifikationsrisiko, hoher Wert); 4–5 sind die
größten verbleibenden Lücken mit direktem Geld-/Qualitätsbezug; 6–10 sind
Portal-belegte, teils kleine Slices, die Breite sichtbar machen. Vor jedem Slice
`product-lens` anwenden und die Gate-Kette einhalten.

---

## 5. Quellen-Hinweis (Eintrag für `SOURCE-REGISTER.md`)

Einfügen in `docs/parity/SOURCE-REGISTER.md` als neuen Abschnitt (nach dem
Abschnitt „Reonic REST API v3“):

```markdown
## Reonic-Portal-Audit (Browser, eingeloggt) — OBSERVED, 2026-09-02

Read-only-Sweep eines Browser-Agenten in einer angemeldeten Portal-Sitzung
(Sitzung Daniel Ehmer / WM Erneuerbare Energien). Es wurden keine Aktionen
ausgeführt, keine Rohdaten/PII persistiert und keine Texte, Layouts, Icons,
Assets oder Preise übernommen. Vollständige Auswertung in
`docs/parity/REONIC-PORTAL-AUDIT-MAP.md`.

| ID | Quelle | Klasse | Belegt | Confidence / Grenze |
|---|---|---|---|---|
| `SRC-PORTAL-AUDIT` | `docs/parity/reonic-portal-audit/reonic_portal_audit_gesamt.csv` (2026-09-02) | OBSERVED | 118 beobachtete Seiten/Bereiche (Startseite bis Agenten) mit sichtbaren Funktionen, Filtern, Bedienelementen und Zugriffsgrenzen | hoch (Sichtsemantik); keine Aktionen, nicht alle UUIDs einzeln gecrawlt, Schreibfunktionen nicht betätigt |
| `SRC-PORTAL-KATALOG` | `docs/parity/reonic-portal-audit/reonic_funktionskatalog.csv` (2026-09-02) | OBSERVED | kondensierter Funktions-/Routenkatalog derselben Sitzung (Bereich → Seite → Route → Funktionen → Grenzen) | hoch (Sichtsemantik); abgeleitete Kompaktierung, keine zusätzliche Primärevidenz |
```

Compliance-Hinweis für das Register: Die CSVs enthalten sitzungsbezogene
Kontakt-/Projekt-/Wettbewerber-Namen und IDs; daraus wurden **keine PII und
keine IDs** in die Auswertung oder in diese Karte übernommen. Sitzungskontext
„Daniel Ehmer / WM Erneuerbare Energien“ wird nur als Quellen-Kontext geführt.
