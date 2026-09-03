# Kimi-K3-Review: M3-01 UI-/E2E-Schicht (Bereich „Rechnungen & Dokumente")

Datum: 2026-09-04 · Quelle: OpenRouter `moonshotai/kimi-k3` (effort high)
via `scripts/kimi-review.mts` · Scope: Actions, Seiten (Übersicht/Typ/Listen/
Berichte/CSV-Route), Dialoge, E2E-Spec, Archiv-Toggles im Service.

## Verdikt: NACHBESSERUNG (0 P0, 1 P1, 6 P2, 6 P3) → nach Schließung FREIGABE-reif

## P1 — geschlossen

1. **Spaltenversatz „Zahlung" bei paymentStatus null** (Entwürfe) →
   `<td>` wird für Geld-Typen immer gerendert, Inhalt konditional (`—`);
   Folgezellen rutschen nicht mehr.

## P2 — geschlossen

1. **Monatsgrenz-Flake E2E-03** → Seeds liegen jetzt deterministisch in der
   Berlin-Monatsmitte (`date_trunc('month', …) + 1d12h`), nie mehr in der
   ersten Stunde des Folgemonats.
2. **Typ-Abdeckung §7** → neuer E2E-05: Anlage + Spalten-Assertions über
   Gutschrift (Lieferdatum + Grund-Filter), Auftragsbestätigung (geplante
   Lieferung/Leistung), Bestellung (Gültig bis), Lieferschein, Brief.
3. **Pflichtzustände §11** → Leerzustände (Liste + Berichte) im frischen
   isolierten Workspace assertiert; `loading.tsx` für den Bereich ergänzt;
   Axe-Check mit geöffnetem Storno-Dialog.
4. **Dialog-Fokus** → gemeinsamer `useModalDialog`-Hook: Escape schließt,
   Tab-Falle, Fokus-Rückgabe an den Trigger beim Schließen — in allen drei
   Dialogen (Gruppe/Anlage/Storno).
5. **„Stornieren" bei Entwürfen** → Button nur noch für `issued`
   (Draft-Storno lehnt der Service ab).
6. **AX-08-Testname** → ehrlich benannt (unbekannte Gruppen-ID im eigenen
   Workspace; Cross-Tenant der Listen liegt in M301-LIST-06).

## P3 — geschlossen

1. Monats-Fallback Seite vs. CSV-400 → DECIDED-Kommentar (Formularsteuerung
   vs. API-Parameter).
2. Datumsanzeige Server-TZ → `formatBerlinDate`/`formatDateOnly`
   (Europe/Berlin) für Ausstellungs-/Fachdaten.
3. Labels vereinheitlicht („Archivierung aufheben" überall; Void-Grund
   `cancelled` → „Aufgehoben").
4. Audit-Actions vereinheitlicht (`invoicing.document.archive.write`,
   `invoicing.group.write`).
5. `number_year` im E2E-Seed dynamisch (Berlin-Jahr statt Literal).
6. `hasPaymentAxis` statt zweideutigem `moneyType` im Anlage-Dialog.

## Nachweise nach Schließung

`npm run check` exit 0 (194 Dateien, 1874 passed/1 skipped, 88/88 + 5/5), Production-Build
exit 0, `db:generate` keine Drift, **Chromium-E2E 5/5** (Journey, Filter/
Archiv, Berichte+CSV, Rollen, Typ-Abdeckung), Axe A/AA inkl. offenem Dialog.
