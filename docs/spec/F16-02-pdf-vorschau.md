# F16.2 — Zustandslose PDF-Vorschau

Status: **SPECIFIED (DISCOVERED abgeschlossen)**

Lane: `codex/f16-02-pdf-vorschau` off `origin/codex/m1-wave-02` (keine Migration).
Vorgänger: M2-02 (PDF-Draft-Engine, Template, Worker), M2-01 (Snapshot).

## Angewendete Skill-Regeln
- reonic-parity: Bestand wiederverwenden (Template/Validierung), TDD, keine erfundenen Preise.
- contract-first: Preview-Command im `pdf-contract.ts`-Stil (zod, kein neuer Mirror).
- product-lens: Warum — Editor will „wie sieht das gerade aus" ohne Draft-Job, Queue-Wartezeit und Datenbank-Spuren.
- Keine Secrets, kein Remote-HTML (M2-02-Grenzen gelten).

## Scope
1. `getOfferPreviewHtml(tx, ctx, {offerId, variantId, expectedVariantRevision})` (pdf-service): Quell-Validierung per NEUER `readSource` (plain SELECTs, **kein `FOR UPDATE`**, kein Touch) mit identischen Prüfungen wie `lockSource` (Scoped-Existenz, Revisions-Gleichheit, Snapshot-Integrität). `lockSource` bleibt exklusiv Draft-Pfad (Sperren serialisieren Reservierungen; Preview braucht keine Serialisierung). Rendert `renderOfferPdfDraftHtml` aus der versiegelten Revision, **null Writes** (kein Draft-Row, kein Queue-Job, kein `updated_at`-Touch, kein Event/Audit/Outbox).
2. Eingabe-Validierung identisch Draft-Pfad: Server löst aktuelle Revision auf und vergleicht gegen `expectedVariantRevision` (stale → Conflict wie Draft); fremd → NotFound; Snapshot-Bruch → Integrity.
3. Recht: `project.read` (Scope-Label `offer_preview` — `can()` entscheidet nur über Action+Rolle, Label dient Telemetrie; Service + Action doppelt abgesichert); Editor-Button sichtbar bei Leserecht.
6. Template-Marker/Escape decken `tests/unit/m202-offer-pdf-template.test.ts` ab (Referenz, kein Duplikat). Fokus-Trap im Dialog ist M2-Follow-up (Escape + Initial-Fokus drin).
4. UI Offer-Editor: „Vorschau"-Button → Server-Action (POST: kein GET-Caching sensibler Dokumente, `srcDoc`-Transport ohne neue Route) → `<iframe srcDoc>` im Dialog; Draft-Wasserzeichen bleibt. Button rendert die gerade angezeigte (aktive) Variante per expliziter `variantId` — nach F2.2-Merge ist das die Primary, ohne weiteren Umbau. Keine F2.2-Blockade.
5. Keine Migration, keine RLS-Änderung, keine neue Permission, keine Worker-/Storage-Berührung.

## Nicht-Ziele
- Kein PDF-Bytes-Download (weiter Draft-Artefakt), keine Ausstellung/Signatur, kein Override in der Vorschau (BOM-Wahrheit des Snapshots; Override ist Verhandlungsfeld, kein Vertragswert).
- Keine Template-Änderungen (M2-02-Template unverändert wiederverwendet).
- Keine Auswahl der Variante in der Preview-Funktion (explizite `variantId`; UI übergibt Primary aus F2.2-Readmodell sobald gemergt).

## Tests (RED zuerst)
- HTML enthält Draft-Marker + Angebotsnummer + Positionszeilen; null Writes: keine Draft-Rows, kein Queue-Eintrag, `updated_at` unverändert, `domain_events`/`audit_log`/Outbox unverändert.
- Stale Revision → Conflict; fremde Variante → NotFound; Snapshot-Bruch → Integrity.
- Externe ohne Leserecht → PermissionDenied; Reader OK. (Jede interne Rolle hat `project.read` — minRole viewer; „leselose Interne" existieren nicht.)
- Pure Template-Asserts (Marker/Escape) ohne DB.

## Offene Punkte → FRAGEN-AN-MIKAIL.md
- Keine slice-eigenen.
