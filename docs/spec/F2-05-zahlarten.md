# F2.5 — Zahlarten (Slice A: Stammdaten + Varianten-Auswahl, ohne Provider)

Status: **SPECIFIED**
Basis: Modulkatalog F2.5 („Zahlarten pro Komponente: Kauf / Finanzierung
(Bees&Bears mit Status-Rückmeldung, ‚Classic' als reine Anzeige) / Leasing;
Reonic wickelt keine Zahlungen ab").

## 1. Discovery-Quellen (Clean Room)

- Modulkatalog F2.5: drei Zahlarten pro Komponente — Kauf, Finanzierung,
  Leasing. Nur Finanzierung hat eine Provider-Rückmeldung (Bees&Bears);
  „Classic" ist reine Anzeige; Zahlungen wickelt Reonic nicht ab.
- Live-Signatur-API (M2-04-Spec §2.2, read-only): `offerDocuments[]`-Einträge
  sind `{ variantId*, paymentOptionId* (nullable), pdfUrl* }`;
  `signedPaymentOptionId` ist „null until signed, or for
  legacy/default-payment documents". → Die Zahlart ist eine **nullable
  Auswahl je Variante**, kein Pflichtfeld, kein Default mit
  Zahlungssemantik.
- M2-04 bindet genau ein Dokument (eine Variante + optionale Zahlart);
  Mehr-Zahlarten-Auswahl ist dort NICHTZIEL. Slice A bleibt dabei:
  **genau eine Zahlart je Variante**, keine Staffeln, keine Ratenpläne.
- Ist-Repo: kein Zahlungsmodell vorhanden (Grep über
  `lib/integrations/offers`, `modules/offers`, Angebots-UI: keine
  financing/leasing/payment-Treffer). Echter Provider-Verkehr
  (Bees&Bears-Bonität/Status, PSD-Bank) ist in dieser Sandbox weder
  lesbar noch aufrufbar → PROVDER-Teil ist NICHTZIEL dieses Slices.

## 2. Scope Slice A (vertikal)

1. **Stammdaten**: Tabelle `payment_option` je Workspace — Schlüssel
   (`purchase`, `financing_classic`, `leasing`), Label (frei, 1–120),
   Art (`purchase`/`financing`/`leasing`), Archivierung statt Löschung
   (`archived_at`; Reonic-Muster wie F1.8 Lead Sources).
2. **CRUD-Service**: create / update / archive / restore / list
   (Filter aktiv/archiviert). Schlüssel je Workspace genau einmal
   (partial-unique über aktive Zeilen); unbekannte Id →
   `PaymentOptionNotFoundError`, Schlüssel-/Namenskollision →
   `PaymentOptionConflictError`.
3. **Auswahl**: `offer_variant.payment_option_id` (nullable FK,
   ON DELETE RESTRICT als Schutznetz; kein Hard-Delete möglich).
   `setVariantPaymentOption(offerId, variantId, paymentOptionId|null)` —
   revisionslos auf der stabilen `offer_variant`-Zeile (Präzedenz F2.2
   `setOptionalBundles`: kein Revise-Op, eigenes Audit-Event,
   `updatedAt`-Touch). Archivierte Option ist nicht mehr wählbar;
   gesetzte Historie bleibt referenzierbar. Recht: `project.write`
   (keine neue Matrix-Action, M2-01-Muster).
4. **UI**: Editor-Sektion (F2.2-Panel-Muster): Dropdown der aktiven
   Optionen + „Keine Angabe", Anzeige-Badge an der Variante.
   Read-only-Zweig zeigt nur die Auswahl. Keine Beträge, keine
   Raten, keine Zinssätze — reine Anzeige (Katalog: „Classic als
   reine Anzeige", auf alle drei Arten verallgemeinert).
5. Migration **0068** (ein File, additiv; Backfill: keine — alles
   nullable, keine Defaults mit Zahlungssemantik).

**Nicht in Slice A** (eigene Slices): Bees&Bears-Status-Rückmeldung und
Antragstrecke (Provider, F13.4-Nähe), Raten-/Zinsberechnung (keine
erfundene Finanzmathematik), Kunden-Auswahl auf der Signaturseite
(F2.6-Nähe; `signedPaymentOptionId`-Übergabe folgt mit der
Signaturstrecke), Mehr-Zahlarten-Modelle, PSD-Bankkredit.

## 3. Verträge

### 3.1 Berechtigungen (`lib/permissions.ts`)

| Action | minRole | capability | internalOnly |
|---|---|---|---|
| `payment_option.read` | viewer | — | ja |
| `payment_option.write` | editor | — | ja |

Admin-Bypass wie etabliert. Varianten-Auswahl nutzt bestehendes
`project.write` (kein neues Recht).

### 3.2 Datenvertrag

`payment_option`:

| Feld | Typ | Regeln |
|---|---|---|
| id | uuid PK | default gen_random_uuid() |
| workspace_id | uuid FK → workspace | not null |
| key | text | not null, einer von `purchase`, `financing_classic`, `leasing`; je Workspace unter aktiven Zeilen unique (partial-unique) |
| label | text | not null, 1–120 Zeichen |
| kind | text | not null, `purchase`/`financing`/`leasing` (anzeigegebunden an key, Service prüft Konsistenz) |
| archived_at | timestamptz nullable | Soft-Delete; Schlüssel wird nach Archivierung frei (aktive Eindeutigkeit) |
| created_at / updated_at | timestamptz | Standard |

`offer_variant.payment_option_id uuid NULL REFERENCES payment_option(id)`
— ON DELETE RESTRICT; Index (workspace_id, payment_option_id).

### 3.3 Service-Signaturen (`modules/offers/payment-options.ts`, neu)

```
listPaymentOptions(ctx, { includeArchived }) → PaymentOptionDto[]
createPaymentOption(ctx, { key, label }) → dto
updatePaymentOption(ctx, { id, label? }) → dto (key ist immutable)
archivePaymentOption(ctx, { id }) → dto
restorePaymentOption(ctx, { id }) → dto (Konflikt bei belegtem Schlüssel)
setVariantPaymentOption(ctx, { offerId, variantId, paymentOptionId|null }) → { changed }
```

Fehler: `PaymentOptionNotFoundError`, `PaymentOptionConflictError`,
`PaymentOptionValidationError`; Offer-Fehler wie M2-01
(`OfferNotFoundError` bei Scope-Miss, kein Cross-Tenant-Leak).

### 3.4 RLS/ACL (CRM-Stammdaten-Muster, Präzedenz F1.8/0049)

- `payment_option`: RLS + FORCE mit permissiver `tenant_isolation`-Policy
  über `app.workspace_id`; KEINE restriktiven Actor-Policies (kein
  Geldfluss, reine Anzeige-Stammdaten).
- ACL via Rollenvertrags-Skript: REVOKE ALL + GRANT SELECT/INSERT/UPDATE
  an `app_runtime`, kein DELETE (Soft-Delete).
- `offer_variant.payment_option_id`: keine neue Policy (Tabellen-Policies
  bestehen); Auswahl schreibt nur die FK-Spalte.

### 3.5 Auswahl-Semantik

- `null` = „keine Angabe" (Normalzustand, Live-`null`-Parität).
- Archivierte Option: nicht wählbar (`ValidationError`); bereits
  gesetzte Verweise bleiben lesbar (Historie bricht nicht).
- No-op (wertgleich inkl. doppelt-`null`) → Return ohne Event/Audit/Touch.
- Events (bestehendes `emitEvent`-Muster):
  `offer.variant_payment_option_set` (+ `paymentOptionId`,
  `previousPaymentOptionId`), `offer.variant_payment_option_cleared`.
- Keine Snapshot-Umschreibung, kein Revisionsbump (revisionslos wie
  F2.2-Bundles/Override).

## 4. Testmatrix

| ID | Test | Ebene |
|---|---|---|
| F205-DB-01 | create/list/update happy path + Schlüssel-Eindeutigkeit | db |
| F205-DB-02 | Schlüsselkollision (aktiv) → Conflict; nach Archivierung frei | db |
| F205-DB-03 | archive/restore; archivierte Option nicht wählbar, Historie lesbar | db |
| F205-DB-04 | Cross-Workspace-Isolation + Viewer darf nicht schreiben | db |
| F205-DB-05 | Auswahl setzen/clearen/No-op, Scope-Miss → OfferNotFoundError | db |
| F205-PERM-01 | permissions-Matrix wächst um 2 Actions | unit |
| F205-JRN-01 | m111a-Journal: idx 68 / TOTAL 69 | db |
| F205-E2E-01 | Editor wählt Zahlart, sieht Badge, clears Auswahl | e2e |
| F205-E2E-02 | Viewer: Auswahl sichtbar, keine Änderung | e2e |

## 5. Nachweise

- Katalogvertrag: keine zweite Vertragswahrheit (Schemas in
  `lib/integrations/offers/contract.ts`, Command-Versionen
  `offer-payment-option-command.v1` /
  `offer-variant-payment-option-command.v1`).
- Reviews: Kimi + DeepSeek (Exit-3 ohne Key → Gates entscheiden).
- Offene Punkte → FRAGEN-AN-MIKAIL.md (nur echte Blocker).
