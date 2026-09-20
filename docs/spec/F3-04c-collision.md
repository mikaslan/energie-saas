# F3-04c Belegung-vs-Sperrzonen-Kollision (Stufe-0, FINAL)

## Stand
- Panel-Gruppen prüfen nur Rechteck-in-Polygon — eine
  Gruppe darf mitten auf einer Schornstein-/Fenster-
  Sperrzone liegen. Letzte Konsistenzlücke im
  providerfreien Kern (Dach→Sperrzone→Gruppe→Deselect
  →String→Equipment sonst geschlossen). FINALer
  Lane-Slice.
- Stufe-0: Kollisions-Warnung (advisory-only, kein
  Reject — kein Anordnungs-Deadlock), Rechteck-
  Ebene (keine Zell-Liste), Deselect als
  Auflösungsweg. KEINE Migration (0278/0279 bleiben
  frei, Lane schließt).

## Umfang
- Contract `lib/integrations/planning/contracts/
  panel-collision` (client-sicher): Version
  `planning-panel-collision.v1`, reine Funktion
  Gruppen-Rechteck vs. Restriction-Rechtecke
  desselben Dachs → betroffene Paare +
  Schnittfläche (nur Schnitt > 0). Strict-Input.
- Service: `panel-groups` list/get reichern DTO um
  `collisions: [{restrictionId, kind, label}]` an
  (Restrictions desselben Dachs laden);
  `roof-restrictions` list symmetrisch um
  `collidingGroups: [{groupId, label}]`. Create
  beidseitig zulässig. Viewer liest, External
  fail-closed (bestehend).
- UI: Warnbadge „überlappt Sperrzone X — Zellen
  abwählen" in Gruppen- und Sperrzonen-Liste
  (Testids planning-panel-collision-*); Quick
  blendet aus (F3-01).

## ESTIMATE (reversibel)
- COLLISION_ADVISORY_ONLY: Warnung statt Reject;
  Upgrade: hart/asymmetrisch (Deadlock-Risiko!).
- COLLISION_RECT_ONLY: keine Zell-Liste, keine
  Gruppe-gegen-Gruppe; Upgrade: eigener Slice.

## Tests
- Contract: Version, Schnitt/kein-Schnitt/Kante,
  Mehrfach-Restrictions, Fläche.
- DB: Service-Collisions (Gruppe über Zone →
  collisions befüllt; saubere Gruppe → leer;
  symmetrisch an Restrictions; RBAC lesen).
- E2E: Gruppe über Schornstein → Warnung →
  Deselect darunter → Count sinkt, Warnung mit
  Hinweis bleibt → saubere Gruppe → keine
  Warnung → Viewer/External.
