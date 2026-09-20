# F5-02 Heizlast-Methoden (Katalog F5.1, SPECIFIED)

Ziel: Methoden-Katalog der Heizlastverfahren je Energieprofil — Abgrenzung,
Reihenfolge und Norm-Disziplin. Rein SPECIFIED (Schnittstellen festgelegt,
nichts gebaut), lesend gedacht, keine Editierung, keine neue Permission,
keine Schemaänderung, keine Migration.

## ESTIMATE-Disziplin (Regel: Norm nie aus Optik)

- Alles Unbelegte ist **ESTIMATE** und trägt eine offene Q-Referenz
  (Q-F5-02-…); kein Norm-Label (DIN EN 12831, TABULA, VDI) ohne belegte
  Normgrundlage. Optik begründet keine Norm: Tabellenform,
  Nachkommastellen und Norm-Vokabular allein machen kein Verfahren
  zur Normrechnung.
- DIN-Negativ-Disclaimer: Jedes Verfahren unterhalb von Roomwise-Stufe B
  ist eine **Schätzung** und ersetzt keine Heizlastberechnung nach
  DIN EN 12831 (zertifizierte Normrechnung). Die UI trägt diesen Hinweis
  direkt an der Zahl (kein Kleingedrucktes anderswo) — wie F5-01.
- Fail-closed: ohne belegte Eingaben keine Zahl — kein 0-kW-Ergebnis,
  keine stillen Defaults (Baujahr, Wohnfläche, U-Wert je explizit).

## §1 Methoden-Abgrenzung

1. **Simple Simulation** = Hüllflächen-Schnellverfahren aus Baujahr +
   Wohnfläche. SPECIFIED: Eingaben (Baujahr, Wohnfläche) und Ergebnis
   (Heizlast-ESTIMATE) sind festgelegt, der Builder ist nicht gebaut.
2. **Heat-Load-Indication** = Baujahr-U-Wert-Mapping plus vorhandener
   Energieprofil-Kontext (thermischer Jahresbedarf, Gebäudeklasse aus
   dem F5-01-Umfeld). Rein lesend aus gespeicherten Profildaten.
3. **Room-by-room nach DIN EN 12831** in zwei Stufen:
   - **Stufe A**: DIN-angelehnte Schätzung (ESTIMATE, kein Normanspruch,
     DIN-Negativ-Disclaimer wie oben).
   - **Stufe B**: zertifizierte Normrechnung — erst mit **Normkauf-Gate**
     (Norm lizenziert vorliegend, Gate-Export belegt den Kauf); ohne
     Gate keine Stufe-B-Bezeichnung, kein DIN-Label.

## §2 Reihenfolge (Indication → Simple → Roomwise)

1. **Indication zuerst**: nutzt nur vorhandene Profildaten (Bedarf,
   Klasse) plus Baujahr-U-Wert-Mapping — kleinster Eingriff, sofort
   lesend, keine neue Eingabe.
2. **Simple danach**: braucht zusätzlich nur Baujahr + Wohnfläche —
   eine neue Eingabe, grobe Hülle, immer noch Schnellverfahren.
3. **Roomwise zuletzt**: braucht raumweise Geometrie und die
   Normgrundlage — teuerster Eingriff (Eingaben + Normkauf erst
   für Stufe B, §4).

## §3 F5-01-Abgrenzung

F5-01 (`sizing-estimate-v1`: Bedarf ÷ Volllaststunden) bleibt
**Orientierungswert** und wird NICHT als Simple Simulation
umetikettiert. Simple ist ein eigenes Verfahren (Hüllfläche aus
Baujahr + Wohnfläche, §1), F5-01 bleibt daneben bestehen; ein
künftiger Simple-Builder braucht einen eigenen Export, kein
stilles F5-01-Relabel (RED-Test 3).

## §4 U-Wert-Seed

- TABULA-artige **öffentliche** Werte als ESTIMATE-Seed: unbelegt wie
  alles unter §1–§3, daher ESTIMATE plus Q-Referenz je Wert.
- **Quellenregister**: Quelle, Stand und Zugriffsdatum je Seed-Wert,
  versioniert ablegbar (Q-F5-02-U-Wert-Quellenregister).
- **Normkauf erst für Stufe B**: Die lizenzierte Norm wird erst
  gekauft, wenn Roomwise-Stufe B gebaut wird; bis dahin kein
  DIN-Label, kein Norm-Export, nur ESTIMATE-Seed.

## §5 Nummernglossar (nicht verwechseln)

- **F5-02 … F5-07 (dieser Katalog)** = Wärmepumpe/Heizlast
  (F5-02 Methoden, Folgeslices im selben Lane).
- **F5-01-skonto / F5-02-rechnungsdetail** (`F5-01-skonto.md`,
  `F5-02-rechnungsdetail.md`) = fachlich **F8** (Rechnung/Skonto),
  historische Lane-Labels aus Wave-02 — nicht mit den
  Wärmepumpen-Slices F5-01/F5-02 verwechseln.

## ROT-Beleg (RED-Test)

Auszug aus `npx vitest run tests/unit/f502-methoden.red.test.ts`
(alle 4 Tests rot, NUR existierende Imports):

```text
FAIL Indication-Builder existiert (heat-load-indication-v1)
FAIL U-Wert-Lookup nach Baujahr ist exportiert
FAIL Simple-Abgrenzung ist exportiert (kein stilles F5-01-Relabel)
FAIL Roomwise-Stufe-B-Gate existiert (Normkauf-Gate)
Test Files  1 failed (1)
     Tests  4 failed (4)
```

Danach `describe.skip` bis zur Umsetzung (SKIP-Grund im Testkopf:
SPECIFIED, nicht implementiert — Ref §1/§4).

## Scopes

1. Diese Spec + RED-Test `tests/unit/f502-methoden.red.test.ts`
   (4 Tests, danach `describe.skip` bis zur Umsetzung).
2. Offen (eigene Bau-Slices): Indication-Builder, U-Wert-Seed +
   Quellenregister, Simple-Builder, Roomwise-Stufen-Gate.
