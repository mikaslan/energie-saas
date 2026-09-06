# F7.1 — Installation Kern (Slice A: Anlage, Basic-Lesen, Abschluss)

Status: **IMPLEMENTED (VERIFIED pending CI/Maschine — Billing-Block Q6)**

## Umsetzung

- 0069 + Rollenvertrag (Pin PENDING-ORAKEL) + 2 Permissions (Matrix 51).
- Tests: f701-DB (Anlage/Phase/Conflict/Scope/Complete/Isolation),
  E2E-01/02 (Seed w3-f71) auf der Projektseite.
- UI: Installations-Sektion (eigener h2, kein Section-Wrapper) +
  Anlage/Abschluss-Actions. Reviews Exit-3.
Basis: Modulkatalog M7/F7.1 („Phasenwechsel per Signatur (auto) oder
Direkterstellung (Modal, überspringt Signatur); Tabs: Basic, Workbook,
Order Parts, Grid Registration, Subsidy, Handover, Services, Checklist,
Files, Kalender").

> **Abgrenzung 2026-09-06:** F2.8b/M204-I1 setzt eine digitale oder analoge
> Annahme atomar auf `Won`, erzeugt aber bewusst **keine** Installation. Der im
> Modulkatalog genannte Auto-Weg bleibt wegen widersprüchlicher Live-Evidenz
> `ESTIMATE` und benötigt einen eigenen Slice; er ist kein Bestandteil von
> F7.1 Slice A oder F2.8b.

## 1. Discovery-Quellen (Clean Room)

- Katalog F7.1: Zwei Entstehungswege (Signatur-auto, Direkt-Modal), ein
  Tab-Satz. Alle Tabs außer Basic haben eigene Slices (F7.2 Checklisten
  existiert; Workbook/Plantafel/Handover/Order Parts/Fotos folgen).
- Ist-Repo **vor Slice A**: kein `installation`-Modell (Grep über modules, Schema,
  Migrationen: nur Worttreffer in Kommentaren). Projektseite
  (`app/w/[workspaceId]/anfragen/[projectId]/`) ist sektionsbasiert
  (Präzedenz Termin-Sektion) — eine Installations-Sektion passt ins
  Muster.
- F2.8b/M204-I1 integriert `signature.signed` inzwischen synchron in das
  Projektergebnis: `open→won`. Der mögliche Auto-Installationsweg ist weiterhin
  als Slice B anbindbar, darf aber nicht allein aus dem Eventnamen abgeleitet
  werden.

### FACT / INFERENCE / ESTIMATE zum Signatur-Handoff

- **FACT:** Digitale und analoge Annahme setzen das Angebot auf `Won`
  ([digitaler Signierfluss](https://docs.reonic.com/docs/en/offers-finalise-cat-preview-variants-legal-texts-offer-link-validity),
  [analoger Upload](https://docs.reonic.com/docs/en/offers-finalise-cat-upload-manual-signature)).
- **FACT:** Die [OpenAPI v3.11.0](https://api.reonic.de/rest/v3/openapi)
  modelliert `deal.state`, Projekt-`stage` und `installationCreatedAt`
  getrennt. Deal-Abschluss ist daher nicht identisch mit einer belegten
  Installationserzeugung.
- **INFERENCE:** Die bestehende `installation.source = signature`-Reserve ist
  der passende spätere technische Zielpfad, falls Live-Evidenz eine
  automatische Anlage bestätigt.
- **ESTIMATE:** Exakter Auslöser und Zeitpunkt bleiben unklar. Öffentliche
  Texte nennen nachgelagerte Installation/Integrationen, beschreiben den
  Installationsstart andernorts aber als späteren Handoff mit eigener
  Variantenwahl
  ([Widerruf, Fork und Installations-Handoff](https://docs.reonic.com/docs/en/offers-finalise-cat-revoke-offer)).
  Bis zur Klärung bleiben `installation`, `project.phase` und
  `kanban_column_id` bei Signaturannahme unverändert.

## 2. Scope Slice A (vertikal, klein)

1. **Tabelle** `installation` je Projekt: genau eine Zeile je Projekt
   (unique project_id), kein Archiv; Storno = Status. Felder: id,
   workspace_id, project_id, source (`direct` in A; `signature`
   reserviert für B), status (`active`/`completed`), offer_id/
   variant_id (nullable, reine Referenz ohne FK in die Offer-Kette),
   timestamps. Migration **0069**.
   Phasenwechsel: Create setzt `project.phase = 'installation'`
   (M2-01-Präzedenz); `kanban_column_id` bleibt unverändert — es gibt
   keinen Installation-Spalten-Typ (`lead/offer/won/lost`), Board-Mapping
   folgt in Slice B. Erlaubt aus Phase `request` oder `offer`.
2. **Service** `modules/installations/service.ts` (neues Modul, Muster
   lead-sources): create (direct, Idempotenz: zweites Create bei
   existierender Installation → Conflict, kein Upsert),
   complete (nur aus `active`), get (read view für Basic-Tab),
   list-by-project (genau 0/1).
3. **UI**: Projektseite-Sektion „Installation" (Basic-Lesen: Status,
   Quelle, Abschluss-Datum) + Direkt-Anlage (Quelle fest `direct`,
   ohne Offer-Picker — Angebots-Verknüpfung kommt mit Workbook F7.6,
   das Varianten-Auswahl braucht). Abschluss-Button (explizites
   „Abschließen"-Submit, kein JS-Confirm).
4. **Rechte**: neue Actions `installation.read` (viewer) /
   `installation.write` (editor), internalOnly, keine Capability.
5. **RLS/ACL**: `installation` tenant_isolation + FORCE (0060-
   Formulierung), Grants SELECT/INSERT/UPDATE an app_runtime
   (Rollenvertrag + Pin per Orakel, Präzedenz 23b3411).

**Nicht in Slice A**: Auto-Anlage bei Signatur (Slice B, erst nach belastbarer
Live-Klärung; `signature.signed` allein ist kein hinreichender Triggerbeleg),
Workbook/Rollups/Stückliste (F7.6),
Plantafel/Zuweisung (F7.5), Handover-PDF/Unterschrift (F7.7),
Order Parts (F7.8), Fotos, alle übrigen Tabs, Storno/Archiv,
Mehrfach-Installationen je Projekt.

## 3. Verträge

### 3.1 Status

`active` → `completed` (einweg, kein Reopen in A). `completed_at`
wird beim Abschluss gesetzt (statement_timestamp). Kein Löschen.

### 3.2 Service-Signaturen

```
createInstallation(ctx, { projectId, offerId|null, variantId|null }) → dto
  // offer/variant nur als Referenz; Scope-Prüfung: Offer gehört zum
  // Projekt (Scope-Miss → OfferNotFoundError, kein Leak).
getInstallation(ctx, { projectId }) → dto | null
completeInstallation(ctx, { projectId }) → dto
  // nur aus active, sonst ValidationError; No-op? Nein — doppeltes
  // Abschließen ist ValidationError (explizit, kein Stillhalten).
```

Fehler: `InstallationNotFoundError`, `InstallationConflictError`
(existiert bereits), `InstallationValidationError`; Offer-Scope-Miss
wiederverwendet `OfferNotFoundError` aus modules/offers.

### 3.3 Events/Audit

`installation.created` (+source, +offerId?), `installation.completed`.
Audit via writeAudit (Muster lead-sources).

## 4. Testmatrix

| ID | Test | Ebene |
|---|---|---|
| F701-DB-01 | create/get happy path + DTO-Shape | db |
| F701-DB-02 | zweites Create → Conflict; Offer-Scope-Miss → OfferNotFoundError | db |
| F701-DB-03 | complete happy path + doppeltes Complete → ValidationError | db |
| F701-DB-04 | Cross-Workspace-Isolation + Viewer-Schreibsperre | db |
| F701-PERM-01 | Matrix wächst um 2 Actions (49 → 51) | unit |
| F701-JRN-01 | m111a-Journal: idx 69 / TOTAL 70 | db |
| F701-E2E-01 | Direkt-Anlage per Modal, Basic-Sektion sichtbar | e2e |
| F701-E2E-02 | Abschluss per UI, Status + Datum sichtbar | e2e |

## 5. Nachweise

- Katalogvertrag: Command-Versionen `installation-command.v1`
  (Schemas in neuem `lib/integrations/installations/contract.ts`?
  DECIDED: nein — kein Integrationsvertrag ohne Gegenstelle; zod-
  Schemas leben im Service-Modul wie bei lead-sources. Offer-Schema-
  Doc bleibt unberührt, kein Re-Pin nötig.)
- Reviews: Kimi + DeepSeek (Exit-3 ohne Key → Gates entscheiden).
- Signaturgrenze: `docs/spec/F2-08b-signaturakzeptanz-won.md` und ADR 0023;
  DB-Nachweise müssen nach Annahme `Won` bei weiterhin 0 Installationen sowie
  unveränderter Phase/Kanban-Spalte belegen.
