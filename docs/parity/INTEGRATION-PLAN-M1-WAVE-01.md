# Integrationsplan — M1-Welle 01 + 02 (0040 → 0041 → 0042 → 0043 → 0044)

Stand: 2026-09-03 (13:20) · Owner: Root-Integrator · Status: Welle 02 ABGESCHLOSSEN (0040–0045 integriert auf codex/m1-wave-02, E2E 66/66); nächste Kette: 0046 (M3-01) → M2-Rest/M3-Suite

## Ziel

Die parallelen Schwester-Slices auf Basis `01b52e9`/`e5a9c5d` in genau dieser
Reihenfolge zu einem Integrations-Branch zusammenführen:

| Reihenfolge | Slice | Branch | Migration | Status |
|---|---|---|---|---|
| 1 | M1-11b Cannot Fulfil | `codex/m1-11b-cannot-fulfil` | `0040` | INTEGRIERT (`codex/m1-wave-01`) |
| 2 | M1-13 Projektnotizen | `codex/m1-13-project-notes` | `0041` | INTEGRIERT (`codex/m1-wave-01`) |
| 3 | M1-14 Kontakt-Datensatz | `codex/m1-14-contact-dataset` | `0042` | Vollgate grün, Kimi-Code-Review läuft |
| 4 | M1-15 Termine/Kalender | `codex/m1-15-calendar-appointments` | `0043` | INTEGRIERT (Welle 02) |
| 5 | M2-04 E-Signatur | `codex/m2-04-e-signature` | `0044` | INTEGRIERT (`163d2a8`, E2E 62/62) |
| 6 | M3-00 Workspace-Stammdaten | `codex/m3-00-workspace-stammdaten` | `0045` | INTEGRIERT (`1b1f944`, E2E 66/66) |
| 7 | M3-01 Rechnungs-Kern | `codex/m3-01-invoicing-core` | `0046` | Slice A1 in Implementierung (Worktree energie-saas-m301-rechnungen) |

Jeder Slice wird ZUERST auf seinem eigenen Branch vollständig abgenommen
(Gate-Kette inkl. unabhängigem Review). Erst danach Integration — niemals
unfertige Slices zusammenführen.

## Erasure-Ketten-Re-Ankerung (0042 → 0043 → 0044) — Pflichtschritt

Die Migrationen 0042/0043/0044 erweitern `erase_inactive_lead` **quellgepinnt**
(SHA-256 über `pg_proc.prosrc` + strpos-Anker). 0042 und 0043 pinnen aktuell
beide den **post-0041-Quellhash** `891d9914094e8b0b9b42716813dd957f24301a048b95b91049e4d0f8029da3bb` —
0043 liefe daher NACH 0042 zwangsläufig in den Pin-Fehler. Verfahren:

1. **0042 zuerst** anwenden (Pin `891d9914…` trifft post-0041 → grün).
2. Post-0042-`prosrc` von `erase_inactive_lead` ausgeben und neu hashen
   (`SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc …`).
3. In `0043_m1_15_appointments_calendar.sql` den Pin auf den neuen Hash setzen;
   Exception-Text „M1-13-Quellhash" → „M1-14-Quellhash". Die drei strpos-Anker
   (`old_replay_graph`/`old_lock`/`old_delete`) bleiben gültig, weil 0042 nur
   den Kontakt-Scrub-Anker ersetzt — per grep gegen den post-0042-`prosrc`
   **belegen**, nicht annehmen.
4. 0043 anwenden → Erasure-Matrix grün.
5. **0044 (M2-04)** analog nach 0043: Pin auf post-0043-Hash setzen,
   Anker verifizieren, Erasure-Matrix grün. (M2-04 basiert auf `12c863f`
   ohne 0042/0043 — sein Pin zielt auf post-0041 und MUSS ebenfalls neu
   verankert werden.)

Ohne diesen Schritt ist die Kette additiv NICHT anwendbar; der Pin-Fehler ist
beabsichtigtes Chain-Design (Reihenfolge-Verletzung wird hart abgelehnt),
kein Lane-Defekt.

## Bekannte gemeinsame Dateien (Konflikt-Hotspots)

| Datei | Konfliktart | Auflösung |
|---|---|---|
| `drizzle/meta/_journal.json` | beide fügen Migration ein | strikt in Reihenfolge 0040 → 0041 → 0042 → 0043 → 0044 mergen, keine Neu-Nummerierung |
| `drizzle/meta/0041_snapshot.json` | 0042-/0043-Lane reparieren beide identisch (prevId→0040, M1-11b-Tabellen) | byte-gleicher Stand verifiziert (2026-09-03); keine Konfliktbehandlung nötig |
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
