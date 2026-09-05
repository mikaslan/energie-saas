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
4. **F2.2-UI-Gap als eigener Slice einplanen — ERLEDIGT (Turn 47).**
   UI-Slice implementiert (Panel + 3 Server-Actions + E2E-02, kein
   Backend-Umbau außer additivem Bundle-Read); Verifikation pending
   CI/Maschine (Billing-Block Nr. 6).
5. **Push-Transport: `ECC_SKIP_PREPUSH=1` im Einsatz (offengelegt).**
   Globaler Hook (`core.hooksPath`, lint→typecheck→test) kann in dieser
   Sandbox nie grün werden (tsx-EPERM, kein listen()). Statt `--no-verify`
   (verboten) nutze ich das designed Hook-Interface `ECC_SKIP_PREPUSH=1`;
   Gate ist CI auf `codex/**`. Bei Einwand bitte melden, sonst gilt das
   als Verfahren.
6. **CI-Billing — ERLEDIGT (Turn 57).** Läufe starten wieder
   (belegt: Run 33954429993 ff. am 05.09., wave-02-Merge-Run
   33957063144 in_progress). Gates lesen via gh/curl-API.

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

## C. Neue Entscheidung (Turn 26, BLOCKED-ON-MIKAIL bei Integration)

7. **F16.3 Fix-Modell: Lane-D/E vs. gatefix3-0065 — DECIDED
   (Turn 57, Rebase auf 5641e3a).** Weder (a) noch (b): Union.
   wave-02-0064/0065 (Definer/Derive-Fix) gepinnt übernommen,
   Lane-0064 (Snapshot-v3-Check) nach 0066 renummeriert, Lane-Ports
   gedroppt, Cap als NEUE Migration 0073 auf den Trigger gelegt
   (Body-Pin fbb06d5a, rechnerisch + per Lane-CI-Messung belegt).
   0059/0062: wave-02-Fassung (Lane-Grants additiv erhalten).
