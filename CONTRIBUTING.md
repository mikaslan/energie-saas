# Beitragsregeln

## Clean-Room-Regeln (nicht verhandelbar)

Dieses Produkt baut den *Funktionsumfang* eines Wettbewerbers (Reonic) nach. Das ist
rechtlich zulässig (§ 69a Abs. 2 UrhG; EuGH C-406/10 „SAS") — aber nur innerhalb dieser
Grenzen:

1. **Reonic-Material nur gemäß Lizenz- und Gate-Dokumentation.**
   (a) API-Zugang ausschließlich gemäß `docs/parity/COMPLIANCE-REONIC-API.md`
   (read-only, bereinigt, keine Mutationen ohne separate Freigabe).
   (b) Lizenzierter Umfang: Die Reonic GmbH bestätigt mit E-Mail vom
   02.09.2026 (kontakt@reonic.de), dass die WM erneuerbare Energien GmbH die
   Reonic-Software, deren Quellcode und Datenbestände für das Projekt
   „energie-saas" nutzen, verändern und vertreiben darf — dokumentiert in
   `docs/legal/LICENSE-GRANT.md`. Innerhalb dieses Umfangs darf vom Eigentümer
   bereitgestelltes Reonic-Material (Code, Daten, Assets) übernommen werden;
   jede Übernahme wird mit Provenienz dokumentiert.
   (c) Weiterhin verboten: Test-/Demo-/Kunden-Login-Zugänge, Daten anderer
   Kunden, Reonic-Texte als Produkttexte ohne Freigabe und visuelle
   Reonic-Nachahmung (WMEE-Design bleibt die visuelle Referenz).
   Übrige Erkenntnisquellen bleiben öffentlich (Website, Doku, Videos,
   Reviews) plus eigene Anwender-Interviews.
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
