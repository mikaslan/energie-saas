# F13-14 Planungsservice-Revision (GEBAUT, Migration 0263, 2026-09-20)

## Stand
- Modulkatalog F13.3 (docs/blaupause/01-modulkatalog.md:146): Preisstaffel
  9,90–19,90 €/Planung (OFFEN, §1), Fristwahl 24 h/48 h/Datum (ERFÜLLT,
  F13-11), Status Requested → In progress → Finished → Accepted (ERFÜLLT,
  F13-11), Revision über signierte Notizen (SPECIFIED, §2), 1 Anfrage pro
  Angebot (ERFÜLLT, UNIQUE (workspace_id, offer_id)).
- Bestand F13-11: Fristwahl + Kette + Ein-Anfrage-Gate sind gebaut und
  getestet (tests/db/f1311-planungsservice.test.ts). Ausgeschlossen blieben
  dort Preise/Abrechnung, Signatur-Flow-Anbindung, E-Mail je Übergang und
  Portal-Anteil (F13-11-Spec :29-31); Fehlanlage bleibt sichtbar, kein
  Storno-Status (:35).
- Diese Spec dehnt F13-11 NICHT: Sie legt die Revisions-Deutung fest
  (§1–§5) und bleibt bis zum Bau-Slice reines SPECIFIED. Kein Feld, keine
  Migration, kein Provisorium in `planning_request`.

## §1 Preis-Deutung (UNBELEGT, kein Feld)
- Lesart (UNBELEGT, rein aus der Staffel geraten): Express 24 h = 19,90 €,
  Standard 48 h und Datumswahl = 9,90 €. Kein Beleg im Katalog, welche
  Frist welchen Preis trägt; die Staffel nennt nur die Spanne.
- Widerspruch: Katalog-Z.201 („Service-Preise": Website nennt
  349/219/210/9,90–19,90 €; Docs sagen durchgehend „Preise via
  Support-Chat") gilt auch für F13.3 — der Katalog widerspricht sich
  selbst, welche Quelle preisbildend ist.
- Q-F13-PREISBELEG-M2: Welche Quelle bindet den Planungsservice-Preis
  (Website-Staffel vs. Support-Chat), und welche Frist trägt welchen
  Preis? Bis zur Antwort: KEIN Preisfeld an `planning_request`, keine
  Abrechnung, keine Anzeige. Der RED-Test fordert `priceCents` ein (ROT).
- Filing-Muster (`priceSnapshot` in filing-core.v1) ist der Kandidat für
  den Bau-Slice, kein Vorgriff.

## §2 Signierte Notizen (Folgeslice, kein Provisorium)
- Jede Revisionsnotiz wird einzeln per Click-Signatur gezeichnet — Muster
  `signature_request` (offerId-gebundene Signatur-Infra,
  lib/db/schema/signatures.ts:20-34: Statusmenge
  pending/signed/expired/withdrawn/revoked_by_customer, Modi
  click/draw/analog). Für Notizen gilt Click-only (kein Draw-/Analog-Pfad).
- Revisions-Zähler + Roundtrip: Zähler je Anfrage (1, 2, 3 …), jede Notiz
  referenziert Anfrage + Zählerstand; der Roundtrip Kunde → Planer → Kunde
  läuft über Notizpaare (Anfrage-Notiz / Antwort-Notiz), nicht über den
  Anfrage-Status.
- Eigener Folgeslice (`planning_request_revision_note` o.ä. + eigener
  Service): KEIN Provisorium in `planning_request` (kein `notes`-JSONB,
  kein `revision_count`, keine Status-Zwischenwerte). Die F13-11-Kette
  requested → in_progress → finished → accepted bleibt unverändert.
- Der RED-Test fordert den Slice-Pfad
  `modules/planning-request-revisions/service.ts` ein (ROT).

## §3 Draft-Toleranz (dokumentierter Status-quo)
- Anfrage an Draft-Angebot ist ZULÄSSIG: `offer.status` kennt heute nur
  `draft` (offers.ts:75), und die Scope-Query in
  modules/planning-requests/service.ts bindet nur Workspace + Projekt +
  Angebot, ohne Angebotsstatus-Gate. Das ist kein Versehen, sondern der
  einzig mögliche Status-quo — dokumentiert, nicht eingebaut.
- Q-F13-ANGEBOTSBINDUNG-M2: Ab welchem Angebotszustand (Freigabe /
  Ausstellung / Issuance aus M2) darf eine Planungsanfrage gestellt
  werden? Bis zur Antwort bleibt Draft zulässig; die Antwort kann ein Gate
  nachrüsten, ohne die Kette anzufassen.
- UNIQUE bleibt (workspace_id, offer_id): genau 1 Anfrage je Angebot, kein
  Reopen (`accepted` ist terminal, `accepted: null` in der Kantentabelle).
  Zweit-Anfrage → Conflict (F13-11-Bestand).
- GRÜN-Pins im RED-Test (laufen, nicht geskippt): Draft-Toleranz +
  kein-Reopen.

## §4 Frist-Härtung (SPECIFIED)
- `finished_at`-Feld: `finished` setzt einen eigenen Zeitstempel (nicht
  nur `updated_at` wie in F13-11). Auswertung (Durchlaufzeit,
  Fristtreue) liest `finished_at`, nie `updated_at`.
- Überfällig-Badge + Event `planning_request.overdue` (Muster der
  bestehenden Events/Audit, service.ts:226-241 requested,
  service.ts:287-302 status_changed — ID-Payloads, kein Kundenkontext):
  Badge in der Projektakten-Sektion + Event/Audit bei erkannter
  Überschreitung von `deadline_at`. KEINE Eskalations-Automatik (kein
  Auto-Statuswechsel, keine Mail, keine Eskalationskette) — Erkennung ohne
  Vollzug.
- 24 h/48 h sind Kalenderstunden ab Anlage (F13-11-Bestand:
  resolveDeadlineAt, service.ts:142-152; Datum-Art 12:00 UTC als neutrale
  Tagesmitte [ESTIMATE]) — bis eine Feiertags-/Geschäftszeiten-Regel per Q
  geklärt und gebaut ist. Kein stiller Wechsel auf Werktage.
- Der RED-Test fordert `finishedAt`, `isPlanningRequestOverdue` und das
  Event `planning_request.overdue` ein (ROT).

## §5 Accepted-Akteur (intern)
- `accepted` setzt INTERNES Personal (`installation.write`,
  F13-01-Präzedenz, keine neuen Permissions). Kein
  Kunden-Gegenzeichnungs-Pfad in diesem Slice.
- Kunden-Gegenzeichnung (Accepted als signierte Abnahme) erst mit dem
  Portal-Slice (F13-05/F13-06-Nähe): Portal-Identität + Signatur-Muster
  aus §2, dann eigene Spec. Bis dahin ist `accepted` eine interne
  Abnahmebuchung, kein Kundenakt.

## Offene Fragen
- Q-F13-PREISBELEG-M2 (§1): Preisquelle + Frist→Preis-Mapping.
- Q-F13-ANGEBOTSBINDUNG-M2 (§3): Angebotszustand als Anfrage-Gate.
- (Später) Q-F13-FEIERTAG (§4): Feiertags-/Geschäftszeiten-Regel für
  24 h/48 h.

## ESTIMATE (reversibel)
- Preis-Mapping Express = 19,90 / Standard + Datum = 9,90 (§1) ist geraten.
- Datum-Art 12:00 UTC aus F13-11 übernommen (neutrale Tagesmitte).
- Kein Storno-Status (F13-11 :35); Fehlanlage bleibt sichtbar.
- 24 h/48 h = Kalenderstunden bis Feiertags-Regel (§4).

## Tests
- RED: tests/unit/f1314-planung.red.test.ts — NUR existierende Imports,
  5 rote Tests (ROT-Beleg 2026-09-19, danach `describe.skip`):
  ```text
  tests/unit/f1314-planung.red.test.ts (7 tests | 5 failed)
    ✓ Draft-Toleranz: Anfrage an Draft-Angebot ist zulaessig (kein Angebotsstatus-Gate)
    ✓ kein Reopen: Kette endet terminal in accepted, UNIQUE bleibt offer_id
    × Preis-Feld fehlt (S1: kein Feld bis Q-F13-PREISBELEG-M2)
    × Revisionsnotiz mit Click-Signatur fehlt (S2: Folgeslice)
    × finished_at fehlt (S4: Frist-Haertung)
    × Ueberfaellig-Erkennung fehlt (S4: Badge/Event ohne Automatik)
    × Ueberfaellig-Event fehlt (S4: planning_request.overdue)
  Test Files  1 failed (1)
       Tests  5 failed | 2 passed (7)
  ```
  Nach dem Skip: `1 passed … 2 passed | 5 skipped (7)`.
- GRÜN-Pins (laufen, nicht geskippt): Draft-Toleranz + kein-Reopen
  (F13-11-Bestand).
- GRÜN-Beleg (2026-09-20, Migration 0263, Welle 4 + Owner): Unit
  6+1S (Preis-Test DAUER-SKIP als Q-Gate — S1 verbietet das Feld),
  DB F1314-DB-01/02/02b/03/04, Nachbarn f1311 + tenant + m111a-Pins
  (TOTAL 155), E2E F1314-E2E-01 + F13-11 2/2.
  Korrektur ggü. Bau-Brief: Überfällig ab `deadline_at` (F13-11-Bestand,
  Spec-wörtlich §4) statt Anlage+30d (Planer-Halluzination, im Review
  gefangen); keine dueDays-Konstante; UI nutzt Bestands-Frist-Anzeige.
  checkPlanningRequestOverdue idempotent (max 1 Event/Anfrage) + manueller
  UI-Button (ohne Automatik); Signatur Click-only via eigene
  Revisions-Tabelle (kein E-Sign-Anbieter).
