# F8-03 Anzahlungs-Split (eine Anzahlung auf mehrere Schlussrechnungen)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-11
Nachweis: DB F0803 4/4, E2E F8-03-E2E-01 1/1 lokal beobachtet;
keine Migration (Link-Tabelle trägt den Split), keine neuen Permissions.

## Ziel und Abgrenzung

F8-01/F8-02 binden eine Anzahlung an höchstens eine Schlussrechnung
(Exklusivitätswache in `assertLinkable`; Kandidaten zeigen „volles Brutto
verfügbar"). Dieser Slice öffnet den Pfad durchgängig: eine Anzahlung auf
mehrere Schlussrechnungen verteilen, Rest centgenau zeigen. Folgt auf
F8-02 (dort als „bewusst offen" erstgenannt). Keine neue Lane-Freigabe
nötig (Gesamtauftrag 2026-09-10).

## Evidenz

- Katalog F8.5 (Teilrechnungen, 3 Modi) + F8-02-Spec „Bewusst offen:
  Anzahlungs-Split über mehrere Schlussrechnungen, mehrstufige Ketten,
  Gutschrift-Anrechnung".
- Exakte Reonic-Darstellung UNKNOWN; Layout ESTIMATE, nur gespeicherte Werte.

## Datenmodell (keine Migration)

`commercial_document_link` trägt den Split bereits (Paar-Unique
`(workspace_id, final_id, deposit_id)` erlaubt mehrere Finals je
Anzahlung; `applied_cents` je Link). Nur die Exklusivitätswache fällt;
beide Deckel bleiben: Σ applied je Anzahlung ≤ Brutto(Anzahlung),
Σ applied je Schlussrechnung ≤ Brutto(Schluss).

## Validierung (fail-closed, keine stillen Defaults)

- Über-Allokation der Anzahlung (Σ applied + neu > Brutto) → Konflikt.
- Über-Anrechnung der Schlussrechnung (F8-02) bleibt Konflikt.
- Keine Ketten (F8-01-Regel unverändert): Anzahlung mit eigenen
  Eingangs-Links bleibt nicht anrechenbar; Schlussrechnung mit
  Ausgangs-Links bleibt nicht verlinkbar.
- Status-/Typ-/Workspace-Regeln unverändert; unlink stellt Rest wieder her.

## Berechnung/Anzeige

- Kandidaten: je Anzahlung Rest = Brutto − Σ applied (bereits
  voll allokierte entfallen); Command-Default bleibt volles Brutto der
  Anzahlung (F8-02-kompatibel), fail-closed bei Überschreitung; die UI
  zeigt den Rest als Obergrenze und füllt min(Rest Anzahlung,
  Rest Schlussrechnung) vor.
- Detail: Schlussrechnung zeigt weiter Zeilen + Rest; Anzahlungs-Detail
  zeigt Allokationen je Schlussrechnung + offenen Rest.

## Akzeptanz

- DB F0803 4/4 (Split auf zwei Finals, Über-Allokation fail-closed,
  Unlink stellt Rest her, Kette/Status weiter gesperrt).
- E2E F8-03-E2E-01 (Seed: Anzahlung 238 €, zwei Finals → 119 € + 119 €,
  Reste 0 € sichtbar).
- Gates: typecheck/lint/depcruise grün, betroffene Suiten lokal.

## Bewusst offen

- Mehrstufige Ketten, Gutschrift-Anrechnung, DATEV-/E-Rechnung, Versand.
