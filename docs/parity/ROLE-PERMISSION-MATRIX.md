# Rollen- und Berechtigungsmatrix

Stand: 2026-08-30 · M2-01 implementierter Vertrag

Die Laufzeitwahrheit bleibt `lib/permissions.ts`; diese Matrix dokumentiert die
beabsichtigte beobachtbare Semantik. UI-Sichtbarkeit ist keine Autorisierung.

| Fähigkeit | Viewer | Editor | Admin | External | Einzelrecht / Bedingung |
|---|---:|---:|---:|---:|---|
| Offer-Liste/-Detail lesen | ja | ja | ja | nein | `project.read`, gleicher Workspace; External bis Assignment fail-closed |
| B2C-Request in Offer konvertieren | nein | nur mit Rechten | ja | nein | `project.write` + `phase.convert` + `price.edit`, B2C-/Steuerbestätigung und alle Readiness-Gates |
| Variante duplizieren/benennen | nein | ja | ja | nein | `project.write`, `expectedRevision` |
| Neue Basis aus aktueller Resolution | nein | nur mit Recht | ja | nein | `project.write` + `price.edit`, explizite Steuerwahl; 0 % frisch bestätigt |
| Sektion, Menge, Typ, Sichtbarkeit, Reihenfolge | nein | ja | ja | nein | `project.write`, `expectedRevision` |
| VK einer Zeile ändern | nein | nur mit Recht | ja | nein | zusätzlich `price.edit`; Admin impliziert Capability |
| Steuerbehandlung wählen oder ändern | nein | nur mit Recht | ja | nein | zusätzlich `price.edit`; jede Revision protokolliert Actor/DB-Zeit, 0 % commandgebunden frisch bestätigt |
| Rabatt oder Custom Deal Value ändern | nein | nur mit Recht | ja | nein | zusätzlich `discount.apply`; Admin impliziert Capability |
| EK, Einkaufsquelle, Marge, private Vollhashes lesen | nein | nur mit Recht | ja | nein | zusätzlich `price.read_purchase`; strukturelle DTO-Trennung |
| EK einer freien Zeile ändern | nein | nur mit beiden Rechten | ja | nein | `price.edit` + `price.read_purchase`; Admin impliziert beide |
| PDF, Versand, Signatur, Won | nicht vorhanden | nicht vorhanden | nicht vorhanden | nicht vorhanden | spätere Slices; keine Fake-Controls |

## Denial-Vertrag

- Jede Mutation prüft Membership, Workspace, Ressourcenbesitz, Capability und
  erwartete Revision innerhalb der autorisierten Boundary erneut.
- Die bestehende Capability `edit_prices`/Action `price.edit` ist die bewusst
  dokumentierte Autorisierung für Steuerbehandlungen; es wird kein ungesichertes
  separates Steuerrecht erfunden.
- Falscher Tenant, fehlendes Objekt und fehlende Sichtberechtigung geben keine
  unterscheidbaren sensiblen Details preis.
- Event, Audit, Log und Action-State enthalten keine EK, Marge,
  Einkaufsprovenienz, Kundensnapshots oder private Vollhashes.
- Admin impliziert gemäß bestehender Runtime Capabilities. Ein deaktiviertes
  Workspace-Feature bleibt trotzdem auch für Admin bindend.
- `external_only` wird erst mit einem echten Assignmentmodell freigeschaltet.
