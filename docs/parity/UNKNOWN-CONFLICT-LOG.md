# Unknown- und Konfliktregister

Stand: 2026-08-30

Unknowns werden nicht still als Reonic-Wahrheit oder WMEE-Default umgesetzt.
Die sicheren Eigenentscheidungen sind seit Gate 1 `DECIDED WMEE`, bleiben als
eigene Regeln ausgewiesen und austauschbar.

| ID | Klasse | Frage / Konflikt | M2-01-Behandlung | Abschlussgate |
|---|---|---|---|---|
| `UNK-F2-01` | UNKNOWN | exaktes Reonic-Nummernformat und Konfigurationsumfang | eigener versionierter Default; Einstellungs-UI später | Interview/öffentliche Doku |
| `UNK-F2-02` | UNKNOWN | mehrere Offers pro Project oder nur Varianten | v1 unique Offer pro Project | Produktinterview vor Direct-Offer |
| `UNK-F2-03` | UNKNOWN | private Cent-Rundung je Rabattstufe | eigener gepinnter BigInt-Vertrag | rechtmäßige Evidence oder Accepted Exception |
| `UNK-F2-04` | UNKNOWN | genaue Semantik Required/Additional/Optional/Hidden in allen Totals | eigene sichtbare Semantik und Contract-Tests | Interview vor Signatur |
| `UNK-F2-05` | UNKNOWN | deutsche 0 %, 19 %, §13b, Kleinunternehmer im Angebotskontext | ausdrückliche Wahl 19 % oder operatorbestätigt 0 %, technisch stets `price.edit`, kein stiller Default und kein Rechtsclaim | Steuerberater-Review vor Pilot/M3 |
| `UNK-F2-06` | UNKNOWN | Rabattkompetenzen je Rolle/Workspace | vorhandene Einzelrechte, keine neuen Defaults | Owner-/Pilotkundenentscheidung |
| `UNK-F2-07` | UNKNOWN | Direct-Offer und Commercial-Boardtopologie | nicht in M2-01 | eigener Capability-Slice |
| `UNK-F2-08` | UNKNOWN | echte WMEE-SKUs, EK/VK, Services und ca. 40 Pakete; Auswahlalgorithmus, dritter/balancierter Weg und feste versus konfigurierbare Labels | keine Seed-Daten und keine automatisch erzeugten Paketvarianten | autorisierte Datenquelle/Rechte + Produktentscheidung |
| `UNK-F2-09` | UNKNOWN | genaue PDF-Struktur, Firmen-/Rechtsdaten, Issuance sowie autoritative WMEE-Angebotsvorlage/Claim-Regeln | keine PDF-/Textgeneratorfunktion; Fakten statt Hype, keine ungestützte Rendite und schlechte Wirtschaftlichkeit bleiben Pflichtgate | M2-02 Spec + Rechtsdaten + Claim-Review |
| `UNK-F2-10` | CONFLICTING | Wann wird Online-Annahme/Signatur bindend, wer darf freigeben, welche menschliche Prüfung und welche Revision bildet den Vertrag; danach automatische oder manuelle Installation | kein Versand, keine Annahme und kein Vertragsstatus in M2-01 | M2-03 Legal-/Owner-/Interview-Spec |
| `UNK-F2-11` | CONFLICTING | Ergebnis/PDF vor Kontaktpflicht versus Lead/Angebotsanfrage danach; Zeitpunkt der Lead-Anlage, E-Mail/Telefon-Pflicht, Partnerempfänger, Feld-Consent und Datenschutzhinweis | keine neue Kontaktpflicht oder Partnerweitergabe im Offer | Calculator-/Sales-/Privacy-Entscheidung |
| `UNK-F2-12` | UNKNOWN | issued/signed Retention versus DSGVO-Erasure | Draft bleibt löschbar; kein WORM | Legal/DSGVO vor Issuance |
| `UNK-F2-13` | UNKNOWN | strukturierte Klima-Produkte (Außen-/Innengerät, Leitung, Zubehör, Arbeit) | M2-01 ausdrücklich PV-first; `other` wird nicht als Klima-Modell missbraucht | Katalog-Slice vor Klima-Angebot |
| `UNK-F2-14` | UNKNOWN | B2C-/B2B-/unklare Preiszielgruppe und getrennte Preislisten auch im PV-Wohngebäude | M2-01 akzeptiert nur ausdrücklich operatorbestätigtes `b2c`; `residential`/Website werden nicht als Nachweis inferiert, der einzelne Katalog-VK gilt durch Gate 1 nur in diesem Slice als B2C-Listenpreis; B2B/unklar blockiert | eigener Qualifikations-/Katalogvertrag vor B2B oder Pilot |
| `UNK-DESIGN-01` | UNKNOWN | authentische WMEE-Farben, Typografie und freigegebene Screenshot-Baseline | eigene scoped Grünrichtung und vollständige Tokens sind Gate-1-freigegeben; 320 als Reflow-Stress sowie 375/390/768/1024/1440/1920 und 44 px sind A11y-/QA-Entscheidungen, keine Brand-Evidenz; Visual bleibt ohne freigegebene maskierte Baseline INCONCLUSIVE | Mikails Screenshot-Baseline-Freigabe |
| `UNK-INT-01` | UNKNOWN | stabile Rechner-V3-Schnittstelle während externem Bau | bestehende immutable Intake-Grenze; kein Schreibzugriff auf V3 | separate Integrationsfreigabe |

Historische Steuer-/Abrechnungsbehauptungen aus Transkripten, insbesondere das
Verschieben von Arbeitswerten zwischen Gewerken, sind ungeprüft und kein
Produktvertrag.
