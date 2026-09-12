# F13-11 Planungsservice (1 Anfrage je Angebot)

## Stand
- Modulkatalog F13.3: Fristwahl (24 h/48 h/Datum), Status
  Requested → In progress → Finished → Accepted, 1 Anfrage pro Angebot.
  Kein Modell, kein Pfad im Code (0 Treffer).
- Muster: F13-01 Serviceauftrag (Filing-Objekt, `installation.read/write`,
  keine neuen Permissions).

## Umfang
- Migration `0123`: `planning_request` (id, workspace_id, project_id,
  offer_id, deadline_kind `express_24h|standard_48h|date`, deadline_at
  timestamptz, status `requested|in_progress|finished|accepted`,
  created_by, created_at, updated_at) + UNIQUE (workspace_id, offer_id)
  (genau 1 Anfrage je Angebot) + CHECKs (Statusmenge; date-Kind verlangt
  deadline_at; 24h/48h leiten deadline_at von created_at ab, DB-seitig
  via CHECK `deadline_at = created_at + interval`? — nein: ableiten im
  Service, CHECK nur Kohärenz) + RLS tenant_isolation + FORCE +
  Rollenvertrag (app_runtime select/insert/update, eigene Relations-Menge,
  Policy-Pin).
- Service `modules/planning-requests`: `requestPlanning` (Angebot gehört
  zum Projekt, sonst NotFound; Duplikat je Angebot → Conflict),
  `setPlanningStatus` (Kanten requested→in_progress→finished→accepted,
  sonst Validation; finished setzt finished_at? — kein finished_at,
  updated_at genügt), `listPlanningRequests` je Projekt (mit
  Angebotsnummer). Events/Audit IDs + Status (kein Kundenkontext).
- UI: Projektakten-Sektion (Liste + Anlegeformular Angebot + Frist +
  Statuswechsel mit Schreibrecht; Viewer liest).
- Revision über signierte Notizen: NICHT enthalten (Signatur-Flow-
  Anbindung eigenes Folgethema); ebenso Preise/Abrechnung (9,90–19,90 €),
  E-Mail je Übergang, Portal-Anteil.

## ESTIMATE (reversibel)
- Exakte Reonic-Felder/Preise UNKNOWN; Statusmenge + Fristen aus Katalog.
- Kein Storno-Status (Katalog nennt keinen; Fehlanlage bleibt sichtbar).

## Tests
- DB: Anlage + Kanten + Duplikat-Conflict + Fremdangebots-NotFound +
  RBAC + Fremdtenant-Leere.
- E2E: Anfrage anlegen → Statuswechsel → sichtbar.
