# PLAN — Lizenz-Modus (2026-09-02) · ersetzt die Clean-Room-Gesamtplanung

Stand: 2026-09-02 · Status: AKTIV · Kimi-Sign-off: siehe §8
Belege: `docs/legal/LICENSE-GRANT.md` (E-Mail Reonic GmbH, kontakt@reonic.de,
02.09.2026 21:43: Reonic-Software, Quellcode und Datenbestände dürfen für
energie-saas genutzt, verändert und vertrieben werden).

## 1. Neue Ausgangslage

Das Projekt wechselt von „Clean-Room-Nachbau" zu **„lizenzierte Übernahme +
eigene verifizierte Architektur"**:

- Reonic-Material (Software, Quellcode, Datenbestände, Produktdaten, Bilder,
  Vorlagen) darf vollständig importiert und übernommen werden.
- Die eigene Architektur (Tenant-RLS, Rollen, Events/Audit, Statusmaschinen,
  Snapshots) bleibt das Rückgrat — Reonic-Code wird dort übernommen, wo er
  fachlich passt (per ADR je Übernahme dokumentiert).
- **Unverändert:** visuelle Referenz = WMEE.de; Push-/Deploy-/Provider-Freigaben;
  Qualitätsregime (TDD, Gate-Kette, Review-Schwarm, Chromium); ehrliche
  Quoten-Metrik.

## 2. Material-Beschaffung (drei Quellen, nach Verfügbarkeit)

| Quelle | Was | Wann |
|---|---|---|
| **A. API (read-only, eigener Workspace)** | Komponenten+Bilder, Projekte, Kontakte, Notizen, Tasks, Tags, Lead-Sources, Kalender, Kanban, Templates, Wiki, Dateien-Metadaten | **sofort, läuft** |
| **B. Browser (eingeloggte Portal-Session)** | Portal-UI-Beobachtung (OBSERVED-Matrix), UI-Datenextraktion über die App-Oberfläche | morgen (Login durch Eigentümer) |
| **C. Direktlieferung Reonic** | Quellcode-Repository + vollständiger Datenbank-Dump | sobald Reonic liefert (Anforderungstext liegt beim Eigentümer) |

## 3. Strategie

1. **Daten zuerst:** Alles Erreichbare aus A/B/C in die eigene Datenbasis
   übernehmen — Komponenten/Katalog, Stammdaten, Projekte, Vorlagen. Mapping
   auf die eigenen Schemas, RLS-Invarianten bleiben, Provenienz je Import.
2. **Code gezielt:** Reonic-Code-Module übernehmen, wo sie unsere Lücken
   füllen (z. B. Fachlogik, Algorithmen, Validierungen) — nie blind ersetzen,
   immer ADR + eigene Tests.
3. **Paritäts-Slices weiter nach Gate-Kette:** Die laufende M1-Welle
   (M1-11b/M1-13/M1-14/M1-15) und M2/M3 bleiben der Fahrplan; Importe
   beschleunigen Discovery, ersetzen sie aber nicht.
4. **Browser-Erkundung morgen:** komplette Portal-Kartierung als OBSERVED-
   Matrix — größter einzelner Hebel für die Capability-Abdeckung.

## 4. Phasen

- **Phase A (jetzt):** API-Import kompletter Workspace-Daten (Lane
  `bb3ad188` läuft: 337 Komponenten, 288 Bilder; danach Stammdaten-Domänen);
  M1-Welle abschließen: M1-11b-E2E-Fix → Vollsuite grün → Commit/Merge,
  M1-13-Merge (0041), Register auf REVIEWED/VERIFIED; visuelle
  Baseline-Freigabe durch Eigentümer bleibt offen.
- **Phase B (morgen):** Browser-Session: Portal-Kartierung, Screenshots,
  UI-Datenextraktion, Artefakte nach `artifacts/`.
- **Phase C (nach Reonic-Lieferung):** Repo + DB-Dump: vollständige
  Datenübernahme, Code-Adoption je ADR, Priorisierung der F-Module neu
  bewerten (M3-Rechnungen hat z. B. API-seitig nichts — Dump ändert das).
- **Phase D (durchgehend):** Slices bis Parity Freeze; Quote steigt je
  VERIFIED-Slice wie bisher.

## 5. Regeln und Risiken

- **Kimi-Auflage 1 (Beleg-Regime):** Original-Lizenzmail (`.eml`/PDF) vor
  weiteren Importen in `docs/legal/` ablegen (Eigentümer); `ASSET-LICENSE.md`
  anlegen, bevor importierte Bilder/Vorlagen gemerged werden.
- **Kimi-Auflage 2 (PII):** Domänen mit Personenbezug (Kontakte, Kalender,
  Projekte, Notizen) nur nach Datenschutz-Klassifikation importieren;
  Nicht-Produktivumgebungen erhalten pseudonymisierte Daten.
- **Kimi-Auflage 3 (Import-Gates):** Jeder Daten-Import mit Mapping-Validierung
  (Schema-Tests, Dry-Run + Abgleichszählungen) und Provenienzeintrag; ohne
  Gate kein VERIFIED und kein Quoten-Einfluss (Import ≠ Capability).
- Keine Mutationen in produktiven Reonic-Systemen (API: read-only-Key;
  Browser: nur Beobachten, keine Speichern-Klicks, Capture-Protokoll).
- Secrets/Keys bleiben ausschließlich lokal (`gitignored`), nie in Logs/Docs.
- Jede Übernahme mit Provenienz (`SOURCE-REGISTER.md`, `ASSET-LICENSE.md`).
- Prioritäten der F-Module bleiben eingefroren, bis der Reonic-Dump vorliegt;
  Repo-Übernahmen durchlaufen Dependency-/Lizenz-Scan vor Ausführung.

## 6. Definition of Done (unverändert)

Parity Freeze laut Goal-Prompt §19 — jetzt beschleunigt durch lizenzierte
Importe, aber unverändert evidenzbasiert (kein VERIFIED ohne Gates).

## 7. Unmittelbare nächste Schritte

1. API-Import-Lane um alle Stammdaten-Domänen erweitern (nächste Nachricht).
2. M1-11b-E2E-Permission-Rest in wave-01 reproduzieren/fixen.
3. Kimi-Sign-off dieses Plans (§8).
4. Eigentümer: Login morgen; Reonic-Anforderung weiterleiten (Repo+Dump).

## 8. Kimi-Sign-off

**GO** (2026-09-02, Kimi K3 via OpenRouter) unter drei Auflagen — alle in §5
verankert: (1) Beleg-Regime, (2) PII-Einordnung, (3) Import-Gates. Volltext:
`docs/parity/REVIEW-KIMI-PLAN-LIZENZMODUS.md`.

## 9. Eigener WMEE-Rechner (Vault-Referenz, 2026-09-02)

Der Eigentümer hat auf den eigenen Rechner verwiesen: Repo
`mikaslan/wmee-remake-magic`, Zweige `rechner/v5` (fünf Festpreis-Pakete
S–XXL, live wmee-rechner-v5.vercel.app) und `rechner/v6` (3D-Dachplanung aus
LoD2 + Orthofoto, live wmee-rechner-v6.vercel.app). Gemeinsamer Rechenkern
`src/lib/solar/` (ertrag, simulation, wirtschaftlichkeit, lod2, lastprofil,
gebaeude, preise, bestand; mit Tests + Fixtures). Vault-Quellen:
`20-Bereiche/D-Wmee/Rechner/` (insb. „v5 verkauft feste Pakete, v6 plant das
Dach in 3D").

Folgen für den Plan:
- **F12 (Endkunden-Funnel) = eigener Rechner v5**, kein Nachbau des
  Reonic-Embeds. Integration als Embed/Adapter + Intake-Vertrag auf die
  aktuelle Rechner-Generation (M1-04 nutzt noch Rechner-V3-Vertrag).
- **F3 (PV-Planung) = Rechner v6** (LoD2/Orthofoto statt Google — bewusste
  WMEE-Entscheidung, Vault-Beleg vorhanden).
- Rechenkern-Harmonisierung: energie-saas M1-07-Kern (PVGIS) und
  `solar/`-Kern abgleichen; ADR, bevor doppelte Wahrheiten entstehen.
- Lizenz-/Standprüfung des Repos vor Übernahme (Goal-Prompt F12):
  Status: aktiv, privat, gleicher Eigentümer — Prüfung als eigener
  Discovery-Schritt vor dem F12-Slice.
