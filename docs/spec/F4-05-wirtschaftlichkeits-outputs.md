# F4.5 — Wirtschaftlichkeits-Outputs (KPIs, Cashflow, Vergütungs-Kaskade)

Status: **SPECIFIED (Draft) — Implementierung wartet auf ADR 0026
(Rechenkern-Entscheid) + Mikail-Antworten UNK-F4-01/03/04/05** ·
Basis: `codex/m1-wave-02` `75cf00e` · Migration: eigene, erst nach
CONTRACTED (Vorschlag `0049`, nach M1-15b `0048`).

## 1. Zweck (Modulkatalog F4.5)

„Outputs: Ertrag, Autarkie, Eigenverbrauchsquote, Sankey-Energiefluss,
Amortisation/IRR/Break-even, 20-Jahres-Cashflow (Horizont einstellbar),
Einspeisevergütungs-Kaskade (Override > Post-EEG > Länderdefault)" —
laut Modulkatalog läuft die Simulation automatisch bei jeder Änderung
(kein Button); hier nur die OUTPUT-Seite (Rechenkern F4.1–F4.4 =
Vorgänger-Slices, Eingänge siehe §3).

## 2. Umfang (nur Outputs + Kaskade)

- **KPI-Vertrag — je Punkt getaggt (Kimi-P2-1); exakte Reonic-Formeln
  UNKNOWN (UNK-F4-01):**
  - Quoten-Division durch Null (DECIDED, Kimi-P2-2): Nenner 0 (kein
    Verbrauch / keine Erzeugung) → KPI null + `valid: false`-Flag,
    kein Fehler.
  - `ertrag_kwh_jahr` (Jahresertrag, aus Kern; ESTIMATE: Kern-Wert)
  - `autarkie_pct` = Eigenverbrauch / Gesamtverbrauch (DECIDED-Formel,
    ESTIMATE ggü. Reonic)
  - `eigenverbrauchsquote_pct` = Eigenverbrauch / Erzeugung (DECIDED-
    Formel, ESTIMATE ggü. Reonic)
  - `amortisations_jahre` (statisch, KIMI-P1-2: interpolierter
    Jahresbruchteil — linear zwischen dem letzten negativen und dem
    ersten nicht-negativen kumulierten Jahreswert; null, wenn nie)
  - `irr_pct` (interner Zinsfuß der Cashflow-Reihe; Konventionen
    Kimi-P2-3: nominal, vor Steuern, Investition bei t₀; kein
    Vorzeichenwechsel → null; MEHRERE Vorzeichenwechsel (Kimi-P2-1,
    z. B. Zusatzinvestition): niedrigste positive Lösung im
    Intervall [-100 %, +100 %], sonst null)
  - `break_even_jahr` (ganzzahliges erstes Jahr mit kumuliertem
    Cashflow ≥ 0; null, wenn nie)
  - `cashflow_series` (Reihe mit `horizon_years` im Snapshot gepinnt;
    Horizont einstellbar, Default aus F4.6; FALLBACK 20 Jahre laut
    Katalog, falls F4.6 leer — Kimi-P2-2/P2-5)
  - Sankey-Energiefluss (Verbrauch/Eigenverbrauch/Netzbezug/Einspeisung/
    Verluste) — Datenstruktur, kein Render-Contract; ERHALTUNGSINVARIANTE
    (DECIDED, Kimi-P3-5): Erzeugung = Eigenverbrauch + Einspeisung +
    Verluste — in F405-UNIT-01 geprüft
- **Einspeisevergütungs-Kaskade:** Der Katalog nennt NUR die Priorität
  `Override > Post-EEG > Länderdefault` — die Zeitachse ist eine
  **INTERPRETATION (Kimi-P1-1/UNK-F4-01-Erweiterung, Mikail-Bestätigung
  angefordert)**:
  - Priorität pro Jahr: Override > (Post-EEG | EEG-/Länderwert)
  - INTERPRETATION: Jahr 1–20 EEG-/Länderwert, ab Jahr 21 Post-EEG
    (EEG-Laufzeit ~20 J. — Katalog nennt keine Zeitbedingung)
  - Post-EEG-Wert = **0** (ESTIMATE), sofern kein Länderwert aus dem
    F4.6-Länderreferenz-Folgeslice existiert
  - Länderdefault (UNK-F4-03: Datenquelle/echte Werte = Mikail;
    bis dahin nullable, F4.6-Länderreferenz-Folgeslice)
- **Automatik:** Berechnungsauslösung bei Änderungen = F4.1-Slice
  (Non-Goal hier); F4.5 definiert nur den Output-/Snapshot-Vertrag.
- **Immutable Snapshot:** Ergebnis je Berechnungslauf mit Input-Pin
  (M1-07-Muster) — Angebote referenzieren den Snapshot, keine
  Nachberechnung.

## 3. Eingänge (aus Vorgänger-Slices)

- M1-07 Energieprofil (Raster, Verbrauch, PV-Anlage) — autoritative Basis.
- F4.6 Workspace-Defaults (Strompreis, Eskalation, Öl/Gas, Horizont) —
  nullable = Länderreferenz. Eskalations-Indexierung (Kimi-P2-3):
  Input-Aufbereitungsregel, Owner = Rechenkern/F4.6 — hier nur
  dokumentiert (ESTIMATE: jährlich indexierend ab Jahr 2, Jahr 1 =
  F4.6-Basis); verbindlich im ADR-0026-Schließungspfad.
- F4.2/F4.3/F4.4 (Lastprofile, Zusatzlasten, Speicher) — Folgeslices,
  im KPI-Vertrag als optionale Eingangsblöcke vorgesehen.
- Angebot/BOM (M2-01) — Kostenbasis für Amortisation/IRR.

## 4. Nichtziele

- Rechenkern F4.1–F4.4 (eigene Slices, nach ADR 0026).
- **UI-Scope (Kimi-P1-1, DECIDED):** F4.5 IST der Output-Slice — der
  Ergebnis-Bereich (KPI-Karten, Cashflow-Tabelle, Horizont-Einstellung,
  Kaskaden-Anzeige) gehört zum Slice inkl. `F405-E2E-01`. Nichtziel ist
  nur das *grafische* Sankey-Rendering (SVG-Diagramm) — der
  Sankey-DATENvertrag (§2) gehört zu F4.5.
- TOU/dynamische Tarife & Arbitrage (UNK-F4-04, Mikail-Entscheid).
- Länderreferenz-Datentabelle (F4.6-Folgeslice, UNK-F4-03).

## 5. Testmatrix (nach CONTRACTED)

**Abhängigkeit (Kimi-P2-3):** `F405-E2E-01` („Horizont-Änderung aus F4.6
wirkt") läuft erst, wenn F4.6-Referenz/Settings vorhanden sind — F4.6
(0047) ist bereits integriert; die Länderreferenz bleibt Folgeslice,
bis dahin gilt der 20-Jahre-Fallback.

| Kürzel | Prüfung |
|---|---|
| `F405-UNIT-01` | KPI-Berechnung gegen gepinnte Beispielfälle (Amortisation, IRR, Break-even, Quoten) |
| `F405-GOLD-01` | Regression gegen WMEE-Referenzergebnisse (Goldwerte, ESTIMATE-Basis) — verankert die ADR-0026-Drift-Gegenmaßnahme im Slice (Kimi-P2-2); Herkunft je Wert im SOURCE-REGISTER |
| `F405-UNIT-02` | Kaskade: Priorität Override > Post-EEG > Länderdefault je Jahr; Override in beiden Regimen, EEG→Post-EEG-Übergang (Jahr 20→21), Post-EEG=0-Fallback |
| `F405-DB-01` | Snapshot immutable + Input-Pin; RLS/RBAC (economics.read) |
| `F405-E2E-01` | Ergebnis-Bereich zeigt KPIs; Horizont-Änderung aus F4.6 wirkt; A11y |

Rollenprobe 88/88, PG18 5/5, Build, Drift, Kimi SPEC+CODE vor VERIFIED.

## 6. DECIDED / UNKNOWN

SPECIFIED-ESTIMATE (ausstehend: ADR 0026 / Mikail; Kimi-P3-1): KPI-
Formelsätze §2 (Amortisation interpoliert, IRR nominal/vor Steuern/t₀,
Break-even ganzzahlig, Quoten-Definitionen mit Null-Nenner-Semantik); Kaskaden-Reihenfolge
zeitkonditional laut Modulkatalog; Snapshot-Muster M1-07. Alle
formelbezogenen Punkte bleiben ESTIMATE/UNKNOWN, solange ADR 0026
(Rechenkern) offen ist — Verweis wie im ADR gefordert (Kimi-P2-4).
UNKNOWN (Mikail): exakte Reonic-Formeln/Reihenfolge (UNK-F4-01),
Rechenkern-Quelle (UNK-F4-02 → ADR 0026), echte Preis-/Länderwerte
(UNK-F4-03), TOU-Umfang (UNK-F4-04), Cashflow-Detail-Defaults (UNK-F4-05).
