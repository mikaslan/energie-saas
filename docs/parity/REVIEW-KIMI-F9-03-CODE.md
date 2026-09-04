# Code-Review: F9.3-Slice „Fremdnutzer-Filter" (Zeiterfassung)

## Verdikt: ✅ FREIGABE (mit P2-Auflage, kein Blocker)

Der Slice ist sauber, spec-konform im Kern und gut getestet. Ein P2-Befund (fehlende clientseitige Cap-50 im UI, Spec-Punkt 4) sowie zwei P3-Hinweise. Keine P0/P1.

---

## Befunde

### P2-1: Clientseitige Auswahl-Cap 50 fehlt (Spec-Abweichung)
**Ort:** `page.tsx` Filterformular

Spec-Punkt 4 fordert explizit „clientseitige Auswahl-Cap 50 (Server-Validation authoritative)". Die UI rendert bis zu 200 Checkboxen ohne Begrenzung oder Hinweis. `parseUserFilter` kappelt dann **still** per `.slice(0, 50)`:

- Ein Nutzer in einem Workspace mit >50 Mitgliedern kann 60 Häkchen setzen; nach dem Submit sind nur 50 aktiv — ohne Fehlermeldung, ohne visuellen Hinweis, welche 10 verworfen wurden (Dedup-Reihenfolge = Reihenfolge der Optionen, nicht der Auswahl).
- Da die Page invalid/zu-viele IDs vorfiltert, erreicht die authoritative Service-Validation (51 → `TimeTrackingValidationError`) niemals den UI-Pfad. Die „authoritative" Schicht ist im Normalbetrieb tot.

**Empfehlung:** Entweder Checkbox-Limit clientseitig durchsetzen (z. B. Deaktivieren weiterer Checkboxen ab 50 + Hinweistext „max. 50 Nutzer") oder beim Truncating-Hinweis in der Page („Auswahl auf 50 begrenzt"). Kein Blocker, da keine Datenkorruption — aber stilles Fehlverhalten in einer explizit spezifizierten Anforderung.

### P3-1: Testlücke — Summen-Semantik mit laufenden/archivierten Einträgen unter Filter
**Ort:** `tests/db/f903-user-filter.test.ts`

Die Spec-Testliste verlangt „Summe folgt Filter (gestoppte zählen, laufende nicht, archivierte nicht)". Alle Fixtures erzeugen ausschließlich gestoppte, nicht-archivierte Einträge. Die Kombination `userIds`-Filter × laufender Eintrag × archivierter Eintrag wird nicht getestet. Risiko ist gering (das Filter-Fragment ist identisch in Zeilen- und Summen-Query), aber die spezifizierte Matrix ist nicht abgedeckt. Ggf. durch F9.1-Basis-Tests abgedeckt — dann bitte im Spec-Doc referenzieren.

### P3-2: Spec-Dokument — Nummerierungsdurcheinander
**Ort:** `docs/spec/F9-03-fremdnutzer-filter.md` Scope-Liste

Reihenfolge 1–5, dann 8, 6, 7. Rein kosmetisch, erschwert aber Querverweise aus Findings/Fragen.

---

## Checkliste im Detail

| Kriterium | Befund |
|---|---|
| **SQL-Filter: leere Menge vs. fehlend** | ✅ Korrekt. `userIds ?? []` + `length === 0 → sql```: `undefined`, `null` und `[]` kollabieren zu „kein Filter". Nur-Unbekannte (nicht-leere Anfrage, leere Schnittmenge) liefert korrekt leeres Ergebnis — F903-DB-02 belegt beide Seiten der Semantik explizit. |
| **`any(::uuid[])`** | ✅ Korrekt eingebettet, parametrisiert (kein String-Concat → keine Injection). Die 50-UUID-Array-Bindung ist durch F903-DB-04 gegen echtes PostgreSQL abgesichert. |
| **Unqualifiziertes `user_id` in der Summen-Subquery** | ✅ Korrekt aufgelöst: innerste Scope-Regel bindet `user_id` an `total_entries.user_id` (äußere Korrelation greift nur bei fehlender innerer Spalte). Funktional richtig; Qualifizierung (`total_entries.user_id`) wäre leserfreundlicher — kein Befund, nur Stil. |
| **Summe konsistent** | ✅ Identisches `userFilter`-Fragment in Zeilen- und Summen-Query; übrige Summen-Semantik (gestoppt, nicht archiviert, workspace+projekt) unverändert. F903-DB-01 belegt 120/180-Minuten-Fälle. |
| **Validierung 51 / keine UUID** | ✅ `z.array(z.string().uuid()).max(50).nullish()` → `TimeTrackingValidationError`; beide Fälle durch F903-DB-04 rot-grün getestet, inkl. Grenzfall exakt 50. |
| **Scoping/RLS** | ✅ `listTimeMemberOptions` hart auf `ctx.workspaceId` begrenzt; E-Mail-Leak nur gegenüber `time.read`-Inhabern desselben Workspaces (E-Mails sind denen ohnehin über Eintrags-`userId`-Kontext bekannt). Fremde-Workspace-UUIDs im Filter → leer (F903-DB-03). Externe (`external_only`) blockiert (F903-DB-05). Keine RLS-Änderung, keine neue Permission. |
| **Member-Options** | ✅ `time.read` via `requireRead`, Limit 200, deterministische Sortierung (`lower(email), user_id`), zod-Output-Parsing. Dass Externe in der Optionsliste erscheinen, ist spec-konform (Spec schließt sie nicht aus; Filter auf sie ist sinnvoll, da sie Einträge haben können). |
| **Idempotenz/Seiteneffekte** | ✅ Reine Reads, alles innerhalb `authorizedQuery`. Keine Writes, keine Side Effects. |
| **UI: XSS/Escaping** | ✅ `{member.label}` wird von React escaped; `value`/`key` sind validierte UUIDs. Kein `dangerouslySetInnerHTML`. |
| **UI: GET-Form** | ✅ `method="get"`, wiederholte `userId`-Params; Page parst String- und Array-Form plus Komma-getrennt (live-paritätisch), dedupliziert, Reset-Link ohne Query-String. |
| **Bestehende Tests/Verhalten** | ✅ Signatur-Erweiterung `userIds?` rückwärtskompatibel; `includeArchived`-Verhalten unverändert. Verhaltensänderung: ungültige `projectId` wirft nun `TimeTrackingValidationError` statt DB-Fehler — additiv/härtend, alle bestehenden Aufrufer übergeben validierte Route-UUIDs. |
| **Scope-Creep** | ✅ Keiner. `eventTypeIds`, `page`, Datumsfilter explizit ausgenommen und als Folge-Slices deklariert. Keine Migration. |
| **Secrets** | ✅ Keine. |

---

## Fazit

Fachlich und sicherheitstechnisch sauber: Filter-Semantik (leer ≠ fehlend ≠ leere Schnittmenge) ist korrekt implementiert **und** testseitig belegt, Summe folgt dem Filter, Mandantentrennung hält, kein Leak, kein Creep. Die P2-Auflage (clientseitige Cap bzw. Truncating-Hinweis) sollte zeitnah — ggf. im nächsten F9-Slice — nachgezogen werden, blockiert die Freigabe aber nicht.