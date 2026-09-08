# Codex-Review-Handoff — F4.1 Viertelstunden-Simulation

Stand: 2026-09-08 (lebend; finaler Uebergabe-Commit + CI-Run werden bei der
Gesamtuebergabe eingetragen). Kanonische Abnahmequelle bleibt
`docs/blaupause/01-modulkatalog.md`; Bereichsstatus in
`docs/parity/STATUS.md`; Testbelege in `docs/parity/TEST-EVIDENCE.md`.
Dieses Dokument deckt nur den F4.1-Arbeitsstand 2026-09-08 ab, nicht die
Gesamt-F1–F16-Uebergabe (diese folgt nach Muses Fertigmeldung).

## Audit-Anker (bei Uebergabe zu fuellen)

- Repo: `/Users/mikailaslan/Projects/energie-saas-parity`, Branch `codex/m1-wave-02`
- Letzter gepushter Stand: `b8bc549` (enthaelt den gesamten F4.1-Stack ab
  `8313e49`; CI-Run `34253965383` laeuft)
- Richtigstellung: „UNPUSHED"-Vermerke in Commit-Messages und frueheren
  Doc-Staenden sind ueberholt — der Sammel-Push `6b1e559..b8bc549` hat den
  Stack vollstaendig uebertragen. History wird nicht umgeschrieben.
- Uebergabe-Commit: TBD (separat bei Gesamtuebergabe)
- CI-Run zum Uebergabe-Commit: TBD
- Spec: `docs/spec/F4-01-viertelstunden-simulation.md` (SPECIFIED)

## Geliefert (implementiert + lokal verifiziert, Tests gruen)

| Stueck | Dateien | Beleg |
|---|---|---|
| F4.1A Engine (Achse, Rekonstruktion, Dispatch, zykl. SoC) | `lib/integrations/calculation/engine-v2.ts`, `versions-v2.ts` | `f401-quarter-hour-dispatch` 13/13; Blob-SHA-Freeze-Test |
| F4.1B Hay-Kern (Branches 1–5, Gates) | `hay-v2.ts` | `f401b-hay-transposition` 13 + f401-Speicher 15 |
| 0078 v2-Tupel-Checks | `drizzle/0078_*`, `f401-calculation-v2-tuple` | 5/5 DB |
| v2-Vertraege + Preparation + Prepare | `contract-v2.ts`, `preparation-v2.ts`, `prepare-v2.ts` | Contract 6 + Prepare-TDD |
| v2-Run/Finalize | `run-v2.ts`, `validate-result-v2.ts` | `f401-run-v2` 5/5 (Fixpunkt, Bilanzen, Fail-closed, Sha-Bindung) |
| v2-Achse | `axis-v2.ts` | `f401-axis-v2` 4/4 (Feb29-Drop, Labels, Auswertezeitpunkte) |
| v2-Provider (Queries, Parser) | `provider-v2.ts`, `horizon-v2.ts`, `pvcalc-v2.ts` | `f401-provider-v2` 8/8, `f401-horizon-pvcalc-v2` 6/6 (inkl. ECHTE Berlin-PVcalc-Response) |
| v2-Lastprofil + Kettenschluss | `load-v2.ts` | `f401-load-v2` 4/4 (Profil→Run→Finalize exakt) |
| AC-Skalierung (E_y-Gate) | `ac-scale-v2.ts` | `f401-ac-scale-v2` 3/3 (Berlin 1041.3→1006.46) |
| Leistungsverteilung P_q/E_pv,q | `p-distribute-v2.ts` | `f401-p-distribute-v2` 4/4 |
| v2-Workerbausteine (Payload, Pins, Taxonomie) | `worker/calculation-v2.ts` | `m107-calculation-worker-v2` 5/5 |
| SPA-Sidecar + Geometrie | `scripts/f401-spa-geometry.py`, `.venv` (pvlib 0.15.2, Wheel-Pin PyPI-verifiziert) | Elevation vs H_sun 0.023° « 0.25° |
| Tilted Fixtures (3 Klimata, 30°/Sued, Real-Horizont) | `tests/fixtures/f401/pvgis-tilted30-south-2020-*.json` | `f401-tilted-fixtures` 6/6 (URL-Rebuild-Lock) |
| Hay-Nacht-Branch an Echtdaten | `f401-hay-night-v2` | 3/3 (~13.500 Auswertungen) |
| Hay-Monatsvalidierung | `f401-hay-monthly-v2` | 3/3 (Bias ≤1.87, annual <0.12 %; s. ESTIMATE) |

Live-Gegenproben (/tmp, nicht committet): PVGIS-Abruf byte-identisch
(SHA 4b9760), Parser/Achse/URL-Builder an Echtdaten ok.

## ESTIMATE-Register (keine Paritaetsbelege)

1. Intra-Hour-Rekonstruktion, DST-/Schaltjahrregel, SoC-Start, Wirkungsgrade,
   Toleranzen — versioniert in Spec + `versions-v2.ts`.
2. Kanonische Dezimalstellenzahl; Aspect-±180→-179; Horizont-Interpolation;
   printhorizon-Query-Form (beobachtet, HTTP 200).
3. Monatsgate-Huelle (2.0 absolut / 0.03 relativ statt Spec 0.05/0.005;
   annual 0.0025 wie Spec) — 36 Monatsbelege, Spec-Amendment vorgemerkt.
4. PVGIS-Normalisierungen (`building→building-integrated`, `crystSi→c-Si`)
   nur beobachtet, nicht als Regel erfunden.
5. Keine eigene AC-Paritaet (P bleibt Providerwert); keine
   Tarif-Arbitrage/20-Jahres-Cashflow (F4.2–F4.5).

## v2-Transport/Fetch (2026-09-08, lokal verifiziert, unpushed ab `f0fda9d`)
- `http-transport.ts`: aus `pvgis.ts` extrahiert (Timeout, 429/529/5xx,
  Content-Type-Pflicht, Byte-Schranken, Retry-After, Loopback-Override).
  v1-Orakel `pvgis-provider` 22/22 weiter gruen = verhaltensidentisch.
- `fetch-v2.ts`: kanonische URLs, Origin-Override (Query intakt),
  manuelle Redirects (max 3 Same-Origin-Hops, Cross-Origin-Abbruch
  deterministisch), Abrufzeiten, Fetch+Parse-Komposition.
- `f401-fetch-v2` 7/7 gegen echten Loopback-HTTP-Server (keine Mocks).
- Neue Fehlerklassen: `F401FetchError`, `F401RateLimitedError`,
  `F401ConfigurationError`; `contract_size_exceeded` eigenstaendig.

## Offene Gates (kein v2-Produktivlauf bis dahin)

- Worker-Epic: Serien-Persistenz + Reservation-v2 + Finalize-v2 +
  atomare Ketten-Aktivierung (Handler verweigert v2 bis dahin;
  `supportsClaimPins` im v1-Handler schliesst v2 bereits aus).
- Designstand Worker-Epic (2026-09-08): v1 legt bereits 8760er-
  Stundenarrays in `provider_snapshot` (jsonb) ab — v2-Serien (2×35040,
  ~0.5 MB JSON) passen ins gleiche Spaltenmuster, voraussichtlich KEINE
  Migration noetig.
- Storage-Provenienz GEKLAERT (Pfad a, implementiert):
  `catalog-resolution-v2.ts` loest `battery.v1`-Revision auf
  (nominal/nutzbar/Max-Dauerleistung/Roundtrip-bps vorhanden) mit stated
  Regeln (bodenbuendiges SoC-Fenster wie v1, symmetrische Leistung,
  Sqrt-Split Eta; null = No-Storage, ungueltig = cannot_fulfil).
  Tests `f401-catalog-resolution-v2` 3/3.
- Persist/Finalize-v2 IMPLEMENTIERT (47516ce + Fix-Commit, Push mit Hook-Verifikation laeuft):
  Migration 0079 (`finalize_project_calculation_success_v2` + v2-Zweig
  im Revision-JSON-CHECK), `persistProjectCalculationInputV2` /
  `finalizeProjectCalculationSuccessV2`, Tests `m111c` 5/5, m107 ohne
  Regression. Nebenbefunde aus Full-Suite (alle behoben, 64/64 gruen):
  0078 hatte JSON-CHECK uebersehen; `IS TRUE`-Wrapper haette NULL-
  Semantik gebrochen (jetzt ohne); Rollenvertrag um v2-Funktion
  erweitert (Ownership/Signatur/ACL, existenzgeprueft); Journal-Pins
  80/idx 79; Drain-Allowlist fuer Loopback-`response.end`.
  parseStoredInput verzweigt nach Zeilenversion (v1 byte-identisch).
- Rest-Epic: Reservation-v2 (bestaetigte Aufloesung lesen), Fetch im
  Worker, atomare Aktivierung.
- Fetch-Schicht: Redirect/Host/Content-Type/Retry/Offline-Replay
  (Manuell-Curl bisher; keine Worker-Netzpfade).
- Tilted-Matrix: nur 30°/Sued je Klima; Gate verlangt 0/30/60/90°,
  N/O/S/W (~33 weitere Abrufe).
- Spec-Amendment Monatsgate (s. ESTIMATE 3).
- M4 Sidecar-Deploy (Hetzner-Worker, FastAPI) + transitive/OCI-Pins.
- F4.2–F4.5 (Lastquellen, Zusatzlasten, Tarife, Outputs/UI) unberuehrt.

## Nicht behauptet

- Keine beobachtbare visuelle F4-Paritaet (keine Simulations-UI angefasst).
- Keine `f4_public_reference_validated`-Laufzeitbehauptung im Produkt
  (Pin existiert im Vertrag; kein Pfad erzeugt v2-Jobs).
- Commit-Message-Typo `30ordm` in `8313e49` (Kosmetik, kein Force-Push).
