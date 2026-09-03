# ADR 0026 — F4-Rechenkern (Wirtschaftlichkeit): Quellen-Entscheid

Status: **DRAFT (Mikail-Entscheid offen, UNK-F4-02)** · 2026-09-04
Kontext: F4.5-Outputs brauchen EINEN deterministischen Rechenkern;
PLAN-LIZENZ-MODUS §9 verbietet doppelte Wahrheiten (kein zweiter Kern
neben dem M1-07-Kern ohne ADR).

## Kontext

- M1-07 (0036) besitzt einen gepinnten, deterministischen Clean-Room-Kern
  für die Planungsschätzung (15-Minuten-Raster-Vorbereitung, Muneer-
  Referenzvalidierung als Folge-Gate, immutable Snapshots).
- WMEE `src/lib/solar/wirtschaftlichkeit` (v5/v6) existiert und ist
  durch den Lizenz-Modus (docs/legal/LICENSE-GRANT.md) rechtlich
  übernehmbar — inhaltlich/qualitativ nicht auditierte Übernahme.
- F4.1–F4.4 (Raster, Lastprofile, Zusatzlasten, Speicher) sind die
  Eingangsseite, F4.5 (KPIs/Outputs) die Ausgangsseite desselben Kerns.

## Optionen

| # | Option | Vorteile | Risiken |
|---|---|---|---|
| A | WMEE-Kern v5/v6 als zweiter Kern übernehmen (Port + ADR-Doku) | Zeitgewinn | fremde Architektur ungeprüft; **Double-Truth mit M1-07** (durch diesen ADR sanktionierbar, aber nicht empfohlen) |
| A′ | WMEE-Kern ersetzt M1-07 vollständig | keine Double-Truth | verliert die verifizierte M1-07-Kette (Snapshots, Erasure, RLS, PVGIS-/Muneer-Referenz); Großumbau; ungeprüfter Kern wird Kern des Produkts — nicht empfohlen |
| B | M1-07-Kern erweitern (eigener deterministischer Kern) | eine Wahrheit, bestehende Gates/Snapshots/Erasure-Kette | Aufwand F4.1–F4.4 neu; PVGIS-Validierungsnachweis nötig |
| C1 | Hybrid, lizenzbasierter Port: M1-07 als Rasterbasis, F4-Formelsätze aus WMEE per LICENSE-GRANT übernommen + auditiert | Zeitgewinn bei Formeln | Übernahme-Audit nötig; Doppelquelle im Review |
| C2 | Hybrid, Clean-Room-Nachbau: M1-07 als Rasterbasis, F4-Formelsätze nachgebaut (Kimi-P1-1) | rechte-sauber, eine Wahrheit fürs Raster | Aufwand; Formel-Parität nur als Ziel mit Nachweispflicht |

**Hinweis (Kimi-P1-2):** „Formel-Parität zu WMEE" ist in KEINER Option
eine Eigenschaft, sondern ein Ziel mit Nachweispflicht (Goldwerte-/
Regressionstests gegen WMEE-Referenzergebnisse als ESTIMATE-Basis).

**Verifikationspfad gilt für ALLE Optionen (Kimi-P1-4):**
PVGIS-/Muneer-Referenzvalidierung + gepinnte Formelversion + Regression
gegen Goldwerte — im Source-Register vermerkt.

## Empfehlung (Root-Integrator)

**Option C2 (Hybrid, Clean-Room-Nachbau)** — M1-07 bleibt die
autoritative Raster-/Profil-Basis; die F4-Formelsätze (Last→Batterie→
Einspeisung, KPIs, Cashflow) werden als eigener, getesteter Modul-Satz
nachgebaut und über eine Adapter-Schicht an die M1-07-Snapshots
angebunden. **C1 (Port) bleibt Fallback**, falls Mikail die
Lizenz-Übernahme der Formeln bevorzugt (dann mit Übernahme-Audit).

## Entscheidung

- [ ] **Mikail:** A / A′ / B / C1 / C2 / anders.
- Bis zur Entscheidung bleibt F4.5 SPECIFIED (nicht CONTRACTED); die
  Spec markiert alle formelbezogenen Punkte als ESTIMATE/UNKNOWN
  (Verweis steht in der Spec selbst, Kimi-P2-4).

## Konsequenzen / Schließungspfad (Kimi-P2-1)

- Nach Entscheidung: F4.5 CONTRACTED; Kern-Wahl + Formelversion in
  Source-Register und CAPABILITY-MATRIX.
- Audit-Owner: Root-Integrator; Drift-Gegenmaßnahme (Kimi-P2-2):
  gepinnte Formel-Version + Regressionstests gegen WMEE-Goldwerte
  (ESTIMATE-Basis) je Release.
- Follow-up: Mikail-Entscheid wird bei jedem Statusbericht mitgeführt,
  bis UNK-F4-02 geschlossen ist.
