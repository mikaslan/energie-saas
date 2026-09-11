# F16-06 — Angebots-Vorlagen (Zahlart-Preset + Rabatt-Preset)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-11

## Ziel und Abgrenzung

Katalog F16.2/F16.3 verlangt Offer Templates neben Rabatt-, Förder-,
Task- und Termin-Vorlagen (F16-03/F16-04/F16-05 sind real). Dieser Slice
macht den Pfad durchgängig: Verwaltung (Name + Zahlart-Preset und/oder
Rabatt-Preset) → Anwenden an einer Angebotsvariante in einem Schritt.
Keine neue Lane-Freigabe nötig (Gesamtauftrag 2026-09-10).

## Evidenz

- Modulkatalog `docs/blaupause/01-modulkatalog.md`: F16.2 „Offer Templates",
  F16.3 „Vorlagentypen gesamt: Angebot, Planung, Rabatt, Förderung ...".
- Keine Reonic-Offer-Template-Referenz belegt: Die Bündelung
  (Zahlart + Global-Rabatt in einem Schritt) ist eine reversible
  Eigenableitung aus belegten Stammdaten, keine behauptete Reonic-Parität.

## Datenmodell (additiv, Migration 0095)

`offer_template`: Name (+ normalisiert, aktiv-eindeutig je Workspace),
`payment_option_id` NULL, `discount_template_id` NULL, CHECK mindestens
ein Preset belegt, `active`-Flag (Archiv statt Delete), Position,
Actor-/Zeitstempel, Workspace-FK + FKs auf `payment_option` /
`discount_template` (NO ACTION: archivierte Stammdaten bleiben als
Referenz erhalten), `tenant_isolation` + FORCE RLS (M1-CRM-Muster),
Rollenvertrag (select/insert/update für `app_runtime`, kein DELETE).

## Validierung (fail-closed, keine stillen Defaults)

- Anlage/Änderung verlangt mindestens ein Preset; Referenzen müssen im
  selben Workspace existieren (sonst Validation, inkl. Fremdmandant).
- Anwenden nur mit aktiver Vorlage; archivierte Zahlart meldet der
  Zahlart-Pfad (OfferValidation), inaktiver Rabatt der Rabatt-Pfad
  (NotFound). Veraltete `expectedRevision` bei Rabatt-Anteil → Konflikt.
- Keine neuen Permissions: Verwaltung unter
  `discount_template.read/write`; Angebots-Schreibschutz (`project.write`)
  prüft der Angebots-Pfad selbst.

## Berechnung/Anwendung

`applyOfferTemplate`: zuerst Rabatt-Vorlage global (revisionsgeführt,
`applyDiscountTemplateToOfferGlobal` wörtlich), danach Zahlart
(`setVariantPaymentOption`, ohne Revisionsbindung). Zahlart-only lässt die
Revision unverändert; Offer-Fehler laufen transparent durch.

## Anzeige

- Einstellungen → Angebots-Vorlagen: Create/Edit (Zahlart-/Rabatt-Dropdowns,
  archivierte Referenzen sichtbar deaktiviert), Archiv/Restore.
- Angebot → „Vorlage anwenden": Dropdown aktiver Vorlagen
  (Zahlart/Rabatt-Kennzeichnung) + direkter Apply mit Revisionsbindung,
  Erfolgs-/Fehlerfeedback (Konflikt → Seite neu laden).

## Akzeptanz

- DB F1606 4/4 (Anlage/Liste/Anwenden, Konflikt-/Fail-closed-Matrix,
  Viewer/Archiv/Restore, Fremdmandant, archivierte Referenzen).
- E2E F16-06-E2E-01/02 (Verwaltung, Anwenden im Angebot).
- Gates: typecheck/lint/depcruise grün, Vollsuite lokal.

## Bewusst offen

- Förder-Vorlagen als Angebots-Preset (nur Rabatt-Vorlagen gekoppelt).
- Positions-/Paket-Presets (Planning Packages, F16.2).
- E-Mail-/File-Request-Vorlagentypen (keine Domain vorhanden).
