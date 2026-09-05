# 17 — MUSE NETZWERK-AUTONOMIE (Laufzeit-Guard sperrfrei, Mac-Studio-Seite)

Ziel: Der Loop läuft unbeaufsichtigt, ohne „Allow this network access?"-Prompts.

## 1. Warum das passiert

- GitHub Actions hostet Log-Dateien auf Azure Blob
  (`*.blob.core.windows.net`, wechselnde Regionen, z. B.
  `productionresultssa3…`). Jeder NEUE Host = neuer Prompt des
  Laufzeit-Guards.
- Das ist KEINE Frage von Muse: Der Loop-Vertrag (10 §0) verbietet ihm
  Permission-Anfragen ausdrücklich. Der Guard sitzt in der Laufzeit und
  kann nur dort dauerhaft entschärft werden.

## 2. Einmalig auf dem Mac Studio einrichten (Mikail)

1. Konfiguration der Laufzeit öffnen (Config-Datei oder TUI-Einstellungen).
2. Netzwerk-Allowlist um diese Ziele ergänzen (Wildcards, wo möglich):

   ```
   github.com:443
   api.github.com:443
   codeload.github.com:443
   objects.githubusercontent.com:443
   *.githubusercontent.com:443
   *.blob.core.windows.net:443
   registry.npmjs.org:443
   openrouter.ai:443
   reonic.com:443
   get.geoapify.com:443
   re.jrc.ec.europa.eu:443
   ```

3. Falls die Laufzeit ein **Auto-Approve / Permission-Bypass / unrestricted
   für Netzwerk** anbietet: aktivieren. Dedizierte Build-Maschine — die
   harten Projektregeln (kein main, kein Deploy, keine Provider-Mutation,
   keine Secrets) stehen im Loop-Prompt und gelten unabhängig vom Guard.
4. `.muse-plan/freigaben.txt` prüfen: schreibbar? Auch `network:`-Einträge
   aufnehmen. Muse ergänzt sie selbst, wenn die Datei schreibbar ist
   (10 §0) — chmod +w, falls nötig.

## 3. Muse-Verhalten bei RUNTIME-Prompt (bindend)

- Ein RUNTIME-Permission-Prompt ist ein Systemfehler, keine Frage:
  Aktion überspringen, `RUNTIME-BLOCK` im LOOP-LOG notieren, sofort die
  nächste unabhängige Aktion. Nie warten, nie Mikail fragen.
- CI-Status lesen per
  `curl -s "https://api.github.com/repos/mikaslan/energie-saas/actions/runs?branch=<lane>&per_page=3"`
  (Repo public, kein Token). `gh run view <id> --log-failed` NUR bei
  rotem CI (Logs liegen auf Azure Blob → Allowlist §2).
- Neuer Host (z. B. andere Blob-Region) → in `.muse-plan/freigaben.txt`
  eintragen und im LOOP-LOG vermerken.

## 4. Gilt weiterhin unverändert

- Kein Push auf main, kein Deploy, keine Provider-Mutation, keine Secrets
  in Git/Logs/Chat, Clean-Room, keine erfundenen Zahlen. Der Netzwerk-Guard
  schützt diese Regeln nicht — sie stehen im Loop-Prompt und sind von der
  Netzwerk-Freischaltung unberührt.
