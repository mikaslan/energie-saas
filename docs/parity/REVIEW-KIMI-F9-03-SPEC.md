# Review F9.3 „Fremdnutzer-Filter"

## Verdikt: **FREIGABE mit Auflagen** (kein P0/P1; P2-Befunde vor Implementierung beheben, P3 dokumentarisch)

Die Spec erfüllt die Kernanforderungen: Live-Evidenz ist sauber von eigenen Entscheidungen getrennt (Punkt 6 explizit als DECIDED markiert, keine Reonic-Claims zu Summen-/Fehlersemantik erfunden), die Live-Abbildung von `userIds` (array, UUID, maxItems 50) ist korrekt übernommen, Scope-Creep ist aktiv abgewehrt (`eventTypeIds`, CSV, Datums-/Seiten-Filter, Pausen/Idle allesamt in Nicht-Ziele oder Folge-Slices verbannt). Die Schwachstellen liegen in der Präzision der Filter-Semantik und zugehörigen Testlücken.

---

## Befunde

### P2-1 — Widersprüchliche Formulierung der Filter-Semantik bei gemischten Listen
- **Stelle:** Scope-Punkt 3 („Unbekannte/nicht zum Workspace gehörende UUIDs → leere Menge") vs. Punkt 6 („unbekannte/fremde UUIDs werden ignoriert (Filter über bekannte IDs; nur-Unbekannte → leer)").
- **Problem:** Punkt 3 isoliert gelesen bedeutet: *eine* unbekannte UUID in der Liste → Gesamtergebnis leer. Punkt 6 sagt: unbekannte werden ignoriert, bekannte filtern weiter; nur wenn *alle* unbekannt sind → leer. Beide Lesarten sind inkompatibel. Zusätzlich besteht die Implementierungsfalle, „nur-Unbekannte → leer" versehentlich wie „`[]`/fehlend → kein Filter → alles" zu behandeln (leere Menge der bekannten IDs darf nicht mit „kein Filter gesetzt" kollabieren).
- **Fix:** Eine einzige normative Semantik-Definition, z. B.: „Der Filter wirkt über die Schnittmenge angefragter IDs ∩ bekannter Workspace-User-IDs. Ergebnis = Einträge dieser Schnittmenge. Sonderfälle: (a) Parameter fehlend oder `[]` → kein Filter (alle Einträge); (b) Schnittmenge leer bei nicht-leerer Anfrage → leeres Ergebnis (kein Fehler)." Punkt 3 entsprechend umschreiben oder streichen.

### P2-2 — Testplan deckt den kritischen Mischfall nicht ab
- **Stelle:** Abschnitt „Tests (RED zuerst)".
- **Problem:** Getestet werden nur die Extreme (alle bekannt, eine unbekannt, leeres Array). Der Mischfall aus P2-1 — bekannte + fremde UUIDs in einer Liste — fehlt, obwohl genau dort die Semantik-Mehrdeutigkeit liegt. Ebenso fehlt der Grenzfall **exakt 50 IDs** (nur „51 → ValidationError" ist gefordert) sowie explizit eine *existierende UUID aus einem fremden Workspace* (nicht nur generisch „unbekannt").
- **Fix:** Testfälle ergänzen: (a) gemischte Liste bekannt+fremd → Ergebnis nur der bekannten Nutzer; (b) Liste mit nur fremder-Workspace-UUID → leer; (c) exakt 50 IDs → akzeptiert; (d) Regression: nur-Unbekannte ≠ leeres Array.

### P3-3 — Summen-Definition: Zeilen-/Summen-Asymmetrie bei laufenden Einträgen nicht benannt
- **Stelle:** Scope-Punkt 2 und Tests („gestoppte zählen, laufende nicht").
- **Problem:** Dass laufende Einträge in den *Zeilen* erscheinen, aber nicht in `totalWorkingMinutes` eingehen, ist nur implizit. Ohne Verweis auf die F9.1-Definition der Summe bleibt unklar, ob F9.1-Semantik unverändert gilt oder F9.3 sie neu definiert.
- **Fix:** Ein Satz: „Summen-Semantik identisch zu F9.1, lediglich über der gefilterten Menge; laufende Einträge erscheinen in Zeilen, nicht in der Summe."

### P3-4 — UI-Verhalten am 50er-Limit unspezifiziert
- **Stelle:** Scope-Punkt 4 (Nutzer-Multi-Select).
- **Problem:** Serverseitig ist >50 → ValidationError definiert, aber nicht, wie das Multi-Select das verhindert/ankündigt (Auswahl ab 50 sperren? Fehlermeldung?). Geringes Risiko, da technisch abgefangen, aber UX-Flickwerk droht.
- **Fix:** Ein Satz: „Multi-Select begrenzt Auswahl clientseitig auf 50; Server-Validation bleibt authoritative."

### P3-5 — Verweis auf Folge-Slices ohne Ablageort
- **Stelle:** Scope-Punkt 7 (`eventTypeIds` + CSV „Verweis hier").
- **Problem:** Bewusst akzeptiertes Risiko (kein Backlog-Verzeichnis im Repo), aber der Verweis ist nur so lange auffindbar, wie F9.3-Dokumente greifbar sind.
- **Fix:** Optional — Folge-Slices mindestens im M1-Wave-Plan oder F9-Übersichtsdokument festhalten.

---

## Nicht bestätigte Risiken (explizit geprüft, kein Befund)

- **Kein Scope-Creep:** `eventTypeIds` trotz identischer Live-Form korrekt ausgeklammert und als Folge-Slice benannt; breaks/Idle sauber an F9.2-Folge delegiert.
- **Keine erfundenen Claims:** Alle Reonic-bezogenen Aussagen stehen unter „Live-Evidenz" mit Datum/Endpoint; Summen- und Fehlersemantik sind korrekt als eigene Entscheidungen deklariert.
- **Permission-Modell:** Kein neues Recht (`time.read`), RLS unverändert, additiv — konsistent mit „keine Migration".
- **Permission-Hinweis zu Punkt 3:** „keine Leaks via Fehlermeldung" ist konsistent mit der Leere-Menge-Semantik.

---

## Offene Fragen

1. **Historische Nutzer:** Liefert `membershipSearch` auch deaktivierte/ausgetretene Mitglieder? Für Abrechnungs-Reviews (product-lens-Begründung) ist die Filterbarkeit auf *ehemalige* Nutzer relevant — sonst sind deren Stunden per UI-Filter nicht mehr isolierbar, obwohl die Server-Semantik sie liefern würde.
2. **Performance der Summe:** Ohne Datumsfilter (bewusst Nicht-Ziel) aggregiert `totalWorkingMinutes` über die gesamte Historie — ist das bei großen Workspaces ein akzeptiertes Risiko für diesen Slice, oder soll eine Obergrenze/Hinweis in den Slice?
3. **`null` aus dem Live-Vertrag:** Reonic erlaubt `array/null` — wird `null` explizit wie „fehlend" behandelt, oder lehnt der zod-Vertrag `null` ab? Kleinigkeit, aber der Vertrag sollte es eindeutig machen.