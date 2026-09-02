# Integrationsplan — M1-Welle 01 (0040 → 0041 → 0042)

Stand: 2026-09-02 · Owner: Root-Integrator · Status: VORBEREITET (Lanes laufen)

## Ziel

Die drei parallelen Schwester-Slices auf Basis `01b52e9` in genau dieser
Reihenfolge zu einem Integrations-Branch zusammenführen:

| Reihenfolge | Slice | Branch | Migration | Status |
|---|---|---|---|---|
| 1 | M1-11b Cannot Fulfil | `codex/m1-11b-cannot-fulfil` | `0040` | Implementierung läuft |
| 2 | M1-13 Projektnotizen | `codex/m1-13-project-notes` | `0041` | Implementierung läuft |
| 3 | M1-14 Kontakt-Datensatz | (noch nicht angelegt) | `0042` | SPECIFIED |

Jeder Slice wird ZUERST auf seinem eigenen Branch vollständig abgenommen
(Gate-Kette inkl. unabhängigem Review). Erst danach Integration — niemals
unfertige Slices zusammenführen.

## Bekannte gemeinsame Dateien (Konflikt-Hotspots)

| Datei | Konfliktart | Auflösung |
|---|---|---|
| `drizzle/meta/_journal.json` | beide fügen Migration ein | strikt in Reihenfolge 0040 → 0041 → 0042 mergen, keine Neu-Nummerierung |
| `lib/db/schema/index.ts` | Exporte | beide Exporte additiv übernehmen |
| `tests/setup/tenant-fixtures.ts` | neue Tabellen-Factories | beide Blöcke additiv; Reihenfolge egal, Vollständigkeit prüfen |
| `scripts/db-role-contract.mts` | neue Grants/Policies-Blöcke | M1-11b-Block VOR M2-03b1-Marker (wie in verlorener Fassung); M1-13-Block danach; Marker-Grenzen testen |
| `scripts/pgboss-bootstrap.mts` | neue Queue `notification.customer` | nur M1-11b betroffen |
| `docs/parity/UNKNOWN-CONFLICT-LOG.md` | UNK-F1-05 (M1-11b), ggf. neue Einträge | additive Zeilen, keine Umnummerierung |
| `modules/*/index.ts` Exportlisten | neue Exporte | gepinnte Import-Tests (`triage-module-import`) additiv erweitern |
| `docs/parity/STATUS.md`, `CAPABILITY-MATRIX.md`, `TEST-EVIDENCE.md`, `SOURCE-REGISTER.md` | Register | NUR Root-Integrator schreibt nach Abnahme |

## Integrations-Gates (im Integrations-Branch, in dieser Reihenfolge)

1. Merge 0040 → Integrations-Branch; `npm run check` grün (inkl. Chromium-Suite).
2. Merge 0041; `npm run check` grün; gemeinsame Fixtures/Rollenvertrag vollständig.
3. Merge 0042 (nach dessen Abnahme); `npm run check` grün.
4. `npm run db:generate` ohne Drift; `npm run db:roles:verify` 88/88 + 5/5.
5. `npm run build`; `git diff --check`; Secret-Scan.
6. Unabhängiger Review-Schwarm (Codex + Kimi K3) auf dem Integrationsstand.
7. Lokaler Integrations-Commit + Push auf `codex/*`-Integrations-Branch
   (Eigentümer-Regel: erst gepusht = gesichert).

## Voraussetzungen vor Schritt 1

- M1-11b: alle 10 Kimi-Befunde (P0/P1/P2) aufgelöst und im Spec-Abschnitt
  „Review-Befunde M1-11b-R1" dokumentiert; DB-Matrix grün; fokussierter
  Chromium-Lauf nachgeholt (4 Szenarien); unabhängiger Review ohne offene
  P0–P2.
- M1-13: DB-Matrix grün, Chromium-Nachholung eingeplant.
- Eigentümer-Entscheid offen: falls der verlorene Original-Code vom Mac Studio
  auftaucht, wird er als Diff-Kandidat gegen den Neuaufbau geprüft, NICHT
  blind übernommen.
