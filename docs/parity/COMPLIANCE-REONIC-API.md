# Compliance: Reonic API v3 Zugang

Stand: 2026-09-02 · Typ: Compliance-Dokument (Clean-Room-Gate) · Keine Secrets in dieser Datei.

## 1. Anlass und Entscheidung

Der Eigentümer (Mikail) hat am 02.09.2026 im Chat einen Reonic-API-Key
(Format `rnc_v3_*`, Client-ID benannt) bereitgestellt, die Nutzung beauftragt
und auf Rückfrage ausdrücklich bestätigt, dass alle benötigten Freigaben
erteilt sind. Damit gilt das API-Rechte-Gate aus dem kanonischen Goal-Prompt
(§5) als durch den Regelgeber bewusst geöffnet. Die bisherige
Clean-Room-Regel 1 in `CONTRIBUTING.md` ist entsprechend ersetzt (siehe dort).

Der Key wurde noch am selben Tag ausschließlich in die gitignorierte lokale
Datei `.env.local` übernommen und wird nirgendwo in Logs, Commits, Doku oder
Prompts wiederholt.

## 2. Zugang (öffentlich dokumentiert)

- API: Reonic REST API v3, Spec-Version 3.11.0
- Öffentliche Spec: `https://api.reonic.de/rest/v3/openapi` (OpenAPI/JSON)
- Referenz-UI: `https://api.reonic.de/rest/v3/docs` (Scalar)
- Basis-URL: `https://api.reonic.de/rest/v3/` — abgeleitet aus dem
  öffentlichen Spec-Server `{apiBaseUrl}/rest/v3/` und dem Host der Doku;
  per read-only Smoke (`GET /me`) zu verifizieren.
- Auth: Header `X-Authorization`, Wert = bereitgestellter Key (apiKey-Schema).
- 124 dokumentierte Pfade, Tags u. a.: Contacts, Users, Teams, Residential
  Projects (Variants, Payment Options, Subsidies, Signature Requests),
  Commercial Projects, Notes, Tasks, Files, Activities, Time Tracking,
  Checklists, Calendars, Components, Planning Templates/Packages, Offer
  Templates, Kanban, Tags, Lead Sources, Wiki, Photogrammetry, Webhooks.

## 3. Zweck

Der Zugang dient ausschließlich der funktionalen Referenz (Discovery-Lane)
für die Paritätsmatrix: rechtmäßig beobachtbares Verhalten → bereinigte
Capability-Verträge. Er überträgt weder Texte, Hilfetexte, Assets, Layouts
noch Datenbank-Inhalte in das Produkt. `X-Authorization`-Antworten werden
niemals zum kanonischen Domainmodell.

## 4. Verbindliche Nutzungsregeln

1. Nur Endpunkte, die in der öffentlichen OpenAPI-Spec dokumentiert sind.
2. Keine versteckten oder nicht dokumentierten Endpunkte raten oder probieren.
3. Keine Mutationen (POST/PATCH/DELETE, auch update/delete-Endpunkte) ohne
   separate ausdrückliche Freigabe des Eigentümers.
4. Keine Massenexporte; Seiten nur einzeln und nur soweit für die Capability
   nötig.
5. PII, E-Mail-Adressen, IDs und Secrets werden vor jeder Speicherung
   entfernt oder durch synthetische Werte ersetzt.
6. Rohe Antworten werden nicht dauerhaft gespeichert; bereinigte Fixtures
   liegen gitignored unter `artifacts/` und sind als synthetisch markiert.
7. Keine echten Kundendaten als Demo-Fixture; Demo-Organisation bleibt
   synthetisch.
8. Rate Limits und `Retry-After` werden respektiert; kein automatisiertes
   Hammering.
9. Reonic wird nie zur Runtime-Abhängigkeit des Produkts.

## 5. Offene Annahmen (vom Eigentümer zu bestätigen)

- ANNAHME: Key wurde von der Reonic GmbH an den Eigentümer (eigener
  Workspace) ausgestellt.
- ANNAHME: Die vertragliche/AGB-seitige Nutzung für die eigenständige
  Paritätsentwicklung ist durch den Eigentümer geprüft und erlaubt.
- ANNAHME: Umgebung = produktive API; Scope = ein eigener Workspace.
- ANNAHME: Key-Typ (Read-only / Read+Write) wird über `GET /me` ermittelt;
  bis dahin gilt Read-only als Höchstgrenze.

## 6. Smoke-Ergebnis (2026-09-02, read-only)

`GET https://api.reonic.de/rest/v3/me` mit `X-Authorization`-Header → HTTP 200
in 0,8 s. Antwort (Werte maskiert, Rohantwort verworfen): `clientId` = bereit-
gestellte Client-ID, `clientName` = WM…, `locale` = de-DE, `currency` = EUR,
`accessLevel` = **read-only** (9 Zeichen, `rea…`). Basis-URL bestätigt; der
Key ist technisch auf Lesen begrenzt — Mutationen sind damit ausgeschlossen,
bis der Eigentümer ggf. einen anderen Key-Typ freigibt.

## 7. Evidence-Klassifikation

Antworten dieser API werden als OBSERVED geführt, soweit sie aktuelles,
dokumentiertes Verhalten zeigen; alles Weitere bleibt INFERRED/UNKNOWN.
Widersprüche zur öffentlichen Doku werden im UNKNOWN-CONFLICT-LOG geführt.
