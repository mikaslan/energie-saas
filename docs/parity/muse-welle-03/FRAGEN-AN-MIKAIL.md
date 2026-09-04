# FRAGEN-AN-MIKAIL.md (Welle 03) — gebündelt erst im Abschlussbericht

## A. Aktive Fragen (Antwort erforderlich)

1. **OPENROUTER_API_KEY fehlt.** Kein `.env.local` im Repo/Worktree
   (`grep -c` → Datei nicht vorhanden). Folge: Kimi- + DeepSeek-Reviews
   fallen auf den Exit-3-Pfad (Gates entscheiden allein). Bitte Key per
   AirDrop bereitstellen oder bestätigen, dass der Exit-3-Pfad für die
   ganze Welle gilt. (Annahme bis dahin: Exit-3-Pfad.)
2. **F4-Fragen unbeantwortet?** Die F4-Fragen liegen nicht im Repo (kein
   FRAGEN-File auf `9fc49eb`). F4-Rechenkern bleibt geblockt bis zur
   Antwort. Bitte Stand nennen. (Annahme: F4 bleibt übersprungen.)
3. **E2E-Vault-Ergebnis nicht einsehbar.** Vault gesperrt; das Ergebnis der
   E2E-Suite vom integrierten Stand ist unbekannt. Eigene Lauf-Nachweise
   werden je Spec geführt. (Annahme: keine — eigene Messung zählt.)
4. **F2.2-UI-Gap als eigener Slice einplanen.** `is_primary`,
   `total_price_override_net_cents`, `optional_bundles` existieren nur im
   Service-/DB-Layer; im Angebots-Editor gibt es keinen Primary-Switch,
   kein Override-Feld, keine Bundle-Steuerung (Spec versprach
   „Primärkennzeichen + Override-Feld", nicht umgesetzt). Vorschlag:
   eigener UI-Slice nach dem E2E-Nachholblock. Kein Backend-Umbau in
   diesem Block.
5. **Push-Transport blockiert: globaler ECC-Pre-Push-Hook.** Entgegen
   „keine Hooks" greift global `core.hooksPath=/Users/mikailaslan/.codex/
   git-hooks` (Hook: lint → typecheck → `npm run test`). In dieser
   Sandbox scheitert er an `tsx`-EPERM + fehlendem listen() — unbehebbar
   von hier, `--no-verify` bleibt verboten. Commits liegen lokal auf
   `codex/muse-welle-03-e2e` bereit. Bitte entscheiden: Hook-Opt-out für
   `codex/*`-Lanes, oder alternative Abholung. Bis dahin weiter lokale
   Commits ohne Push.

## B. Bestätigte Diagnosen (keine Frage, zur Ablage)

- **f7-03-E2E-01 (reihenfolge-empfindlich):** Ursache Shared-Fixture.
  `workers: 1` (playwright.config.ts:29), ein `mainProjectId` je Lauf,
  `ApplyTemplateSection` rendert bei `checklistVersion !== 0` null
  (project-checklist-manager.tsx:369). F7.2 speichert v1/v2 → Sektion weg.
  Fix: f7-03 auf eigenes Projekt umstellen (M1-12a-Muster); Regel: jede
  neue E2E-Spec bekommt ein eigenes Projekt.
- **f7-02-E2E-01 (Toast fehlt, isoliert):** Speichern-Button sichtbar ⇒
  `checklist.write` erteilt; Payload passt zum Vertrag. Verdacht: DB-
  Schreibfehler NACH der Prüfung (Strict-Rollen-Manifest der E2E-Umgebung
  vs. grüner Ein-Rollen-Testmodus) → unmapped throw → `idle`, kein Toast.
  Nächster Schritt: E2E-Lauf + Server-Log auswerten, strict ↔
  test-legacy-single differenzieren, echte Ursache fixen + sichtbaren
  Fehlerzustand mappen (nie still `idle`).
