# F5-06 Hydraulischer Abgleich (Verfahren B, Katalog F5.5)

Status: **SPECIFIED (RED, Tests geskippt)** · Lane: `codex/muse-fleet-3d-f5` · Stand 2026-09-20 (Spec + RED-Test `tests/unit/f506-hydraulik.red.test.ts`, `describe.skip` bis zur Implementierung)

Katalog F5.5 (`docs/blaupause/01-modulkatalog.md:76`): „Hydraulischer Abgleich Verfahren B: Ventileinstellwerte je Heizkörper, Volumenströme; Heizkörper-Ampel (grün/gelb/rot) mit Tauschvorschlägen → automatische BOM-Zeilen". Die Roadmap parkt F5.2–F5.5, bis das WP-Modul Umsatz trägt (`docs/blaupause/05-roadmap.md:63,73`) — dieser Slice bleibt daher max. SPECIFIED/CONTRACTED (F4-Präzedenz: F4-01d, F4-02d, F4-03b, F4-04g, F4-05c). Keine Implementierung, keine Migration, kein Commit.

## §1 Verfahrens-Umfang

Strikt Katalogumfang: Volumenstrom je Heizkörper, Ventileinstellwert je Heizkörper, Heizkörper-Ampel mit Tauschvorschlag, daraus automatische BOM-Zeilen (§5). Explizit OUT: Pumpenauslegung, Rohrnetzberechnung, Abgleichprotokoll/Bericht (Protokoll gehört zu F5.6-Berichten, sobald Norm- und Förderbelege stehen).

## §2 Rechenweg

Volumenstrom je Heizkörper: `V̇ [l/h] = Q [W] / (c · ΔT)` — mit Raumheizlast Q aus F5.1/F5.4 (Blocker §6), Wärmekapazität c des Heizwassers und Spreizung ΔT = Vorlauf − Rücklauf. Vorlauf, Rücklauf und Spreizung sind explizite Operateur-Inputs (keine stillen Defaults, Bereichsprüfung fail-closed). Ventileinstellwerte brauchen kv-Tabellen je Ventiltyp — keine Ventil-/Herstellerkurven im Repo (vgl. F4-03b „Bewusst offen"): Datenlücke, kein Raten, eigene Datenquelle im Folgeslice.

## §3 Ampel-ESTIMATE v1

Deckungsgrad je Heizkörper = abgebbare Leistung / Raumheizlastanteil (ESTIMATE, versioniert `wmee-hydraulic-traffic-light.v1`, reversibel): grün ≥ 100 %, gelb 80–<100 %, rot < 80 %. Schwellen ohne Normbeleg — Referenzfrage Q-F5-06-AMPEL-REFERENZ offen (F5-01-Muster: Faustwert-Estimate, exakte Reonic-/Normwerte UNKNOWN). Die UI trägt den ESTIMATE-Hinweis direkt an der Ampel (kein Kleingedrucktes anderswo).

## §4 Tauschvorschläge

Ein gelber/roter Heizkörper braucht einen Tauschvorschlag (größerer Heizkörper / höhere Leistung). Das verlangt ein Heizkörper-Inventar je Raum: Typ, Maße, Leistung — heute fehlt alles außer der Zählung (F1-19 `radiatorCount` 0–50, einzige Heizkörper-Spur, s. Pin-Test). Katalog-Anbindung der Vorschläge ist Folgeslice nach F16-13-Präzedenz: optionale Bindung (Id + Revision), Preise/Einheit aus der gebundenen Live-Revision, Drift/Archiv/Fehlen → fail-closed, manuelle Edits lösen die Bindung.

## §5 BOM-Kopplung (M2-01)

Tauschvorschläge werden automatische BOM-Zeilen über M2-01-Revise-Ops (`add_custom_line` / `remove_custom_line`, `expectedRevision`-CAS, unveränderliche Revisionen — bestehende Stände ändern sich nie still). Custom lines zuerst (`source = custom`, eigene Preise, ausdrücklich ohne Katalogbehauptung — Fälschungsschutz wie M2-01/F16-13); kataloggebundene Zeilen erst mit der Katalog-Anbindung aus §4. Revisions-/Idempotenz-Semantik bei Neuberechnung: neue Eingaben → neue Revision N+1 (kein stilles Überschreiben); idempotenter Replay ohne Eingabeänderung → keine neue Revision, kein neues Event (M2-01-Nebenläufigkeit).

## §6 Blocker-Doku

Berechnung heute 0 %: F5.1-Raumheizlast, F5.3-Raummodell und F5.4-Auslegung (VDI 4645, Herstellerkataloge) sind Roadmap-geparkt (s. Kopf); die Heizkörper-Entity fehlt (nur F1-19-Zählung). Bis alle Inputs belegt sind, verweigert das Blocker-Gate (`assertHydraulicReadinessV1`) die Berechnung fail-closed — keine Ampel, keine Einstellwerte, keine BOM-Zeilen aus unbelegten Daten.

## ROT-Beleg (RED-Test vor dem Skip, 2026-09-20)

`npx tsx scripts/run-tests.mts tests/unit/f506-hydraulik.red.test.ts` → 4 failed, 1 passed (Pin grün):

```text
× bietet einen Verfahren-B-Builder hydraulic-balancing-v1 an
  AssertionError: expected false to be true // Object.is equality
× exportiert die Ampel-Regel classifyRadiatorCoverageV1 (versioniert)
  AssertionError: expected '' to contain 'classifyRadiatorCoverageV1'
× exportiert den BOM-Zeilen-Builder buildHydraulicBomLinesV1
  AssertionError: expected '' to contain 'buildHydraulicBomLinesV1'
× verweigert die Berechnung ohne Raumheizlast (Blocker-Gate fail-closed)
  AssertionError: expected '' to contain 'assertHydraulicReadinessV1'
✓ pinnt radiatorCount 0–50 als einzige Heizkörper-Spur (keine Entity)
```

## Bewusst offen

- kv-Tabellen / Ventil-Herstellerkurven (eigene lizenzierte Datenquelle, kein Scraping).
- WP-Herstellerkurven (F5.4), LiDAR-Aufmaß (F5.2), Norm-Lizenzen (DIN EN 12831 / VDI 4645).
- Abgleichprotokoll/Bericht (F5.6), sobald Belege stehen.
- Follow-up entfernt `describe.skip` in `tests/unit/f506-hydraulik.red.test.ts`.
