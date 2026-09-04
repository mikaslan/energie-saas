# Code-Review: F16.2 „Zustandslose PDF-Vorschau"

## Verdikt: **NACHBESSERUNG**

Der Slice ist architektonisch sauber (Lock-Split korrekt, Null-Writes glaubwürdig, XSS-Härtung gut), aber es gibt zwei P2-Befunde (UI-Fehlerpfad unbehandelt, Test-Deckung weicht von Spec ab) und eine Spec-Abweichung beim Permission-Scope, die vor Merge zu klären sind.

---

## Befunde

### P0 — kritisch
*Keine.*

### P1 — hoch
*Keine.* Der Draft-Pfad (`lockSource`) bleibt nachweislich exklusiv gelockt (`fetchSourceRows(tx, input, true)` → `for update`), die Preview geht über `readSource` mit `lock=false` → leeres Fragment. Kein Sperr-Downgrade im Mutationspfad.

### P2 — mittel

**P2-1: Unbehandelter Fehlerpfad in `loadPreview` — UI hängt permanent in „Rendert …"**
Die Server-Action wirft nicht-gemappte Fehler bewusst weiter (`throw error`). Client-seitig fehlt jegliches `try/catch`:
```ts
setPreviewState(await previewOfferHtmlAction({ ... }));
```
Bei unerwartetem Fehler (DB-Ausfall, Netzwerk, deserialisierter Next-Action-Fehler) bleibt `previewState.status === "pending"`, der Dialog zeigt dauerhaft „Vorschau wird gerendert …", der Button bleibt deaktiviert, und es entsteht eine unhandled Promise Rejection (`void loadPreview()`).
→ Fix: `try/catch` um den Action-Aufruf, im Catch `setPreviewState({ status: "unavailable" })`.

**P2-2: Test-Deckung unterschreitet die eigene Spec (Null-Writes-Nachweis lückenhaft)**
Die Spec verlangt explizit: „kein `updated_at`-Touch, `domain_events`/`audit_log`/**Outbox** unverändert". F162-DB-01 prüft nur `offer_pdf_draft`, `domain_events`, `audit_log`:
- **Outbox-Zähler fehlt** vollständig (`countRows` kennt die Tabelle nicht).
- **`updated_at`-Invarianz** auf `offer`/`offer_variant`/`offer_revision` wird nicht geprüft — genau der subtile Write, den ein „lesender" Pfad versehentlich auslösen könnte (z. B. Trigger, Touch-Helfer).
→ Fix: Outbox-Tabelle in `countRows` aufnehmen, `updated_at`-Vorher/Nachher-Vergleich auf den drei Quellzeilen ergänzen.

**P2-3: Spec-Abweichung Permission-Scope — `offer_preview` vs. `offer_detail`**
Spec §3: „Recht: `project.read` (Scope **`offer_detail`**)". Code verwendet durchgehend `offer_preview` (`requireAccess(ctx, "project.read", "offer_preview")`, `authorizedQuery(..., "offer_preview", ...)`). Zwei Risiken: (a) falls der Scope-String in der `can()`-Matrix nicht registriert ist, schlägt die Prüfung fehl oder wird stillschweigend toleriert — aus dem Bundle nicht verifizierbar; (b) Audit-/Telemetrie-Auswertungen nach `offer_detail` erfassen die Vorschau nicht.
→ Fix: Scope an Spec angleichen **oder** Spec korrigieren und Registrierung des neuen Scopes in der Permission-Matrix belegen.

### P3 — niedrig

- **P3-1: Validierungs-Reihenfolge minimal geändert.** Im alten `lockSource` wurde der Revisions-Conflict *vor* dem Revision-SELECT geworfen; jetzt wirft eine fehlende Revision zuerst `Integrity`, dann erst `Conflict`. Da Revision-Missing nur bei ohnehin gebrochener Snapshot-Invariante auftritt, praktisch irrelevant — aber „identische Prüfungen wie `lockSource`" (Spec §1) stimmt nur in der Menge, nicht in der Reihenfolge.
- **P3-2: `NotFound` → `invalid` → irreführender User-Text.** Das Mapping (Existenz nicht leaken) ist sicherheitsseitig korrekt, aber der Client zeigt für `invalid` den Default-Text „…später erneut versuchen" — bei einer gelöschten Variante hilft der Retry nie. Optional eigener Status-Text.
- **P3-3: Kein `validateOfferPdfDraftInput` im Preview-Pfad.** Der Draft-Pfad validiert das gebaute Input-Objekt vor dem Rendern (Import existiert bereits); die Preview rendert bei `buildOfferPdfDraftInput`-Teildefekt direkt. Niedriges Risiko (Snapshot ist zod-validiert), aber Paritätslücke.
- **P3-4: A11y am Dialog.** Kein Fokus-Management (Initial-Focus, Fokus-Rückgabe), kein Escape-zum-Schließen, kein Fokus-Trap bei `aria-modal="true"`. Für M2 tolerierbar, vor GA nachziehen.
- **P3-5: Pure Template-Asserts (Marker/Escape) aus der Spec nicht im neuen Test-File.** Vermutlich durch M2-02-Tests abgedeckt — im Review nicht belegt. Bitte referenzieren oder ergänzen.
- **P3-6: `previewStatusText(previewState)` wird im JSX doppelt ausgewertet** (Bedingung + Render). Kosmetik — einmal in eine Konstante ziehen.

---

## Checkliste im Einzelnen

| Prüfpunkt | Ergebnis |
|---|---|
| Lock-Split korrekt | ✅ Draft-Pfad unverändert `FOR UPDATE`; Preview plain SELECTs. Nit: P3-1 |
| Null-Writes im Preview-Pfad | ✅ Code-Pfad schreibt nichts (`readSource`, `databaseNow` = SELECT, reines Template-Render). **Aber:** Test-Nachweis lückenhaft (P2-2) |
| Validierungs-Parität (Conflict/NotFound/Integrity) | ✅ gemeinsame `validateSourceRows`; `buildOfferPdfDraftInput`-Crosscheck (Revision/Angebotsnummer) vorhanden |
| Permission (`project.read`) | ✅ Service + Action doppelt abgesichert; Test deckt viewer-OK / external-denied. Scope-String weicht von Spec ab (P2-3) |
| Fehler-Mapping vollständig, kein Leak | ✅ Action mappt alle fachlichen Fehler, NotFound ohne Existenz-Leak, Unbekanntes → Rethrow (Next generisch). Client-seitiger Fallback fehlt (P2-1) |
| XSS | ✅ `sandbox=""` (keine Scripts, keine same-origin), `srcDoc` via React-Attribut-Escaping, Template aus M2-02 unverändert. Kein `dangerouslySetInnerHTML` |
| Kein Scope-Creep | ✅ Keine Migration, keine RLS-/Permission-/Worker-Änderung; Docs + Tests im Slice |
| Bestehende Tests gebrochen | ✅ `lockSource`-Signatur und Export-Verhalten kompatibel; neuer Export `getOfferPreviewHtml` rein additiv (Import von `PermissionDeniedError` in `actions.ts` im Diff nicht sichtbar — vermutlich bereits vorhanden, bitte Build-Check) |
| Keine Secrets | ✅ nur `@f162.test`-Fixtures |

---

## Freigabe-Bedingungen

1. **P2-1** Client-Catch → `unavailable` (verhindert hängenden Dialog).
2. **P2-2** Outbox- + `updated_at`-Asserts in F162-DB-01 nachziehen — das ist der Beleg für das Kern-Versprechen des Slices.
3. **P2-3** Scope-String mit Spec synchronisieren und Registrierung in der Permission-Matrix verifizieren.

Danach ohne erneutes Vollreview mergefähig. P3-Punkte als Follow-up-Tickets.