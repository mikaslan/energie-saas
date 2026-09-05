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
6. **CI-Billing: keine Ausführung mehr möglich (BLOCKED-ON-MIKAIL).**
   Seit ca. 21:37 starten keine Jobs: „The job was not started because
   recent account payments have failed or your spending limit needs to be
   increased." Alle CI-Gates (Testsuite, E2E, Build) stehen still; Reruns,
   Kontrolle und Observability-Commit können nicht verifizieren. Nur du
   kannst Billing/Spending-Limit beheben. Bis dahin: autonome Arbeit ohne
   CI (Specs/Statik), Verifikation nachgeholt sobald CI läuft.

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

7. **F16.3 Fix-Modell: Lane-D/E (Snapshot-v2/v3, app-seitig) vs.
   gatefix3-0065 (DB-Derive-Trigger `derive_offer_pdf_draft_input`).**
   Beide Designs koexistieren derzeit auf getrennten Branches und
   kollidieren bei der Integration (0063/0064 vs. 0065, Builder vs.
   Trigger). Die Lane bleibt bis zu deiner Entscheidung beim
   D/E-Design (Slices implementiert, CI-Triage läuft). Bitte
   entscheiden: (a) D/E behalten, gatefix3-0065 verwerfen, oder
   (b) auf Trigger-Design umstellen (D/E-Revert auf der Lane).
