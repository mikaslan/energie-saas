# F13-16 Filing-Post, Audit und Servicepreise (Mail je Übergang, Abrechnung je Vorgang)

Status: SPECIFIED (keine Implementierung, keine Migration auf diesem Branch).
Bezug: M13-Grundmuster „E-Mail je Übergang → Abrechnung pro Vorgang"
(Blaupause 01, M13); ADR-0018 (Transactional Outbox, ID-only, kein PII);
M1-11b/F10-08 (customer_notification + delivery_attempt, portal-link.v1,
Noop-Transport, RESEND_API_KEY-Blocker); F16-10 (8 fixe Template-Keys,
Verwaltung ohne Versand); F13-01/02/03 (Filing-Maschinen wave-02),
F13-06/10 (Token-Pfade); Verträge filing-transition.v1 (notifyCustomer),
service-price.v1; Preise aus Blaupause 01/02/03 (349/219/210/9,90–19,90 €).

STOPP-Regel: Dieser Slice spezifiziert ausschließlich. service_price-Tabelle,
CHECK-/UQ-Erweiterungen, Storno-Kapsel und Feed-Amendment sind SPEC-ONLY —
kein SQL, keine Migration, kein Produktionscode auf diesem Branch (nur
Spec-, Contract- und skipped-RED-Artefakte).

M2-Bindung: wave-02 trägt F13-01/02/03/04/06/07/09/10/11, aber NICHT den
F13-00/12/13/14/15-Bestand (3c-Lane, keine 026x). Alle Deltas unten sind
gegen wave-02 formuliert (0086/0103/0105/0107/0119/0123/0117/0139);
GREEN erst nach 3c-Integration + Leitstand-Freigabe (M2-Bindungs-Q offen).

## §1 Kanten-Mail-Matrix (notify_customer je Kante)

Jede Filing-Transition trägt `notify_customer` (Transport-Vokabular:
filing-transition.v1 `notifyCustomer`). Kundenrelevant sind genau:
eingereicht, bewilligt, abgeschlossen, storniert, Rückfrage (Q-3C-33 —
jede Kante braucht Kundenrelevanz-Beleg) — alle übrigen Kanten bleiben
intern still. Der Empfänger ist der Projekt-Contact, live aus dem
Contact-Graphen aufgelöst (Muster M1-11b `resolveRecipient`; portal_invite
ist aktor-gated und worker-seitig nicht lesbar — worker/customer-notification.ts).
Der Outbox-Payload ist ID-only (IDs + Template + Filing-Bezug, nie Adresse
oder Body — ADR-0018).

### service_case (F13-01, 0086; Kanten service.ts:229-234)

| Kante | notify_customer | Template |
|---|---|---|
| Anlage (`open`) | nein (kein Kundenereignis) | — |
| `open → in_progress` | nein (intern still) | — |
| `in_progress → done` | ja (abgeschlossen) | service-completed.v1 |
| `open/in_progress → cancelled` | ja (storniert) | service-cancelled.v1 |

### grid_registration (F13-02, 0103; Kanten service.ts:45-52)

| Kante | notify_customer | Template |
|---|---|---|
| `vorbereitung → eingereicht` | ja (eingereicht) | grid-submitted.v1 |
| `eingereicht → genehmigt` | ja (bewilligt) | grid-approved.v1 |
| `genehmigt → fertiggemeldet` | nein (interne Arbeitsmeldung) | — |
| `fertiggemeldet → abgeschlossen` | ja (abgeschlossen) | grid-completed.v1 |
| `* → storniert` | ja (storniert) | grid-cancelled.v1 |

### subsidy_case (F13-03, 0105; Kanten lib/subsidy-case.ts:38-46)

| Kante | notify_customer | Template |
|---|---|---|
| `vorbereitung → bza_eingereicht` | ja (eingereicht) | subsidy-submitted.v1 |
| `bza_eingereicht → bza_bewilligt` | ja (bewilligt) | subsidy-approved.v1 |
| `bza_bewilligt → bnd_eingereicht` | ja (BnD-Einreichung) | subsidy-submitted.v1 |
| `bnd_eingereicht → abgeschlossen` | ja (abgeschlossen) | subsidy-completed.v1 |
| `bza/bnd_eingereicht → korrektur` | ja (Rückfrage) | subsidy-info-requested.v1 |
| `korrektur → bza/bnd_eingereicht` | nein (Wiedereinreichung; die Rückfrage-Mail war das Kundenereignis, Status im Portal) | — |
| `* → storniert` | ja (storniert) | subsidy-cancelled.v1 |

planning_request (0123: strikte Kette requested → in_progress → finished
→ accepted, KEIN Storno) und financing (kein Modul auf wave-02) erhalten
keine Matrix in diesem Slice — eigene Amendments nach M2-Bindung.

### DB→Contract-Mapping (ESTIMATE)

DB-Status bleiben deutsch; filing-transition.v1 ist Transport-Vokabular:
vorbereitung→draft, eingereicht/bza_eingereicht/bnd_eingereicht→submitted,
korrektur→awaiting_info, genehmigt/bza_bewilligt→approved,
in_progress→in_progress, done/abgeschlossen→done, cancelled/storniert→cancelled.
`transitionedBy`: intern (Service-Transition), customer (Token-Pfad),
system (Kapsel-Automatik). `reasonCode` (ESTIMATE-Format):
`<typ>.<von>-<nach>`, z. B. `grid.vorbereitung-eingereicht`.
wave-02-Events heißen `*.status_changed` (nicht `transition`); der
Contract mappt, benennt nicht um.

## §2 Template-Namespace (11 neue Keys unter F16-10-Verwaltung)

Outbox-IDs (kebab-case + `.v1`, Muster cannot-fulfil.v1/portal-link.v1):
service-completed.v1, service-cancelled.v1, grid-submitted.v1,
grid-approved.v1, grid-completed.v1, grid-cancelled.v1,
subsidy-submitted.v1, subsidy-approved.v1, subsidy-info-requested.v1,
subsidy-completed.v1, subsidy-cancelled.v1.

F16-10-Verwaltung je Key (Betreff/Text, Aktiv-Flag, Vorschau — Versand bleibt
extern): snake_case ohne Version, 1:1-Abbildung
(`grid-submitted.v1` ↔ `grid_submitted`, …; kein explizites Mapping im
Bestand — SPEC-ONLY-Funktion `-`→`_`, `.v1` streichen). Die 8 bestehenden
Keys bleiben unverändert; die Variablen-Allowlist bleibt v1-geschlossen
(customer_name, project_name, portal_link, company_name) — kein Filing-Body
in der Mail (Datensparsamkeit, Details im Portal).
Kanon-Schreibweise: `cannot_fulfil` (1 l, Template-Seite); das anderswo
vorkommende `cannot_fulfill` (2 l, project-Schema/Inbox) ist KEIN
Template-Key und wird nicht angeglichen (Falle dokumentiert, kein Umbau).
Andockpunkte Bestand: lib/email-template.ts KEYS/LABELS/DEFAULTS
(Z15-24/27-36/55-88), CHECK drizzle/0139:12, Seed/Order automatisch,
page.tsx-Zählung + f1610-Tests kosmetisch.

SPECIFIED (keine Migration auf diesem Branch): CHECK-Erweiterung
`customer_notification_template_ck` (0117:5) um die 11 IDs;
`customer_notification_template_invite_ck` (0117:6): Filing-Templates mit
`invite_id IS NULL` (Empfänger ist der Projekt-Contact, kein Invite).
Guard-Verzweigung 0117:48-82 je Template (Idempotenz-Key-Format +
Vorbedingung, Muster portal-link Z63-78). Neue nullable Spalte
`filing_ref TEXT` (Format `<typ>:<vorgangs-id>:<ziel`, z. B.
`service_case:<uuid>:done`; NULL für cannot-fulfil/portal-link) mit
Format-CHECK; die Aktiv-UQ 0117:4 bleibt für `filing_ref IS NULL`
bestehen (generisch, kein Edit), dazu eine partielle UQ
(workspace, project, template, filing_ref) für NOT NULL (service_case
ist 1:n je Projekt — ohne Filing-Bezug blockierte die heutige UQ
parallele Vorgänge). Idempotency-Key: `<template>:<filing_ref>`
(Alttemplates unverändert). Contract-Seite: CUSTOMER_NOTIFICATION_TEMPLATE_IDS
(contract.ts:16-19) + Noop-Allowlist (resend-transport.ts:53-57).

## §3 Noop-Doktrin (Outbox-Zeile = Zustellwahrheit)

Bis zur RESEND-Freigabe (externer Blocker wie F10-08/F13-10, Beleg
contract.ts:14 + 0117:13-14) attestiert allein der Noop-Transport den
ID-only-Aufruf — es geht keine echte Mail raus (nur Noop verdrahtet,
resend-transport.ts:49-75, worker/index.ts:345). Zustellwahrheit ist
die Outbox-Zeile plus Dispatch-Job, beide in derselben Transaktion wie
die Transition geschrieben (ADR-0018-Muster: INSERT queued in
Fach-Transaktion service.ts:248-253, Dispatch pgboss
enqueue_customer_notification Queue `notification.customer`, Payload
ID-only, Handler resolveTemplate→resolveRecipient→send→deliver,
Evidenz je Versuch append-only in `customer_notification_delivery_attempt`
via `_m111b_worker_deliver`, idempotent, Deckel 10→failed_final).

Storno storniert Queued in derselben Transaktion (Muster
`_f1008_cancel_project_portal_notification`, 0117:158-181, aufgerufen aus
withdrawPortalInvite service.ts:322-333; Rotation in create_portal_invite
0117:243-249): der Storno-Übergang ruft die DEFINER-Kapsel
`_f1316_cancel_filing_notifications(workspace_id, project_id, filing_prefix)`
(`<typ>:<vorgangs-id>:`), die alle nicht-terminalen Zeilen des Vorgangs auf
`cancelled_manual` setzt (fachliches Storno, nie Erasure — P2-9-Trennung;
Erasure-Pfad cancelled_contact_erased unberührt, DELETE/TRUNCATE verboten
0117:33-36). Storno ohne Queued-Zeilen ist ein No-op, kein Fehler.

## §4 service_price-Tabelle (SPEC-ONLY, kein SQL)

| Spalte | Typ/Regel |
|---|---|
| id, workspace_id | uuid; RLS tenant_isolation + FORCE (M1-CRM-Muster) |
| service_type | TEXT, CHECK IN (netz_pv, netz_wp, foerderung, planung_standard, planung_express) — aus service-price.v1 |
| amount_net_cents | INT, CHECK ≥ 0 (netto; Websitepreise als netto gelesen — ESTIMATE, Gegenprobe offen) |
| vat_rate_percent | NUMERIC(5,2), NOT NULL DEFAULT 19.00 (ESTIMATE, je Revision pflegbar) |
| currency | TEXT, CHECK = 'EUR' |
| valid_from / valid_to | TIMESTAMPTZ; valid_to NULL = aktuell; CHECK-Reihenfolge |
| revision | INT ≥ 1; UNIQUE (ws, service_type, revision); partielle UNIQUE (ws, service_type) WHERE valid_to IS NULL |
| source | TEXT, CHECK IN ('catalog_estimate','manual'); Seed = catalog_estimate |
| created_by/updated_by + Timestamps | F16-Muster |

Seed (ESTIMATE-markiert, aus Blaupause 01:144-146/201, 02-Marktbild,
03-Integrationskarte): netz_pv 34900, netz_wp 21900, foerderung 21000,
planung_standard 990 (48 h/Datum), planung_express 1990 (24 h) — Cent,
netto, EUR. Die 9,90↔Standard/19,90↔Express-Zuordnung folgt der
Fristwahl (ESTIMATE).

Zugriff: Lesen `installation.read` (Akte-Kontext); Schreiben
`price.edit` (bestehend: editor + edit_prices-Capability — lib/permissions.ts,
keine neuen Keys). Preise sind revisions-append-only (nie UPDATE auf
Betrag/Satz — Abrechnungs-Nachvollzug, Q-3C-34). SPECIFIED-Query
(`modules/service-prices/service.ts`, existiert heute nicht):
`getServicePrice(tx, ctx, {serviceType, at?})` → gültige Revision,
fail-closed (unbekannter Typ → Validation, keine Zeile → NotFound).

## §5 Abrechnungs-Doktrin (manuell, kein Auto-Invoice)

Abrechnung pro Vorgang erfolgt manuell per F8-Positionsimport (Q-3C-35):
ein Editor mit `invoicing.write` erstellt die Rechnung, Positionen aus
der gültigen service_price-Revision; der Filing-Core trägt den
Preis-Snapshot (service-price.v1 `$def priceSnapshot`:
amountCents/currency/source mit service_price|estimate|manual — KEIN
eigener filing-core-Contract, $defs inline nach Hausstil). Muster:
Positionen aus versiegeltem Snapshot (modules/invoicing/service.ts).
Kein Invoice-Write in der Filing-Transitions-Transaktion — ein
Auto-Invoice erfordert einen separaten GoBD-Slice (Nummernkreis-Sperre,
Unveränderlichkeit; vgl. M2-03b1 „kein WORM-/GoBD-Claim") und bleibt
bis dahin verboten.

## §6 Audit-Pflicht (Event+Audit, Kapsel-Evidenz, Namensräume)

- Paar-Pflicht: jede Filing-Mutation (Anlage, Transition, Chat-Post,
  Bestätigung, Preis-Revision) schreibt genau ein Domain-Event und ein
  Audit (`allowed: true`) in derselben Transaktion (emitEvent in-tx
  lib/events.ts:4-19, Erfolgs-Audit in-tx lib/audit.ts:7-10, Filing-Paare
  service-cases 152-167/269-284, subsidy-cases 335-350/451-466/533-548,
  grid-registration 181-196/291-306). Denial-Audits nur an der
  Aufrufgrenze in eigener Transaktion (lib/audit.ts:12-26, vollzogen
  lib/action.ts:120-129; Service wirft nur PermissionDeniedError).
- Kapsel-Evidenz für Token-Pfade (SPECIFIED): `post_subsidy_message`
  schreibt heute weder Event noch Audit (drizzle/0119:96-109 — Lücke),
  die interne Seite schreibt `subsidy_case.message_posted` + Audit
  (modules/subsidy-cases/service.ts:533-548). Künftig: Kunden-Post in
  der Kapsel mit `subsidy_case.message_posted` (side: customer) +
  audit_log — Muster: `confirm_service_case` schreibt
  `service_case.confirmed` (drizzle/0107:721-732). Audit in Token-Kapseln
  fehlt heute in beiden Pfaden (kein audit_log in 0107/0119) und wird
  mitgezogen.
- Body-nie-Regel (Q-3C-37): Event-Payload und Audit-Details tragen nie
  Chat-Body oder Programm-Details — nur IDs + Status/Seite (Belege:
  `{caseId,side}` subsidy service.ts:539/547, service.create
  `payload:{projectId}` ohne Titel, confirm `{caseId,inviteId}` ohne
  Token 0107:727-730, DSGVO-Regel sites/service.ts:77-84).
- Details-ohne-Event-Politik: keine Audit-Details ohne Event-Zwilling.
  BESTANDS-AUSNAHME (grandfathered, kein Umbau): `set*Details` schreibt
  heute nur Audit ohne Event (subsidy-cases/service.ts:390-397,
  grid-registration/service.ts:236-243). DB-Test-Regel für Neues: je
  Mutation genau ein Paar (Event, Audit) mit korrelierbaren IDs.
- Kein separates `<typ>.notified`-Event: Outbox-Zeile + Dispatch-Job sind
  die Benachrichtigungs-Evidenz (ADR-0018); die Transition-Events bleiben
  die einzige Event-Quelle (kein Doppel-Counting).
- Namensraum-Empfehlung: je Filing-Typ eigenes Aggregat
  (`service_case.*` besteht; `grid_registration.*`/`subsidy_case.*`
  emittieren heute unter Aggregat `project` — SPECIFIED-Migration zum
  eigenen Aggregat, kein Umbau auf diesem Branch;
  `planning_request.*` bereits eigen). Feed-Grenze:
  `domain_events_project_activity_idx` (lib/db/schema/events.ts:27-46)
  listet nur `project.*`-Typen — Filing-Events erscheinen nicht im
  Projekt-Feed; Aufnahme erfordert ein Index-Amendment (Migration,
  eigener Slice). Bis dahin Verlauf per Aggregat-Abfrage (F13-02-Muster).

## Testmatrix (geschlossen, Folge-Slices)

- F1316-DB-01: Matrix-Mails — je kundenrelevanter Kante genau eine
  Queued-Zeile mit korrektem Template + filing_ref; stille Kanten ohne
  Zeile; illegale Kanten fail-closed ohne Zeile.
- F1316-DB-02: Storno-in-Tx — Storno storniert Queued desselben Vorgangs
  (cancelled_manual), fremde Vorgänge/Templates unberührt; ohne Zeile No-op.
- F1316-DB-03: Kapsel-Evidenz — Token-Chat-Post schreibt
  message_posted (customer) + Audit; Body in keinem Payload/Detail.
- F1316-DB-04: service_price — Seed-5, Revisions-Append-only,
  Gültigkeitsfenster, price.edit-Guard (Viewer denied), Isolation.
- F1316-E2E-01: Transition → Outbox-Zeile intern sichtbar, kein Versand
  (Noop), Portal-Status konsistent; kein Mail-Assert ohne Provider.
- Unit: RED-Test tests/unit/f1316-mail-audit-preis.red.test.ts (6 Tests,
  ROT-Beleg unten, danach describe.skip bis zur Umsetzung).

### ROT-Beleg (Auszug, `npx vitest run tests/unit/f1316-mail-audit-preis.red.test.ts`)

```text
 Failed Tests 6
 FAIL  ... > Transition mailt Outbox-Zeile: grid-submitted.v1 ist als Outbox-Template gepinnt
 FAIL  ... > Noop-Transport akzeptiert das Filing-Template (ID-only-Aufruf)
 FAIL  ... > Template-Key registriert: grid_submitted steht unter F16-10-Verwaltung
 FAIL  ... > service_price-Query existiert (modules/service-prices/service.ts)
 FAIL  ... > Kapsel-Evidenz: Token-Chat-Post schreibt subsidy_case.message_posted
 FAIL  ... > Storno storniert Queued: Filing-Storno-Kapsel existiert
 Test Files  1 failed (1)
      Tests  6 failed (6)
```

Danach `describe.skip` bis zur Umsetzung (SKIP-Grund im Testkopf).

## Bewusst offen

planning_request-/financing_request-Matrix (eigene Amendments; financing
hat kein Modul, nur Katalog F13.4); echter Provider-Versand
(RESEND-Freigabe); Feed-Index-Amendment; Preis-Historien-UI; Währung ≠ EUR;
MaStR-/Wallbox-Add-ons und Factoringsätze (keine Preisbasis im Katalog);
M2-Bindung (3c-Bestand F13-00/12/13/14/15 fehlt auf wave-02 — GREEN erst
nach Integration + Freigabe).
