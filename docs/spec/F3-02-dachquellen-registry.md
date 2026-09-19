# F3-02 Dachquellen-Registry + Upload (providerfrei)

## Stand
- Modulkatalog F3.2: Gebäudequellen = Orthofoto, Google
  Solar/Earth 3D, Building-AI, Drohnen-Photogrammetrie, eigener
  Upload mit Referenzlinien-Skalierung, Selbstzeichnen.
- Batch-1 (F3-BATCH-1-vertrag): nur Registry + Upload +
  Selbstzeichnen. Alle Adapter = Folge-Batches.
- Muster: file-requests WORM-Put + 10MiB-Gates, storage/s3
  immutableKey/putImmutable, F3-01 Quick-Ausblendung.

## Umfang
- Migration `0270`: `planning_source` (id, workspace_id,
  project_id, site_id NULL, kind `upload|self_drawn` +
  RESERVED `ortho|google_solar|earth_3d|building_ai|drone`,
  storage_key/sha256/byte_size NULL außer upload,
  scale_ref_json NULL, created_by/at) + CHECKs (kind-Menge;
  upload verlangt storage-Felder; self_drawn verbietet sie;
  RESERVED-Writes reject) + RLS tenant_isolation + FORCE +
  Rollenvertrag (eigene Relations-Menge, Policy-Pin).
- scale_ref_json: `{ meters: number>0, pixelLength: number>0 }`
  (ESTIMATE SCALE_REF_SINGLE_SEGMENT).
- Service `modules/planning/sources`: `createSource` (Projekt
  gehört zum Workspace sonst NotFound; Duplikat per
  (project_id, sha256) → existierende ID, kein Duplikat),
  `listSources` je Projekt, `getSource`. Events/Audit nur
  IDs + kind (kein Kundenkontext, keine Bytes).
- UI: Projekt-Sektion (Liste + Upload-Formular mit
  Referenzlinie + Selbstzeichnen-Anlage; Schreibrecht;
  Viewer liest; Quick-Modus blendet Sektion aus).

## ESTIMATE (reversibel)
- Exakte Reonic-Quellfelder UNKNOWN; kind-Menge aus Katalog.
- 10MiB/JPEG/PNG-Gates aus file-requests-Muster übernommen.
- Kein Adapter-Call, kein Key-Management (Folge-Batch).

## Tests
- DB: Anlage upload/self_drawn + RESERVED-reject +
  Duplikat-Idempotenz + Fremdprojekt-NotFound + RBAC +
  Fremdtenant-Leere.
- Contract: kind-Enum, scale_ref-Zahlen > 0.
- E2E: Upload → Liste → Selbstzeichnen → Quick-Ausblendung.
