# F13-16 Filing-Post, Audit und Servicepreise (Mail je Übergang, Abrechnung je Vorgang)

Status: SPECIFIED (keine Implementierung, keine Migration auf diesem Branch).
Bezug: M13-Grundmuster „E-Mail je Übergang → Abrechnung pro Vorgang“
(Blaupause 01, M13); ADR-0018 (Transactional Outbox, ID-only, kein PII);
M1-11b/F10-08 (customer_notification + delivery_attempt, portal-link.v1,
Noop-Transport, RESEND_API_KEY-Blocker); F16-10 (8 fixe Template-Keys,
Verwaltung ohne Versand); F13-01/02/03 (Filing-Maschinen),
F13-06/10 (Token-Pfade); Verträge filing-core.v1, filing-transition.v1
(notifyCustomer), service-price.v1; Preise aus Blaupause 01/02/03
(349/219/210/9,90–19,90 €).

STOPP-Regel: Dieser Slice spezifiziert ausschließlich. service_price-Tabelle,
CHECK-/UQ-Erweiterungen, Storno-Kapsel und Feed-Amendment sind SPEC-ONLY —
kein SQL, keine Migration, kein Commit auf diesem Branch.

## §1 Kanten-Mail-Matrix (notify_customer je Kante)

Jede Filing-Transition trägt `notify_customer` (Transport-Vokabular:
filing-transition.v1 `notifyCustomer`). Kundenrelevant sind genau:
eingereicht, bewilligt, abgeschlossen, storniert, Rückfrage — alle übrigen
Kanten bleiben intern still. Der Empfänger ist der Projekt-Contact, live aus
dem Contact-Graphen aufgelöst (Muster M1-11b `resolveRecipient`; portal_invite
ist aktor-gated und worker-seitig nicht lesbar — worker/customer-notification.ts).
Der Outbox-Payload ist ID-only (IDs + Template + Filing-Bezug, nie Adresse
oder Body — ADR-0018).

### service_case (F13-01)

| Kante | notify_customer | Template |
|---|---|---|
| Anlage (`open`) | nein (kein Kundenereignis) | — |
| `open → in_progress` | nein (intern still) | — |
| `in_progress → done` | ja (abgeschlossen) | service-completed.v1 |
| `open/in_progress → cancelled` | ja (storniert) | service-cancelled.v1 |

### grid_registration (F13-02)

| Kante | notify_customer | Template |
|---|---|---|
| `vorbereitung → eingereicht` | ja (eingereicht) | grid-submitted.v1 |
| `eingereicht → genehmigt` | ja (bewilligt) | grid-approved.v1 |
| `genehmigt → fertiggemeldet` | nein (interne Arbeitsmeldung) | — |
| `fertiggemeldet → abgeschlossen` | ja (abgeschlossen) | grid-completed.v1 |
| `* → storniert` | ja (storniert) | grid-cancelled.v1 |

### subsidy_case (F13-03)

| Kante | notify_customer | Template |
|---|---|---|
| `vorbereitung → bza_eingereicht` | ja (eingereicht) | subsidy-submitted.v1 |
| `bza_eingereicht → bza_bewilligt` | ja (bewilligt) | subsidy-approved.v1 |
| `bza_bewilligt → bnd_eingereicht` | ja (BnD-Einreichung) | subsidy-submitted.v1 |
| `bnd_eingereicht → abgeschlossen` | ja (abgeschlossen) | subsidy-completed.v1 |
| `bza/bnd_eingereicht → korrektur` | ja (Rückfrage) | subsidy-info-requested.v1 |
| `korrektur → bza/bnd_eingereicht` | nein (Wiedereinreichung; die Rückfrage-Mail war das Kundenereignis, Status im Portal) | — |
| `* → storniert` | ja (storniert) | subsidy-cancelled.v1 |

### DB→Contract-Mapping (ESTIMATE)

DB-Status bleiben deutsch; filing-transition.v1 ist Transport-Vokabular:
vorbereitung→draft, eingereicht/bza_eingereicht/bnd_eingereicht→submitted,
korrektur→awaiting_info, genehmigt/bza_bewilligt→approved,
in_progress→in_progress, done/abgeschlossen→done, cancelled/storniert→cancelled.
`transitionedBy`: intern (Service-Transition), customer (Token-Pfad),
system (Kapsel-Automatik). `reasonCode` (ESTIMATE-Format):
`<typ>.<von>-<nach>`, z. B. `grid.vorbereitung-eingereicht`.

## §2 Template-Namespace (11 neue Keys unter F16-10-Verwaltung)

Outbox-IDs (kebab-case + `.v1`, Muster cannot-fulfil.v1/portal-link.v1):
service-completed.v1, service-cancelled.v1, grid-submitted.v1,
grid-approved.v1, grid-completed.v1, grid-cancelled.v1,
subsidy-submitted.v1, subsidy-approved.v1, subsidy-info-requested.v1,
subsidy-completed.v1, subsidy-cancelled.v1.

F16-10-Verwaltung je Key (Betreff/Text, Aktiv-Flag, Vorschau — Versand bleibt
extern): snake_case ohne Version, 1:1-Abbildung
(`grid-submitted.v1` ↔ `grid_submitted`, …). Die 8 bestehenden Keys bleiben
unverändert; die Variablen-Allowlist bleibt v1-geschlossen
(customer_name, project_name, portal_link, company_name) — kein Filing-Body
in der Mail (Datensparsamkeit, Details im Portal).

SPECIFIED (keine Migration auf diesem Branch): CHECK-Erweiterung
`customer_notification_template_ck` um die 11 IDs;
`customer_notification_template_invite_ck`: Filing-Templates mit
`invite_id IS NULL` (Empfänger ist der Projekt-Contact, kein Invite).
Neue nullable Spalte `filing_ref TEXT` (Format `<typ>:<vorgangs-id>:<ziel`,
z. B. `service_case:<uuid>:done`; NULL für cannot-fulfil/portal-link) mit
Format-CHECK; die Aktiv-UQ bleibt für `filing_ref IS NULL` bestehen, dazu
eine partielle UQ (workspace, project, template, filing_ref) für
NOT NULL (service_case ist 1:n je Projekt — ohne Filing-Bezug blockierte
die heutige UQ parallele Vorgänge). Idempotency-Key:
`<template>:<filing_ref>` (Alttemplates unverändert).

## §3 Noop-Doktrin (Outbox-Zeile = Zustellwahrheit)

Bis zur RESEND-Freigabe (externer Blocker wie F10-08/F13-10) attestiert
allein der Noop-Transport den ID-only-Aufruf — es geht keine echte Mail
raus. Zustellwahrheit ist die Outbox-Zeile plus Dispatch-Job, beide in
derselben Transaktion wie die Transition geschrieben (ADR-0018-Muster);
Evidenz je Versuch append-only in `customer_notification_delivery_attempt`.

Storno storniert Queued in derselben Transaktion (Muster
portal/service.ts:322-333): der Storno-Übergang ruft die DEFINER-Kapsel
`_f1316_cancel_filing_notifications(workspace_id, project_id, filing_prefix)`
(`<typ>:<vorgangs-id>:`), die alle nicht-terminalen Zeilen des Vorgangs auf
`cancelled_manual` setzt (fachliches Storno, nie Erasure — P2-9-Trennung).
Storno ohne Queued-Zeilen ist ein No-op, kein Fehler.

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
Betrag/Satz — Abrechnungs-Nachvollzug). SPECIFIED-Query
(`modules/service-prices/service.ts`, existiert heute nicht):
`getServicePrice(tx, ctx, {serviceType, at?})` → gültige Revision,
fail-closed (unbekannter Typ → Validation, keine Zeile → NotFound).

## §5 Abrechnungs-Doktrin (manuell, kein Auto-Invoice)

Abrechnung pro Vorgang erfolgt manuell per F8-Positionsimport: ein Editor
mit `invoicing.write` erstellt die Rechnung, Positionen aus der gültigen
service_price-Revision; der Filing-Core trägt den Preis-Snapshot
(filing-core.v1 `priceSnapshot`: amountCents/currency/source mit
service_price|estimate|manual). Muster: Positionen aus versiegeltem
Snapshot (modules/invoicing/service.ts). Kein Invoice-Write in der
Filing-Transitions-Transaktion — ein Auto-Invoice erfordert einen separaten
GoBD-Slice (Nummernkreis-Sperre, Unveränderlichkeit; vgl. M2-03b1 „kein
WORM-/GoBD-Claim") und bleibt bis dahin verboten.

## §6 Audit-Pflicht (Event+Audit, Kapsel-Evidenz, Namensräume)

- Paar-Pflicht: jede Filing-Mutation (Anlage, Transition, Chat-Post,
  Bestätigung, Preis-Revision) schreibt genau ein Domain-Event und ein
  Audit (`allowed: true`) in derselben Transaktion. Denial-Audits nur an
  der Aufrufgrenze in eigener Transaktion (lib/audit.ts-Vertrag).
- Kapsel-Evidenz für Token-Pfade (SPECIFIED): `post_subsidy_message`
  schreibt heute weder Event noch Audit (drizzle/0119 — Lücke), die
  interne Seite schreibt `subsidy_case.message_posted` + Audit
  (modules/subsidy-cases/service.ts). Künftig: Kunden-Post in der Kapsel
  mit `subsidy_case.message_posted` (side: customer) + audit_log —
  Muster: `confirm_service_case` schreibt `service_case.confirmed`
  (drizzle/0107). Audit in Token-Kapseln fehlt heute in beiden Pfaden
  (kein audit_log in 0107/0119) und wird mitgezogen.
- Body-nie-Regel: Event-Payload und Audit-Details tragen nie Chat-Body
  oder Programm-Details — nur IDs + Status/Seite (Muster F13-01 Scopes.3
  „Audit nur IDs + Status"; postSubsidyMessage-Payload `{caseId, side}`).
- Details-ohne-Event-Politik: keine Audit-Details ohne Event-Zwilling.
  DB-Test-Regel: je Mutation genau ein Paar (Event, Audit) mit
  korrelierbaren IDs (auditRef im Filing-Core).
- Kein separates `<typ>.notified`-Event: Outbox-Zeile + Dispatch-Job sind
  die Benachrichtigungs-Evidenz (ADR-0018); die Transition-Events bleiben
  die einzige Event-Quelle (kein Doppel-Counting).
- Namensraum-Empfehlung: je Filing-Typ eigenes Aggregat
  (`service_case.*` besteht; `grid_registration.*`/`subsidy_case.*`
  emittieren heute unter Aggregat `project` — SPECIFIED-Migration zum
  eigenen Aggregat, kein Umbau auf diesem Branch). Feed-Grenze:
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
hat kein Modul, nur die filing-core-Capability); echter Provider-Versand
(RESEND-Freigabe); Feed-Index-Amendment; Preis-Historien-UI; Währung ≠ EUR;
MaStR-/Wallbox-Add-ons und Factoringsätze (keine Preisbasis im Katalog).
