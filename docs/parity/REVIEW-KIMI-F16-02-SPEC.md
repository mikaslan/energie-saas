# Review F16.2 — Zustandslose PDF-Vorschau

## Verdikt: **NACHBESSERUNG**

Keine P0-Blocker, aber drei substanzielle P1/P2-Befunde, die vor Freigabe in der Spec verankert werden müssen. Der Slice ist in Grundkonzept und Scope-Disziplin sauber; die Schwachstellen liegen im Kernversprechen („null Writes") und einer unterschätzten Upstream-Abhängigkeit.

---

## Befunde

### P1-1 — `lockSource`-Wiederverwendung widerspricht potenziell dem Null-Writes-Versprechen
Die Spec schreibt „gleiche Quell-Validierung wie Draft-Pfad (`lockSource`-Wiederverwendung)" und gleichzeitig „null Writes … kein `updated_at`-Touch". Der Name `lockSource` impliziert eine Sperr-Semantik (z. B. `SELECT … FOR UPDATE`, Lock-Flag oder zumindest transaktionale Sperre). Im Lesepfad wäre **jede** Form von Sperre/Touch ein Verstoß gegen die Kernzusage des Slices — und genau darauf ist der Slice zugeschnitten.

**Gefordert:**
- Explizites Statement in der Spec: `lockSource` ist im Preview-Pfad eine reine, nicht-sperrende Validierung (kein Row-Lock, kein Touch, kein `FOR UPDATE`).
- Falls `lockSource` heute sperrt: Refaktor in `validateSource` (read-only) + `lockSource` (Draft-Pfad) als Aufgabe des Slices benennen — das ist dann kein Scope-Creep, sondern Voraussetzung des Null-Writes-Claims.
- Test ergänzen: Nachweis, dass während des Preview-Calls keine exklusive Sperre gehalten wird (bzw. mindestens: Validierungsfunktion ist als pure deklariert und per Test abgesichert).

### P1-2 — Null-Writes-Testplan unvollständig: Events/Audit fehlen
Die Spec verspricht „kein Event/Audit", der Testplan prüft aber nur Draft-Rows, Queue-Eintrag und `updated_at`. Der wichtigste Nachweis des Slices ist damit lückenhaft — ein versehentlich emittiertes Domain-Event oder ein Audit-Eintrag der Server-Action würde unentdeckt durchrutschen.

**Gefordert:**
- Testassertions ergänzen: Event-/Outbox-Tabelle und Audit-Log vorher/nachher unverändert.
- Prüfen, ob die Server-Action-Infrastruktur selbst implizit auditiert (Request-Logs ausgenommen, aber fachliche Audit-Events nicht); falls ja, muss die Preview-Action davon ausgenommen sein.

### P2-1 — Versteckte Abhängigkeit zu ungemergtem F2.2
„UI übergibt Primary aus F2.2-Readmodell sobald gemergt" ist aus Sicht der Funktion korrekt (explizite `variantId` ist die richtige Design-Wahl — Primär-Auflösung gehört nicht in die Preview), verschiebt das Problem aber in die UI: **Ohne F2.2 hat der Editor-Button keine Quelle für die `variantId`.** Der Slice wäre dann fachlich fertig, aber nicht auslieferbar. Die Spec benennt dies als Nicht-Ziel, aber nicht als Abhängigkeit/Risiko.

**Gefordert:**
- Expliziter Abhängigkeits-Eintrag: F16.2 ist mergebar, aber der UI-Button ist erst mit F2.2 (oder einem definierten Interim, z. B. explizite Varianten-Auswahl im Dialog) aktivierbar.
- Entscheidung festhalten: Feature-Flag/versteckter Button bis F2.2, oder Interims-Auflösung — nicht dem Implementierer überlassen.

### P2-2 — `expectedVariantRevision` vs. „aktuelle Revision" nicht präzisiert
Der Scope spricht einmal von „versiegelter **aktueller** Revision", die Signatur nimmt aber `expectedVariantRevision`. Bei Parität zum Draft-Pfad (stale → Conflict) ist das konsistent — aber nur, wenn „aktuell" serverseitig aufgelöst und gegen `expectedVariantRevision` geprüft wird. Die Spec sollte einen Satz dazu festhalten, damit keine zweite Interpretation („rendere immer aktuell, ignoriere expected") entsteht.

### P3-1 — Server-Action-Semantik dokumentieren
Eine Server-Action ist technisch ein POST/Mutation-Endpunkt. Für einen explizit zustandslosen Slice ist das legitim, sollte aber einen Halbsatz Rechtfertigung bekommen (srcDoc-Transport, kein GET-Endpunkt nötig, kein Cache-Verhalten) — sonst lädt es zu späteren „warum kein GET?"-Nachfragen oder ungewolltem Caching-Verhalten ein.

### P3-2 — Test: Pure-Template-Asserts gut, aber Fehlerpfad-Abdeckung asymmetrisch
Reader-OK und PermissionDenied sind abgedeckt; der Fall „interner User ohne `project.read`" (nicht nur Externe) ist nicht explizit genannt. Kleinigkei­t, eine Zeile im Testplan genügt.

---

## Checkliste im Einzelnen

| Prüfpunkt | Ergebnis |
|---|---|
| Zustandslosigkeit (inkl. Touch/Event) | ⚠️ Anspruch sauber formuliert, aber `lockSource`-Semantik ungeprüft (P1-1) und Event/Audit-Nachweis fehlt im Testplan (P1-2) |
| Validierungs-Parität zum Draft-Pfad | ✅ Konflikt/NotFound/Integrity spiegeln Draft-Pfad; P2-2 präzisieren |
| Permission-Wahl (`project.read`) | ✅ Korrekt: lesender Zugriff, keine neue Permission, keine RLS-Änderung. Draft-Wasserzeichen verhindert Missverständnis als verbindliches Dokument |
| Explizite `variantId` statt Primary | ✅ Richtige Design-Entscheidung (Funktion bleibt dumm); F2.2-Ungemergt ist ok für die Funktion, aber UI-Auslieferbarkeit muss als Abhängigkeit deklariert werden (P2-1) |
| Override-Ausschluss | ✅ Sauber begründet: Vorschau zeigt Snapshot-/BOM-Wahrheit, Override ist Verhandlungsfeld — konsistent mit „keine erfundenen Preise"; Ausschluss ist in Nicht-Zielen dokumentiert |
| Scope-Creep | ✅ Keiner. Download, Ausstellung, Template-Änderung, Worker, Storage, Migration, RLS alle explizit draußen |
| Testplan | ⚠️ RED-first, gute Fehlerfälle, Escape-Asserts — aber Kernnachweis (null Writes) unvollständig (P1-2) |
| Erfundene Claims | ✅ Keine erkannt. Template/Renderer/Validierung werden als M2-02-Bestand referenziert, nicht neu behauptet; Status „SPECIFIED (DISCOVERED abgeschlossen)" plausibel |
| Sicherheit | ✅ Kein Remote-HTML, kein Secret, Escape-Test geplant, `srcDoc` lokal, Wasserzeichen |

---

## Empfohlene Änderungen (kompakt)

1. **P1:** `lockSource`-Semantik klären (read-only-Validierung, keine Sperre) — ggf. Refaktor-Aufgabe in Scope aufnehmen.
2. **P1:** Testplan um Event-/Outbox-/Audit-Unverändertheit erweitern.
3. **P2:** F2.2 als formale Abhängigkeit für die UI-Aktivierung deklarieren, Interim/Flag-Strategie festlegen.
4. **P2:** Einen Satz zur Auflösung „aktuelle Revision vs. `expectedVariantRevision`".
5. **P3:** Server-Action-Wahl begründen; interner PermissionDenied-Test ergänzen.

Nach Einarbeitung von 1–3 ist der Slice ohne weitere Review-Runde freigabefähig — die Architektur-Entscheidungen (Permission, variantId, Override-Ausschluss, Template-Wiederverwendung) sind tragfähig und brauchen keine Diskussion mehr.