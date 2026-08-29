# ADR 0006: Operative Site-Identität mit revisionsgebundener Pin-Bestätigung

- Status: angenommen
- Datum: 2026-08-29
- Bezug: `docs/spec/M1-06-planungsstandort-adresskorrektur.md`

## Kontext

M1-04 koppelt `inbound_receipt`, `project`, `contact` und `site` mit einem
zusammengesetzten Datenbank-FK. Das schützt den Tenant-Graphen, lässt aber eine
regionale Rechner-Site nicht ohne Weiteres auf eine bereits vorhandene Site
umbinden. Gleichzeitig ist `site.pin_confirmed` bisher ein einzelner Bool. Eine
spätere Adressänderung könnte daher nicht beweisen, auf welche Adressfassung
sich die Bestätigung bezog.

Für M1-06 wird genau ein regionaler Rechner-Standort zu einer hausgenauen
operativen Adresse korrigiert. Ein vollständiges Site-Merge-, Historien- oder
Master-Data-Modell würde den Golden Path unnötig mit Datenschutz-, Retention-
und Konfliktfragen erweitern.

## Entscheidung

Die bestehende Site-ID bleibt die operative Standortidentität von Receipt und
Project. M1-06 mutiert ihre Adressfelder in place und erhöht dabei atomar eine
positive `address_revision`.

Eine Pin-Bestätigung ist nur gültig, wenn `pin_confirmed_address_revision` exakt der
aktuellen `address_revision` entspricht. Jede Adresskorrektur setzt den Pin
zurück. Anwendung und Datenbank erzwingen gemeinsam, dass nur eine vollständige
ausgewählte Hausadresse bestätigt werden kann.

`inbound_receipt.site_id` bezeichnet damit die durch den Intake entstandene
operative Site-Identität, keinen unveränderlichen Snapshot ihrer ersten
Adressfelder. Der unveränderte signierte Body-Hash belegt die
Transportintegrität; CalculatorSnapshot und Requirements bleiben immutable.
Events und Audits protokollieren nur IDs und Revisionsnummern, keine Adresse
oder Koordinaten.

Existiert für denselben Contact bereits eine andere Site mit demselben
versionierten Adressfingerprint, endet die Korrektur fail-closed. M1-06 führt
weder zusammen noch bindet es Receipt oder Project um.

Ebenso endet die Korrektur fail-closed, wenn mehrere Projects auf die zu
mutierende Site zeigen. Regionale Rechner-Sites werden heute nicht dedupliziert
und sind im Normalfall exklusiv; ein abweichender Graph verlangt aber eine
bewusste spätere Merge-/Rebinding-Entscheidung statt einer stillen Änderung für
mehrere Projekte.

## Konsequenzen

- Zwei Tabs können über eine erwartete Revision konfliktfest arbeiten.
- Eine veraltete Pin-Bestätigung ist auf DB-Ebene unmöglich.
- Der bestehende Receipt-/Project-Graph und alle Intake-Snapshots bleiben
  unverändert.
- Der kleinste Golden-Path-Slice benötigt keine neue Historientabelle und
  keine neuen RLS-/Retention-Flächen.
- Die erste unstrukturierte/regional geschätzte Adressfassung ist nach der
  Korrektur nicht als eigene lesbare DB-Revision vorhanden. Das ist eine
  bewusste Datenminimierungsgrenze, keine Behauptung einer vollständigen
  Adresshistorie.
- Site-Merge, Rebinding oder immutable Adresshistorie benötigen später eine
  eigene ADR inklusive Lösch-/Aufbewahrungskonzept und UX für Konflikte.

## Verworfene Alternativen

### Project und Receipt sofort auf eine andere Site umbinden

Verworfen für M1-06. Die heutige zusammengesetzte Graph-FK koppelt beide
Referenzen bewusst. Ein sicheres Rebinding braucht eine fachliche Entscheidung
über Intake-Provenienz, mehrere Projects pro Standort und Merge-Rollback.

### Nur `updated_at` als Concurrency-Token

Verworfen. Zeitstempel sind für fachliche Revisionsbindung und DB-Constraints
unnötig indirekt; eine monotone Ganzzahl ist eindeutig und testbar.

### `pin_confirmed` ohne Revisionsbezug beibehalten

Verworfen, weil jede Adress- oder Koordinatenänderung dann auf
Anwendungsdisziplin vertrauen müsste und ein stale bestätigter Pin möglich
bliebe.

### Sofort eine vollständige Adresshistorie speichern

Verworfen für diesen Slice. Sie vergrößert die PII-Fläche und verlangt zuerst
eine klare Retention-, Lösch-, Zugriff- und Merge-Semantik. Der aktuelle
Golden Path benötigt nur eine konfliktfeste operative Wahrheit.
