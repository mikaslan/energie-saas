# RUNBOOK — Verifikation & Integration (Root-Integrator)

Stand: 2026-09-02 · Gilt für die M1-Welle und folgende Slices. Konkrete
Befehlsfolge, die der Root-Integrator bei jeder Slice-Abnahme ausführt.
Details je Slice: dessen Spec-Abschlussgates.

## 1. Slice-Verifikation (im Slice-Worktree)

```bash
cd <worktree> && pwd && git status --short --branch
npm run lint && npm run typecheck
npx vitest run <fokussierte Testpfade>
npm run db:generate        # KEINE Drift
npm run build
npm run db:roles:verify    # 88/88 + 5/5
git diff --check
# Secret-Scan:
grep -rnE "sk-or-v1|rnc_v3_|gho_[A-Za-z0-9]{20,}" --include="*.ts" --include="*.sql" --include="*.md" . | grep -v node_modules || echo "sauber"
```

## 1a. Diagnose-Reihenfolge (Token-Disziplin, seit 2026-09-03)

Die Nachweis-Pflichten bleiben unverändert; diese Reihenfolge ordnet nur
billige vor teure Läufe, damit der teure Vollgate-Lauf am Ende EINMAL grün
wird statt mehrmals rot:

1. **Kleinster isolierter Test zuerst:** `npm run test:focus -- "<Muster>"`
   (vitest `-t`, gleiche Rollen-/RLS-Umgebung wie die DB-Tests). Fehler in
   Sekunden, nicht in E2E-Minuten.
2. **DB-Stufe:** `npm run test:db` (alle `tests/db` + `tests/contracts`,
   isolierte Postgres-Instanz mit echtem Rollenvertrag). Erste Adresse für
   Migrations-, RLS-, Trigger- und Races-Diagnose — **nicht** der
   Browser-Runner.
3. **Fokussierte E2E nur für UI-Wahrheiten** (A11y, Formulare, Server-Action-
   Serialisierbarkeit): `M1_05_E2E_GREP="<Muster>" npm run test:e2e`.
4. **Vollgate** (`npm run check`, E2E komplett, `npm run build`,
   `npm run db:generate`) ausschließlich als letzter Schritt einer
   Slice-Abnahme oder Integration — ein Lauf pro Meilenstein.

Weitere Regeln:

- **Logs nur gefiltert lesen:** `grep -n -B<k> -A<k>` auf die Logdatei, nie
  volle Runner-/Next-/Rollenprobe-Dumps in den Kontext ziehen. Pin-Dumps sind
  Absicht; sie werden nur bei Pin-Arbeit gelesen.
- **Max. zwei identische Fehlrunden ohne neue Information:** danach
  Instrumentierung (console.error/Assertion) in den kleinsten isolierten
  Test verlagern, statt den teuren Lauf zu wiederholen.
- **Neue Skripte in `package.json`:** `test:db`, `test:unit`, `test:focus`
  (`npm run test:focus -- "Muster"`).

## 2. Chromium-Nachholung (zentral, nach Implementierung)

```bash
npm run test:e2e           # oder Einzel-Spec via M1_05_E2E_SPEC=<spec.ts> npm run test:e2e
```
Erwartung: Slice-Szenarien grün, keine Konsolenfehler, Axe A/AA, Keyboard,
375 px, prefers-reduced-motion.

## 3. Unabhängiger Review-Schwarm

- Codex-Review (`codex exec review`) auf dem Slice-Diff.
- Kimi-K3-Review (`kimi -p` mit inline Spec/Diff) — Muster:
  `docs/parity/REVIEW-KIMI-*.md`.
- P0/P1 müssen vor Commit geschlossen sein; P2 bewusst dokumentieren.

## 4. Commit & Sicherung

```bash
git add <nur Slice-Dateien> && git commit -m "feat(...): <slice>"
git push origin <branch>   # Eigentümer-Regel: erst gepusht = gesichert
```

## 5. Integration (nach Einzel-Abnahme, Reihenfolge laut INTEGRATION-PLAN)

```bash
cd /Users/mikail/Projects/energie-saas-m1-wave-01
git merge <slice-branch>   # strikt 0040 → 0041 → 0042
npm run check && npm run build && npm run db:generate && git diff --check
```

## 6. Register aktualisieren (nur Root)

`docs/parity/STATUS.md`, `CAPABILITY-MATRIX.md`, `TEST-EVIDENCE.md`,
`SOURCE-REGISTER.md` + Vault-Abnahme unter `20-Bereiche/D-Wmee/Rechner/
Reonic Clone Final/`.

## Verbote

Kein Push vor Gate-Grün. Kein Deploy. Keine Mutationen gegen die Reonic-API.
Keine fremden Worktree-Änderungen anfassen. Nichts als VERIFIED ausgeben,
was nur lokal geprüft ist.
