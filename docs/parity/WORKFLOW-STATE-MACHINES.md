# Workflow- und Statusmaschinen

Stand: 2026-08-30 · M2-01, M2-02 und M2-03a lokal verifiziert

## Project-Phase

```text
request/open + active lead column
  -- createOfferFromRequest -->
offer/open + active offer column
```

Vorbedingungen: autorisierter Editor, bestätigter Standort, keine Dedupe-/Pin-
Blocker, aktuelle Calculation und aktuelle Projektauflösung. Offer, Phase,
Spalte, Event und Audit sind eine Transaktion. Rückwärts-, Won-, Lost- und
Installation-Übergänge gehören nicht in M2-01.

## Offer v1

```text
missing -- successful conversion --> draft
draft -- M2-01 --> draft
```

`issued`, `sent`, `signed`, `expired`, `withdrawn` oder `accepted` werden weder
gespeichert noch in der UI vorgetäuscht. Ein M2-02-PDF-Draft verändert den
Offer-Status nicht; Ausstellung und Signatur benötigen eigene Folgeverträge.

## Variant und Revision

```text
variant missing -- create/duplicate --> variant@revision 1
variant@revision N -- valid command + expected N --> variant@revision N+1
variant@revision N -- expected != N --> conflict, no write
```

Alle früheren Revisionen bleiben unverändert. Variantenduplikation erzeugt eine
neue stabile Identität und kopiert den gesamten aktuellen Snapshot. Eine neue
Basis aus aktueller Resolution verlangt dagegen eine ausdrückliche
Steuerbehandlung und bei 0 % eine frische commandgebundene Bestätigung; sie
erbt keine Steuerentscheidung einer alten Variante.

## Herkunftsstatus

```text
current
  -- Katalog/Requirement/Calculation/Resolution drift --> outdated
outdated
  -- explicit create from current resolution --> old variant stays outdated
                                         + new current basis variant
```

Outdated ist ein abgeleiteter Lesestatus, keine Mutation historischer BOMs.
Wenn keine aktuelle Resolution existiert, ist die Aktualisierungsaktion
`blocked`.

## Interner Angebots-PDF-Entwurf

```text
missing -- authorized request --> queued
queued -- worker claim --> running
running -- valid PDF commit --> succeeded
running -- retryable failure --> retry_wait
retry_wait -- due recovery --> queued -- claim --> running
running -- final/integrity failure --> failed_final
running -- expired lease --> running@attempt N+1
running -- expired lease at max attempts --> failed_final
```

Die Oberfläche bezeichnet `failed_final` allgemein als endgültig
fehlgeschlagen; der gespeicherte Zustand bleibt präzise. Es gibt höchstens drei
fachliche Versuche, eine zweiminütige Lease und einen gedeckelten exponentiellen
Backoff. Lease-Token plus Attempt-CAS verhindern, dass ein alter Worker einen
neueren Lauf finalisiert. Ein Recovery-Sweep repariert fällige `retry_wait`-
und abgelaufene `running`-Jobs, ohne den fachlichen Input zu verändern.

```text
queued/running/retry_wait -- authorized user replay
  --> gleicher Zustand + dispatch repaired + Offer-Aktivität
succeeded/failed_final -- authorized exact replay
  --> gleicher terminaler Zustand + Offer-Aktivität, kein Dispatch
queued/running/retry_wait/succeeded/failed_final
  -- source revision changes --> existing job unchanged
new current revision -- authorized request --> distinct queued job
```

Der fachliche Job ist unique je Workspace, Variante, Revision, Template und
gepinntem Renderer-Rezept. Das Produktionsrezept bindet `linux/amd64`,
Playwright 1.62.1 und den vollständigen OCI-Child-Digest. Ein Browser-,
Architektur- oder Imagewechsel ist deshalb eine neue Rezeptidentität, kein
stiller Replay eines alten Jobs.

Nur `succeeded` besitzt vollständige PDF-Bytes, MIME, Länge und Artefakt-SHA;
alle anderen Zustände besitzen kein Artefakt. Ein Download reautorisiert
`project.read`, Tenant, Offer und Job und prüft Hash/Länge/MIME erneut. Viewer,
Editor und Admin dürfen einen erfolgreichen internen Draft lesen; External
nie. Nur Editor/Admin mit `project.write` dürfen anfordern oder den Dispatch
replayen. Nur `app_worker` darf unter Tenantkontext claimen/finalisieren.

Die PDF-Zustandsmaschine führt bewusst kein M2-02-Rollout-Flag ein und erzeugt
weder `issued`/`sent`/`accepted`/`signed` noch öffentlichen Link, E-Mail,
Rechnung oder Object-Lock-Archiv. Eine aktive Render-Lease blockiert Draft-
Erasure; nach Ende der Lease löscht der Offer-Erasuregraph Job und Bytes.

## Dokumentprofil und Aktivierung

```text
Profil fehlt -- Admin revise --> Profil-Head + Revision 1 (nicht aktiv)
Revision N -- Admin revise(expected N) --> Revision N+1 (nicht automatisch aktiv)
Revision N -- Admin activate(exakter Hash) --> append-only Aktivierung
aktive Revision N -- neue Revision N+1 --> N bleibt aktiv, bis N+1 separat aktiviert wird
expected != current oder Hashabweichung --> conflict/integrity error, no write
```

Die Aktivierung bedeutet `operator_reviewed` für exakt einen unveränderlichen
Aussteller-/Rechtstextstand. Sie ist keine juristische Prüfung. Nur Admins mit
`settings.manage` dürfen Revisionen anlegen oder aktivieren; interne Nutzer mit
`project.read` dürfen den aktuellen Stand lesen. Kandidaten verwenden nur eine
aktuelle hashvalide Aktivierung.

## Empfänger-/Rechnungsstand

```text
Empfängerstand fehlt -- authorized revise --> recipient revision 1
recipient revision N -- authorized revise(expected N) --> revision N+1
expected != current --> conflict, no write
```

Jede Revision ist append-only und bestätigt Empfänger sowie Rechnungsadresse
als eigenen Offer-Stand. Es gibt keinen stillen Fallback auf den
Anlagenstandort. Die Mutation verlangt `offer.release.prepare`; External
bleibt fail-closed.

## Angebots-Freigabekandidat

```text
missing -- authorized prepare + readiness --> queued
queued -- worker claim --> running
running -- valid deterministic PDF commit --> ready_for_approval
running -- retryable failure --> retry_wait
retry_wait -- due recovery --> queued -- claim --> running
running -- final/integrity failure --> failed_final
running -- expired lease --> running@attempt N+1
running -- expired lease at max attempts --> failed_final
```

Der Reservation-Key bindet Variantenrevision, validen M2-02-Quelldraft,
aktivierte Profilrevision, Empfängerrevision, Gültigkeitsdatum und
Renderrezept. Derselbe fachliche Request liefert denselben Candidate und
repariert nötigenfalls nur den Dispatch; ein anderer gebundener Stand erzeugt
einen neuen Candidate. Queue und Worker sehen ausschließlich Workspace- und
Candidate-ID.

```text
ready_for_approval -- approver + exakte Attestations + Byte-Rehash
  --> append-only approval; derived approved_not_issued
ready_for_approval -- stale source/hash/byte mismatch --> blocked, no approval
approved_not_issued -- replay same approval --> same approval, no new write
queued/running/retry_wait/failed_final -- approval attempt --> rejected
```

Die Approval-Relation verändert den gespeicherten Publication-State
`not_issued` und den Offer-Status nicht. `approved_not_issued` ist nur der
abgeleitete interne Lesestatus. Vor dem Approval können allein Approver die
Bytes laden, danach interne Nutzer mit `project.read`; jeder Download wird
erneut autorisiert und verifiziert. Es entstehen weder Ausstellungsbytes noch
Object-Lock, Versand, Annahme oder Signatur.

## Command-Ergebnisse

```text
clean → dirty → pending → success → clean@revision N+1
          │         ↘ validation_error → dirty
          │         ↘ blocked          → dirty
          │         ↘ denied           → dirty
          │         ↘ unauthenticated  → dirty/login
          │         ↘ conflict         → dirty, no revalidation
          │         ↘ unavailable(retryAfter UTC) → dirty, no automatic retry
          └─ discard → clean@server revision
pending -- unexpected throw --> segment error boundary
pending -- while active --> no second mutation
```

Expected Errors werden als typisierter Action-State zurückgegeben.
Unerwartete Fehler sind ausdrücklich kein normaler Action-State und gehen an
die Segment-Error-Boundary. `unavailable` ist der erwartete Zustand einer
erschöpften Offer-Mutationsquote und erhält den Draft bis zum angezeigten
Retry-Zeitpunkt. Variantenwechsel, Breadcrumb/Back, Reload/Tab-Schließen,
Logout/Login-Redirect, Duplizieren und neue Basis sind im `dirty`-Zustand nur
nach Save oder bewusstem Discard zulässig. Kein Fehlerzustand darf einen
Teilstand hinterlassen. Die M2-03a-Formulare erhalten fachliche Eingaben nach
erwarteten Serverfehlern, führen den Fokus zur Fehlerzusammenfassung und nach
Erfolg zum nächsten Schritt; zurückgesetzte Attestations-Checkboxen werden
explizit angekündigt.
