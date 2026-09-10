# F5-01 Wärmepumpen-Schätzung (Schätzverfahren, lesend)

Ziel: Heizlast-Orientierungswert je Energieprofil aus dem gespeicherten
thermischen Jahreswärmebedarf — rein lesend, keine Editierung, keine neue
Permission, keine Schemaänderung.

## ESTIMATE (reversibel, Referenzfrage offen)

- Methode: `Heizlast [kW] = thermischer Jahresbedarf [kWh] / Volllaststunden [h]`,
  Volllaststunden versioniert: Bestand 2000 h/a, Neubau 1700 h/a
  (Faustwert-Bandbreite VDI-4650-Praxis; exakter Reonic-Wert UNKNOWN,
  Q-F4-03-COP-Referenz-Nachbarschaft).
- Empfehlungsgröße: Heizlast × 1,1 Reserve, auf halbe kW aufgerundet.
- Das Ergebnis ist eine **Schätzung** und ersetzt keine Heizlastberechnung
  nach DIN EN 12831 (zertifizierte Normrechnung). Die UI trägt diesen Hinweis
  direkt an der Zahl (kein Kleingedrucktes anderswo).
- Fail-closed: ohne bekannten thermischen Bedarf (> 0, endlich) keine Zahl —
  kein 0-kW-Ergebnis, keine stille Gebäudeklasse (beide Klassen werden
  nebeneinander gezeigt, solange das Profil keine Klasse trägt).

## Scopes

1. Reiner Builder `sizing-estimate-v1` (Bedarf + Klasse → Last + Empfehlung).
2. Read-only-Box im Energieprofil-Editor aus gespeicherten Profildaten.
