# F16-09 Förder-Preset-Kopplung (Angebots-Vorlage trägt Förder-Vorlage)

Ziel: Die in F16-06 als „Bewusst offen: Förder-Vorlagen als
Angebots-Preset (nur Rabatt-Vorlagen gekoppelt)" geführte Lücke
schließen. Eine Angebots-Vorlage trägt optional zusätzlich eine
Förder-Vorlage (`subsidy_template`, F16.3 Slice B); das Anwenden an
einer Variante setzt Zahlart + Global-Rabatt + Förderung in einem
Schritt — lesend aus bestehenden Commands, ohne neue Permission.

## ESTIMATE (reversibel, Referenzfrage offen)

- Modell: `offer_template.subsidy_template_id` nullable (Migration
  0138, Composite-FK `(workspace_id, subsidy_template_id)` wie
  Rabatt, Muster 0095). Preset-CHECK: Zahlart ODER Rabatt ODER
  Förderung belegt.
- Anwenden: Rabatt + Förderung in EINEM Revisions-Call
  (Ordnung Rabatt → Förderung), danach Zahlart ohne Revisionsbump.
  Eine Revision je Anwenden ist DB-Invariant (Deferred-Mirror-Trigger:
  zwei Revises in einer Tx committen nie). Beide Prozent-Presets teilen
  sich den einen `globalDiscountBps`-Slot der Variante, beide
  Fix-Presets den `globalFixDiscountCents`-Slot: **späterer Schritt
  gewinnt**, Ergebnis-Flags + Event-Payload (`discountApplied`,
  `subsidyApplied`, `paymentOptionApplied`) machen das sichtbar.
  Fix + Prozent koexistieren (getrennte Slots). Kein Fail-closed bei
  Doppelbelegung: ein bestätigtes „Vorlage anwenden" ist eine
  atomare Benutzeraktion mit dokumentierter Ordnung, kein
  destruktiver Zufall.
- Berechtigung: Verwaltung weiter `discount_template.write`
  (KEINE neuen Permission-Keys — Mandat); Förder-Liste liest mit
  `subsidy_template.read` (Viewer-ok, gleiche Schranke wie
  Rabatt-Liste). Angebots-Schreibschutz (`project.write`,
  `discount.apply` via `discounts`-Capability) prüfen die
  Angebots-Pfade selbst — Editor ohne `discounts` scheitert wie
  bisher am Rabatt-Pfad.
- Anzeige: Einstellungen (dritte Preset-Spalte „Förder-Preset",
  Format wie Rabatt), Angebotsseite (Eintrags-Suffix
  Zahlart/Rabatt/Förderung kombiniert, Erfolgsmeldung mit
  „Förderung gesetzt").

## Scopes

1. Migration 0138 + `subsidyTemplateId` in DTO/Create/Update
   (mindestens-ein-Preset-Refinement mit drittem Zweig).
2. `assertPresetReferences` + Förder-Zweig (gleicher
   Workspace-Nachweis, Fremdmandant fail-closed).
3. `applyOfferTemplate` mit Förder-Schritt (verkettete Revision,
   `subsidyApplied`-Flag, Payload).
4. UI: Manager-Formular + Liste, Apply-Panel + Einträge,
   Settings-Seite (Förder-Optionen), Aktions-Parser.
5. Tests: DB (Anlage/Anwenden beider Kinds, Verkettung +
   Slot-Sichtbarkeit, Validation, Archiv/NotFound), E2E
   (Verwalten + Anwenden mit Förder-Preset).

## Geschlossene Testmatrix

- `F1609-DB-01`: Förder-only (Prozent) anlegen → anwenden →
  `globalDiscountBps` gesetzt, `subsidyApplied`, Revision 2.
- `F1609-DB-02`: Fix-Förderung + Prozent-Rabatt koexistieren
  (beide Slots belegt, eine Revision je Schritt).
- `F1609-DB-03`: Prozent + Prozent → Förderung gewinnt
  (dokumentierte Ordnung), Payload zeigt beide Flags.
- `F1609-DB-04`: leer/fremd/mandantenfremd fail-closed;
  archivierte Förder-Vorlage referenzierbar, nicht anwendbar.
- `F1609-E2E-01`: Editor verwaltet Vorlage mit Förder-Preset;
  Viewer read-only.
- `F1609-E2E-02`: Anwenden am Angebot setzt Förderung
  (Revision + Snapshot-Beleg).

## Bewusst offen

- E-Mail-Vorlagen (letzter offener F16-Vorlagentyp),
  Positions-/Paket-Presets (Planning Packages, F16.2),
  echte Produkte, Brand-/Human-Visual-Freigabe.
