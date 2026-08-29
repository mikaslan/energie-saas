# Reonic-Parität — belastbarer Liefer- und Fortschrittsstand

Stand: 2026-08-29 · kanonische Abnahmequelle:
`docs/blaupause/01-modulkatalog.md` (F1–F16)

## Bedeutung dieses Dokuments

Die Prozentwerte sind eine grobe Programmprognose, **kein** Ersatz für die
Capability-Abnahme. Eine Funktion zählt erst mit der Kette

`DISCOVERED → SPECIFIED → CONTRACTED → RED → IMPLEMENTED → REVIEWED → VERIFIED`.

Unbekannte private Reonic-Interna zählen nicht als erreicht. Abgenommen wird nur die
rechtmäßig belegte funktionale und semantische Paritätsbaseline; Texte, Markenassets,
UI-Bestände, proprietärer Code und geschützte Daten werden nicht übernommen.

## Aktuelle Schätzung

| Sicht | Stand | Einordnung |
|---|---:|---|
| Gesamtmission einschließlich F1–F16 | ca. 5–7 % | Fundament weit fortgeschritten, fachliche Verticals noch überwiegend offen |
| Technisches Fundament M0/M1 | ca. 75–85 % | Auth-, Tenant-, DB- und Worker-Grenzen lokal weitgehend real, externe Gates offen |
| Nutzerseitige F1–F16-Funktionsparität | ca. 0–2 % | Noch kein vollständiger CRM-/Angebots-Golden-Path |

Diese Werte steigen nicht durch Seiten, Mocks oder Dokumentation allein, sondern nur
durch unabhängig verifizierte Endzustände.

## Verifizierte und laufende Grundlagen

| Slice | Status | Beleg/Grenze |
|---|---|---|
| M1-00 Autorisierungsgrenze | VERIFIED (lokal) | Commit `8c2cf60` |
| M1-01 Tenant-Schlüsselregeln | VERIFIED (lokal) | Commit `aa47671` |
| M1-02 Actor-/Membership-DML | VERIFIED (lokal) | Commit `992796b` |
| M1-03 getrennte DB-Principals | REVIEWED/VERIFIED (lokal) | 210 Tests, 73 Rollen- plus 5 PG18-Proben und Build grün; echte Provider-, Staging- und Restore-Gates bleiben NO-GO |
| Rechner V3 | DISCOVERED | read-only Baseline `rechner/v3@7be46ad`; versionierter Intake-Vertrag noch offen |

## F1–F16-Matrix auf Capability-Ebene

Der Modulkatalog ist vollständig spezifiziert. Die folgende Matrix behauptet bewusst
keine Implementierung aufgrund bloßer Infrastrukturarbeit.

| Bereich | Höchster belastbarer Stand | Nächster echte Slice |
|---|---|---|
| F1 CRM & Leads | SPECIFIED | Rechner-V3-Intake → Kontakt → Standort → Anfrage → Kanban |
| F2 Angebote | SPECIFIED | Anfrage → Variante → BOM/Preise → PDF → Signatur |
| F3 PV-Planung | SPECIFIED | Quick-Modus, danach rechtmäßige Adress-/Dachdatenadapter |
| F4 Simulation | SPECIFIED | deterministischer Rechenkern mit fachlichem Güte- und Haftungsgate |
| F5 Wärmepumpe | SPECIFIED | Schätzverfahren klar von zertifizierter Normrechnung trennen |
| F6 Schaltplan | SPECIFIED | eigener Editor-/Exportvertrag |
| F7 Installation | SPECIFIED | Signatur → Installation → Checkliste/Disposition/Handover |
| F8 Rechnungen | SPECIFIED | unveränderliche Belegkette und Teil-/Schlussrechnung |
| F9 Zeiterfassung | SPECIFIED | Timer/Eintrag → Audit → Export |
| F10 Kundenportal | SPECIFIED | geschützter Projektlink → Angebot/Status/Dateien |
| F11 Mobile/PWA | SPECIFIED | schmale Offline-Outbox für Fotos/Checklisten/Zeit |
| F12 Lead-Funnel | SPECIFIED | Rechner V3 als versionierter Intake-Adapter |
| F13 Services | SPECIFIED | Filing-Objekt und Statusmaschine, externe Human-Gates ehrlich markieren |
| F14 KI | SPECIFIED | rechtegebundene Tools erst nach realen Domain-Commands |
| F15 Gewerbe | SPECIFIED | getrenntes Commercial-Datenmodell |
| F16 Katalog/Vorlagen | SPECIFIED | Produkte, Speicher, Preise und Snapshot-Propagation |

## Lieferform

1. **Geschützter Preview-Link:** öffnet die jeweils verifizierten Slices wie eine
   Webseite; unfertige Funktionen werden nicht als fertig dargestellt.
2. **Parity-Freeze-Link:** nach grüner F1–F16-Matrix, kritischen E2E-Flows,
   Security-/Migration-/Backup-/Rollback-Gates und Mikails ausdrücklichem Freeze.
3. **Produktionslink:** erst nach separater Freigabe. Push, Preview-Deploy, Provider-
   Kauf oder Produktion erfolgen nicht stillschweigend.

Zusätzlich bleiben Repository, Migrationen, Tests, Runbooks, Quellenregister und
Abnahmen als prüfbare Lieferartefakte erhalten.

## Nächste Reihenfolge

1. M1-03 ohne offene lokale High-Befunde abschließen; externe Provider-/DR-Gates
   ausdrücklich BLOCKED lassen, bis echte autorisierte Evidenz vorliegt.
2. Rechner V3 read-only auffinden und seinen sich ändernden Vertrag hinter einem
   versionierten Adapter stabilisieren.
3. Golden Path real bauen:
   `Rechner → Lead → Kontakt → Standort/Adresse → Kalkulation → Katalog/Speicher →`
   `Angebot → Variante → PDF → Signatur → Installation → Rechnung → Kundenportal`.
4. Danach F1–F16 capabilityweise bis VERIFIED schließen.
