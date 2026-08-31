# Rollen- und Berechtigungsmatrix

Stand: 2026-08-31 · M1-08b, M2-01, M2-02, M2-03a und M2-03b1 lokal verifiziert

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
| CSV-Datei prüfen und Preview persistieren | nein | nur mit allen drei Rechten | ja | nein | nein | `catalog.manage` + `price.edit` + `price.read_purchase`; gleiche Session/Origin, ≤1 MiB/1.000 Zeilen |
| Katalogimport starten | nein | nur mit allen drei Rechten | ja | nein | nein | dieselben drei Rechte plus versionierte Rechteattestation und `ready_for_review` |
| Nicht gestartete Preview abbrechen | nein | nur mit allen drei Rechten | ja | nein | nein | dieselben drei Rechte; exakte Workspace-/Importbindung |
| Importstatus, Vorschau und Fehlerreport lesen | nein | nur mit allen drei Rechten | ja | nein | nur fachlicher Job | dieselben drei Rechte; private paginierte DTO/CSV, kein Objektoracle |
| Import claimen, verarbeiten, recovern und redigieren | nein | nein | nein | nein | ja, minimal | ID-only-Queues; ausschließlich M1-08b-Definer-Gateways, maximal 25 Zeilen je Claim; kein direktes Importtabellen- oder Katalog-DML |
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
| Issuance-Status lesen | ja | ja | ja | nein | nur fachlicher Job | internes `project.read`; DTO ohne Inhalte, Bytes oder Vollhashes |
| Ausstellungsfassung anfordern oder Dispatch replayen | nein | nur mit Recht | ja | nein | nein | `offer.issue.prepare` / `prepare_offer_documents`; freigegebener Candidate und exakte aktuelle Bindungen |
| Ausstellungsbytes vor 2/2 laden | nein | nur mit Recht | ja | nein | nein | `offer.issue.approve` / `approve_offer_documents`; erneute Tenant-/Offer-/Issuance-/MIME-/Längen-/Hashprüfung; nur solange nicht zurückgezogen |
| Tatsächliche Ausstellungsbytes freigeben | nein | nur mit Recht | ja | nein | nein | `offer.issue.approve` / `approve_offer_documents`; zwei verschiedene Actors, mindestens einer ≠ Candidate-Approver; kein Admin-Bypass |
| Ausstellungsfassung vor Archivierung zurückziehen | nein | nur mit Recht | ja | nein | nein | `offer.issue.withdraw` / `approve_offer_documents`; strukturierter Ursachencode, append-only und terminal |
| Ausstellungsbytes nach 2/2 laden | ja | ja | ja | nein | nein | internes `project.read`; privat/no-store und weiterhin nicht ausgestellt; nach Withdrawal kein Download |
| Issuance claimen, retryen, recovern und finalisieren | nein | nein | nein | nein | ja, minimal | ID-only-Queue-Payload; exakt erlaubte Issuance-Reads/-State-Spalten, kein Approval-/Withdrawal-/Storagerecht |
| Archivevidence/`issued`, Versand, Annahme/Signatur, öffentlicher Link, Rechnung/Won | nicht vorhanden | nicht vorhanden | nicht vorhanden | nicht vorhanden | nicht vorhanden | spätere Slices; keine Fake-Controls und kein Object-Lock-Claim |

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
  ID-only-`pdf.render`-, Candidate- beziehungsweise Issuance-Renderpfads und
  die zwingend nötige Kanonizitätsprüfung. Er darf weder Profile aktivieren,
  Empfänger ändern, menschliche Approvals/Withdrawals schreiben noch Archive
  oder Storage bedienen.
- M1-08b erlaubt dem Worker ausschließlich ID-only Claim/Apply/Finalize,
  Recovery, Locator-Quarantäne und Due-Cleanup über eng signierte Gateways.
  Runtime und Worker besitzen keinerlei direkte DML auf den vier
  Importrelationen; der Worker darf Katalogtabellen nicht direkt mutieren.
- `approved_not_issued` ist ausschließlich ein abgeleiteter interner
  Freigabestand. Er erteilt kein Recht auf Ausstellung, Versand, WORM-Promotion
  oder Signatur und verändert den Offer-Vertragsstatus nicht.
- Admin umgeht in M2-03b1 weder Zwei-Personen-, Candidate-Approver-, Byte-,
  Drift-, Tenant- noch Withdrawal-Regel. Auch
  `approved_for_archive_not_issued` erteilt kein Recht auf Object Lock,
  Archivevidence, `issued`, Versand oder Signatur.
- `external_only` wird erst mit einem echten Assignmentmodell freigeschaltet.
