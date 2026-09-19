# F3-BATCH-1 — Providerfreies Fundament (0270 + 0271)

## Stand
- Modulkatalog F3.2 (Gebäudequellen) + F3.3 (Dach-Editor): je Spec
  F3-02/F3-03. F3.1 Planungsmodi existiert (0075, Snapshot-v4).
- Range 0270-0279 (Lane 1d-f3, RANGES.md): Batch-1 belegt 0270
  + 0271. 0272-0279 bleiben frei.
- Kein Code: planning_sources-/planning_roofs-Tabelle fehlt
  (nur 0049-Leadquellen + 0075-Modi), kein planning/contract.ts,
  kein Batch-Muster in modules/planning.

## Umfang (gilt für beide Capabilities)
- Rechte: `planning.sources.read/manage` (0270),
  `planning.roofs.read/manage` (0271)? — NEIN: keine neuen
  Permissions ohne Bedarf. Stattdessen bestehende
  Projekt-/Offer-Rechte + Rollenvertrag: RLS `tenant_isolation`
  FOR ALL, kanonisches Prädikat, enabled + forced; ACL-Form
  revoke-all + enge app_runtime-Grants; Policy-Hash/Marker
  ernten (db:roles:verify grün halten).
- RLS + WORM: Upload-Bytes via storage/s3 immutableKey +
  putImmutable (einziger Key-Weg); DB speichert nur
  storage_key/sha256/byte_size. Doppelter Put = kein Duplikat.
- F3.1-Bindung: Quick-Modus blendet Quellen-/Dach-UI aus
  (F3-01 Z.139-144); v1/v2/v3-Snapshots byte-/hashstabil;
  neue Felder nur additiv, Hash-Version bump nur wenn nötig.
- Neigung nie automatisch aus Google (Katalog F3.2):
  trivially erfüllt — kein Google-Pfad in Batch-1.
- TDD: RED zuerst (DB + Contract + E2E rot auf fehlendem
  Code), dann minimal grün. BATCH-Vertrag als Muster:
  `modules/planning/contracts/` (neu, zod, versioniert).

## Grenzen (Nicht-Ziele, werden in Review abgelehnt)
- Keine Adapter: Ortho, Google Solar/Earth-3D, Building-AI,
  Drohne. Keine API-Keys, keine externen Calls, keine Kosten.
- Keine Gauben, kein Schornstein-Höhe/Schattenwurf, kein
  Fenster-Vollmodell, keine Belegung, keine Strings/WR-Slots,
  kein Verschattungs-Player/Heatmap/Score-Persistenz, keine
  Photogrammetrie-Jobs, keine PDF-Änderung außer Hinweistext.
- kind-Enum: nur `upload` + `self_drawn` schreibbar; Adapter-
  Werte als RESERVED (DB-CHECK rejectet Writes, Contract
  rejectet Inputs) — kein stiller Fallback.

## ESTIMATEs (benannt, Upgrade-Pfad)
- SCALE_REF_SINGLE_SEGMENT: genau 1 Referenzstrecke je Upload.
  Upgrade: Mehrsegment + Fehlerausgleich.
- ROOF_SINGLE_POLYGON_NO_DORMER: genau 1 Polygon je Dach,
  keine Gauben/Teilflächen. Upgrade: Teilflächen + Gauben.
- MARGIN_UNIFORM_FALLBACK: fehlende Kantenabstände = Default.
  Upgrade: Kanten-Editor voll.
- SOURCE_SITE_OPTIONAL: Quelle hängt am Projekt, Site optional.
  Upgrade: Site-Pflicht + Adress-Cache.

## Tests (Pflicht, RED zuerst)
- drizzle 0270/0271 up/down auf frischer DB; Range-Kollision
  (nur 0270+0271 aus 0270-0279 belegt).
- Contract: kind-Enum rejectet RESERVED; Polygon-Selbstschnitt
  reject; tilt 0–90 sonst reject; 3..64 Punkte.
- Service: RBAC read/manage, WORM-Idempotenz, source→roof
  FK-Pflicht, Fremdtenant-Leere.
- UI/E2E: Upload-Gates (10MiB, JPEG/PNG), Polygon
  zeichnen/speichern/laden, Quick blendet aus.
- Snapshot: v4-Hash ohne neue Felder unverändert; mit Feldern
  stabile Revise-Op.
