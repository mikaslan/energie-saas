# F8-04 Gutschrift-Anrechnung (Gutschrift auf Rechnung anrechnen)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-11
Nachweis: DB F0804 4/4, E2E F8-04-E2E-01 1/1 lokal beobachtet;
keine Migration (Link-Tabelle typneutral), keine neuen Permissions.

## Ziel und Abgrenzung

F8-02/F8-03 rechnen nur Anzahlungen (Typ `invoice`) an. Eine
ausgestellte Gutschrift (Typ `credit_note`) mindert die Forderung
gleichgerichtet, ist aber nicht verlinkbar (F8-02-Spec „Bewusst offen:
Gutschrift-Anrechnung"). Dieser Slice öffnet den Pfad: Gutschrift als
Geber auf ausgestellte Rechnung, mit denselben Deckeln und derselben
Anzeige. Keine neue Lane-Freigabe nötig (Gesamtauftrag 2026-09-10).

## Evidenz

- Katalog F8.6 („Korrektur nur Void oder Gutschrift") + F8-02-Spec
  „Bewusst offen".
- Exakte Reonic-Darstellung UNKNOWN; Layout ESTIMATE, nur gespeicherte Werte.

## Datenmodell (keine Migration)

`commercial_document_link` ist typneutral (Paar-Unique + `applied_cents`);
nur die Typwache fällt für die Geberseite (`invoice`/`credit_note`,
je `issued`). Empfängerseite bleibt `invoice` (nicht storniert).
Kandidaten-DTO bekommt additiv `kind: "deposit" | "credit"`.

## Validierung (fail-closed)

- Geber: nur `issued` (Entwurf nie); Empfänger: `invoice`, nicht `voided`.
- Σ applied je Gutschrift ≤ Brutto(Gutschrift); Σ je Rechnung ≤
  Brutto(Rechnung) — sonst Konflikt.
- Kettenregel unverändert (Geber mit Eingangs-Links nicht verlinkbar).
- Unlink stellt Rest wieder her (gleicher Pfad wie Anzahlungen).

## Berechnung/Anzeige

- Keine neuen Blöcke: Kandidatenliste führt Gutschriften mit Rest
  (Suffix „· Gutschrift"), Vorbelegung min(Reste) wie F8-03,
  Allokationen am Gutschrift-Detail wie am Anzahlungs-Detail.
- Berichts-CSV (F5-01) bleibt unverändert (keine Umbuchung, nur Anzeige).

## Akzeptanz

- DB F0804 4/4 (Link + beidseitige Caps, Entwurfs-Gutschrift gesperrt,
  Über-Allokation fail-closed, Kette gesperrt, Kandidaten-kind).
- E2E F8-04-E2E-01 (Gutschrift 119 € voll auf 238-€-Rechnung, Rest 119 €).
- Gates: typecheck/lint/depcruise grün, Nachbarn (F8-01/02/03, M301, M3-01-E2E) lokal.

## Bewusst offen

- Mehrstufige Ketten, DATEV-/E-Rechnung, Versand, Mahnwesen (Nicht-Feature).
