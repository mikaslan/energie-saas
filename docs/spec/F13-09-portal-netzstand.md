# F13-09 Netzstand im Kundenportal (Katalog F13.2-Folge)

Stand: IMPLEMENTIERT (Muse-Slice F13-09, Migration 0109; Muster 0106/0107).
Schließt die Portal-Lücke „KfW/Netzanmeldung“ für die Netzseite: Das Portal
zeigte bisher keinen Netzanmeldungs-Stand. Wie F13-04: kein
Reonic-Referenzbeleg; Auswahl und Layout sind reversible eigene Näherung
(ESTIMATE).

## 1. Umfang

- Migration `0109`: `resolve_portal_public_view` projiziert zusätzlich
  `gridRegistration` (genau eine Netzanmeldung je Projekt oder NULL:
  Status/Betreiber/Phasen-Daten — nie Zählernummer, rein interne
  Betriebsreferenz). `GRANT SELECT ON grid_registration TO app_owner`
  für den DEFINER. Keine Schreibpfade, keine neuen Rechte.
  Rollenvertrags-Pin per `grid_entry`-Marker nachgezogen.
- Contract (`lib/integrations/portal/portal-contract.ts`):
  `portalGridSchema` (+ `PortalGrid`), Pflichtschlüssel in der
  Public-View, optional im Resolver-Parse (Alt-Projektionen → null),
  Allowlist-Parse fail-closed (Fremdschlüssel/Fehlform → null).
- Portal-Übersicht: Karte „Netzanmeldung“ mit Stand (+ Betreiber),
  nur wenn vorhanden.

## 2. Tests

- DB (`tests/db/f1309-portal-netzstand.test.ts`): Portal projiziert
  Netzstand mit Betreiber, nie `meterNumber`-Schlüssel; ohne Anmeldung
  ehrlich null; mandatsfremdes Projekt unsichtbar.
- E2E (`tests/e2e/f13-09-portal-netzstand.spec.ts`): Akte anlegen →
  Betreiber/Zähler setzen → einreichen → Portal-Link → Übersicht zeigt
  „Eingereicht (Netz E2E GmbH)“, Zählernummer tritt nie aus.

## 3. Abgrenzung

- Zählernummer bleibt intern (Analogie BzA-Nummer in F13-04).
- F13-Angebotsbindung bleibt offen (Q-F13-ANGEBOTSBINDUNG-M2).
