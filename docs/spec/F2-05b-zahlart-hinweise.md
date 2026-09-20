# F2-05b — Zahlart-Hinweise (intern lesend; öffentlich verworfen)

Status: **SPEC-DRAFT** · Lane 7 Welle 2
Ziel: Die an der Variante gewählte Zahlart (F2-05 Slice A) erscheint als
reiner Lese-Hinweis in der internen Signaturvorbereitung (D5-05). Ein
öffentliches Zahlart-Label (D5-04) wird verworfen (s. §5).

## 1. Scope

1. **D5-05 (IN):** Interner Hinweis im Signatur-Panel der Angebotsdetailseite
   (`OfferSignaturePanel`, Finalise-Sektion „Signaturanforderungen"): welche
   Zahlart die aktive Variante trägt — lesend, ohne Write, ohne Migration.
2. **D5-04 (OUT):** Öffentliches Zahlart-Label auf Token-Route `/s/[token]`
   oder Portal-Signaturpfad — VERWORFEN, siehe §5 mit Zitaten.

## 2. Nicht-Ziele

- Keine Migration, keine neuen Spalten, keine neue Permission.
- Keine Providerlogik (Bees&Bears/PSD), keine Raten-/Zinsberechnung.
- Keine `signedPaymentOptionId`-Schreibsemantik (R3-BLOCKED): kein Write in
  `signature_request`, kein CHECK-/Guard-Eingriff.
- Keine Kunden-Auswahl der Zahlart (F2-05 §2: „folgt mit der Signaturstrecke").
- Keine neuen öffentlichen Routen, kein Versand, keine Auto-Installation.

## 3. Datenquelle (lesend, kein Raten)

- `getOfferDetail` liefert je Variante `paymentOptionId: string | null`
  (`modules/offers/service.ts`: Variante-View, `?? null` = „keine Angabe").
- Label-Auflösung lesend über `listPaymentOptions` (`payment_option.read`,
  `modules/offers/payment-options.ts`); archivierte Historie bleibt lesbar
  (F2-05 §3.5: current-only, kein Reaktivieren).
- Kein neuer Service: Panel resolved ID→Label aus bereits geladenem Detail
  plus Stammdatenliste; Rechte unverändert (`offer.signature.read` Panel,
  `payment_option.read` Liste).

## 4. Semantik (D5-05)

- **Anzeigeort:** `OfferSignaturePanel`, neben dem Badge „vorbereitet ·
  nicht versendet" bzw. über dem `CreateSignatureForm`-Block — Hinweis,
  keine Auswahl, kein Button.
- **Texte:**
  - DE gesetzt: `Zahlart der Variante: <Label> (reine Anzeige).`
  - DE null: `Zahlart der Variante: keine Angabe (reine Anzeige).`
  - EN gesetzt: `Variant payment option: <label> (display only).`
  - EN null: `Variant payment option: none selected (display only).`
  - Archiviert gebunden: Label + ` (archiviert)` / ` (archived)`.
- **Datenfluss:** Server Component liest `paymentOptionId` aus dem
  Angebots-Detail-DTO und das Label aus `listPaymentOptions`
  (`includeArchived: true`, nur zur Anzeige). Null/ungültig → Null-Text;
  niemals Exception an die UI.
- **Ehrlichkeit:** Hinweis ändert weder Request-Erzeugung noch Attestierung
  noch Content-Hash; reine Projektion wie F2-06 Slice A.

## 5. D5-04 öffentlich: VERWORFEN

Keine saubere Begründung aus R3/DEC-M204-04-Text + Code möglich:

- `DEC-M204-04` (M2-04-Spec §13): „Vorbereitungs-Gate: kein `issued`/`sent`
  ohne M2-03b2-Gate; interne Kennzeichnung ‚vorbereitet · nicht versendet'."
- `app/s/[token]/page.tsx:9-12`: „Die öffentliche Token-Route rendert vor
  dem M2-03b2-`issued`-Gate KEIN Dokument (konservativ). Es wird bewusst
  KEINE Offer-, PDF- oder Token-Auflösung ausgeführt."
- M2-04b-Spec: „öffentliches Rendern `/s/[token]` bis M2-03b2/`issued`
  (DEC-M204-04 …); … BLOCKED".
- F2-05 §2 Nicht-Ziele: „Kunden-Auswahl auf der Signaturseite …
  `signedPaymentOptionId`-Übergabe folgt mit der Signaturstrecke".
- `R3` ist kein Repo-Artefakt (Grep ohne Treffer); auch der
  Portal-Invite-Pfad (F10-02c, `POST /p/[token]/signatur`) liest nur Status,
  kein Offer-Label — ein Label dort wäre neue öffentliche Offer-Auflösung
  ohne `issued`-Gate. Öffentliches Label daher erst nach M2-03b2 neu
  bewerten.

## 6. Tests

| ID | Test | Ebene |
|---|---|---|
| F205B-U-01 | ID→Label-Projektor: gesetzt/null/archiviert/unbekannt→Null-Text | unit |
| F205B-U-02 | DE/EN-Texte exakt (gesetzt/null/archiviert-Suffix) | unit |
| F205B-DB-01 | Panel-Datenfluss: Detail-`paymentOptionId` + Liste lösen Label lesend, kein Write | db |
| F205B-E2E-01 | Variante mit Zahlart → Hinweis im Signatur-Panel sichtbar; ohne → Null-Text; Axe sauber | e2e |
| F205B-NEG-01 | Öffentliche Token-Route zeigt kein Zahlart-Label (Gate unverändert) | e2e |

## 7. Offene Punkte

1. Soll der Hinweis auch die Art (`Kauf/Finanzierung/Leasing`) tragen oder
   nur das Label? Vorschlag: nur Label (F2-05-Panel zeigt Art bereits).
2. Nach M2-03b2-`issued`: D5-04 (öffentliches Label im Portal/in der
   Signieransicht) neu bewerten — dann mit `signedPaymentOptionId`-Vertrag.
