# F8-09 Eltern-Sperre: keine Positionsänderung an belegter AB

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-12

Ziel: Belegter F8.5-Katalogsatz („Eltern-Editor sperrt"): Sobald eine
Auftragsbestätigung AKTIVE Teilrechnungen hat (alle Modi, Storno
ausgenommen), lehnt `createDocumentLine` weitere Positionen mit
`Conflict` ab — die Kettenbasis darf sich unter einer laufenden Kette
nicht ändern (stille Basenänderung wäre erfundene Abrechnung).

## ESTIMATE (reversibel, Referenzfrage offen)

- Sperre gilt nur für `order_confirmation` mit aktiver Kette (einzige
  Ketten-Eltern; F8-04b-Duplikate und freie Rechnungen unberührt).
- Stornierte Teilrechnungen befreien (konsistent mit Cap/Verbrauch).
- Fehlertyp `Conflict` wie übrige Kettenbrüche (Cap, Doppelverbrauch).
- Kein UI-Anteil: Die Belegdetailseite hat keinen Positions-Editor
  (read-only); der Guard sichert die Service-Grenze für alle
  gegenwärtigen und künftigen Aufrufer. Daher DB-verifiziert, kein E2E.

## Scopes

1. Service-Guard in `createDocumentLine` (aktive Kette → Conflict).
2. Keine Migration, keine Permissions, keine Events (Abweisung ohne
   Seiteneffekt — kein Audit für abgelehnte Schreibversuche wie
   übrige Guards).

## Geschlossene Testmatrix

- `F809-DB-01`: AB + percent-Kette → Zeile an AB → Conflict; Storno
  der Teilrechnung → Zeile wieder möglich.
- `F809-DB-02`: freie AB ohne Kette → Zeile ok; freie Rechnung mit
  „Kette" unmöglich (kein Elterntyp) — Zeile an Rechnung ok.

## Bewusst offen

- Positions-Editor-UI (eigener Pfad, dann mit Sperr-Anzeige).
- „Eltern-Zahlungsstatus berechnet" (Katalogsatz ohne belegte
  AB-Zahlungs-Semantik — keine erfundene Ableitung).
