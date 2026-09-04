# F9.3 — Fremdnutzer-Filter (userIds-Liste)

Status: **SPECIFIED (DISCOVERED abgeschlossen)**

Lane: `codex/f9-03-fremdnutzer-filter` off `origin/codex/m1-wave-02` (keine Migration).
Vorgänger: F9.1 Slice A (Liste/Summe), F9.2 (Stoppuhr).

## Angewendete Skill-Regeln
- reonic-parity: Live-Evidenz zuerst, TDD, keine erfundenen Filter, additiv (kein Schemawandel).
- contract-first: Query-Vertrag in `lib/integrations/time-tracking/contract.ts` (kein Hash-Pin dort — kein Mirror).
- product-lens: Warum — Projektleitung sieht wessen Stunden wo drinstehen (Abrechnung/Review), ohne CSV-Umweg.

## Live-Evidenz (api.reonic.de/rest/v3/openapi, 2026-09-04, read-only)
- `GET /timetracking`: `userIds` — array/null, items UUID, maxItems 50, „Comma-separated list or repeated query param".
- Daneben (NICHT Scope): `eventTypeIds` (gleiche Form), `page`, `archived`, `parentId/parentType`, `startAt.gt/...`.
- `eventTypeIds` bleibt bewusst offen (eigener Filter-Slice oder mit CSV-Export).

## Scope
1. `listTimeEntries` akzeptiert `userIds?: string[]` (max 50, UUIDs, zod-validiert; `[]`/fehlend = kein Filter).
2. Filter greift auf Zeilen UND Summe (`totalWorkingMinutes` über gefilterter Menge: gestoppt, nicht archiviert).
3. Normative Filter-Semantik (Schnittmenge): Ergebnis = Einträge deren `user_id` ∈ (angefragte IDs ∩ bekannte Workspace-User-IDs). Sonderfälle: (a) Parameter fehlend/`[]`/`null` → kein Filter (alle Einträge); (b) Anfrage nicht-leer, Schnittmenge leer → leeres Ergebnis (kein Fehler, keine Leaks). Leere Schnittmenge kollabiert nie zu (a).
4. UI Projekt-Zeiterfassung: Nutzer-Multi-Select über NEUE schlanke `listTimeMemberOptions` (time-tracking-Service, `time.read`, membership↔user_identity, Label = E-Mail, Limit 200, inkl. ehemaliger Mitglieder solange Membership besteht) + Server-Action in der Zeiterfassungs-Route; clientseitige Auswahl-Cap 50 (Server-Validation authoritative). NICHT `membershipSearch` (braucht `project.assign` — falsche Permission für Lese-Filter).
5. Keine Migration, keine RLS-Änderung, keine neue Permission (`time.read` wie bisher).
6. Summe serverseitig, Semantik identisch F9.1 über gefilterter Menge (laufende Einträge in Zeilen, nicht in Summe); `null` = fehlend (zod nullish→[]). UI-Cap 50 via Client-Komponente (`user-filter-form.tsx`, deaktiviert+ Hinweis); Server-Slice als Backstop.
7. DECIDED (eigene Entscheidungen, keine Reonic-Claims): unsere Liste hat keine `page`-Pagination (keine Partial-Seiten-Falle); Trennung Format-/Existenzvalidierung (keine UUID → ValidationError, gültige-aber-fremde UUID → leer).
8. Folge: `eventTypeIds`-Filter + CSV-Export bleiben F9-Folge-Slices (kein Backlog-Verzeichnis im Repo — Verweis hier).

## Nicht-Ziele
- Kein CSV-Export, keine `eventTypeIds`, keine Datums-/Seiten-Filter, keine Pausen-Segmente/Idle (F9.2-Folge), keine Anonymisierung (Leser sehen Einträge inkl. userId bereits heute).

## Tests (RED zuerst)
- Eigene + fremde Einträge mischen: Filter je Nutzer, mehrere IDs, leeres Array = alles.
- Mischfall bekannt+fremd → nur bekannte; nur-fremde-Workspace-UUID → leer; nur-Unbekannte ≠ leeres Array.
- Exakt 50 IDs akzeptiert; 51 IDs / keine UUID → ValidationError.
- Summe folgt Filter (gestoppte zählen, laufende nicht, archivierte nicht).
- Reader ohne `time.read` weiter blockiert; Viewer-Verhalten unverändert; Member-Options ohne `time.read` blockiert.

## Offene Punkte → FRAGEN-AN-MIKAIL.md
- Keine slice-eigenen; F4-Fragen bleiben separat.
