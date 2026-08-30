# Rollen- und Berechtigungsmatrix

Stand: 2026-08-30 · M2-01, M2-02 und M2-03a lokal verifiziert

Die Laufzeitwahrheit bleibt `lib/permissions.ts`; diese Matrix dokumentiert die
beabsichtigte beobachtbare Semantik. UI-Sichtbarkeit ist keine Autorisierung.

| Fähigkeit | Viewer | Editor | Admin | External | `app_worker` | Einzelrecht / Bedingung |
|---|---:|---:|---:|---:|---:|---|
| Offer-Liste/-Detail lesen | ja | ja | ja | nein | nein | `project.read`, gleicher Workspace; External bis Assignment fail-closed |
| B2C-Request in Offer konvertieren | nein | nur mit Rechten | ja | nein | nein | `project.write` + `phase.convert` + `price.edit`, B2C-/Steuerbestätigung und alle Readiness-Gates |
| Variante duplizieren/benennen | nein | ja | ja | nein | nein | `project.write`, `expectedRevision` |
| Neue Basis aus aktueller Resolution | nein | nur mit Recht | ja | nein | nein | `project.write` + `price.edit`, explizite Steuerwahl; 0 % frisch bestätigt |
| Sektion, Menge, Typ, Sichtbarkeit, Reihenfolge | nein | ja | ja | nein | nein | `project.write`, `expectedRevision` |
| VK einer Zeile ändern | nein | nur mit Recht | ja | nein | nein | zusätzlich `price.edit`; Admin impliziert Capability |
| Steuerbehandlung wählen oder ändern | nein | nur mit Recht | ja | nein | nein | zusätzlich `price.edit`; jede Revision protokolliert Actor/DB-Zeit, 0 % commandgebunden frisch bestätigt |
| Rabatt oder Custom Deal Value ändern | nein | nur mit Recht | ja | nein | nein | zusätzlich `discount.apply`; Admin impliziert Capability |
| EK, Einkaufsquelle, Marge, private Vollhashes lesen | nein | nur mit Recht | ja | nein | nein | zusätzlich `price.read_purchase`; strukturelle DTO-Trennung |
| EK einer freien Zeile ändern | nein | nur mit beiden Rechten | ja | nein | nein | `price.edit` + `price.read_purchase`; Admin impliziert beide |
| PDF-Jobstatus lesen | ja | ja | ja | nein | nur fachlicher Job | `project.read`, gleicher Workspace; DTO ohne Input, Bytes, Preise und Vollhashes |
| Erfolgreichen PDF-Entwurf herunterladen | ja | ja | ja | nein | nein | `project.read`, erneute Tenant-/Offer-/Job- sowie MIME-/Längen-/Hashprüfung; privat/no-store |
| PDF-Entwurf anfordern oder Dispatch replayen | nein | nur mit Recht | ja | nein | nein | `project.write`, aktuelle Variantenrevision; kein M2-02-Rollout-Flag |
| PDF-Job claimen, retryen, recovern und finalisieren | nein | nein | nein | nein | ja, minimal | nur ID-Payload und exakt erlaubte `offer_pdf_draft`-/Queue-Operationen unter Tenantkontext; keine Membership-, Auth-, Katalog- oder sonstigen App-Rechte |
| Aktuelle Angebotsprofilstände lesen | ja | ja | ja | nein | nein | internes `project.read`; nur gleicher Workspace, keine Mutation |
| Dokumentprofilrevision erstellen und exakten Hash aktivieren | nein | nein | ja | nein | nein | `settings.manage`; getrennte Actions, keine Defaulttexte oder Rechtswirkung |
| Empfänger-/Rechnungsrevision speichern | nein | nur mit Recht | ja | nein | nein | `offer.release.prepare` / `prepare_offer_documents`; strukturierte Billing-Adresse, kein Site-Fallback |
| Freigabekandidatenstatus lesen | ja | ja | ja | nein | nur fachlicher Job | internes `project.read`; DTO ohne Adressen, Rechtstexte, Preise, Bytes oder Vollhashes |
| Freigabekandidat vorbereiten oder Dispatch replayen | nein | nur mit Recht | ja | nein | nein | `offer.release.prepare` / `prepare_offer_documents`; exakte aktuelle Quellen und Readiness |
| Unfreigegebene Candidate-Bytes laden | nein | nur mit Recht | ja | nein | nein | `offer.release.approve` / `approve_offer_documents`; erneute Tenant-/Offer-/Candidate-/MIME-/Längen-/Hashprüfung |
| Tatsächliche Candidate-Bytes intern freigeben | nein | nur mit Recht | ja | nein | nein | `offer.release.approve` / `approve_offer_documents`; vier feste Attestations, bedingte 0-%-Bestätigung; Ergebnis nur `approved_not_issued` |
| Freigegebene Candidate-Bytes laden | ja | ja | ja | nein | nein | internes `project.read`; private `no-store`-Antwort, kein öffentlicher Link |
| Candidate claimen, retryen, recovern und finalisieren | nein | nein | nein | nein | ja, minimal | ID-only-Queue-Payload; exakt erlaubte Candidate-Reads/-State-Spalten unter Tenantkontext, keine Profil-/Approval-Mutation |
| PDF ausstellen/versenden, Annahme/Signatur, öffentlicher Link, Rechnung/Won | nicht vorhanden | nicht vorhanden | nicht vorhanden | nicht vorhanden | nicht vorhanden | spätere Slices; keine Fake-Controls und kein Object-Lock-Claim |

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
- M2-02 führt bewusst kein eigenes Rollout-Flag ein. Vorhandene Feature-Flags
  können fehlende Membership, Rolle, `project.read` oder `project.write` nicht
  ersetzen; sobald eine spätere Action ein Flag deklariert, bleibt es über den
  zentralen `can()`-Pfad auch für Admin bindend.
- `app_worker` ist kein Benutzer und erhält keine Portalrolle. Seine Rechte
  reichen nur für tenantgebundenes Claim/Finalize/Recovery des
  ID-only-`pdf.render`- beziehungsweise Candidate-Renderpfads und die zwingend
  nötige Kanonizitätsprüfung. Er darf weder Profile aktivieren noch Empfänger
  ändern oder Candidate-Approvals schreiben.
- `approved_not_issued` ist ausschließlich ein abgeleiteter interner
  Freigabestand. Er erteilt kein Recht auf Ausstellung, Versand, WORM-Promotion
  oder Signatur und verändert den Offer-Vertragsstatus nicht.
- `external_only` wird erst mit einem echten Assignmentmodell freigeschaltet.
