## Verdikt: FREIGABE

Der Slice ist vollständig, evidenzsauber und scope-diszipliniert. Kein P0, kein P1. Die P2-Befunde sind Präzisierungen, die vor/während der Implementierung eingearbeitet werden sollten, blockieren den Start aber nicht.

---

## Befunde

### P2

**P2-1 — Stelle: Service-Semantik / Anzeige-Regel (`displayTotalGrossCents = null` bei aktivem Override)**
Mit Override ist Brutto `null`. Die Spec definiert das sauber, prüft aber nicht, ob existierende Consumer des Readmodells (Editor-Detailansicht, ggf. PDF-Vorschau aus Vorgänger-Slices) `null` tolerieren. Da kein neuer Contract-Eintrag entsteht, entfällt die Consumer-Verifikation faktisch.
**Fix:** Kurze Bestandsaufnahme der `getOfferDetail`-Consumer im Testplan ergänzen (Readmodell-Test, der `overrideActive && gross === null` gegen den Editor-Render prüft). Wenn PDF aktuell Brutto rendert, dort Fallback auf „Netto + Hinweis" definieren oder explizit auf Signaturstrecke verweisen.

**P2-2 — Stelle: Audit-Events (Payload `{offerId, variantId?, actor, at}`)**
`offer.total_override_set` trägt den gesetzten Betrag nicht im Payload. Damit ist aus dem Audit-Trail nicht rekonstruierbar, *welcher* Wert gesetzt wurde (nur *dass*). Bei einem kundenwirksamen Preis-Override ist das eine echte Nachvollziehbarkeitslücke.
**Fix:** Payload für `total_override_set` um `valueNetCents` erweitern (Cleared-Event bleibt ohne Wert). Test „Audit-Events je Mutation" um Payload-Assertion ergänzen.

**P2-3 — Stelle: Konkurrenz Erstvarianten-Create (Verlierer → `OfferIntegrityError`, „Aufrufer wiederholt den Create-Pfad")**
Die Retry-Semantik ist unspezifiziert: Ein blindes Wiederholen des Creates erzeugt eine fachliche Duplikat-Variante (gleicher Name, gleicher Inhalt) — der Verlierer-Request des Clients würde beim Retry eine zweite, nicht-primäre Variante anlegen, ohne dass der Client das erwartet.
**Fix:** Spec klarstellen: Retry ist nur für idempotente Client-Wiederholung mit Fehler-Rückmeldung gedacht („Variante existiert inzwischen"), nicht für automatisches serverseitiges Re-Create. Alternativ: Verlierer-Create semantisch als Fehler an den Client propagieren, kein Retry-Pfad empfehlen.

**P2-4 — Stelle: Migration 0055, Backfill („Variante mit minimalem Ordinal")**
Tie-Break bei Ordinal-Gleichstand ist nicht angegeben. M2-01 impliziert vermutlich eindeutige Ordinals je Offer, die Spec sagt das aber nicht explizit; ein nicht-deterministischer Backfill wäre bei versehentlich doppelten Ordinals im Altbestand nicht reproduzierbar.
**Fix:** Backfill-Regel präzisieren: `ORDER BY ordinal ASC, created_at ASC, id ASC LIMIT 1` (deterministisch, stabil). Eine Zeile in der Migration + Backfill-Test um Tie-Case erweitern.

### P3

**P3-1 — Stelle: Bundle-Mapping (`id` → nein, „positionelle Identität genügt, erweitbar")**
Erweiterbarkeit ist behauptet, aber der spätere Pfad nicht skizziert: Fügt man später `id` hinzu, haben Altbestand-Einträge keinen. Unkritisch, aber einen Satz wert.
**Fix:** Ein Satz im Datenmodell-Abschnitt: „Bei späterer `id`-Einführung: Backfill auf `position`-Basis oder lazy bei nächstem Write."

**P3-2 — Stelle: `setOptionalBundles` (Service-Semantik)**
Keine Idempotenz-/No-op-Regel analog zu `setPrimaryVariant` (gleiche Bundle-Liste erneut setzen → Event + `updatedAt`-Touch oder No-op?). Inkonsistent zur sonst sauberen No-op-Disziplin.
**Fix:** Ein Satz: „Identisches Bundle-Array → idempotentes No-op ohne Event" (oder bewusst dagegen entscheiden und begründen).

**P3-3 — Stelle: CHECK-Range `0..9_000_000_000_000_000`**
Override `0` ist zulässig. Fachlich plausibel (kulanter Gratis-Deal), aber nicht begründet — anders als die sonst überall dokumentierten Grenzfälle.
**Fix:** Ein Halbsatz im Scope-Punkt 2: „0 explizit zulässig (Explizit-Override ≠ Clear)."

---

## Was sauber ist (Stichprobe, kein Befund)

- **Live-Evidenz-Abbildung vollständig:** Alle `ResidentialVariant`-Pflichtfelder sind mapped oder begründet verworfen (`totalPrice` deprecated → nicht persistiert; `systems` → Snapshot-BOM M2-01; `id` → stabile UUID). Bundle-Mapping feldweise dokumentiert.
- **Exactly-One-Design korrekt:** partieller Index, atomarer Switch, Promote-only, beide Konkurrenzfälle (Switch + Erstvarianten-Create) mit Index als letzter Schranke und explizitem Fehler statt stillem Retry. Revisionsstabilität der `offer_variant`-Zeile ist der entscheidende, korrekt belegte Grund, warum der Index auf der stabilen Zeile greift.
- **Live-Deprecation beachtet:** `totalPriceOverride`-Deprecation ist der Beleg für Offer-Level-Platzierung — kein Varianten-Override modelliert. Datierte Evidenz (Abruf vs. Deprecation-Stichtag) als zwei verschiedene Zeitstempel sauber aufgelöst.
- **Migrationssicherheit:** additiv, Backfill vor Index, DDL-Transaktion ohne CONCURRENTLY begründet (0054-Vorbild), RLS unverändert, keine Steuerzeichen in CHECKs.
- **Keine erfundenen Reonic-Behauptungen:** eigene Produktentscheidungen (max 50 Bundles, `position`, revisionsloser Override mit M2-01-Präzedenz) sind als solche markiert.
- **Kein Scope-Creep:** Finanzierung, Kundenauswahl, Mathematik sauber als Nicht-Ziele; Delete-Folgevertrag als verbindliche Vorgabe statt stiller Implementierung.
- **Testplan:** deckt Exactly-One, Promote, Demote-Abwesenheit, Backfill, beide Races, Anzeige-Fallback inkl. Primary-loser Altbestände, Cross-Tenant, Rollen, Idempotenz ab.

---

## Offene Fragen

- Ist Ordinal-Eindeutigkeit je Offer in M2-01 per Constraint garantiert (relevant für P2-4-Tie-Break-Relevanz)?
- Rendert irgendein aktueller Consumer (PDF/Export aus Vorgänger-Slices) bereits `displayTotalGrossCents`, sodass `null` bei Override sichtbar würde?
- Soll `offer.total_override_set` neben `valueNetCents` auch den vorherigen Wert (Diff) im Audit tragen — oder genügt die Sequenz set/cleared?