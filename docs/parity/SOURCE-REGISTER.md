# Paritäts-Quellenregister

Stand: 2026-09-02

Dieses Register klassifiziert Quellen; es ersetzt weder die Clean-Room-Regeln
in `CONTRIBUTING.md` noch eine Capability-Abnahme. Reonic-Quellen dürfen nur
beobachtbare Funktionssemantik belegen. UI, Texte, Assets, Code und Daten werden
nicht übernommen.

## Reonic REST API v3 — autorisierter read-only-Zugang (seit 2026-09-02)

Zugang vom Eigentümer freigegeben und in `COMPLIANCE-REONIC-API.md` dokumentiert.
Nur öffentlich dokumentierte Endpunkte, nur GET, keine Rohdaten-Persistenz,
Werte werden vor jeder Weitergabe maskiert/anonymisiert.

| ID | Quelle | Klasse | Belegt | Confidence / Grenze |
|---|---|---|---|---|
| `SRC-API-SPEC` | OpenAPI v3.11.0, `https://api.reonic.de/rest/v3/openapi` | DOCUMENTED | 124 Pfade, Schemas, Scopes, Rate-Limits; kartiert in `REONIC-API-CAPABILITY-MAP.md` | hoch (öffentliche Spec); kein Laufzeitbeweis |
| `SRC-API-ME` | `GET /me` (2026-09-02) | OBSERVED | clientId/Workspace, locale de-DE, currency EUR, Key-Typ `read-only` | hoch; Werte maskiert |
| `SRC-API-LEADSOURCES` | `GET /leadSources` (2026-09-02) | OBSERVED | 8 Einträge; Felder: id, name, projectDomain, createdAt, updatedAt, archivedAt | hoch (Schema); Inhalte maskiert |
| `SRC-API-TAGS` | `GET /tags` (2026-09-02) | OBSERVED | 2 Einträge; Felder: id, label, parentType, textColor, backgroundColor, createdAt, updatedAt, archivedAt | hoch (Schema); Inhalte maskiert |
| `SRC-API-CALCAT` | `GET /calendarCategories` (2026-09-02) | OBSERVED | 0 Einträge (leerer Bestand) | hoch (Bestandsfakt) |

## Aktive Quellen für M2-01

| ID | Quelle | Klasse | Belegt | Confidence / Grenze |
|---|---|---|---|---|
| `SRC-CONSTITUTION-01` | `CONTRIBUTING.md` | DOCUMENTED | Clean-Room, erlaubte Quellen, verbotene Zugänge | hoch; bindend |
| `SRC-BLUEPRINT-F2` | `docs/blaupause/01-modulkatalog.md`, F2.1–F2.4 | INFERRED / sekundär synthetisiert | Arbeits-Hypothesen zu Offer, Varianten, BOM, Rabattstack | mittel; keine Primärevidenz, Claims müssen an öffentliche Doku/Vault gebunden bleiben |
| `SRC-M108-01` | `docs/spec/M1-08-produktkatalog-projektaufloesung.md` und ADR 0008 | DOCUMENTED | immutable Katalog-/Preissnapshots, EK-Grenze, Current/Stale | hoch; lokal verifiziert |
| `SRC-REONIC-CREATE` | [Create an offer](https://docs.reonic.com/docs/en/offers-overview-create-an-offer) | DOCUMENTED | Offer aus Request oder direkt, Workspace-Nummer, Standardvariante | hoch für öffentlich beschriebene Semantik; kein Login |
| `SRC-REONIC-BASIC` | [Offer basic information](https://docs.reonic.com/docs/en/offers-overview-basic-informations) | DOCUMENTED | BOM-Felder, Menge, Preis, Rabatt, VAT, Sektionen | hoch für öffentlich beschriebene Semantik |
| `SRC-REONIC-VARIANTS` | [Variants](https://docs.reonic.com/docs/en/offers-plan-additional-optional-variants) | DOCUMENTED | unabhängige Varianten und Duplizieren | hoch; private Implementierung unbekannt |
| `SRC-REONIC-ADDITIONAL` | [Additional components](https://docs.reonic.com/docs/en/offers-plan-additional-optional-additional-components) | DOCUMENTED | zusätzliche, im Angebotspreis enthaltene Komponenten | hoch |
| `SRC-REONIC-OPTIONAL` | [Optional components](https://docs.reonic.com/docs/en/offers-plan-additional-optional-optional-components) | DOCUMENTED | separat auswählbare optionale Komponenten | hoch; Auswahl selbst ist späterer Signatur-Slice |
| `SRC-REONIC-SECTION-DISCOUNT` | [Discounts per section](https://docs.reonic.com/docs/en/offers-finalise-cat-discounts-per-section) | DOCUMENTED | Sektionsrabatte | hoch; Rundung nicht öffentlich belegt |
| `SRC-REONIC-GLOBAL-DISCOUNT` | [Global discounts](https://docs.reonic.com/docs/en/offers-finalise-cat-global-discounts) | DOCUMENTED | globale Rabatte | hoch; Rundung nicht öffentlich belegt |
| `SRC-REONIC-FINALISE` | [Finalise overview](https://docs.reonic.com/docs/en/offers-finalise-cat-finalise-overview) | DOCUMENTED | Finalisierung als eigener Schritt | hoch; wird in M2-01 nicht implementiert |
| `SRC-REONIC-LIFECYCLE` | [Offer characteristics](https://docs.reonic.com/docs/en/offers-overview-overview-offer-characteristics) | DOCUMENTED | Offer-Lebenszyklus und gesperrter signierter Stand | hoch; Signatur bleibt später |
| `SRC-VAULT-REQ` | eigene WMEE-Strategie-, Rechner- und Feedbacknotizen im Manifest unten | DOCUMENTED | Rechner→Lead→unverbindlicher Angebotsentwurf, menschliche Prüfung, drei Ergebnisrichtungen, Klima-/PV-Ziele | mittel bis hoch; eigene Anforderungen, keine Reonic-Live-Evidenz |
| `SRC-VAULT-INTERVIEW` | Jamie-Meeting und sechs direkt verlinkte Transkripte im Manifest | OBSERVED stakeholder statement | Nutzerwünsche, Reonic-Anwenderaussagen, Text-/Claim-Probleme | mittel; Aussagen nicht als unabhängige Produktbeobachtung ausgeben |
| `SRC-VAULT-BETA` | Design-/Fehlernotizen und zugehörige Transkripte im Manifest | OBSERVED own QA | Rechnerfehler, responsive und Accessibility-Risiken | hoch für geprüfte Beta, keine WMEE-Brandtokens |
| `SRC-VAULT-SESSIONS` | vier historische Session-Markdowns im Manifest | DOCUMENTED / secondary archive | frühere Agent-/Nutzerentscheidungen und Quellenhinweise | niedrig bis mittel; keine Produktbeobachtung, `fc23821a` ist überlappender Frühstand und keine zweite Bestätigung |
| `SRC-NEXT-16-LOCAL` | installierte offizielle Next-16.3.3-Dokumentation in `node_modules/next/dist/docs` | DOCUMENTED | Server-/Client-Grenze, Actions, Forms, Cache, Revalidation, Errors | hoch; exakt installierte Version |
| `SRC-CLAUDE-M201-UI` | lokaler Claude-Code-2.1.251-Leselauf, Modellalias `opus`, Effort `max` | INFERRED / design input | unabhängige UI-/A11y-Gegenprobe für M2-01 | mittel; keine Produktwahrheit, keine Schreibrechte, ausgewählte Punkte bewusst übernommen |

Öffentliche Reonic-Seiten wurden am 2026-08-29 ohne Account gelesen. Die
Vault-Auswertung war read-only. Keine Quelle liefert einen autoritativen
WMEE-SKU-/Preiskatalog oder exakte private Reonic-Rundungsregeln.

## Durch Gate 1 freigegebene Eigenentscheidungen

Mikail hat Gate 1 am 30. August 2026 freigegeben. Diese Entscheidungen sind
damit `DECIDED`, bleiben aber eigene WMEE-Produktentscheidungen und werden
nicht als private Reonic-Produktwahrheit ausgegeben.

| ID | Entscheidung | Klasse | Ablage |
|---|---|---|---|
| `DEC-M201-01` | ein Offer pro Project im v1 | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-02` | PV-Wohngebäude-Golden-Path zuerst | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-03` | `ANG-{YYYY}-{sequence:6}` als eigener Nummernstandard | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-04` | Cent/Basispunkte/BigInt/half-up/Largest Remainder | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-05` | Required+Additional im Basispreis, Optional separat, Hidden ohne Rechenwirkung | DECIDED WMEE | Spec M2-01 |
| `DEC-M201-06` | 0 % nur operatorbestätigt, nie automatisch inferiert | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-07` | erste Variante heißt `Basis`; alle 1–500 Resolution-Zeilen werden in fester Kategorienreihenfolge vollständig als sichtbare `required`-Positionen ohne Rabatt geseedet | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-08` | M2-01 erlaubt nur ausdrücklich operatorbestätigte B2C-Rechneranfragen; der einzelne Katalog-VK gilt nur in diesem Slice als B2C-Listenpreis | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-09` | jede Steuerwahl/-änderung und neue Basis verlangt `price.edit`; 0 % wird commandgebunden frisch bestätigt | DECIDED WMEE | Spec M2-01, ADR 0009, Rollenmatrix |
| `DEC-M201-10` | Offer kopiert nur Name, primäre E-Mail/E.164-Telefon und sieben bestätigte Anlagenadressfelder; übrige PII und Rechnerpayloads bleiben außen vor | DECIDED WMEE | Spec M2-01, Domain Model |
| `DEC-M201-11` | höchstens 12 Varianten, 500 Zeilen und DB-gebundene 15-Minuten-Mutationsquoten 120/Actor sowie 1200/Workspace | DECIDED WMEE | Spec M2-01, ADR 0009 |
| `DEC-M201-12` | vollständige scoped Tokens sowie maskierte Screenshot-Baselines bei 375/390/768/1024/1440/1920; Visual bleibt bis Mikails Freigabe INCONCLUSIVE | DECIDED WMEE / visuelle Baseline ausstehend | Spec M2-01, Goal §13 |

## Vollständig gelesenes Vault-Manifest

Basis: `/Users/mikail/Downloads/OBSIDIAN/ASLAN FINAL/`.

| Nr. | Relativer Pfad | Klasse / Verwendung |
|---:|---|---|
| 1 | `Wo alles liegt.md` | DOCUMENTED, reine Vault-Navigation |
| 2 | `_START.md` | DOCUMENTED, Vault-Kontext |
| 3 | `20-Bereiche/D-Wmee/_index.md` | DOCUMENTED, Bereichskontext |
| 4 | `20-Bereiche/D-Wmee/Eigener PV-Rechner als Rionic-Alternative Prototyp mit drei Versionen.md` | DOCUMENTED, eigene Rechner-/Prozessanforderung |
| 5 | `20-Bereiche/D-Wmee/Eigener Solarrechner gebaut, reonic zurück auf Produktion, Beta isoliert live.md` | DOCUMENTED / OBSERVED own QA |
| 6 | `20-Bereiche/D-Wmee/Design-Review des Solarrechner-Beta neue Befunde dokumentiert.md` | OBSERVED own QA; keine Brandtokens |
| 7 | `20-Bereiche/D-Wmee/Daniel gibt Feedback zum PV-Rechner Fehler und Anpassungen nötig.md` | OBSERVED stakeholder statement |
| 8 | `20-Bereiche/D-Wmee/Klimaanlagen-Vertrieb ausgebaut, All-in-One-Energierechner geplant.md` | DOCUMENTED, eigene Produktabsicht |
| 9 | `20-Bereiche/D-Wmee/Klimaanlagen-Standbein bei WME startet, KI-Wissensdatenbank geplant.md` | DOCUMENTED, eigene Produktabsicht |
| 10 | `20-Bereiche/D-Wmee/Strategie für Dennis-Partnerschaft Rechner als Köder, Reolink nachbauen.md` | DOCUMENTED, eigene Strategie; keine Reonic-Primärevidenz |
| 11 | `20-Bereiche/D-Wmee/WMEE baut Klimaanlagen-Sparte aus und koppelt sie an PV.md` | DOCUMENTED, eigene Produktabsicht |
| 12 | `Jamie/Meetings/2026-08-26 Optimierung PV-Rechner Rionic-Alternative.md` | DOCUMENTED Meetingzusammenfassung / OBSERVED Aussagen |
| 13 | `00-Inbox/Sessions/Mitschrift/2026-08-28-fc23821a.md` | DOCUMENTED / secondary archive; überlappender Frühstand von Nr. 14 |
| 14 | `00-Inbox/Sessions/Mitschrift/2026-08-28-4e1cc9a9.md` | DOCUMENTED / secondary archive; maßgeblicherer Vollstand |
| 15 | `00-Inbox/Sessions/Mitschrift/2026-08-27-b557f3c7.md` | DOCUMENTED / secondary archive |
| 16 | `00-Inbox/Sessions/Mitschrift/2026-08-27-81f346a3.md` | DOCUMENTED / secondary archive |
| 17 | `40-Ressourcen/Automatik/setup/MacStudio-von-Mikail/gedaechtnis/-Users-mikailaslan/lod2-bw-live-abrufbar.md` | DOCUMENTED internal technical note |
| 18 | `40-Ressourcen/Automatik/setup/MacStudio-von-Mikail/gedaechtnis/-Users-mikailaslan/wmee-rechner-varianten.md` | DOCUMENTED internal technical note |
| 19 | `Jamie/Transcripts/2026-08-26 Optimierung PV-Rechner Rionic-Alternative (transcript).md` | OBSERVED stakeholder statements |
| 20 | `Jamie/Transcripts/2026-08-26 Solarrechner Feedback und Optimierung (transcript).md` | OBSERVED stakeholder statements |
| 21 | `Jamie/Transcripts/2026-08-24 Vertriebsstrategie Klimaanlagen und Solarrechner (transcript).md` | OBSERVED stakeholder statements |
| 22 | `Jamie/Transcripts/2026-08-22 Geschäftsausbau Klimaanlagen & KI-Automatisierung (transcript).md` | OBSERVED stakeholder statements |
| 23 | `Jamie/Transcripts/2026-08-26 Photovoltaik-Geschäftsmodell KI-Strategie mit Dennis (transcript).md` | OBSERVED stakeholder statements |
| 24 | `Jamie/Transcripts/2026-08-26 Strategie für Photovoltaik und Klimatechnik (transcript).md` | OBSERVED stakeholder statements |

Alle 24 Dateien existierten und wurden am 2026-08-29 read-only vollständig
ausgewertet. Nicht sichtbare Roharchive, verschlüsselte Denkblöcke und Anhänge
außerhalb des Goal-Manifests wurden nicht als gelesen oder belegt ausgegeben.

## Nicht zulässige Quellen

- Reonic-Test-, Demo-, Kunden- oder Mitarbeiter-Login-Zugänge;
- Reonic-API-Zugriffe außerhalb des autorisierten read-only-Gates
  (`COMPLIANCE-REONIC-API.md`): keine Mutationen, keine un-dokumentierten
  Endpunkte, keine Rohdaten-Speicherung, keine Werte-Weitergabe;
- kopierte Reonic-Texte, Screens, UI-Assets, Komponenten- oder Preisdaten;
- historische Klartext-Credentials aus Mitschriften;
- Rechner-`market_estimate` als Produkt- oder Angebotspreis.

| `SRC-PORTAL-AUDIT` | `docs/parity/reonic-portal-audit/reonic_portal_audit_gesamt.csv` (Browser-Agent, eingeloggte Sitzung Daniel Ehmer / WM Erneuerbare Energien, 2026-09-02) | OBSERVED | 18 Bereiche des Portals, Funktionen, Zugriffsstatus, Grenzen | hoch (beobachtet); keine Aktionen ausgeführt |
| `SRC-PORTAL-KATALOG` | `docs/parity/reonic-portal-audit/reonic_funktionskatalog.csv` (dito) | OBSERVED | kompakter Funktionskatalog je Seite/Route | hoch (beobachtet) |
