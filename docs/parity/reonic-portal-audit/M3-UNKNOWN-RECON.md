# M3-UNKNOWN-RECON — Read-only Portal-Tiefenaufnahme

Stand: 2026-09-03 · Methode: Playwright `connectOverCDP` (gesteuerter Chrome, Sitzung Daniel Ehmer/WM Erneuerbare Energien), reine DOM-Extraktion (goto, textContent, select-Optionen, Labels, Filter-Dropdowns öffnen). Keine speichernden/sendenden Aktionen. Kundendaten maskiert; nur Struktur/Labels/Enums als OBSERVED-Evidenz.

---

## 1. Issuing-Details-Felder — M3-00 UNKNOWN 1

**URL (Beobachtet):** `https://portal.reonic.de/portal-settings?settings=invoicing&tab=issuing-details`

Der Abschnitt „Einstellungen → Firmeneinstellungen → Rechnungsstellung“ hat **4 Unter-Tabs** (URL ändert sich beim Tab-Wechsel):

| Tab-Label | URL-Parameter | Inhalt |
|---|---|---|
| Unternehmensinformationen | `tab=issuing-details` | Firmen-/Absenderdaten |
| Details zu Steuern und Zahlungen | `tab=payment-detail` | Steuer/Buchhaltung + Bankkonto |
| Textvorlagen | `tab=default-texts` | Fußzeile + Belegtexte je Dokumenttyp |
| Zahlenkreise | `tab=number-circles` | Nummerierungs-Format je Dokumenttyp |

### 1a. Unternehmensinformationen (`tab=issuing-details`)
Felder (Label → Typ; `*` = Pflicht):
- Name des Unternehmens `*`
- Email `*`
- USt-IdNr.
- Behörde
- Registernummer
- Adresse: Straße, Nummer, Postleitzahl, Stadt, Staat
- Land `*` (Select, z. B. „Deutschland“)

Pflicht-Markierung: Label-Suffix „ * “ + (in Sidebar) „Pflichtfelder“. Aktion: „Speichern“.

### 1b. Details zu Steuern und Zahlungen (`tab=payment-detail`)
- **Besteuerung → Buchhaltungsmethode** (Radio): „Periodengerecht“ | „Zahlungsbasiert“
  Hinweis: bei „Zahlungsbasiert“ wird Notiz „Umsatzsteuer nach vereinnahmten Entgelten“ in
  Rechnungen/Teilrechnungen/Gutschriften ergänzt (DE/FR/CH/UK).
- **Bankkonto Details**: Name des Kontoinhabers, Bank Name, IBAN, BIC / SWIFT

### 1c. Textvorlagen (`tab=default-texts`)
- **Fußzeile** mit 3 Spalten (Links / Mitte / Rechts): Linker Text, Mittlerer Text, Rechter Text
- Je Dokumenttyp folgende Textfelder (Rechnungen/Teilrechnungen zusätzlich QR):
  - **Rechnungen**: Anzahl der Tage vor dem Fälligkeitsdatum (number), Beschreibung, Schlussnoten,
    Zahlungs-QR-Code (Toggle „Aktiviere/Deaktivieren“ EPC-QR-Codes), Zweck Code, Überweisungstext, Informationen
  - **Teilrechnungen**: Anzahl der Tage vor dem Fälligkeitsdatum, Beschreibung, Schlussnoten,
    Zahlungs-QR-Code (Toggle), Zweck Code, Überweisungstext, Informationen
  - **Gutschriften**: Beschreibung, Schlussnoten
  - **Auftragsbestätigungen**: Anzahl der Tage vor dem Fälligkeitsdatum, Beschreibung, Schlussnoten
  - **Bestellungen**: Anzahl der Tage vor dem Fälligkeitsdatum, Beschreibung, Schlussnoten
  - **Lieferscheine**: Anzahl der Tage vor dem Fälligkeitsdatum, Beschreibung, Schlussnoten
  - **Briefe**: Titel, Untertitel, Beschreibung, Schlussnoten

### 1d. Zahlenkreise / Nummerierung (`tab=number-circles`)
Abschnitt „Formatierung der Dokumentenkennung“ — je Dokumenttyp **Format-Textfeld + Nummer-Zähler**:

| Dokumenttyp | Format (OBSERVED-Wert) |
|---|---|
| Rechnungen | `Rechnung-{YEAR}-{MONTH}-{NUMBER}` |
| Teilrechnungen | `Abschlagsrechnung-{YEAR}-{MONTH}-{NUMBER}` |
| Gutschriften | `CRN-{YEAR}-{MONTH}-{DAY}-{NUMBER}` |
| Auftragsbestätigungen | `OFC-{YEAR}-{MONTH}-{DAY}-{NUMBER}` |
| Bestellungen | `PO-{YEAR}-{MONTH}-{DAY}-{NUMBER}` |
| Lieferscheine | `DN-{YEAR}-{MONTH}-{DAY}-{NUMBER}` |
| Briefe | `LE-{YEAR}-{MONTH}-{DAY}-{NUMBER}` |

Platzhalter-Legende: `{YEAR}` (2026) · `{MONTH}` (9) · `{DAY}` (3) · `{NUMBER}` (XXX).
Beispiel-Zeile: `OFC-2025-01-01-1, OFC-2025-12-12-12, OFC-2023-01-01-24`.

---

## 2. Gutschrift-„Typ“-Filter — M3-01 UNKNOWN 4

**URL (Beobachtet):** `https://portal.reonic.de/invoicing/credit-notes`

Filter „Typ“ (Dropdown geöffnet, read-only) — **Enum-Werte (2)**:
- Minderleistung
- Empfehlungsprämie

(plus Leer-Option „Ohne typ / Nicht gesetzt“ und „Alle Auswählen 2 / 2“)

---

## 3. Dokumentgruppen-Detail — M3-01 UNKNOWN 5

**URL (Beobachtet):** `https://portal.reonic.de/invoicing/document-groups`
(`/invoicing` leitet hierher weiter = „Übersicht“-Tab)

- **Spalten der Übersicht:** `Name` (einzige Spalte; Paginierung „0/0“)
- **Leerzustand:** „0 Artikel“ → **keine Gruppe vorhanden**, daher keine Detailfelder beobachtbar.
- Erreichbare Aktionen: „Neu“ (nicht geklickt), Filter „Archiviert“ (Toggle).

**Ergebnis:** Übersicht hat nur Spalte „Name“; Gruppendetail nicht beobachtbar (leerer Bestand).

---

## 4. Berichte-KPI-Definitionen — M3-01 UNKNOWN 1

**URL (Beobachtet):** `https://portal.reonic.de/backoffice/reports`

Tabs: „Übersicht“ | „Forderungen“. Aktion: „Daten herunterladen“.

### 4a. KPI-Karten (Labels + Untertitel)
- **Einnahmen diesen Monat** — Wert `0 €`, Untertitel **„Kein Vormonat“**
- **Cashflow diesen Monat** — Wert `0 €`, Untertitel **„Kein Vormonat“**
- **Ausstehend** — Wert `0 €` (kein Untertitel)
- **Überfällig** — Wert `0 €` (kein Untertitel)

Tooltips: **keine beobachtet** (kein `[role=tooltip]`, keine `title`-Attribute auf KPI-Elementen).
Zeitraum-Semantik: „diesen Monat“ = laufender Monat; „Kein Vormonat“ = Vormonatsvergleich-Indikator
(zeigt Vormonatswert sobald vorhanden). „Ausstehend“/„Überfällig“ ohne Monatsbezug.

### 4b. Diagramm „Einnahmen Nach Status“ (Legende/Statusgruppen)
Versendet · Bezahlt · Überfällig · Entwurf · Storniert (je mit `0 €`)

### 4c. Überfälligkeitsbericht (Bucket-Labels)
- 0-30 Tage
- 31-60 Tage
- 61-90 Tage
- Über 90 Tage
- Insgesamt ausstehend

### 4d. Tabelle „Neueste Dokumente“ (Spalten)
Name · Betrag · Status · Zahlung (Leerzustand „Noch keine Dokumente“)

---

## Abdeckung / offen
- **Gefunden:** 1) vollständige Issuing-Felder + 4 Unter-Tabs + Nummerierungs-Formate + Textvorlagen;
  2) Gutschrift-Typ-Enum (Minderleistung, Empfehlungsprämie); 4) KPI-Labels/Untertitel + Überfälligkeits-Buckets.
- **Leer/nicht beobachtbar:** 3) Dokumentgruppen-Detail (Bestand leer, nur Spalte „Name“);
  4) KPI-Tooltips (keine vorhanden).
