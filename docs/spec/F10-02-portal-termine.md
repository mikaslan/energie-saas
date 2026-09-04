# F10.2 Slice A — Termine-Tab im Kundenportal

Status: **SPECIFIED (DISCOVERED abgeschlossen)**

Lane: `codex/muse-welle-03-e2e` off `origin/codex/m1-wave-02`.
Vorgänger: F10.1-Skeleton (0056, Invite-Lifecycle, öffentliche
Projektion). Katalog: F10.2 „Termine" (Modulkatalog M10).

## Angewendete Skill-Regeln
- reonic-parity: TDD RED→IMPLEMENTED, keine erfundenen Felder.
- contract-first: View-Schema + Resolve-Parser zusammen erweitern.
- database-migrations: Funktions-Migration handgeschrieben (Nummer
  GLOBAL prüfen: 0059 ist frei); db:generate bleibt „no changes"
  (Funktionen stehen nicht im Drizzle-Schema); Funktions-Pin aus dem
  Migrationstext berechnen (Skript, kein Abtippen).

## Privacy-DECIDED (Datenminimalismus, öffentlich ohne Login)
- Projiziert werden: id, title, startAt, endAt, allDay,
  appointmentType, location. `description` (Freitext, intern) wird
  NIEMALS projiziert — kein Schlüssel im JSON, keine Leckfläche.
- Titel bleiben sichtbar (Datum ohne Titel ist nutzlos); interne
  Titel-Formulierung ist Redaktionsverantwortung, kein Filter.
- Version bleibt `portal-public-view.v1` (gleiche Deployment-Einheit:
  Migration + Parser shippen zusammen; kein alter Producer existiert).

## Scope
1. Migration `0059_f10_portal_appointments`: `CREATE OR REPLACE
   resolve_portal_public_view` — Vollkopie des 0056-Bodys +
   `appointment_list` (nur aktive Invites, nur Projekt-Termine,
   aufsteigend nach start_at): jsonb-Objekte mit id/title/startAt/
   endAt/allDay/appointmentType/location (ISO-Strings via
   `to_json`/`to_char` wie documents-IssuedAt-Muster). Journal von Hand
   (Muster 0057-Eintrag).
2. Rollenvertrag: Funktions-Pin `resolve_portal_public_view(bytea)`
   — nur Hash ersetzen (Rest identisch kopieren), Hash per Skript aus
   dem Migrationstext (prosrc = Body zwischen den `$$`-Markern).
3. Contract: `portalAppointmentSchema` + `appointments`-Array in
   `portalPublicViewV1Schema` und `portalResolveOkSchema`
   (strict, required — kein alter Producer).
4. UI `/p/[token]`: Tabs „Übersicht" (Default, bisheriger Inhalt) und
   „Termine" (`?tab=termine`, Server-Links, kein JS): Liste mit
   Titel/Datum Berlin/Uhrzeit/Ort oder Leerzustand „Aktuell liegen
   keine Termine vor." Unbekannter `tab`-Wert → Übersicht (kein 404,
   kein Orakel).
5. Tests: (a) Vitest-DB `f1002-portal-appointments`: Invite +
   Termin → Resolve enthält ihn (alle Felder, KEIN description-Key);
   kein Termin → `[]`; Withdraw → not_found (unverändert);
   (b) E2E (eigenes f102-Projekt in run.mts): interner Invite (F10.1-
   Muster) + interner Termin (M1-15-Muster) → öffentlicher Link →
   Termine-Tab zeigt Titel. Fallback (dokumentieren wenn gezogen):
   E2E nur Tab-Navigation + Leerzustand, Positivfall per DB-Test.

## Nicht-Ziele
- Keine Description-Projektion (nie, siehe Privacy).
- Keine anderen Tabs (Angebot/E-Signatur/Widerruf, Dateien, KfW,
  Netzanmeldung, Fortschritt) — eigene Slices.
- Keine Sichtbarkeits-Flags, keine Schreibaktionen im Portal.
- Keine Änderung an Invite-Lifecycle/Withdraw/Expiry.

## Akzeptanz
- `npm run check` grün, `db:generate` ohne Drift, E2E-Spec grün (CI),
  Reviews Exit-3 (Selbstreview + Gates).
- Funktions-Pin stimmt beim ersten CI-Lauf (Skript-Herleitung, kein
  Rateversuch).
- Withdrawn/expired/deformiert → identischer 404-Endzustand (kein
  Orakel — bestehende Tests bleiben grün).
