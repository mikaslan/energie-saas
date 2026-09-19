# F4-03b — EV-Segmentfaktoren, Wallbox-Kappung, Intake-Widerspruch

Status: **SPECIFIED (RED, Tests geskippt)** · Lane: `codex/muse-fleet-3b-f4spec` · Stand 2026-09-19 (Spec + RED-Test `tests/unit/f403b-ev-wallbox.red.test.ts`, `describe.skip` bis zur Implementierung)

## Ziel und Abgrenzung

Die EV-Ladungsrechnung ist heute eine Pauschale: Jahres-km mal
`evKwhPerKm = 0.2` (`planning-assumptions-v2.ts`: „Midpoint",
Upgrade-Pfad benannt), geformt nach Ladepattern ohne jede
Leistungsgrenze. Die EV-Präsenz leitet der Rechner-Intake aus km > 0 ab
(`rechner-profile.ts:268-272`), ein Widerspruch gegen ein belegtes
`known_absent` passiert ungeprüft. Dieser Slice spezifiziert die
Zwischenstufe: Segmentfaktoren statt Einheitsfaktor, optionale
Wallbox-Kappung der EV-Slots und ein fail-expliciter
Intake-Widerspruchscheck. Keine neue Lane-Freigabe nötig (Folgeslice
zu F4-03).

## Evidenz und Näherungsstatus

- Modulkatalog `docs/blaupause/01-modulkatalog.md`: F4.3 verlangt die
  kuratierte EV-/WP-Hersteller-DB (dort als eigene Datenquelle, hier
  als Folgeslice abgegrenzt, s. „Bewusst offen").
- Kein Fahrzeugbeleg im Repo: Die Segmentfaktoren sind eine
  **reversible ESTIMATE-Näherung** (Version `wmee-ev-segment.v1`),
  kein behaupteter Flottenverbrauch. Der pauschale Default 0.2 bleibt
  bis zum Beleg bestehen (Pin-Test).
- Keine Wallbox-Belegleistung im Profil: Die Kappung ist eine
  **ESTIMATE-Näherung** (Default 11 kW, Haushaltswallbox); heute
  rechnen EV-Slots unbegrenzt weiter.

## Datenmodell (additiv, keine Migration)

`consumption.*` (alle optional, strictObject-kompatibel):

```text
evSegment: KnownOrUnknown                 # klein | mittel | gross (Fahrzeugklasse)
wallboxMaxKw: KnownOrUnknown              # Kappung je EV-Slot, kW, Bereich 1..43
evVehicleModel: KnownOrUnknown            # Freitext-Quelle (Modellname), max 120 Zeichen
```

- DB-CHECK bindet nur Top-Level-Keys → keine Migration; Änderung rein in
  Zod-Schemas (`contract.ts`, Fetch-`consumptionSchema`).
- Legacy ohne Segmentwerte rechnet byte-identisch weiter (Faktor 0.2,
  keine Kappung, SHA unverändert).

## Validierung (fail-closed, keine stillen Defaults)

- EV-km > 0 bei gleichzeitig `existingAssets.ev = known_absent` →
  Save/Compose verweigern (Widerspruch, keine stille Präzedenz).
- Segment belegt, aber km = 0 oder Pattern unbelegt → verweigern
  (kein erfundener Ladeplan).
- `wallboxMaxKw` außerhalb [1,43] kW → verweigern. `wallboxMaxKw`
  ohne EV-km → verweigern (keine wirkungslose Belegung).
- `evVehicleModel` ist reine Quellenangabe (Freitext): Sie löst
  keinen Faktor aus und ersetzt keinen Beleg; Segment bleibt
  Kundenwert oder ESTIMATE-Default.

## Berechnung (versioniert)

Neue Annahme `wmee-ev-segment.v1` (ESTIMATE, in Quell-SHA):

```text
Faktor(km):  klein 0.15 / mittel 0.18 / gross 0.22 kWh/km, sonst 0.2
annualKwh = evKm × Faktor(Segment)
Slot_kappt = min(Slot, wallboxMaxKw × 0.25)   # Viertelstunden-Energie
```

- `[ESTIMATE]` Segmentfaktoren (klein 0.15 / mittel 0.18 /
  groß 0.22 kWh/km): Näherung ohne Flottenbeleg; Default 0.2 gilt,
  solange kein Segment belegt ist.
- `[ESTIMATE]` Wallbox-Kappung (Default 11 kW): Kappung je
  Viertelstunden-Slot auf `wallboxMaxKw × 0.25` kWh; die entnommene
  Energie wird nicht umverteilt (Mindermenge sichtbar, kein stilles
  Nachladen). Heute: keine Kappung (`wallboxMaxKw` unbelegt).
- Pattern-Form (`evening`/`daytime`/`away`) bleibt belegt wie bisher;
  unbekanntes Pattern bei EV-km > 0 bricht fail-closed ab.
- Provenienz: `sourceId`, `sourceRevision`, `sourceSha256` über
  (km, Segment, Faktor, Pattern, wallboxMaxKw, Annahmenversion).

## Intake

- Editor: optionale Fahrzeugklasse (klein/mittel/groß) plus optionales
  Modell-Freitextfeld beim E-Auto-Eintrag; Wallbox-Maximalleistung als
  optionales kW-Feld (Default-Vorschlag 11, kein stiller Wert).
- Rechner-Intake (`rechner-profile.ts`): EV-Präsenz weiter aus km > 0;
  zusätzlich Widerspruchs-Check gegen belegtes `known_absent`
  (fail-explicit, s. Validierung). Fahrzeugmodell-Quelle wird als
  `customer_input` übernommen, löst aber keinen Faktor aus.

## Wärmepumpe (Pin, keine Änderung)

- Die generische COP-Kennlinie (`wmee-heat-pump-cop.v1`, ESTIMATE)
  bleibt gepinnt; Herstellerkurven erst mit F5.4 (eigene Datenquelle).
- Bivalenz bleibt Rechen-Schalter mit Default −6 °C.
- WW-Split-Default 0 bleibt: Default rechnet byte-identisch zum
  expliziten Wert (Pin-Test: Slots + SHA gleich).

## Anzeige

Keine neuen Blöcke: Jahres-/Monatswerte zeigen Kettenergebnisse;
Provenienz nennt EV-Segment- oder Wallbox-Quelle. Editor: drei
optionale EV-Felder plus Widerspruchshinweis (km vs. known_absent).

## ROT-Beleg (RED-Test vor dem Skip, 2026-09-19)

`npx vitest run tests/unit/f403b-ev-wallbox.red.test.ts` → 3 failed,
2 passed (Pins grün):

```text
× bietet Segmentfaktoren klein/mittel/gross als ESTIMATE an
  AssertionError: expected undefined to deeply equal
  { small: 0.15, medium: 0.18, …(1) }
× kappt EV-Slots auf wallboxMaxKw (Default 11 kW)
  AssertionError: expected 4.307745326096321 to be less than or
  equal to 2.75
× verweigert km > 0 bei gleichzeitig known_absent (fail-explicit)
  AssertionError: expected true to be false // Object.is equality
✓ pinnt den pauschalen Default 0.2 kWh/km bis zum Beleg
✓ rechnet WW-Split-Default 0 byte-identisch zum expliziten Wert
```

## Akzeptanz

- Unit: Segmentfaktor-Auflösung (drei Klassen + Default 0.2),
  Wallbox-Kappung (Slots ≤ max × 0.25, Mindermenge sichtbar),
  Widerspruchs-Matrix (km > 0 × known_absent fail-closed),
  WW-Split-Default byte-identisch, Nullreihe.
- Compose-Unit: Segment→Faktor-Pfad, Legacy-Pfad byte-identisch,
  Kappung in SHA sichtbar.
- Actions-Unit: Bereichs-/Widerspruchsvalidierung.
- E2E: Editor speichert Segment + Wallbox als known-Profil; Kette
  bis currentV2 mit gekapptem EV-Anteil, Monatstabelle sichtbar,
  Axe sauber.
- Gates: lint/typecheck/test/build + CI grün; RED-Skip in dieser
  Spec auflösen (Follow-up entfernt `describe.skip`).

## Bewusst offen

- Kuratierte EV-DB (Fahrzeugmodell → Verbrauch): nur mit lizenzierter
  Quelle (WLTP-/ADAC-Extrakt), kein Scraping; eigener Folgeslice.
- WP-Herstellerkurven (F5.4, eigene Datenquelle).
- Lastverschiebung statt Kappung (intelligentes Laden, F4.4).
- Bidirektionales Laden (weiter `bidirectional_charging_not_modeled`).
