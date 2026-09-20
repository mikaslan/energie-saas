# F5-07 Förder-Berichte (Katalog F5.6, SPECIFIED)

Ziel: BEG/GEG/KfW-orientierte Berichte je Projekt aus gespeicherten
Planungsdaten — Förder-Schätzkarte (30 % Basis + Boni, Deckel 70/80 %,
WE-Staffel) als Angebotsbeilage. Rein SPECIFIED (Schnittstellen
festgelegt, nichts gebaut): reiner Read-only-Builder ohne Persistenz,
ohne neue Permission, ohne Schemaänderung, keine Migration.

Stil-/Muster-Referenz: F5-01 (`sizing-estimate-v1`, reiner Builder,
versionierte ESTIMATE-Konstanten, Fail-closed, Hinweis direkt an der
Zahl). Zahlen-Referenz: `docs/blaupause/03-integrationskarte.md:45`
(KfW 458: 30 % Grund + Klimabonus + Einkommensbonus, Deckel 70/80 %,
förderfähige Kosten 28 T€ EFH).

## §1 Berichtstypen (Slice 1)

- Schätzkarte als Angebotsbeilage (ESTIMATE): Fördersatz-Schätzung aus
  Regelsatz f56-458.v1 (§2) × WE-Staffel (§3), mit Stichtag,
  Regelversion und Disclaimer direkt an der Zahl (§5).
- Heizlast-Kurzbericht: F5-01-Zahl (Heizlast + Empfehlung) als Beilage
  wiederverwendet, kein zweites Rechenverfahren.
- Wort-Disziplin in allen Artefakten: Das Wort „konform" ist VERBOTEN
  (Zusicherungs-Wortlaut). Zulässig: „BEG-orientiert" und
  „unverbindliche Schätzung". Jeder Verstoß ist ein Spec-Bruch.

## §2 Regelsatz f56-458.v1 (ESTIMATE, versioniert)

- 30 % Basis; Klimabonus zum Stichtag (Höhe nur aus der versionierten
  ESTIMATE-Tabelle, nie aus Tageswissen); Einkommensbonus nur als
  Bis-zu-Bandbreite („bis zu X %", kein Punktwert ohne Beleg).
- Deckel: 70 % Default; 80 % nur mit explizitem Opt-in-Flag am
  Builder-Aufruf (kein stiller 80-%-Pfad).
- Die Tabelle ist handgepflegt (Integrationskarte: „handgepflegtes
  Regelwerk") und trägt Stichtag + Regelversion `f56-458.v1` in
  jedem Output. Unbelegte Felder → fail-closed (kein Satz, kein
  Raten), analog F5-01.
- Karten-Vertrag (Schwester-Arbeitsstand, untracked):
  `contracts/subsidy-estimate-card.v1.schema.json`
  (`contractVersion` + `ruleVersion: f56-458.v1`, `capPct` ∈ {70, 80}).

## §3 WE-Staffel (nur EFH belegt)

- Belegt ist nur: EFH (WE = 1), förderfähige Kosten 28 T€.
- WE ≠ 1 (auch WE = 0, negativ, nicht-ganzzahlig, unbekannt) ist
  fail-closed: Fehler statt Rate — kein hochgerechneter Satz, kein
  stiller EFH-Fallback. Guard am Builder-Eingang (vgl. F5-01
  Gebäudeklassen-Guard).
- Jede weitere WE-Stufe braucht einen eigenen belegten Spec-Satz;
  bis dahin bleibt die Staffel einspaltig (EFH).

## §4 F5/F13-Schnitt

- F5.6 ist ein reiner Read-only-Builder ohne Persistenz und ohne
  eigene Permission — wie F5-01 (`sizing-estimate-v1`: Eingaben →
  Zahl + Disclaimer, kein I/O). Umsetzungsziel:
  `lib/integrations/subsidies/subsidy-estimate-v1.ts`.
- Output fließt als vorausgefüllter Vorschlag in die F13-03-Akte
  (Förderakte, BzA→BnD-Maschine); die Akte bleibt schreibführend
  für Programm/BzA-Nummer/Status.
- F13-08 (Programm-Heuristik `f13-08-suggest.v1`) und F5.6
  (`f56-458.v1`) sind zwei getrennte versionierte Blöcke in der
  Akte: Vorschlagstext + je eigene Regelversion, kein
  Misch-Block, keine geteilte Versionsnummer.
- Zur Angebotsbindung trifft diese Spec keine Aussage — Verweis:
  Q-F13-ANGEBOTSBINDUNG-M2 (F13-08 §3: `offer.status` kennt nur
  `draft`, kein verbindlicher Zustand).

## §5 Disclaimer-Text (Wortlaut-Vorschlag, Haftungsarchitektur)

- Wortlaut-Vorschlag (an jeder Zahl, kein Kleingedrucktes anderswo):
  „Unverbindliche Schätzung (BEG-orientiert, Regelsatz f56-458.v1,
  Stichtag TT.MM.JJJJ) — keine Förderzusage, kein Ersatz für die
  KfW/BAFA-Regelwerke und keine Rechtsberatung. Maßgeblich sind
  allein die Programmbedingungen zum Antragszeitpunkt."
- Haftungsarchitektur: Schätzung statt Zusage (drei Schichten:
  Artefakt-Disclaimer + Regelversion/Stichtag als Provenienz +
  fail-closed bei unbelegten Eingaben). Kein Satz ohne alle drei.

## §6 Zeitscheiben (Folgeslice)

- Stichtags-/Gültigkeitsmodell: Jede Schätzkarte trägt Stichtag und
  Regelversion; alte Karten bleiben mit ihrer Version lesbar
  (keine stille Neuberechnung nach Regelwechsel).
- Redaktions-Prozess (Tariftabelle mit Gültigkeitszeiträumen,
  Degressions-/Bonus-Historie, Review-Pflicht vor Regelwechsel)
  ist ein Folgeslice — diese Spec normiert nur, dass der Prozess
  existiert, bevor eine zweite Regelversion (`f56-458.v2`) landet.

## Scopes (Umsetzung, nicht dieser Slice)

1. Builder `subsidy-estimate-v1` (Eingaben → Schätzkarte +
   Disclaimer, Guards, keine I/O, keine Permission).
2. Angebotsbeilage (Schätzkarte + Heizlast-Kurzbericht aus F5-01).
3. Vorausgefüllter Vorschlag in der F13-03-Akte (Lesepfad,
   Übernahme nur mit bestehendem Schreibrecht).

## RED-Beleg (2026-09-20, 5/5 ROT)

`node_modules/.bin/vitest run tests/unit/f507-berichte.red.test.ts`
(nur existierende Imports; danach `describe.skip`):

- FAIL Schätzkarte-Builder existiert (Read-only, Muster F5-01)
- FAIL 458-Regelsatz f56-458.v1 ist als ESTIMATE-Tabelle gepinnt
- FAIL WE-Staffel: nur EFH belegt, WE≠1 fail-closed (Guard exportiert)
- FAIL Deckel-Default 70 %, 80 % nur per Opt-in-Flag
- FAIL Disclaimer-Export ohne Zusicherungs-Wortlaut (unverbindliche Schätzung)
- `Test Files 1 failed (1)` · `Tests 5 failed (5)`

Ref-Test: `tests/unit/f507-berichte.red.test.ts` (skip bis Umsetzung).
