# Discovery-Brief: Rechner als direkte Leadquelle anbinden (v5/v6 → energie-saas)

Status: DISCOVERED (2026-09-04) · Anfrage Mikail: „Rechner v6 direkt als
Leadquelle anbinden, wenn es nicht zu viel Aufwand ist".

## Ist-Zustand (belegt)

- energie-saas besitzt die verifizierte Intake-Grenze
  `POST /api/inbound/rechner/v1` (HMAC, Key-ID + Secret, E2E-getestet).
- Der Intake-Vertrag `RechnerIntakeV1` verlangt: Producer (application
  **fest `"wmee-rechner-v3"`**), Acquisition/UTM, Customer, Privacy,
  **Site (Adresse + lat/lng + Präzision)**, **Calculation-Snapshot**
  (branch, questionnaireVariant, inputs, provenance, resultIntegrity).
- Der v5-Rechner (Worktree `~/Projects/webseiten/wmee-rechner-v5`, Branch
  `rechner/v5`, HEAD `2283c2d` mit v5-P0) besitzt ALLE Fachdaten im
  Frontend-State (Adresse, PVGIS, Anlage, Verbrauch, Wirtschaftlichkeit)
  — flacht sie aber derzeit in eine **Text-Mail** über `/api/contact`
  (Resend) ab. Strukturierter Post an Dritte existiert nicht.
- **v6 existiert als Code noch nicht** (Plan: eigener Rechner auf
  v5-Basis, M6).

## Optionen

| # | Option | Aufwand (ESTIMATE) | Bewertung |
|---|---|---|---|
| A | **Lead-only-Fan-out:** energie-saas-Intake um eine „Kontakt-Lead"-Variante erweitern (Calculation/Site optional, producer-Enum + `wmee-rechner-v5`), v5-`/api/contact` postet zusätzlich strukturiert (HMAC) — Mail-Flow bleibt unverändert | mittel (1 Slice saas + kleiner v5-Patch) | schneller Effekt; Leads landen als unqualifizierte Anfragen im Board; Adresse/Berechnung fehlen |
| B | **Voller Snapshot:** v5-Ergebnis-State vollständig auf `RechnerIntakeV1` mappen (Calculation-Snapshot aus ergebnis/PVGIS/Verbrauch), saas akzeptiert `wmee-rechner-v5` als Producer | hoch (2 Slices: Vertragserweiterung + v5-Mapping mit Tests) | volle Parität: Lead MIT Adresse + Berechnung wie beim v3-Flow |
| C | **Auf v6 verschieben:** v6 (eigener Rechner, M6) nativ gegen die Intake-Grenze bauen; v5 bleibt beim Mail-Flow | null jetzt, entfällt später doppelt | sauberste Architektur (ein Producer, kein Dual-Mapping-Pflegeaufwand); kein Effekt vor M6 |

## Empfehlung (Root-Integrator)

**C für jetzt, A als schnellste Zwischenlösung falls gewünscht.** B lohnt
erst, wenn v6 gebaut wird (dort nativ, dann ohne v5-Doppelpflege). A
wäre ein kleiner vertikaler Slice mit echtem Nutzen (jede
Rechner-Anfrage = Lead im Board) — Aufwand ca. ein Slice.

## Fragen an Mikail

1. A, B oder C? (Empfehlung: C; wenn sofort Leads: A)
2. Bei A: dürfen Kontaktformular-Leads ohne Adresse als „unqualifizierte
   Anfrage" ins Board (regionale Schätzung = Regional-Default,
   Berechnung leer)?
3. Producer-Name im Intake: `wmee-rechner-v5`/`v6` akzeptieren (Enum-
   Erweiterung) — okay?
