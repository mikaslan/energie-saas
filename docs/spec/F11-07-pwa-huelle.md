# F11-07 PWA-Hülle (Install-Hinweis + SW-Update-UI)

Status: **SPECIFIED** · Lane: `codex/muse-fleet-2d-f11-07` · Basis `9b3ef17`
Ziel: Die PWA-Hülle wird benutzbar — (a) ein Install-Hinweis erscheint,
sobald der Browser Installierbarkeit signalisiert; (b) ein SW-Update
meldet sich statt still zu tauschen, mit benutzergetriebenem
„Aktualisieren". Schließt die beiden provider-freien Lücken aus der
F11-Matrix („Install-Hinweis, SW-Update-UI ABSENT").

## Evidenz (FACT, Basis 9b3ef17)

- Bestand PRESENT: Manifest (`public/manifest.webmanifest`, standalone,
  192/512/maskable Icons), SW `f11-02-v1` (`public/sw.js`, Caches
  `wmee-*`, Precaches offline.html+Manifest, `skipWaiting` +
  `clients.claim`), Registrierung (`app/sw-register.tsx`, 14 Zeilen,
  register-and-forget), Offline-Fallback (F11-02-E2E-01 grün).
- Bestand ABSENT (je per 0-Treffer-Sweep belegt): `beforeinstallprompt`/
  `appinstalled` (0 Treffer in app/lib/public/tests), Update-UI
  (Registrierung ohne `updatefound`/`waiting`-Behandlung).
- Lane 2c ist NICHT in dieser Basis (kein `lib/mobile`, kein Tab-Bar-
  Layout) — Banner rechnen mit `var(--f11-tabbar-h, 0px)` und funktionieren
  heute (0px) wie nach dem 2c-Merge (45px), ohne Codeänderung.
- Suite seriell (`workers: 1`, `fullyParallel: false` in
  `playwright.config.ts`) — ein dateibasierter Update-E2E ist ohne
  Parallel-Race.

## Vertrag

- Teil A — Install-Hinweis (`app/_components/pwa-install-hint.tsx`,
  Client, im Root-Layout global):
  - Hört auf das ECHTE `beforeinstallprompt` (preventDefault, Event
    merken, Hinweis zeigen). Kein Fake-Feuer im Produktcode.
  - Zeigt NICHT: im Standalone-Display-Mode
    (`matchMedia('(display-mode: standalone)')` oder iOS
    `navigator.standalone`), nach Wegklicken (`localStorage`
    `wmee:pwa-install-dismissed`, try/catch-gekapselt), ohne Event.
  - UI (`data-testid="pwa-install-hint"`): Text + „Installieren"
    (`prompt()` aufrufen, nach `userChoice` ausblenden; bei Outcome
    `dismissed` zusätzlich als weggeklickt merken) + „Nicht jetzt"
    (merken + ausblenden). Buttons `min-h-11`, deutsch.
- Teil B — SW-Update-UI (`app/_components/sw-update-notice.tsx`, Client,
  im Root-Layout global):
  - `public/sw.js` wird `f11-07-v1`: kein automatisches `skipWaiting`
    im `install` mehr; `message`-Listener auf `{type:'SKIP_WAITING'}`
    → `skipWaiting()`. `clients.claim()` bleibt (Kontrolle sofort nach
    benutzergetriebenem Skip). Alte `f11-02-*`-Caches räumt der
    bestehende `activate`-Filter ab (nur aktuelle Namen bleiben).
  - Registrierung mit `updateViaCache: 'none'` (in `sw-register.tsx`
    UND in der Notice — wer zuerst registriert, setzt die Option;
    Effekt: Update-Check umgeht den HTTP-Cache, auch in Prod).
  - Notice: meldet `registration` (idempotentes `register()`), zeigt
    `data-testid="sw-update-notice"` sobald `registration.waiting`
    existiert (Mount-Check + `updatefound` → `installed` bei
    vorhandenem Controller). „Aktualisieren" → `waiting.postMessage(
    {type:'SKIP_WAITING'})` → bei `controllerchange` (once) Reload.
  - Erstinstallation unverändert: ohne aktiven Worker aktiviert der
    neue sofort (kein Waiting) — F11-02-E2E-01 bleibt grün.
- Darstellung beider Banner: fixierte Karte unten zentriert
  (`max-w-xl`), `z-40`, `bottom: calc(var(--f11-tabbar-h, 0px) +
  max(0.75rem, env(safe-area-inset-bottom)))`; Install-Hinweis
  `role="region"` + `aria-label`, Update-Notice `role="status"`.
  375 px ohne Überlauf. Bei gleichzeitigem Erscheinen liegt die Notice
  oben (DOM-Reihenfolge; selten, transient bis Reload).
- Keine Migration, keine neue Permission, kein Backend, kein Provider.
  iOS-Grenze dokumentiert: ohne `beforeinstallprompt` kein Hinweis
  (Plattform, kein Fake).
- Akzeptierte Reste (Review-Runde, bewusst): `beforeinstallprompt` VOR
  Effekt-Anhang geht verloren (Browser feuert üblicherweise nach Load;
  Refire bei Navigation); Install-`region` ohne Live-Ansage (kein
  Marketing-Lärm für Screenreader).

## Tests

- Unit: keine (reine DOM-/Navigator-Verdrahtung; Präzedenz F11-02 E2E-only).
- DB: keine.
- Chromium-E2E `F11-07a-E2E-01` (Install, `/login` ohne Workspace,
  Muster F11-02): Hinweis initial versteckt → synthetisches
  `beforeinstallprompt` (prompt-Stub + `userChoice accepted`) →
  sichtbar → „Installieren" → Stub aufgerufen → versteckt. Zweitlauf:
  „Nicht jetzt" → versteckt → Reload → Event → BLEIBT versteckt
  (Persistenz). Dritt-Zustand per `addInitScript`-matchMedia-Stub
  (standalone) → Event → bleibt versteckt. Axe A/AA, 375/768/1440,
  0 Console-/Page-Errors.
- Chromium-E2E `F11-07b-E2E-01` (SW-Update, ECHTER Lebenszyklus):
  Notice initial versteckt → Testrunner tauscht `public/sw.js`
  dateibasiert (Version → `f11-07-v1-e2e`, finally-Restore + Byte-Assert)
  → `registration.update()` → Notice sichtbar → „Aktualisieren" →
  Reload belegt (Marker weg + Loginfeld da) → `caches.keys()` enthält
  `wmee-static-f11-07-v1-e2e` (neuer Worker aktiv). Axe A/AA,
  375/768/1440, 0 Console-/Page-Errors, keine 4xx/5xx.
- Regression: F11-02-E2E-01 (Erstinstall-Aktivierung), F11-01-E2E-01
  (Manifest), volles `test:e2e` in der Lane-CI.

## Nicht Umfang

- Web-Push/VAPID (Provider-blockiert), Offline-Outboxen (F11-03/04),
  Install-Zähler/Analytics, Update-Erzwingung ohne Zustimmung,
  iOS-Add-to-Home-Screen-Anleitung (eigener Content-Slice).
