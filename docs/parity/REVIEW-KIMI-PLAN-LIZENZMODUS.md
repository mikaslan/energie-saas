# Kimi-K3-Sign-off — PLAN-LIZENZ-MODUS (2026-09-02)

Reviewer: Kimi K3 (moonshotai/kimi-k3 via OpenRouter, Kimi Code CLI 0.40.1).
Gegenstand: `docs/parity/PLAN-LIZENZ-MODUS.md` (Volltext inline geprüft),
zusätzlich `docs/legal/LICENSE-GRANT.md` und `docs/parity/` verifiziert.

## Ergebnis: GO unter drei Auflagen

Befunde (8, kein P0): P1 — Lizenzbeleg nur als Transkript (Original-`.eml`
fehlt); P1 — DSGVO-Einordnung für personenbezogene Import-Domänen fehlt;
P1 — „nie blind übernehmen" gilt nur für Code, nicht für Daten-Mappings;
P2 — ASSET-LICENSE-Register fehlt (Drittmaterial-Risiko bei 288 Bildern);
P2 — Browser-Session nur prozedural schreibgeschützt (Capture-Protokoll);
P2 — Phase C ohne Zeitplan (Prioritäten eingefroren lassen bis Dump da ist);
P2 — Supply-Chain-Scan bei Repo-Übernahme; P2 — Quoten-Drift durch Importe
(Import ≠ Capability).

## Auflagen (im Plan §5 verankert)

1. **Beleg-Regime:** Original-Lizenzmail (`.eml`/PDF) vor weiteren Importen
   in `docs/legal/` ablegen; `ASSET-LICENSE.md` anlegen, bevor importierte
   Bilder/Vorlagen gemerged werden.
2. **PII-Einordnung:** Domänen mit Personenbezug (Kontakte, Kalender,
   Projekte, Notizen) nur nach Datenschutz-Klassifikation importieren;
   Nicht-Produktivumgebungen erhalten ggf. pseudonymisierte Daten.
3. **Import-Gates analog Code-Gates:** Jeder Daten-Import mit
   Mapping-Validierung (Schema-Tests, Dry-Run + Abgleichszählungen) und
   Provenienzeintrag; ohne Gate kein VERIFIED und kein Quoten-Einfluss.
