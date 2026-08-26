# K3-Gegenprobe zur Reonic-Nachbau-Architektur — Ergebnis mit Einschränkungen

## Ablauf-Befund (wichtig, vor der Inhaltszusammenfassung)

Der vorgeschriebene Aufruf (`~/.claude/bin/k3 --effort high`, ein Aufruf, voller Kontext) war **nicht durchführbar**: Das OpenRouter-Konto war zu Beginn bei **119,915 $ von 120 $ verbraucht (~0,085 $ Rest)**. Stufenweiser Abstieg:

1. `--effort high --max-tokens 24000` → HTTP 402 („can only afford 5659 tokens"), kostenlos
2. `--max-tokens 5500` und `4000` → HTTP 402 `in_flight_budget_exhausted` (interner Deckel bei ~50 % des Restguthabens), kostenlos
3. `--effort low --max-tokens 2500` (k3-CLI) → ging durch, aber **`finish_reason=length`: K3 verbrauchte alle 2.500 Tokens im Denken, kein Content — 0,0399 $ Totalverlust.** Das CLI wies diese Kosten nicht aus (Exit vor dem Usage-Print, `/Users/mikailaslan/.claude/bin/k3` ~Z. 100–107)
4. Direkter OpenRouter-Aufruf (gleiches Modell `moonshotai/kimi-k3`, gleicher Endpoint) mit `reasoning: {max_tokens: 200}`, 700 Tokens → **Kappe wurde ignoriert** (688/700 Tokens Reasoning, kein Content, 0,0123 $) — aber der Reasoning-Trace enthält verwertbare Analyse
5. Direkter Aufruf mit `reasoning: {enabled: false}`, 600 Tokens → **Erfolg** (finish=stop, 0,0100 $), stark kondensierter Prompt, Antwort ohne Denkphase

**Qualitätsvorbehalt:** Die finale Antwort entstand ohne Extended Thinking und mit auf ~500 Tokens eingedampftem Kontext; sie zeigt sprachliche Degradation („Lohnt dieselbeßig?", „Time-Scheiben für Zensur"). Die Konsultation ist eine abgeschwächte Gegenprobe, keine vollwertige. Zudem widersprechen sich K3s zwei Pässe an einer Stelle (s. u.).

## (1) Wo K3 zustimmt

- **Tag-1-Fundament explizit bestätigt:** doppelte RLS (`withTenant` + Policies), `domain_events`-Outbox, `audit_log`, Zeitscheiben-Tabellen — wörtlich: „Das ist nicht übertrieben, das ist Standard."
- **pg-boss auf Neon** „vermutlich OK" (ohne Tiefenprüfung).
- **E-Signatur-Eigenbau** (aus dem Reasoning-Trace): einfache elektronische Signatur rechtlich ausreichend, „not the worst" — Restpunkt sind Kundenerwartungen (DocuSign-Look), nicht Rechtslage.
- **pvlib implizit bestätigt:** K3 nennt die pvlib-Simulation „nicht optional" — Werkzeugwahl unstrittig, nur der Zeitpunkt (s. Widerspruch).
- Nuance aus dem Reasoning-Trace: Quick-Modus ohne Simulation „könnte reichen, wenn Ziel Mikro-Installateure" sind.

## (2) Wo K3 widerspricht (mit K3s Begründung)

- **Wichtigster Punkt, in beiden Pässen konsistent — Roadmap: Wirtschaftlichkeitsrechnung VOR den Pilot.** Begründung: PV-Installateure verkaufen die Simulation/Amortisationsstory; „M2 Quick-Modus ohne Simulation ist faktisch ein unvollständiges Angebot"; „Reonics Kern ist die Simulation". Das Pilot-Gate nach M1+M2+M3 testet das Produkt ohne sein zentrales Verkaufsargument. K3s Vorschlag: M4 (mindestens pvlib+Amortisation) vor den Pilot ziehen.
- **Snapshot-BOM + Unveränderlichkeits-Trigger ohne Order-Modell = für K3 Fehlentscheidung Nr. 1:** PV-Anlagen werden nach Signatur häufig umdisponiert (Unterkonstruktion, Speicher-Upgrade); Fork-only ohne Auftragsverwaltung „wird ein Chaos"; DB-Trigger-Unveränderlichkeit mit Drizzle „painful". Alternative: domänenseitig versionierte Snapshots mit expliziten manuellen Versionswechseln. → K3 stellt sich im offenen Streitpunkt 3 auf die Seite von Richter 3 (frühes Order-/Nachtragsmodell).
- **Ein Hetzner-Worker = SPOF:** PDF + pvlib + Serialisierung auf einem Host — Ausfall während des Piloten „legt den Piloten lahm".
- **Offline-LWW „katastrophal"** bei zwei Monteuren auf derselben Baustelle; die Praxisannahme sei zu optimistisch.
- **(Nur Reasoning-Trace, im Widerspruch zur eigenen finalen Antwort):** „Compliance-Overengineering vor Produkt-Validierung" — Tag-1-Stack inkl. doppelter RLS als „massive complexity tax", WORM erst ab M3 nötig. Diese Inkonsistenz zwischen K3s Denken und K3s Antwort ist offen zu benennen; sie schwächt beide Aussagen zum Tag-1-Stack.

## (3) Was K3 übersieht oder falsch gewichtet (gegen den Architekturtext geprüft)

- **Worker-SPOF überzeichnet:** Die Architektur definiert explizit Degradations-Semantik (Ausfall verzögert Jobs, blockiert nie das Portal; Healthcheck, Alarm, Runbooks). Berechtigter Kern: Das Angebots-PDF liegt auf dem kritischen Vertriebspfad — ein Ausfall zur Unzeit tut trotzdem weh. Die Gegenmaßnahme existiert aber bereits im Plan.
- **LWW-Kritik trifft Fotos nicht:** Fotos laufen append-only via presigned Upload und können sich nicht „überschreiben"; LWW gilt pro Feld nur für Checklisten-Antworten, und die Architektur begrenzt bewusst auf „ein Monteur, seine zugewiesene Checkliste". K3s Szenario (zwei Monteure, dieselbe Checkliste) ist der relevante Restfall — Antwort darauf wäre Zuweisungs-/Sperrlogik, nicht CRDT.
- **WORM-Kritik trifft etwas, das so nicht geplant ist:** M0 baut nur die Storage-Abstraktion mit WORM-*Vorbereitung*; das Vollarchiv kommt mit den Belegen (M2/M3).
- **DSGVO-„Real-Time"-Punkt** ist wirr und entwertet; EU-Storage, AVV-Vorlagen und Consent-Felder stehen bereits im Plan.
- **Budgetbedingt gar nicht adressiert** (Fragen mussten gestrichen werden): better-auth-Reifegrad, RLS-Performance, KI-Code-Zeitplanillusion, Clean-Room-Rechtsrisiko und vor allem **Solo-Vertrieb an Handwerksbetriebe** — letzteres ist womöglich das größte reale Risiko des Vorhabens und blieb ungeprüft.

## (4) Ausgewiesene Kosten

- Aufruf A (k3-CLI, effort low, 2500): **0,0399 $** — Totalverlust (length, kein Content; per Guthaben-Delta gemessen, CLI wies nichts aus)
- Aufruf B (direkt, Reasoning-Kappe): **„[597 in / 700 out, davon 688 Reasoning, ~$0.0123]"** — nur Reasoning-Text
- Aufruf C (direkt, Reasoning aus): **„[finish=stop, 505 in / 568 out, ~$0.0100]"** — vollständige Antwort
- **Summe lt. Konto-Delta: 0,0611 $** (119,9151 → 119,9762). Alle 402er kostenlos. **Restguthaben: 0,0238 $ — das OpenRouter-Konto ist praktisch leer; weitere K3-Aufrufe erst nach Aufladung möglich.**

## Empfehlung an den Hauptagenten

1. **Ernst nehmen (konsistent in beiden K3-Pässen, plausibel gegen den Markt):** Das Pilot-Gate prüfen — M4-light (pvlib + einfache Amortisationsdarstellung, ohne volles Förder-Rechenwerk) vor den Pilot-*Start* ziehen oder parallel zur Pilot-Akquise bauen. Entscheidungshilfe: das Zielsegment des ersten Pilotkunden (Mikro-Installateur → Quick-Modus reicht laut K3s eigener Nuance).
2. **Streitpunkt 3 neu bewerten:** K3 verstärkt Richter 3 — mindestens der Nachtrags-/Änderungs-Workflow nach Signatur (Fork-UX, Preisdifferenz-Handling) sollte vor dem Piloten konzipiert sein, auch wenn kein volles Order-Modell kommt.
3. **Nicht übernehmen:** SPOF-Dramatisierung (Degradation ist geplant), Foto-LWW-Kritik (faktisch falsch), DSGVO-Punkt (wirr).
4. **Betrieblich:** OpenRouter-Guthaben aufladen, bevor die CLAUDE.md-Regel „K3 als Zweitblick" wieder greifen kann; erwägen, `/Users/mikailaslan/.claude/bin/k3` zu härten (Flag für `reasoning.enabled=false`/Budget-Kappe; Kostenausweis auch im length-Fehlerpfad — aktuell verschluckt der Exit-Pfad die Kosten des Fehlversuchs).

## Offen

- Die ungeprüften Risikofragen (better-auth-Reife, RLS-Performance bei Wachstum, Solo-Vertrieb) brauchen nach Guthaben-Aufladung eine echte High-Effort-Gegenprobe oder eine andere Zweitmeinung — die hier erzwungene No-Thinking-Antwort ersetzt sie nicht.
- K3s Selbstwiderspruch zum Tag-1-Stack (Overengineering vs. „Standard") ist unaufgelöst; mein Befund gegen den Text: Der Stack ist als Stunden-, nicht Wochen-Investition dimensioniert und im Plan gut begründet — ich sehe keinen Änderungsbedarf, markiere den Punkt aber als nicht unabhängig bestätigt.