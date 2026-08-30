# M2-01 — Umsetzungsplan Angebotsvarianten und Snapshot-BOM

Status: **GATE 1 AM 2026-08-30 DURCH MIKAIL FREIGEGEBEN — UMSETZUNG AKTIV**

## Ziel

Den bis M1-08 verifizierten PV-Wohngebäude-Spine um einen
operatorqualifizierten B2C-Angebotspfad real erweitern:

```text
aktuelle Anfrage + aktuelle Projektauflösung
  → atomarer Offer-/Phasenwechsel
  → erste revisionsgebundene Variante
  → eigenständige Snapshot-BOM
  → serverautoritatives Preis-/Rabatt-/Steuerergebnis
  → Variantenduplikat
  → Reload und Outdated-Nachweis
```

PDF, Versand, Signatur, WORM, Financing und Rechnung bleiben außerhalb dieses
Slices. Reale Produkt- oder Preisdaten werden nicht erfunden.

## Task List nach Gate 1

### 1. Vertrag und RED — Owner: Root

- Runtimeverträge für Offer-Create, Variant-Revision, BOM-Snapshot, redigierte
  DTOs und kanonische Hashes schreiben.
- Create-Digest aus IDs/Revisionen plus serverintern geladenen Hashbindungen,
  exakte Contact-/Anlagenstandort-Allowlist, operatorbestätigtes B2C,
  deterministische 1–500-Zeilen-Resolution→BOM-Seed-Regel, explizite
  Steuerwahl und wahrheitsgemäße Preisoverride-Provenienz pinnen.
- Pure Money Engine als Contract festlegen: Cent, Basispunkte,
  `quantity_milli`, BigInt, half-up, Largest Remainder und feste
  Rabattreihenfolge einschließlich Custom-Target-Allokation; nichtnegative
  Input-/Outputgrenzen und getrennte Basis-/Optional-Totals.
- Zuerst rote Contract-, Golden-, Property-, Overflow-, Mixed-Tax- und
  Redaktions- sowie Action-Boundary-Tests ausführen.
- Keine Implementierung vor nachgewiesenem RED.

### 2. Additives Schema und Migration — Owner: Root

- Vor Schemaänderung `npm run db:generate` in einem sauberen isolierten
  Arbeitsbaum ausführen. Weil `_journal.json` bis 0030 reicht, die
  Metasnapshots aber bei 0024 enden, jeden historischen Delta-Befund zuerst
  reproduzierbar reconciliieren; keine alte SQL-Migration umschreiben.
- `offer_number_series`, `offer`, `offer_variant`,
  `offer_variant_revision`, `offer_variant_section` und `offer_bom_line`
  modellieren.
- Die fehlende Metadatenstrecke nach 0024 zuerst als forward-only No-op
  `0031_schema_metadata_baseline` mit unverändert generiertem Post-0030-
  Snapshot schließen. Danach die durch Drizzle generierte M2-Migration 0032
  samt `_journal.json` und Metasnapshot prüfen; `0000–0030` bleiben
  byteidentisch.
- Ausschließlich aktive Default-Boards mit `scope='residential'` und null
  Offer-Spalten idempotent backfillen, bestehende 1/n-Konfiguration sowie
  Custom-, Commercial- und archivierte Boards nicht verändern und die
  Workspace-Provisionierungsfunktion per `CREATE OR REPLACE` für zukünftige
  Default-Wohngebäude-Boards erweitern.
- Request-Readmodell explizit auf Lead-Spalten filtern und Offer-Readmodell
  ergänzen; 0/n Offer-Spalten bleiben getestete Konfigurationsblocker.
- Composite-FKs, RLS ENABLE/FORCE, genau eine permissive Tenant-Policy,
  immutable Trigger, minimale ACLs sowie deferred Snapshot↔Mirror-
  Vollständigkeits-/Hash-/Pointer-Checks festschreiben.
- DSGVO-Erasuregraph, Locking, `latest_activity` aus Offer-/Variant-/Revision-
  Zeitpunkten und Tombstone-Replay für Draft-Offers erweitern; jede erfolgreiche
  Offer-Mutation aktualisiert Offer/Project mit DB-Zeit, Runtime-DELETE bleibt
  verboten, alte Tombstones bleiben gültig.
- eigene fachinhaltsfreie Offer-Mutationsfenster für 120 Versuche je
  Actor/Workspace und 1200 je Workspace in 15 DB-Minuten sowie zwölf Varianten
  pro Offer modellieren; keine Better-Auth-Tabelle wiederverwenden. Admission
  in separater Quoten-Transaktion vor der Domain-Transaktion committen, damit
  Denied, Validation, Replay, Conflict und Domain-Rollback gezählt bleiben;
  Advisory Locks Workspace→Actor nehmen, danach einmal `clock_timestamp()`
  lesen, `window_start` aus genau diesem Wert per UTC-Epoch-`date_bin` an
  globale Viertelstunden binden und `retryAfter` als UTC-Fensterende
  serialisieren. Lock-Wartezeit über die Fenstergrenze explizit testen.
- Tenant-Fixtures und exakten DB-Rollenvertrag erweitern.
- Fresh-, Upgrade-, Generate-Clean-Diff-, Direkt-SQL-, Mirror-Tamper-,
  Erasure-, Race- und Rollback-Tests zunächst rot, dann minimal grün
  implementieren.

### 3. Services, Zustände und Rechte — Owner: Root

- schmalen `import "server-only"`-Katalogexport definieren, der Workspace,
  Project, Kopierzweck und aktuelle vollständige Projektauflösung selbst
  autorisiert;
- `modules/offers` mit `TenantTx + ServiceCtx` aufbauen;
- Convert unter Project-/Serien-Lock implementieren, vollständigen
  Create-Digest für Replay/Conflict verwenden und Project/Board atomar
  umstellen;
- Create nur für `wmee-rechner-v3`/`offer_request`, operatorbestätigtes B2C und
  `project.write + phase.convert + price.edit` zulassen;
- erste Variante `Basis` exakt nach Seed-Regel und expliziter Steuerwahl
  erzeugen; Steuerwahl/-änderung sowie neue Basis immer über `price.edit`, bei
  0 % mit frischer commandgebundener Bestätigung;
- Duplikation und Revision unter Offer-/Variant-Lock implementieren;
- globale Lockreihenfolge `Project → Offer → Variant → Revision/Mirrors`, für
  Create `Project → OfferNumberSeries` und für Erasure nach der realen
  bestehenden Reihenfolge `Contact → ContactLegalHold → Project → Site →`
  `CalculationJob → CalculationRevision → SiteEnergyProfile →`
  `ProjectRequirement → CalculatorSnapshot → InboundReceipt` dieselbe
  Offer-Unterfolge erzwingen; Erstlauf und Replay identisch testen;
- ausschließlich serverseitig Preise, Allokation, Steuer und Provenienz neu
  berechnen;
- Public-/Purchase-Readmodelle strukturell trennen;
- bestehende Runtime-Semantik „Admin impliziert Capabilities, Feature-Flag
  schlägt Admin“ unverändert testen;
- Events/Audits ohne Geld, PII, Freitext und private Hashes schreiben.

### 4. Geschützte Next-16-Oberfläche — Owner: UI-Lane

- `/w/[workspaceId]/angebote` und
  `/w/[workspaceId]/angebote/[offerId]` als Server-Component-Routen bauen;
- `params` und `searchParams` als Promises awaiten, `?variante=` streng als
  einzelne UUID serverseitig validieren;
- readiness-gegatete Konvertierung samt B2C- und Steuerbestätigung aus der
  Projektakte ergänzen;
- kleine Client Islands für Variantenauswahl, Edit-State, Reorder und lokale
  Vorschau verwenden;
- einen lokalen Variantendraft, genau einen expliziten gebündelten Save, eine
  Action in flight sowie Dirty-/Save-/Discard-/Conflict-Rebase-Verhalten
  implementieren; Variantenwechsel, Breadcrumb/Back, Reload/Tab-Schließen,
  Logout, Duplizieren und neue Basis verlieren keinen Draft still; keine
  Autosaves; `<Link>.onNavigate`, History/Back, Guard vor `signOut()`,
  unauthenticated ohne Auto-Redirect und Savefehler jeweils browsertesten;
- Dirty-Dialog als benanntes/beschriebenes Modal mit Fokusbindung,
  Anfangsfokus auf „Bleiben“, Escape=Bleiben, Fokus-Rückgabe und
  fehlerabhängigem Navigationsabbruch implementieren;
- FormData-Allowlist inklusive `$ACTION_`, Duplikat-/File-Abweisung,
  Commandgrößen und exakte Revalidation-vor-Redirect-Pfade testen;
- Desktop-Editor, 375-px-Kartenlayout, Preiszusammenfassung und
  Keyboard-Reorder implementieren;
- Loading, Empty, Blocked, Denied, Not Found, Outdated, Dirty, Pending,
  Conflict, Validation, Unavailable mit `retryAfter`, Unauthenticated,
  Unexpected Error, Success und Read-only real ausformen;
- Action-State, `aria-live`, Fokusmanagement, 44-px-Touchziele, 200-%-Textzoom,
  320-CSS-px-/400-%-Reflow, die Pflichtbreiten 375/390/768/1024/1440/1920,
  Reduced Motion und WCAG 2.2 AA abdecken;
- vollständige scoped Tokens für Brand, Foreground/Background, Surface 1–4,
  Border, Accent, Interaktions-/Statusfarben, Overlay, Chartpalette,
  Typografie, Spacing, Radius, Shadow, Z-Index, Motion und Breakpoints
  dokumentieren;
- keine PDF-/Signatur-/Versand-Placebos anzeigen.

### 5. Integration und Browser-Golden-Path — Owner: Test-Lane

- synthetischen Request mit Site, Calculation, Katalog und aktueller
  Projektauflösung anlegen;
- Request → Offer → Duplikat → BOM-/Preisänderung → Reload testen;
- Seedgrenzen 250/251/500, Reject 501, zwölf/dreizehn Varianten sowie
  Actor-/Workspace-Quoten an beiden Grenzen und unter Race testen;
- Katalogrevision → neue Projektauflösung → Outdated → neue Basisvariante
  testen und alten Snapshot bytegleich nachweisen;
- Viewer, `price.read_purchase`, `price.edit`, `discount.apply`, External,
  Steuerwahl/-änderung/neue Basis, Admin/Feature-Flag, unauthenticated und
  Fremdtenant negativ testen;
- direkte Action-, Draft-Erasure-, Mirror-Vollständigkeits- und
  Preisprovenienz-Nachweise ausführen;
- nachweisen, dass nur die erlaubten Contact-/Anlagenstandortfelder kopiert,
  private Hashes nur intern geladen und ein alter Kontakt mit frischer
  Offer-Revision nicht löschberechtigt ist;
- Board-Backfill gegen Custom-, Commercial- und archivierte Negativfixtures
  prüfen;
- 320/375/390/768/1024/1440/1920, 200 %/400 %, Tastatur, Axe und
  Console/Page-Errors prüfen;
- mit synthetischen stabilen Fixtures und layoutstabilen Masken für Nummern,
  PII, Zeitpunkte und IDs Screenshot-Kandidaten bei
  375/390/768/1024/1440/1920 erzeugen; gepinnten Chromium/Fonts, deaktivierte
  Animation/Caret und Visual-Regression-Schwellen `0.2`/`0.001` verwenden;
- die vollständige Capture-Matrix erzwingen: Editor-Board, readiness-CTA und
  befüllter Editor bei `375×812`, `390×844`, `768×1024`, `1024×900`,
  `1440×1000`, `1920×1080`; Dirty, Conflict, Unavailable als Editor und
  Read-only als Viewer zusätzlich bei 390×844 und 1440×1000, jeweils
  `deviceScaleFactor=1`, hell, Reduced Motion und `fullPage=true`;
- keine Produktionsdaten oder fremden Zugangsdaten verwenden.

### 6. Unabhängige Reviews und Delivery Gates — Owner: Review-Lanes

- getrennte Code-/Korrektheits-, Tenant-/Security-, Money-/Snapshot- und
  Accessibility-Reviews durchführen;
- alle P0–P2 schließen und Tests für bestätigte Befunde ergänzen;
- `npm run check`, vollständige Tests, Fresh-/Upgrade-DB, Rollenproben,
  `npm run db:generate` mit clean Diff, Browser-E2E und `npm run build`
  ausführen;
- Capability-Matrix, Test-Evidence, ADR, Spec, Status und Vault aktualisieren;
- erste Screenshot-Baseline Mikail zur visuellen Freigabe vorlegen; bis dahin
  `M201-VISUAL-01 = INCONCLUSIVE`, niemals PASS und kein Gate 2;
- vor lokalem Commit Gate 2 bei Mikail einholen;
- kein Push, Preview, Providerkauf oder Deploy ohne gesonderte Freigabe.

## Vorgesehene Arbeitsteilung

- Root besitzt Vertragsformen, zentrales Schema, Migration, Money Engine,
  Board-/Erasure-Integration, Katalogexport und den CTA in der Projektakte.
- Eine UI-Lane darf ausschließlich die neuen Offer-Routen und Offer-UI ändern.
- Eine Test-Lane ergänzt nicht überlappende Contract-/E2E-Fixtures.
- Review-Lanes arbeiten nach Implementation read-only und verändern keine
  Tests, um GREEN zu erzwingen.

Vor Parallelisierung werden exakte Dateieigentümer erneut per
`git status`, Worktree- und Prozessprüfung festgelegt. Niemand arbeitet
gleichzeitig an denselben Dateien.

## Kritische Dateien

- `lib/integrations/offers/**`
- `contracts/offer*.schema.json` und synthetische Fixtures
- `lib/db/schema/offers.ts`
- `lib/db/schema/boards.ts`, `modules/boards/**`
- nächste Migration nach `0030`, `drizzle/meta/_journal.json` und neuer
  Metasnapshot; Erasure-/Provisionierungsfunktionen ausschließlich additiv
- `scripts/db-role-contract.mts`, `tests/setup/tenant-fixtures.ts`
- `modules/catalog/index.ts`, `modules/offers/**`
- `app/w/[workspaceId]/angebote/**`
- `app/w/[workspaceId]/anfragen/[projectId]/**`
- Contract-, Unit-, DB-, Migration-, Action- und E2E-Tests

## Interne grüne Inkremente

Der finale M2-01-Abnahmeumfang bleibt zusammenhängend, wird aber intern in
vier nachweisbare Stände geliefert:

1. Contracts + Money + Schema/Migration;
2. Convert + Initialvariante + read-only Offer-Detail;
3. lokaler Draft + Save/Revision + Duplicate;
4. Outdated/neue Basisvariante + vollständige RBAC-/Action-/A11y-Abnahme.

## Stoppschilder

- Kein Code vor Gate 1 und keinem RED-Nachweis.
- Kein Commit vor Gate 2.
- Kein Reonic-Login, keine interne API und kein Reonic-Datensatz.
- Kein Rechner-`market_estimate` als Angebots- oder BOM-Preis.
- Keine erfundene WMEE-SKU, kein Preis und keine Paketdefinition.
- Kein EK, keine Einkaufsprovenienz, Marge oder privater Vollhash im
  unberechtigten Clientpayload, Event, Audit oder Log.
- Keine stille Snapshot-Propagation und kein In-place-Revisionsupdate.
- Keine automatische Steuerbehauptung.
- Keine Abschwächung bestehender Tests oder Migrationen.
- Kein Push, Preview, Providerkauf oder Produktionsdeploy ohne Freigabe.

## Gate 1

Mikail bestätigt Spec, ADR und diese Task List. Erst danach beginnt Task 1 mit
RED. Änderungen am genehmigten Scope werden erneut sichtbar vorgelegt.
