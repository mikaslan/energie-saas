# Vollständigkeitskritik — was den fünf Dokumenten fehlt

## 1. Nicht recherchierte Quellen/Modalitäten (höchste Priorität)

1. **Kein einziger Anwender wurde befragt.** Die gesamte Funktionsanalyse basiert auf Doku/Marketing/Reviews. Die „nur per Demo klärbar"-Liste ist ehrlich, aber es fehlt ein Plan, sie abzuarbeiten (Interviews mit Reonic-Kunden, Ex-Kunden, Churnern — legal unbedenklich, im Gegensatz zum verbotenen Demozugang). Gerade Churner würden zeigen, welche der 16 Module real genutzt werden vs. Shelfware sind.
2. **Play-Store-Reviews, LinkedIn-Jobposts, Changelogs, Webinare/YouTube-Demos** von Reonic sind nicht ausgewertet — Jobposts verraten Stack/Prioritäten, aufgezeichnete Demos zeigen das UI-Verhalten, das die Doku nicht hergibt.
3. **Keine Nachfrage-Validierung für die eigene Positionierung.** Der Wallbox-Keil ist plausibel argumentiert, aber es gibt null Primärdaten: keine Gespräche mit Elektrobetrieben, keine Suchvolumen-/Zahlungsbereitschafts-Messung, kein Smoke-Test. Das Marktbild zitiert „62 % WhatsApp" ohne Quellenangabe im Dokument.
4. **VNB-Realität ungetestet:** Das VNB-Verzeichnis soll der Moat sein, aber niemand hat exemplarisch 5 echte Netzanmeldungen durchgespielt, um Aufwand pro VNB und Redaktionskosten zu kalibrieren.
5. **Reonic-Preismodell bleibt Schätzung** ($60–120) — für die eigene Preisarchitektur (29/69–99 €) fehlt damit der Anker; Konkurrenz-Preislisten (Streit, Label, eTurnity) ebenfalls offen.

## 2. Unklare / vermutlich falsch verstandene Funktionen

1. Die **9 dokumentierten Widersprüche** (LiDAR offline, Signatur→Installation-Automatik, App-Angebotserstellung …) werden im Katalog benannt, aber Architektur und Roadmap bauen teils auf einer stillschweigend gewählten Lesart auf (z. B. „Signatur setzt Won + Phase Installation" in M2 — genau Widerspruch Nr. 4).
2. **Checklisten-Engine unterschätzt:** if/then-Konditionallogik, Merge-Versionierung und 12 Item-Typen sind ein eigenes Produkt; die Roadmap presst sie mit Plantafel, Workbook, Handover, Zeiterfassung UND PWA-Offline in einen Meilenstein (M5) — der wahrscheinlich am meisten unterschätzte Block.
3. **„Won" vs. Auftrag:** Ob Reonic zwischen signierter Variante und kaufmännischem Auftrag (Nachträge, Änderungsaufträge!) trennt, ist ungeklärt — der Architektur-Streitpunkt 3 vertagt genau das, obwohl Nachträge im Handwerk der Normalfall sind, nicht der Sonderfall.
4. **Simulationsgüte:** „gegen PVGIS validiert" sagt nichts über Speicher-/Arbitrage-Logik, dynamische Tarife, WP-JAZ-Realismus. Ob pvlib+hplib Reonics Verkaufszahlen reproduziert, ist unverifiziert — falsche Amortisationszahlen sind ein Haftungsthema (s. u.).

## 3. Regulatorische Lücken

1. **Haftung für Wirtschaftlichkeits- und Förderaussagen fehlt komplett.** Wenn die Software „30 % KfW" oder „Amortisation in 9 Jahren" ins Kunden-PDF schreibt und das falsch ist, haftet der Installateur — und der regressiert. Disclaimer-Architektur, Aktualitätsgarantien fürs Förder-Regelwerk, E&O-Versicherung: nirgends behandelt.
2. **Netzanmeldungs-Service = Rechtsdienstleistung?** Vollmacht-basiertes Einreichen für Dritte streift RDG/HwO; das „konzessionierter Meister als Partner"-Modell braucht eine saubere Vertragskonstruktion (wer haftet für die Fertigmeldung?). Nur der Meister ist erwähnt, nicht das Haftungsgefüge.
3. **eIDAS-Einordnung der Eigenbau-Signatur:** „einfache Signatur reicht" ist behauptet, nicht geprüft — insbesondere für Verbraucherverträge mit Finanzierungsbezug und den §-356a-Widerruf.
4. **AI Act:** Lead-Scoring, Bill Reading, Call Agent — Transparenzpflichten ab 08/2026 sind akut, kommen aber in keinem Dokument vor.
5. **DSGVO-Detail:** Funnel/Portal verarbeiten Endkundendaten vor Vertragsschluss; Löschkonzept, Consent-Kaskade Broker→Plattform, GPS in der Zeiterfassung (Mitbestimmung § 87 BetrVG bei größeren Kunden!) fehlen.
6. **Fernwartungs-/TSE-Themen** nein, aber: **Verfahrensdokumentation als Produktbestandteil** wird erwähnt, ihre Pflege (bei jedem Release!) nicht.

## 4. Architektur-Blindstellen

1. **Backup/Restore/Disaster Recovery:** WORM-Archiv und 8 Jahre GoBD sind modelliert, aber kein Wort zu Backup-Strategie, RPO/RTO, Restore-Tests — für ein Fakturierungssystem die eigentliche Existenzfrage.
2. **DSGVO-Löschung vs. Append-only/WORM:** Löschzeitstempel am Contact kollidiert konzeptionell mit unveränderlichen Events, Audit-Log und archivierten PDFs (Kundendaten in Rechnungen sind aufbewahrungspflichtig, in Notizen nicht). Kein Krypto-Shredding-/Pseudonymisierungs-Konzept.
3. **PDF-Worker als Single Point of Failure** für den Signatur-Flow: „Worker-Ausfall blockiert nie das Portal" — aber ohne PDF keine Signatur, ohne Signatur kein Geldpfad.
4. **Such-Skalierung, Rate-Limiting, Mandanten-Fairness** (ein Großkunde mit CSV-Bulk-Import) unbehandelt.
5. **Migrations-/Onboarding-Pfad:** Wie kommen Bestandsdaten eines Betriebs (aus Excel, HERO, Reonic!) hinein? Import ist als CSV-Lead-Import gedacht, nicht als Voll-Migration — für Wechselkunden entscheidend.

## 5. Roadmap-Illusionen

1. **Keine Zeit-/Kapazitätsachse.** M0–M8 haben keine Wochen-Schätzungen; für einen Solo-Gründer mit KI-Unterstützung ist M0+M1+M2+M3 realistisch 6–12 Monate — das steht nirgends, und die Integrationskarten-Schätzungen (2–3 PM Fakturierung) summieren sich nie auf.
2. **Pilot nach M3 setzt einen Pilotkunden voraus** — Akquise, Onboarding-Material, Support-Kapazität (das Marktbild selbst sagt: Reonics 5★ hängen am Support) sind keine Roadmap-Posten.
3. **Moat-Pflege ist unbepreist:** „Redaktion ab Woche 1" für Förderung+800 VNB — wer macht das neben dem Bauen, wie viele Stunden/Woche?
4. **Roadmap widerspricht der Positionierung:** Das Marktbild empfiehlt den Wallbox-/Elektriker-Keil; die Roadmap baut den PV-Residential-Pfad (Simulation, Dachplanung) und schiebt Netzanmeldung — den Wallbox-Kernnutzen — nach M7. Die zwei Dokumente beschreiben zwei verschiedene Firmen; das ist die größte offene Entscheidung.
5. **„Funktionsparität" als M8-Sammelbecken** (ganze KI-Schicht, Commercial, Mieterstrom, native App) ist keine Planung, sondern eine Restehalde.

## 6. Offene Geschäftsfragen

1. **Finanzierung/Runway:** nichts zu Kosten bis Break-even, Preispunkt × nötige Kundenzahl.
2. **Wer verkauft?** Vertriebsmodell (Self-Service allein vs. Reonics Demo-Vertrieb) unentschieden — und der Zielkunde (Kleinbetrieb) kauft erfahrungsgemäß über Empfehlung/Messe, nicht über Pricing-Seiten.
3. **Service-Ökonomie:** Netzanmeldung zu 200–350 € braucht Meister-Partner-Marge — Deckungsbeitrag pro Vorgang nie gerechnet.
4. **Reonic reagiert:** wöchentliche Releases, VC-Tempo — kein Szenario, was passiert, wenn Reonic Preise veröffentlicht oder einen Starter-Tarif launcht (der halbe Positionierungsvorteil wäre weg).
5. **Team:** Alles ist auf Solo+KI ausgelegt; ab wann die erste Einstellung (Support? Redaktion?) nötig ist, bleibt offen.

**Fazit-Priorität:** (1) Positionierungs-/Roadmap-Widerspruch auflösen, (2) Nachfrage- und Anwender-Primärforschung, (3) Haftungs-/Löschkonzept-Lücken, (4) Zeitachse + Moat-Pflegekosten ehrlich rechnen.