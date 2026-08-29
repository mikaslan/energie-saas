# Finale Gesamtarchitektur „Reonic-Nachbau" — Synthese

Basis ist Entwurf 0 (Pragmatik-Linse, 2:1-Richterentscheid). Eingearbeitet sind die konsensfähigen Grafts aus Entwurf 1 (Struktur-Härtung, Compliance-Tiefe) und Entwurf 2 (Domänenpräzision). Prinzip der Synthese: **E0s Zeitplan und Betriebskonkretheit bleiben unangetastet; übernommen wird nur, was am Tag 1 Stunden kostet und später Wochen spart.**

## 1. Leitentscheidung

**Modularer Monolith auf dem vertrauten Stack plus genau ein selbstverwalteter Worker-Host.** Eine Next.js-App, in der Module Ordner mit klaren Grenzen sind (`modules/crm`, `modules/offers`, `modules/invoicing` …) — aber anders als in E0 sind die Grenzen **technisch erzwungen**: dependency-cruiser/ESLint-Regeln verbieten Cross-Modul-Importe auf fremde Tabellen und Interna, CI wird rot bei Grenzverletzung (Graft aus E1, von allen drei Richtern gefordert). Bei überwiegend KI-generiertem Code ist Grenz-Erosion das wahrscheinlichste Verfallsszenario; die Lint-Regel ist die billigste Versicherung dagegen. Kein Monorepo/Turborepo, kein Command-Executor-Framework — stattdessen die Konvention: **alle Mutationen laufen durch Service-Funktionen** (Server Actions sind dünne Wrapper), und Service-Funktionen schreiben Domain-Events (s. u.). Das liefert 80 % des E1-Nutzens ohne dessen Vorlaufkosten.

**Modulreihenfolge (jedes einzeln produktiv, unverändert aus E0):** M1 CRM/Kanban → M2 Angebote (Quick-Modus, Snapshot-BOM, Rabatt-Stack, PDF, E-Signatur) → M8 Fakturierung (GoBD + E-Rechnung) → M4-light Simulation (pvlib/PVGIS) → M7 Checklisten + PWA-Offline → M16 Katalog-Ausbau → M13 Services. **Pilotkunde nach M1+M2+M8** („CRM+Angebot+GoBD-Rechnung für PV-Betriebe"). Explizit nach Umsatz vertagt: 3D-Editor, Commercial, Mieterstrom, Rust-Kern, KI-Agenten, eigene Photogrammetrie.

## 2. Komponenten

1. **Next.js-App auf Vercel** (App Router, Server Actions + wenige REST-Routen): Portal, PWA, Auth, CRUD-Domänenlogik. Eigenes Route-Segment für Kundenportal/Funnel mit vollständig getrennter Token-Auth (Graft E2, betrifft schon Signatur-Links in M2).
2. **Neon Postgres** als einzige Datenbank — auch Queue, Dateimetadaten, Events, Audit, Delivery-Log. Test-DB strikt getrennt (`POSTGRES_URL` vs. `_PROD`).
3. **Worker-Host (1× Hetzner, Docker Compose)**: pg-boss-Node-Prozess, Playwright/Chrome für PDF, pvlib-Python-Sidecar (FastAPI) für Ertragssimulation + PVGIS-Cache, E-Rechnungs-Serialisierung. **Degradations-Semantik:** Worker-Ausfall verzögert PDFs/Jobs, blockiert nie das Portal. Healthcheck + Uptime-Alarm, Runbooks in `docs/`.
4. **Object Storage (Cloudflare R2 oder Hetzner S3, EU)** hinter einer dünnen `storage`-Abstraktion. **Neu (Graft E1): WORM/Object-Lock-Semantik für festgeschriebene Belege** (issued-Rechnungen, signierte Angebots-PDFs) plus Content-Hash in der DB — der DB-Trigger allein schützt das PDF/XML im Storage nicht; damit ist das 8-Jahre-GoBD-Archiv vollständig.
5. **`domain_events`-Tabelle als Outbox ab Tag 1** (Graft E1, beide Pro-E0-Richter): append-only, `{tenant_id, aggregate_type, aggregate_id, event_type, actor, payload, occurred_at}`, Emission **in derselben Transaktion** wie die Mutation. Daraus speisen sich Activity-Feed, Mail-Automatiken, Integrations-Trigger, Kunden-Timeline, spätere Webhooks und KI-Agent-Trigger. Nur Tabelle + Konvention, kein Executor-Framework. Nachrüsten hieße jede Servicefunktion anfassen — das ist der eine wirklich nicht nachrüstbare Punkt, den E0 offen ließ.
6. **E-Mail:** Resend; Kunden-SMTP später. **KI-Schicht:** Claude-API direkt aus Server Actions (Bill Reading, Angebotstexte); kein Agent-Framework in V1.
7. **Reporting:** materialisierte Views für Pipeline/Dashboards statt Live-Aggregation über OLTP-Tabellen (Graft E2) — billig ab Tag 1, erspart spätere Query-Notoperationen.
8. **ADRs im Repo** pro Architektur-/Modulentscheidung (Graft E1): bei Solo+KI-Entwicklung das externe Gedächtnis, Teil der Bus-Faktor-Absicherung.

## 3. Tech-Stack (Wechselkosten ehrlich bepreist)

- **Next.js 16 + TypeScript + Tailwind + shadcn, Drizzle + Neon, Vercel:** gesetzt. Alternativen (Remix, Rails, NestJS+Fly, Supabase) bieten nichts, was 2–12 Wochen Umlernen und den Verlust des eingespielten Skill-Arsenals (Neon-Branches, Chrome-PDF-Pipeline, Drizzle-Fallen) rechtfertigt. RLS geht auf Neon selbst — kein Anbieterwechsel nötig.
- **Exit-Hygiene:** keine Vercel-proprietären APIs außer Hosting/Env, Cron nur als dünner Trigger auf pg-boss, alles läuft auch unter `next start` auf einer VM. Exit-Schätzung ~1–2 Wochen ist eine Annahme, kein Nachweis (Richter-1-Kritik akzeptiert) — Gegenmaßnahme ist die Hygiene selbst, nicht die Zahl.
- **Auth: better-auth** (Magic Link + OTP + Passkeys, Organization-Plugin, Drizzle-Adapter).
- **Queue: pg-boss** — transaktionale Job-Anlage mit Domänendaten, kein SaaS-Lock-in (Inngest/Trigger.dev verworfen).
- **PDF: HTML→Chrome** auf dem Worker (bekannte Fallen dokumentiert), nicht react-pdf.
- **E-Rechnung — geänderte Reihenfolge (Grafts E1+E2):** Rechnung wird intern als **EN-16931-Datenmodell** geführt; ZUGFeRD und XRechnung sind nur Serialisierungen daraus — beide Formate aus einer Quelle, golden-file-testbar, kein „PDF-Nachbrenner". Serialisierer: **zuerst node-zugferd ernsthaft prüfen** (eine Runtime weniger auf dem Worker); Mustang-CLI-Container bleibt Fallback. KoSIT-Validator im CI bleibt in jedem Fall. Damit schrumpft die von Richter 1 kritisierte Drei-Runtimes-Ops-Fläche im besten Fall auf zwei (Node + Python).
- **E-Signatur: selbst bauen** (Click-to-sign, Content-Hash, Zeitstempel, IP, View-Tracking) — einfache elektronische Signatur reicht für B2C-Handwerksangebote, wie bei Reonic.
- **Simulation: pvlib + PVGIS + hplib im Python-Sidecar** — von allen Richtern als fachlich beste Entscheidung bestätigt (E2s Eigenbau-Modell ist der härteste Fehlgriff des Feldes). Davor ein `SimulationEngine`-Interface (Graft E2), damit ein späterer Rust/WASM-Swap Schnittstellen-, kein Umbau-Thema ist. Ergebnisse versioniert als Snapshot am Angebot.

## 4. Datenmodell-Kern

Alle Tabellen tragen `workspace_id` (NOT NULL, Teil jedes Unique-Index und jeder RLS-Policy).

- **`workspace`** (Mandant) → **`user_identity`** (global, E-Mail = Schlüssel) → **`membership`** (Rolle/Rechte pro Workspace).
- **`contact`** (Spine): Consent + Policy-Version, DSGVO-Löschzeitstempel.
- **`site` (Gebäude/Objekt) — neu, Graft E2, von allen Richtern gefordert:** eigene Entität zwischen Contact und Project (Contact 1:n Site 1:n Project). Lat/Lng (Pin bestätigt), Gebäudedaten, Bestandsanlagen. Begründung: Dachmodell und WP-Raummodell hängen am Gebäude, nicht am Projekt; zwei Projekte am selben Haus (PV heute, WP nächstes Jahr) teilen das Aufmaß. Ab Tag 1 als **schmale** Tabelle; Detailmodelle (Roof→RoofSide, Building→Story→Room) erst mit den Modulen. Das Energie-/Gebäudeprofil (`energy_profile`) liegt an der Site, als JSONB **mit Zod-Schema je Profiltyp** (Graft E2 — schließt die „handgewedelte JSONB"-Kritik).
- **`project`**: EIN Datensatz über alle Phasen — `phase: request|offer|installation`, orthogonal `outcome: open|won|lost|cannot_fulfill`, `kanban_column_id`. **Statusmaschinen explizit** (Graft E2): Enums + erlaubte Übergänge in Code für Projekt-Phase, Rechnung, Signatur, Filing — verhindert illegale Übergänge und ist die natürliche Andockstelle für Event-Automatiken.
- **`kanban_board`/`kanban_column`** workspace-konfigurierbar, Spalten-Typ steuert Automatik.
- **`offer` → `offer_variant` → `bom_line`** mit der **wichtigsten Invariante des Systems: Snapshot-Semantik.** `bom_line` kopiert Preis/Name/Datenblatt-Ref aus dem Katalog bei Anlage; `catalog_component_id` bleibt als Herkunfts-Link („Outdated"-Banner + expliziter Bulk-Update, nie stille Propagation). Signierte Variante: `locked_at`, unveränderliches PDF im WORM-Storage, Content-Hash; Änderung nur per Fork; DB-Trigger erzwingt Unveränderlichkeit.
- **`signature_request`**: Token, TTL, View-Count, Status, Attestierungskette append-only.
- **`catalog_component`**: workspace-eigen + globaler Seed-Katalog; technische Daten als JSONB mit **Zod-Schema je Komponententyp**.
- **`invoice` + `invoice_line`**: Status `draft→issued→sent→void`, orthogonaler Zahlungsstatus. `issued` friert Nummer + PDF + EN-16931-Modell ein; **DB-Trigger verbietet UPDATE auf issued-Belegen**. `number_sequence` pro Typ+Workspace mit `SELECT … FOR UPDATE`. Teilrechnungskette über `parent_invoice_id`; **kumulierter Anzahlungsabzug in der Schlussrechnung erzwungen** (§-14c-Schutz als Code). GoBD verlangt Nachvollziehbarkeit, nicht Lückenlosigkeit — keine Sperr-Komplexität für verbrannte Nummern (Richter-1-Korrektur an E1).
- **`checklist_template`** (versioniert) / **`checklist_instance`** (Kopie als JSONB-Baum, Antworten relational in `checklist_answer`).
- **`plant_record`** (kanonisches Anlagen-Datenmodell: Netzanmeldung, § 14a, MaStR, Förderung) **plus generisches `filing`-Muster** (Graft E2): Formular-Snapshot, Statusmaschine, Chat, Datei-Slots — einmal bauen, trägt Netzanmeldung, KfW und Planungsservice. `plant_record` = Daten, `filing` = Prozess.
- **`domain_events`** (fachliche Outbox, s. o.) und — getrennt davon (Graft E1) — **`audit_log`**: wer tat wann was mit welchen Rechten, inkl. abgelehnter Zugriffe und Rechteänderungen. Events = Fachlichkeit, Audit = Compliance-/DSGVO-Nachweis; beide append-only, read-only per DB-Rechten.
- **`task`, `appointment`, `note`, `file`** (project-scoped, `visible_to_customer`), **`integration_delivery_log`**.
- **Förder-Regelwerk + VNB-Verzeichnis als Datentabellen mit `valid_from`/`valid_to`** — redaktionell gepflegt ab Woche 1: das ist der Moat, nicht der Code.

Drei durchgehende Muster (E2s Formulierung, übernommen): Snapshot statt Referenz an jeder kommerziellen Grenze; Statusmaschinen explizit; append-only für alles Rechtliche.

## 5. Mandanten / Auth / Rechte

- **Shared Schema + `workspace_id` + Postgres-RLS ab Tag 1**, zwei Verteidigungslinien:
  (1) Nutzeraktionen laufen über `authorizedAction` → `withSessionTenant`, das
  als erste SQL-Anweisung `READ COMMITTED`, danach `SET LOCAL app.workspace_id` und erst
  nach erfolgreicher Membership-Auflösung die verifizierte `user_identity.id` als
  `SET LOCAL app.actor_id` setzt. Actorloser Membership-Bootstrap/Recovery läuft
  ausschließlich über den isolierten DB-Principal `app_system`, nicht über das
  Runtime-Secret. (2) RLS-Policies
  auf jeder Tabelle. Ein vergessener `where` wird damit Datenpanne-unmöglich statt
  -wahrscheinlich. Schema-/DB-per-Tenant verworfen.
- **Auth passwortlos** (Magic Link + OTP via better-auth, Passkeys gratis), eine Identität in n Workspaces. OIDC-SSO später. Kundenportal/Funnel: signierte Token-Links mit TTL, strikt getrennt vom Mitarbeiter-Auth.
- **Rechte in 3 Schichten**: Workspace-Feature-Flags → Rolle `viewer|editor|admin` → ~8 Einzelrechte als JSONB am Membership (`see_purchase_prices`, `edit_prices`, `discounts`, `invoicing`, `convert_phase`, `manage_catalog`, `manage_settings`, `external_only`). **Alle Prüfungen durch eine zentrale `can(user, action, resource)`-Funktion** — Verfeinerung Richtung Reonics 4 Schichten/20 Rechten kostet später Daten, nicht Code. `external_only` → eigene RLS-Policy (nur zugewiesene Projekte).
- **Membership-DML hat drei DB-Schranken (ADR 0003/0004):** Runtime besitzt nur SELECT;
  restriktive Principal-Policies plus Statement-Trigger verlangen zusätzlich die
  nicht fälschbare NOLOGIN-Markerrolle `app_membership_writer`. Danach verbieten
  befehlsspezifische
  actorbasierte `AS RESTRICTIVE`-Policies verbieten Self-INSERT/-UPDATE/-DELETE; ein
  `SECURITY INVOKER`-Statement-Trigger sperrt den Workspace vor Zielzeilen, ein Row-
  Trigger lässt fremde Mutationen nur durch einen Admin desselben Workspace zu und hält
  Identitätsspalten unveränderlich. `READ COMMITTED` wird im App-Einstieg und DB-seitig
  erzwungen, damit die Rollenprüfung keinen alten Snapshot akzeptiert. Service-Code
  prüft trotzdem vorher mit `can()` und erzeugt auditierbare `PermissionDeniedError`;
  die Trigger sind der Backstop, nicht die Benutzerfehlermeldung.
- **Trust Boundary:** Custom-GUCs transportieren Kontext, authentifizieren aber keinen
  beliebigen SQL-Caller. Browserpfade dürfen deshalb weder `withTenant` noch
  `withAuthorizedTenant` verwenden; ausschließlich parametrisierte Queries sind
  zulässig. M1-03 schließt Membership-Schreiben durch Runtime auch bei GUC-Spoof und
  einem einzelnen Grant-Drift, behauptet aber keine SQL-Injection-Garantie für alle
  anderen Tenant-Tabellen. Das verbleibende Pilot-Gate steht in M1-03.
- **EK/Marge nie im Client-Payload für Nicht-Berechtigte** — serverseitige Serialisierungs-Filterung, kein CSS-Verstecken.

## 6. Mobile-Strategie

**PWA zuerst; nativ nur für den einen Hardware-Grund.** Monteur-Kernfälle (Checklisten offline, Foto-Batch, Zeiterfassung, Projektliste) sind PWA-fähig; eine zweite Codebasis kostet den Solo-Gründer dauerhaft ~30 % Kapazität. **Offline-Fläche bewusst schmal** (Reonics eigenes Muster): offline-first NUR Checklisten-Antworten, Fotos, Zeiterfassung — Rest online-only. Implementierung: IndexedDB-Outbox mit append-only Operationen (client-generierte UUIDv7, idempotente Server-Mutationen), Replay bei Konnektivität, last-write-wins pro Feld — Konflikte sind bei „ein Monteur, seine zugewiesene Checkliste" selten; das Event-Log dient als Beweismittel. Kein CRDT, kein Replicache. Fotos via presigned URLs direkt zu R2, Background-Sync/Retry. **Ehrliche Lücke:** LiDAR/RoomPlan und AR gehen nicht als PWA → WP-Aufmaß startet mit manueller Raumeingabe (Reonics Android-Fallback beweist Produktionstauglichkeit); eine dünne Capacitor-Hülle mit Swift-RoomPlan-Plugin erst, wenn das WP-Modul Umsatz trägt — 95 % Code bleibt dann geteilt.

## 7. Integrationsmuster

Drei wiederverwendbare Bausteine, alle event-gestützt:

1. **Inbound (Broker/Webhooks/CSV):** generische `POST /api/inbound/:source`-Route → validieren → rohes Payload in `inbound_event` (Idempotenz-Key = tenant+source+record-ID) → pg-boss-Job mappt zu Contact+Site+Project, emittiert `lead.created`. Neuer Broker = neues Mapping-Modul. Dedupe kontaktbasiert cross-broker; Polling-Quellen laufen im Worker mit Cursor.
2. **Outbound-Push (Lexware/sevDesk/DATEV-ZIP):** `IntegrationAdapter`-Interface (`pushContact`, `pushInvoice`, `healthcheck`), ausgelöst per Event oder Button; jede Zustellung als `integration_delivery_log`-Zeile (Payload-Snapshot, Status, manueller Replay — Reonic-Parität). Lexware-Falle: Abschlagsrechnungen nur lesend → eigene Fakturierung führt, Push ist Kopie. **Per-Tenant-Credentials verschlüsselt, Schlüssel außerhalb der DB** (Graft E1) — vor dem ersten Connector.
3. **Externe Daten-APIs (PVGIS, Google Solar `buildingInsights`, MaStR-SOAP):** dünne Clients im Worker, aggressiver Response-Cache in Postgres (TMY je Rasterzelle, buildingInsights je Adresse).

Eigene REST-API v1 + signierte Webhooks: erst bei zahlendem Bedarf — aber weil Server Actions dünne Wrapper um Service-Funktionen sind und `domain_events` existiert, ist das dann Exponierung plus Wochenprojekt, kein Umbau.

## 8. Teststrategie

Testbudget dahin, wo Fehler Geld oder Recht kosten:

1. **Geldpfad = pure Functions, höchste Dichte:** Rabatt-Stack, MwSt-Logik (0 %/19 %/§ 13b/Kleinunternehmer), Teilrechnungs-Kumulation, Rundungsausgleich (centgenau, Summe der Teile = Ganzes, Property-Tests), Schlussrechnungs-Anzahlungsabzug, Nummernkreise, Statusmaschinen-Übergänge.
2. **Golden-File-Tests:** Angebots-/Rechnungs-PDF (PyMuPDF-Textextraktion gegen Snapshot), **jede erzeugte XRechnung/ZUGFeRD gegen den KoSIT-Validator im CI** (Docker), DATEV-Exporte gegen Formatspez.
3. **DB-Invarianten gegen echte Test-DB (Neon-Branch pro CI-Lauf):** **generische Tenant-Isolations-Suite, die über ALLE Tabellen iteriert** und bei jeder Schemamigration mitläuft (Graft E1 — Fehlerklasse statt Einzelfall); **Rechte-Matrix-Test** (Action × Rolle × Capability → erwartete `can()`-Entscheidung, Graft E1); Unveränderlichkeit issued-Belege und signierter Varianten per Service **und** per direktem SQL (Trigger-Test); Migrationen immer `generate` **und** `migrate`.
4. **Playwright-E2E, nur ~6 Flows:** Lead→Angebot→Signatur→Rechnung, Offline-Checkliste→Replay, Login. Nicht mehr — E2E-Pflege frisst Solo-Kapazität.
5. **Simulation:** pvlib einmalig gegen PVGIS-Referenzfälle validieren, dann Regressionssnapshots; Annahmen im PDF ausweisen.
6. Codex-Background-Review vor Merge; GitHub Actions.

## 9. Risiken und Gegenmaßnahmen

| Risiko | Gegenmaßnahme |
|---|---|
| **Scope-Erschlagung** | Strikte Modulreihenfolge, Pilot nach M1+M2+M8, Nach-Umsatz-Liste hart |
| **GoBD-/§-14c-Fehler** | DB-Trigger-Festschreibung, erzwungener Anzahlungsabzug, KoSIT-CI, WORM-Archiv + Hash, 1× Steuerberater-Review + Verfahrensdoku vor Pilot |
| **Mandanten-Leck** (viel KI-Code) | RLS + `withTenant` doppelt, generische Isolations-Suite bei jeder Migration |
| **Struktur-Erosion durch KI-Code** | dependency-cruiser/ESLint-Grenzen, CI rot; Service-Funktionen als einziger Schreibpfad; ADRs |
| **Snapshot-Disziplin bricht** | Kopier-Semantik im Schema, Locking-Trigger, Golden-Test, „Outdated"-Banner statt Auto-Update |
| **Offline-Sync-Sumpf** | Fläche hart auf 3 Datentypen begrenzt, LWW dokumentiert akzeptiert |
| **Vercel-Grenzen** | Worker ab Tag 1, Exit-Hygiene; Exit-Aufwand als Annahme markiert |
| **Solo-Bus-Faktor** | Managed-Dienste, Compose+Healthcheck+Alarm, Runbooks, ADRs |
| **Rechtsrisiko Nachbau** | Clean-Room strikt (kein Demozugang, keine Katalogdaten, eigenes Naming/UI; § 4 UWG, § 87a UrhG), als CONTRIBUTING-Grundsatz dokumentiert; Markencheck |
| **Moat = Datenpflege, nicht Code** | Förder-/VNB-Tabellen mit Zeitscheiben ab Woche 1, KI-gestützter Redaktionsprozess |
| **Google-Solar-Kosten/ToS** | nur `buildingInsights`, Cache je Adresse, ToS-Prüfung; LOD2 als notierter Ersatzpfad |
| **Falsche Ertragszahlen** | pvlib statt Eigenbau, PVGIS-Referenzvalidierung, versionierte Ergebnis-Snapshots |

## 10. Offene Streitpunkte (bewusst markiert)

1. **Rechte-Modell-Tiefe:** Synthese folgt E0 (3 Schichten, zentrale `can()`); Richter 3 hält Reonics 4-Schichten-Modell (Bereichs-Toggles, Teams transitiv, Lizenzfamilien) als Datenstruktur ab Tag 1 für nicht nachrüstbar. Entscheidung: 3 Schichten, aber Membership-Schema so anlegen, dass Bereichs-Toggles/Teams additive Spalten sind — Restrisiko einer Migrationsrunde bei Enterprise-Kunden wird akzeptiert.
2. **Command-Executor:** mehrheitlich als Zeremonie verworfen; Richter 3 sieht im einheitlichen Schreibpfad die Voraussetzung für API/Agenten. Kompromiss (Service-Funktionen + Events + `can()` im Service) ist eine Wette darauf, dass Disziplin plus Lint reicht — wenn nicht, ist der Executor nur um die Geld-/Rechtspfade nachziehbar.
3. **Offer/Order-Trennung und `asset` vs. `plant_record`:** Richter 3 will E2s Order-Entität früh; Richter 2 sieht darin Widerspruch zum Ein-Projekt-Spine. Entscheidung: vorerst kein separates Order-Modell — signierte Variante + Projekt-Phase tragen den Auftrag; erst wenn Rechnungsseite eigene Wahrheit braucht (Nachträge), wird Order eingezogen. Markiert als bewusstes Nachrüst-Risiko.
4. **node-zugferd vs. Mustang:** Prüfung offen; bis dahin gilt Mustang-Container als Fallback eingeplant.
5. **Exit-Kosten Vercel (~1–2 Wochen):** unbewiesene Annahme; wird nach M8 einmal per Probelauf (`next start` auf VM) verifiziert.

**Kern in einem Satz:** Ein Next.js-Monolith mit lint-erzwungenen Modulgrenzen, RLS-Postgres, Domain-Event-Outbox und einem Hetzner-Worker deckt Reonic funktional schrittweise ab; die nicht nachrüstbaren Investitionen — Snapshot-/Unveränderlichkeits-Semantik mit WORM-Archiv, Site-Entität, Event-/Audit-Trennung, EN-16931-Kern, RLS, Förder-/VNB-Zeitscheiben — sind Tag-1-Entscheidungen von je Stunden bis wenigen Tagen, und alles Übrige bleibt dem Zeitplan Richtung Pilotkunde nach M1+M2+M8 untergeordnet.
