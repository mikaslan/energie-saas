# F10.1 Kundenportal-Skeleton — Link-Infra + Status + Dok-Sicht

Status: **SPECIFIED** (P1+P2-Nachbesserungen eingearbeitet; FREIGABE ausstehend) · Lane: `codex/f10-portal-skeleton` · Migration: 0055
Basis: Modulkatalog F10 (Kundenportal-Skeleton) · M2-04 (§3–§5) als
Token-/RLS-Kanon · **OBSERVED**: Reonic OpenAPI 3.11.0 `GET
/api/v3/solar-planning/{planningUuid}/share` + `SharedAccess` —
Link-Erzeugung (`createShareLink`), `accessStatus`, `revokeSharedAccess`
sind belegt; Ausgestaltung DECIDED WMEE.

## 1. Discovery-Quellen (Clean Room)

- Reonic `SharedAccess` (DOCUMENTED): Share-Link mit Status und Widerruf —
  belegt Link-Infra als eigenständige Schicht vor Portal-Inhalten.
- M2-04 Token-Kanon (DOCUMENTED, `lib/integrations/offers/signature-contract.ts`):
  32-Byte-Zufall (base64url), in DB ausschließlich SHA-256(raw);
  `hashSignatureToken` wirft bei deformiertem Token `TypeError`
  (offener TODO M2-04b: als not_found ohne Orakel behandeln).
- M2-04 Status-Guard-Muster (DOCUMENTED): DB-seitige Zustandsmaschine +
  SECURITY-DEFINER, `signature_view_log` ohne Fingerprinting
  (nur Zeitstempel).
- F10-Verdict: kein Issuance-/Files-Flag im Portal-Scope belegt →
  Skeleton = Link-Infra + Projektstatus-Projektion + Dok-Metadaten-Sicht
  (kein Byte-Serving, kein Upload, keine Signatur im Portal).

## 2. Scope (vertikal)

1. **Invite**: `createPortalInvite({ workspaceId, projectId, ttlDays })`
   → genau EIN aktiver Invite je Projekt (partieller Unique-Index
   `WHERE status='active'`); neue Erstellung entzieht dem alten aktiven
   Invite automatisch (`withdrawn`, Grund `superseded`) — atomar in einer
   DB-Funktion. Gibt Klartext-Token **genau einmal** zurück.
2. **Token**: 32 Byte `randomBytes`, base64url; DB nur `token_hash`
   (SHA-256 über Raw-Bytes, Spiegel M2-04). Deformiertes Token
   (base64url-dekodiert ≠ 32 Byte) → `not_found`-Union, KEIN TypeError/500,
   KEIN Unterschied zu unbekanntem Token (kein Orakel; schließt M2-04-TODO
   für den Portal-Pfad von Tag 1).
3. **Öffentliche Route** `GET /p/[token]`: Token-Hash → Invite `active` +
   `expires_at > now()` → View-Event (nur Zeitstempel) → read-only
   Projektion: Projektstatus (+ Phasen-/Next-Step-Text aus `project`),
   Dok-Liste = `offer_issuance`-Metadaten (id, issued_at, Titel;
   KEINE Bytes, KEINE Download-Links), **gefiltert auf
   `derived_state = 'approved_for_archive_not_issued'`** (final freigegeben,
   nicht entzogen; DOCUMENTED `derivedStateSchema` in
   `modules/offers/issuance-service.ts`). Vorzustände (`queued`, `running`,
   `retry_wait`, `ready_for_approval`, `failed_final`, `approval_pending`)
   und `withdrawn_before_archive` erscheinen NIE im Portal.
   Abgelaufen/entzogen/unbekannt/deformiert → **eigener Endzustand
   „Link ungültig“ (weder Error noch Empty), HTTP 404 mit byte-identischem
   Body in allen vier Fällen** (kein Orakel; 200-vs-404 ist die
   Token-Fähigkeit selbst).
4. **Intern**: Projekt-Seite „Kundenportal“-Sektion — aktiven Link erzeugen
   (Token einmalig anzeigen + Kopieren), entziehen (strukturierter Grund),
   Ablaufdatum sehen. `project.write` (Editor+) für create/withdraw;
   `project.read` (Viewer+) für Status.
5. **TTL**: `ttlDays ∈ 1..60` (Spiegel M2-04); Ablauf serverseitig;
   abgelaufener Link → terminal `expired` (Touch-Funktion beim Resolve).
6. **Events/Audit**: `portal.invite_created`, `portal.invite_withdrawn`,
   `portal.viewed` (Aggregat `project`) + Audit wie Bestand, gleiche
   Transaktion. Der Lazy-Übergang `active→expired` beim Resolve emittiert
   **genau einmal** `portal.invite_expired` (bedingt durch die Transition
   selbst; keine Event-Flut bei wiederholtem Aufruf toter Links).
   Öffentlicher Resolve ist **bewusst capability-frei** (anonyme
   Token-Fähigkeit über DEFINER-Funktion; kein `project.read` nötig,
   kein interner Actor).

**Nicht in F10.1**: Byte-Serving/Downloads, Uploads, Portal-Signatur,
E-Mail-Versand, Mehrfach-Invites pro Projekt, kontakte E-Mail-Bindung
(kein PII-Feld im Skeleton → kein Erasure-Eintrag nötig), Offline.

## 3. Verträge

Neues Modul `modules/portal` (eigener Contract, KEIN Cross-Import aus
`modules/signatures`; Token-Helper lokal gespiegelt):

```
createPortalInvite(ctx, { workspaceId, projectId, ttlDays }) → { inviteId, expiresAt, token } (token genau einmal)
  (Conflict nur bei echter Race; Supersede statt Conflict im Normalfall)
withdrawPortalInvite(ctx, { workspaceId, inviteId, reason }) → { status: "withdrawn" } (nur active; sonst NotFound-Union)
getPortalStatus(ctx, { workspaceId, projectId }) → { active: null | { inviteId, expiresAt, viewCount } }
resolvePortalByToken(token) → { project: { id, status, nextStep }, documents: [{ id, issuedAt, title }] } | NOT_FOUND
  (NOT_FOUND deckt ab: unbekannt, deformiert, withdrawn, expired — ohne Unterscheidung)
```

Fehler-Union: `Validation` (Zod: ttlDays, reason-Enum
`user_request|superseded|project_closed|other`), `NotFound`
(deckt Fremdmandant/entzogen/abgelaufen/deformiert ab),
`Forbidden` (Rolle), `Conflict` (Race-Doppel-aktiv).

## 4. DB-Vertrag (0055)

Additiv; `workspace_id`-gebunden, `UNIQUE(workspace_id, id)`,
RLS/FORCE-RLS, Composite-Tenant-FKs (Muster M2-04):

- `portal_invite`: id, workspace_id, project_id→project, token_hash bytea
  NOT NULL, status CHECK (`active|withdrawn|expired`), expires_at,
  created_by, created_at, withdrawn_at nullable, withdraw_reason nullable.
  Partiell unique `(workspace_id, project_id) WHERE status='active'`.
- `portal_view_log`: id, workspace_id, invite_id→portal_invite,
  viewed_at — append-only, KEIN IP/UA/Referrer.
- **Erasure/Retention**: keine Kunden-PII im Skeleton (`created_by` = interner
  Actor wie Bestand, kein E-Mail-Feld, View-Log nur Zeitstempel) → **kein
  eigener Erasure-Eintrag**; `project_id`-FK mit `ON DELETE CASCADE` —
  Projekt-Erasure entfernt Invites + View-Logs automatisch mit.
- **Rollback (0055)**: rein additiv (neue Tabellen/Funktionen/Trigger, kein
  Backfill, keine Bestandänderung) → Umkehrung dokumentiert als
  Kommentarblock in 0055 (Repo-Konvention forward-only, keine
  Down-Migrationen); verlustfrei für Bestand.
- DB-Funktion `create_portal_invite(w, p, hash, ttl)` (SECURITY DEFINER):
  withdraws alten active (Grund `superseded`) + insert — **Validierung
  (Zod: ttlDays, IDs) läuft im Contract-Layer VOR dem DB-Call**
  (Fail-fast: bei invalidem Input bleibt der alte Invite aktiv).
  `EXCEPTION WHEN unique_violation THEN RAISE 'race_detected'` → Contract
  mappt auf `Conflict` (niemals 500 bei Race-Doppel-aktiv).
- Guard-Trigger: erlaubt nur `active→withdrawn|expired`; **jede Änderung
  einer Zeile mit `OLD.status != 'active'` → EXCEPTION (23514,
  Message `portal_invite terminaler Zustand ist immutable`)**; DELETE nur
  via Projekt-Kaskade (Eltern-Projekt im Statement bereits entfernt),
  sonst 23514.
- `token_hash`: **unsalted SHA-256** über die 32 Raw-Bytes (256-bit Entropie
  braucht keinen Salt; erhält O(1)-Hash-Index-Lookup).
- Öffentlicher Resolve ausschließlich über SECURITY-DEFINER-Funktion
  `resolve_portal_by_token_hash(hash)` (gibt nur die §2-Projektion zurück;
  KEINE `anon`-Policy auf der Tabelle — Tenant-Isolation bleibt geschlossen).
- `db:generate` ohne Drift; Rollenprobe (external/worker denied).

## 5. Testmatrix

| ID | Art | Behauptung |
|---|---|---|
| F1001-CONTRACT-01 | unit (DB-frei) | Token-Roundtrip: generiert→gehasht→auflösbar; deformiert (kürzer/länger/kein-base64url) → NotFound-Union, kein Throw |
| F1001-SVC-01 | service | create → genau ein active; zweites create → altes `withdrawn/superseded`, neues active; parallele creates → genau ein Gewinner, Verlierer `Conflict` (unique_violation-Mapping, kein 500) |
| F1001-SVC-02 | service | TTL-Validierung 1..60; Ablauf → resolve = NOT_FOUND |
| F1001-SVC-03 | service | withdraw nur active; doppelter withdraw → NotFound-Union |
| F1001-RBAC-01 | service | Viewer darf Status, nicht create/withdraw; external/worker/Fremdmandant fail-closed |
| F1001-SVC-04 | service | Events + Transaktionsbindung: create→`invite_created`, withdraw→`invite_withdrawn`, View→`viewed`, Erst-Touch nach Ablauf→genau einmal `invite_expired`; Audit in selber Transaktion |
| F1001-DB-01 | migration | Guard-Trigger: UPDATE an `withdrawn`/`expired`-Zeile → 23514 (`terminaler Zustand ist immutable`); Rollback dokumentiert in 0055 (forward-only) |
| F1001-ROUTE-01 | route (DB) | `/p/[token]` aktiv → 200 Projektion ohne Bytes (nur `approved_for_archive_not_issued`-Docs); unbekannt/deformiert/entzogen/abgelaufen → 404 byte-identischer „Link ungültig“-Body — VERIFIED außerhalb Sandbox |
| F1001-MIG-01 | migration | `db:generate` ohne Drift (GRÜN); partieller Unique-Index wirksam — VERIFIED außerhalb Sandbox |
| F1001-E2E-01 | e2e | Editor erzeugt Link → öffentlicher Aufruf zeigt Status+Dokliste → Withdraw → Link tot (gleicher Endzustand) — VERIFIED außerhalb Sandbox (kein e2e-File, Präzedenz F2-02/F9-03/F16-02) |

DB-Bindung: F1001-SVC-01…04, F1001-RBAC-01, F1001-DB-01, F1001-ROUTE-01
laufen in `tests/db` (geschrieben, Sandbox-blockiert) — VERIFIED außerhalb
Sandbox. F1001-CONTRACT-01 läuft DB-frei (26 Asserts GRÜN).

## 6. UI/A11y

Interne Sektion + öffentliche Seite: echte getrennte
Loading/Empty/Error/Endzustände; `aria-live` für Create/Withdraw;
responsive 320–1920, 400-%-Reflow, Touchziele ≥ 44 px, Tastaturpfad,
kein Offline-Schreibversprechen.
