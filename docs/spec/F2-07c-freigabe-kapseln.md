# F2-07c · Freigabe-Lesekapseln (DEFINER-Kapseln für F2-07b)

Status: **SPEC-DRAFT · Lane 7 · Welle 2**
Vorgänger: F2-07b (Ansichten), M2-03b1 (Kapsel-Muster
`read_offer_issuance_status`).

## Befund (verifiziert)

S4-Reader mit direktem Tabellen-SELECT funktionieren nur als Superuser
(DB-Tests grün); als `app_runtime` fehlt SELECT auf
`offer_release_candidate_approval`, `offer_issuance_approval`,
`offer_issuance_withdrawal` (Panels null). Bestand liest via
DEFINER-Kapsel `read_offer_issuance_status`. F2-07b-Reader werden
daher auf neue Lesekapseln umgestellt; kein Tabellen-Grant.

## Kapseln (Namen: Vorschlag)

Namensbegründung: `read_offer_*`-Präfix wie Bestand
(`read_offer_issuance_status`); Suffix je F2-07b-Ansicht
(Ledger/Candidate-Historie/Withdraw-Historie). Chronik (D4-07) bleibt
Direkt-SELECT auf `domain_events` (dort hat `app_runtime` bereits
SELECT; kein PII im DTO, Payload-IDs serverseitig abgeleitet).

Gemeinsam für alle 3: `LANGUAGE plpgsql STABLE SECURITY DEFINER SET
search_path = pg_catalog`, Owner `app_owner`, `REVOKE ALL FROM
PUBLIC`, `GRANT EXECUTE TO app_runtime` (kein Worker-Grant, reine
Reads). RLS: Tabellen bleiben ohne `app_runtime`-Policy; die Kapsel
prüft Kontext selbst wie `read_offer_issuance_status` (Z. 2014–2044 in
`drizzle/0035_m2_03b1_offer_issuance.sql`): `app.workspace_id` =
`requested_workspace_id`, `app.actor_id` gesetzt, Membership-Rolle in
(`viewer`,`editor`,`admin`), `external_only` blockiert, sonst
`42501`. Args immer `(requested_workspace_id uuid,
requested_offer_id uuid)`; optionaler Filter als 3. Arg (NULL =
offer-weit).

### K1 `read_offer_approval_ledger(uuid, uuid, uuid)`

D4-02 + D4-04 (Issuance-Teil). 3. Arg: `requested_issuance_id`
(NULL = alle Issuances des Offers).
`RETURNS TABLE (workspace_id uuid, issuance_id uuid, approved_at
timestamptz, has_zero_tax_treatment boolean, approval_version text,
recipient_and_scope_reviewed boolean, commercial_totals_reviewed
boolean, legal_profile_reviewed boolean,
final_pdf_for_archive_understood boolean,
zero_tax_treatment_reviewed boolean)` — exakt die F2-07b-Whitelist.
Sortierung aufruferseitig nach `approved_at, issuance_id`; Ordinale
(1/2, 2/2) bildet der Reader.

### K2 `read_offer_candidate_history(uuid, uuid, uuid)`

D4-01 + D4-04 (Candidate-Teil). 3. Arg: `requested_candidate_id`
(NULL = alle Candidates des Offers).
`RETURNS TABLE (workspace_id uuid, candidate_id uuid,
variant_revision integer, profile_revision integer, recipient_revision
integer, has_zero_tax_treatment boolean, approved_at timestamptz,
recipient_billing_reviewed boolean, commercial_content_reviewed
boolean, active_profile_reviewed boolean,
not_issued_status_understood boolean)` — exakt F2-07b-Whitelist.

### K3 `read_offer_withdraw_history(uuid, uuid)`

D4-03, offer-weit (kein 3. Arg).
`RETURNS TABLE (workspace_id uuid, issuance_id uuid, reason_code
text, withdrawn_at timestamptz)` — exakt F2-07b-Whitelist.
Verboten in allen 3 RETURNS: `approved_by`, `withdrawn_by`, Hashes,
`artifact_*`, `approval_command`/`withdrawal_command`, Snapshots.

## Migration 0330-Plan (nur Plan, kein Code hier)

`drizzle/0330_f2_07c_offer_approval_capsules.sql`: 3×
`CREATE FUNCTION` (s. o.) + `REVOKE ALL ... FROM PUBLIC` je Funktion
+ DO-Block wie 0035 (Z. 3116–3126): `GRANT EXECUTE` der 3 Kapseln an
`app_runtime` nur wenn Rolle existiert + Journal-Eintrag (Fun-
nktionen angelegt, keine Tabellen-ACL-Änderung, kein Write-Pfad).

## Rollen-Pin-Plan (`scripts/db-role-contract.mts`)

Erweitern analog Issuance-Block (Z. 4242–4281): REVOKE-Liste +
`grant execute ... to app_runtime` um die 3 Kapseln; Owner-Pin
(`:app_owner`, vgl. Z. 5928f), Signatur-Pin mit neuem Body-SHA
(vgl. Z. 6690–6700), EXECUTE-Pin
`app_runtime:<name>(uuid,uuid[,uuid]):EXECUTE:app_owner:false`
(vgl. Z. 8776f), Funktions-ACL-Erwartung (vgl. Z. 9228–9267).
Keine Tabellen-Grant-Änderung (Negativpin bleibt).

## Testmatrix (IDs F207C-*)

- `F207C-EXIST-01`: 3 Kapseln vorhanden, Owner `app_owner`, DEFINER,
  `search_path=pg_catalog`, STABLE (Katalog-Assert).
- `F207C-TENANT-01`: Cross-Tenant-Aufruf → `42501`; Fremd-Offer →
  leere Menge (Muster M2-03b1-DB-Test: `tenantQuery` mit
  `app.workspace_id`/`app.actor_id` per `set_config`).
- `F207C-RUNTIME-01`: Aufruf als `app_runtime` (low-privileged)
  liefert Whitelist-Zeilen; Direkt-SELECT auf die 3 Tabellen als
  `app_runtime` bleibt verboten.
- `F207C-PII-01` (adversarial): RETURNS-Spalten = Whitelist, kein
  `approved_by`/`withdrawn_by`/Hash/Payload/Preis/Adresse; JSON-Dump
  enthält keine Actor-ID.
- `F207C-RBAC-01`: Viewer/Editor/Admin lesen; `external_only` →
  `42501`; Non-Member → `42501`.
- `F207C-PIN-01`: Rollenvertrag grün (neue Pins), kein Tabellen-Grant
  an `app_runtime` für die 3 Tabellen.
