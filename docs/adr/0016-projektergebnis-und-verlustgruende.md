# ADR 0016: Projektergebnis und strukturierte Verlustgründe

- Status: angenommen
- Datum: 2026-09-01
- Bezug: `docs/spec/M1-11a-projektergebnis.md`

## Kontext

Das Project-Modell besitzt bereits die Outcome-Werte `open`, `won`, `lost`
und `cannot_fulfill`, aber weder Zeitstempel, strukturierte Gründe,
Transitionsservice, Revision, Abschlussansicht noch UI. Das Request-Board zeigt
bewusst nur `request/open`. Ein heute direkt per SQL geschlossener Lead würde
daher aus der operativen Ansicht verschwinden, ohne einen unterstützten
Wiederauffindungs- oder Reopen-Pfad zu besitzen.

Öffentliche Reonic-Dokumentation beschreibt Kanban-Spalte und Outcome als
orthogonale Achsen. Won/Lost verlassen die aktive Pipeline; Closed und Archive
sind getrennte Sichten. Cannot fulfill hat zusätzliche irreversible
Nebenwirkungen auf Kundenkommunikation und Signatur. Diese Nebenwirkungen
existieren im aktuellen System noch nicht.

## Entscheidung

M1-11a implementiert ausschließlich manuelles Won, Lost und Reopen für
Request-Projects. `cannot_fulfill` bleibt ohne neue Transition, bis eine
atomare Kundenmail-Outbox und eine belastbare Signatursperre existieren.

Project erhält eine eigene `outcome_revision`, `closed_at`, eine optionale
Tenant-FK auf `project_loss_reason` und einen optionalen kurzen Kommentar.
Outcome-Revision und Assignment-Revision bleiben getrennt: Zuweisungen,
Kanban-Moves und Outcome-Änderungen sollen sich nicht künstlich gegenseitig in
CAS-Konflikte treiben.

Verlustgründe sind eine Workspace-Taxonomie mit stabiler UUID. Sie werden
archiviert, nicht gelöscht. Ein archivierter Grund bleibt an historischen
Lost-Projects lesbar, ist für neue Lost-Transitions aber nicht mehr zulässig.
WMEE seedet keine angeblichen Reonic-Standardwerte, weil deren vollständige
Taxonomie nicht öffentlich belegt ist.

Die Kanban-Spalte wird durch Outcome-Commands niemals verändert. Eine
geschlossene Request-Liste liest dieselben Project-Zeilen nach Outcome und
`closed_at`; sie ist keine zweite Fachwahrheit. Reopen stellt deshalb die
unverändert gespeicherte frühere Spalte automatisch wieder in der offenen
Pipeline dar.

Jede Transition sperrt zuerst das Project und validiert Phase, Outcome und
`expectedOutcomeRevision`. Lost sperrt anschließend den aktiven Reason.
Project-Update, redigiertes Domain-Event und Audit werden in derselben
Transaktion committed. Eine DB-Guard-Funktion prüft zusätzlich Rollenbindung,
Zustandskante, Revision, Feldkohärenz und Reason-Aktivität.

Aktive Verlustfelder werden bei Reopen geleert. Der frühere strukturierte
Grund bleibt als UUID im append-only Transitionsevent historisch nachvollziehbar.
Damit wird die öffentlich widersprüchliche Reopen-Semantik explizit entschieden,
ohne löschpflichtigen Freitext in WORM-nahe Logs zu kopieren.

Die neue Permission `project.outcome.write` verlangt einen internen Editor.
Reason-Verwaltung verwendet das bestehende Adminrecht `settings.manage`.
External-Nutzer können Outcomes nicht mutieren und verlieren durch die bereits
existierende `request/open`-RLS nach einem Close automatisch ihre Project-Sicht.

## Konsequenzen

- Der erste operative CRM-Zyklus endet belastbar in Won/Lost und kann bewusst
  wieder geöffnet werden.
- Outcome bleibt unabhängig von Boardkonfiguration und späteren
  Spaltenautomatiken.
- Lost-Analytics kann später über stabile Reason-IDs aufgebaut werden, ohne
  Freitextlogs auszuwerten.
- Offer-/Signaturautomation kann denselben Outcome-Kern später nur über einen
  eigenen artefaktbewussten Service erweitern; M1-11a behauptet das nicht.
- `cannot_fulfill`, Archive und Reports bleiben sichtbare Folgeslices.

## Verworfen

### Outcome aus Spaltentyp ableiten

Verworfen: Ein Board-Move ist organisatorisch, ein Geschäftsergebnis fachlich.
Eine Kopplung würde Konfiguration und Vertragshistorie vermischen.

### Lost als freies Textfeld

Verworfen: keine stabile Auswertung, Tippfehlerduplikate und schlechtere
Datensparsamkeit. Freitext bleibt nur optionaler, löschbarer Kontext.

### Reopen setzt eine Standardspalte

Verworfen: Das überschreibt Nutzerorganisation und erzeugt eine zweite
versteckte Statusmaschine. Die bestehende Spalte bleibt unverändert.

### Reason-Label in Event oder Audit kopieren

Verworfen: frei konfigurierbarer Text würde append-only dupliziert. Die stabile
Reason-ID und ein Boolean für vorhandenen Kommentar reichen als Historie.

### Cannot fulfill ohne Delivery-Vertrag

Verworfen: Eine irreversible UI-Aktion ohne atomare Kundenmail und
Signatursperre wäre fachlich falsch und gefährlich.

### Geschlossene Projects hart löschen

Verworfen: Won/Lost ist ein Ergebnis, keine Löschentscheidung. Personenbezogene
Daten bleiben ausschließlich über den bestehenden DSGVO-Erasurepfad löschbar.
