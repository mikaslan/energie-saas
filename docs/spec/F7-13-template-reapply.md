# F7-13 Template Re-Apply: Merge/Reset (Katalog F7.3)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12
Nachweis: DB F713 3/3, E2E F713-E2E-01 1/1 lokal beobachtet (Merge erhält
Haken + ergänzt Block, Reset ersetzt; Axe sauber, keine Konsolenfehler);
Nachbarn checklist-templates 7/7; tsc/eslint/depcruise grün; Migration 0131
(Validator-Key componentId) + Rollen-Hash/Pins geerntet; keine neue
Permission, kein neuer Provider.
Basis: Modulkatalog F7.3 („Update per Merge (erhält alle Werte) oder Reset
(Admin-only bei angepassten)") · Q-unblockiert (kein Upload/Provider nötig).

## Ziel und Abgrenzung

Heute ist `applyChecklistTemplate` Erst-Anlage-only (Conflict bei vorhandener
Checkliste). Dieser Slice ergänzt das erneute Anwenden einer aktiven Vorlage
auf ein Projekt mit vorhandener Checkliste — in zwei Modi:

- **Merge** (`checklist.configure`, Admin): fehlende Vorlagen-Positionen werden
  ergänzt; alle vorhandenen Werte (done/required/irrelevant/Notizen/Sichtbarkeit)
  bleiben unangetastet. Idempotent (zweiter Merge ändert nichts).
- **Reset** (`checklist.unlock`, Admin — bestehender Key, keine neue
  Permission): Baum wird durch frisches Vorlagen-Rendering ersetzt (Werte gehen
  verloren).
- Rollen-DECIDED: Der Katalog qualifiziert nur Reset („Admin-only bei
  angepassten"), aber Merge ergänzt Knoten = Strukturänderung — und das Produkt
  reserviert JEDE Strukturänderung bestehender Listen für Admins (Kapsel
  `save_project_checklist_v2` + `canEditStructure`-Regel im Manager).
  Beide Modi sind daher Admin-genehmigt (configure vs. unlock),
  ohne neue Permission-Keys.

Nicht in diesem Slice: AI-Builder aus PDF/Bild/CSV, Template-Versionierung
mit Diff-Ansicht, andere Phasen als `site_documentation`, Portal-Anteil.

## Evidenz und ESTIMATE

- Katalogbedarf F7.3 aus der Blaupause (öffentliche Programmlogik, kein
  Reonic-Livebeleg für deren exakte Schritte).
- `[ESTIMATE]` Positions-Identität: Vorlagen-Positionen tragen `componentId`;
  Projekt-Punkte erhalten `componentId` als optionales Feld (JSONB, keine
  Migration — `.nullish()`, Bestand ohne Feld bleibt gültig). Merge-Match:
  erst `componentId`, Fallback exakter Titel (Legacy-Bestand). Mengen-/Titel-
  Änderungen der Vorlage erzeugen bewusst neue Punkte statt stiller
  Überschreibung (kein Werteverlust — Umbenennen ist Anlegen + Altpunkt
  bleibt sichtbar).

## Datenmodell (keine Migration)

- `editableChecklistItemSchema` + `componentId: stableUuidSchema.nullish()`.
- `reapplyChecklistTemplate(tx, ctx, { projectId, templateId, mode })` in
  `modules/checklists/templates.ts` (Muster: `applyChecklistTemplate`).
- Bestehender Block mit Vorlagen-Namen wird ergänzt; fehlt er, wird ein neuer
  Block angehängt (Position = max + 1). Speichern über `saveProjectChecklist`
  mit Versions-CAS (Race → Conflict, kein stiller Overwrite).
- Events/Audit: `checklist.template_reapplied` + `checklist.write`
  (IDs + Modus, kein Kundenkontext).

## Validierung (fail-closed, ehrliche Fehler)

- Unbekannte Vorlage / kein Projekt / keine vorhandene Checkliste → NotFound
  (kein Orakel, keine Auto-Anlage durch Re-Apply).
- Merge/Reset mit ungültigem Modus → Validation; Versions-Race → Conflict.
- Reset ohne Admin-Recht → Denied (Server-Action bleibt Sicherheitsgrenze);
  Viewer liest nur.
- Template ohne Positionen → Validation (kein Leer-Reset).

## UI

- Checklisten-Seite: Bei vorhandener Checkliste zusätzlich „Vorlage erneut
  anwenden" mit Modus-Wahl (Zusammenführen nur mit Strukturrecht,
  Zurücksetzen nur mit Unlock-Recht sichtbar) + Erfolgs-/Fehlermeldung über
  bestehendes Feedback. Reine Server-Actions, keine neuen Routen.

## Akzeptanz

- DB: Merge erhält done + ergänzt Fehlendes (Admin); Merge idempotent;
  Merge/Reset als Editor → Denied; Reset löscht Werte (Admin);
  ohne Bestand → NotFound; Fremdtenant-Leere.
- E2E: Vorlage A anwenden → Punkt abhaken → Vorlage B mergen (beide Blöcke,
  Haken bleibt) → Reset (Admin, Haken weg, Punkte da); Axe sauber; keine
  Konsolenfehler.
- Gates: tsc/eslint/depcruise grün; keine Migration; keine neue Permission;
  kein neuer Provider.

## Bewusst offen

- AI-Builder, Diff-Vorschau vor Merge, Umbenennungs-Erkennung (statt
  Neu-Anlage), andere Phasen, Portal-Anteil.
