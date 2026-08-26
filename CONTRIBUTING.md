# Beitragsregeln

## Clean-Room-Regeln (nicht verhandelbar)

Dieses Produkt baut den *Funktionsumfang* eines Wettbewerbers (Reonic) nach. Das ist
rechtlich zulässig (§ 69a Abs. 2 UrhG; EuGH C-406/10 „SAS") — aber nur innerhalb dieser
Grenzen:

1. **Kein Reonic-Zugang.** Niemals einen Test-, Demo- oder Kundenzugang zu Reonic nutzen
   oder nutzen lassen. Reonics AGB verbieten die Nutzung für Konkurrenzentwicklung;
   ein Verstoß öffnet GeschGehG- und UWG-Angriffsflächen (§ 4 Nr. 3 UWG).
   Erkenntnisquellen sind ausschließlich öffentlich (Website, Doku, Videos, Reviews)
   plus eigene Anwender-Interviews.
2. **Nichts kopieren außer Funktionsideen.** Tabu sind: Reonics UI-Gestaltung, Layouts,
   Icons, Texte (auch Hilfe-Texte), Code sowie Inhalte der Komponenten-Datenbank
   (§§ 87a ff. UrhG — Datenbankschutz). Eigene Benennungen, eigenes Design, eigene Daten.
3. **Abstand in Name und Auftritt.** Kein an „Reonic" angelehntes Naming, keine
   verwechselbare Aufmachung (§ 4 Nr. 3 a/b UWG). Markencheck (DPMA/EUIPO) vor jeder
   öffentlichen Namensnutzung.
4. **Screenshots/Zitate von Reonic** nur in internen Analyse-Dokumenten mit Quellenangabe,
   nie in Produkt, Marketing oder Doku.

## Architektur-Invarianten (aus docs/blaupause/04-architektur.md)

- Jede Tabelle trägt `workspace_id`; Zugriff nur über `withTenant()`; RLS auf jeder Tabelle.
- Alle Mutationen laufen durch Service-Funktionen; Server Actions sind dünne Wrapper.
- Service-Funktionen emittieren `domain_events` in derselben Transaktion.
- Snapshot statt Referenz an jeder kommerziellen Grenze (BOM, Rechnung, Signatur).
- Statusmaschinen explizit (erlaubte Übergänge in Code); append-only für alles Rechtliche.
- Modulgrenzen sind lint-erzwungen (dependency-cruiser); CI-Rot ist ein Stoppschild,
  keine Empfehlung.
- Migrationen immer `generate` **und** `migrate`; Test-DB strikt getrennt von Prod.

## Arbeitsweise

- Pro Meilenstein: Spec → Implementierungsplan → TDD. Kein Code ohne Plan.
- Architektur-Entscheidungen als ADR unter `docs/adr/` festhalten.
- Reviews laufen über Codex (`/codex:review --background`); Ergebnisse werden gesichtet
  und begründet übernommen oder verworfen.
