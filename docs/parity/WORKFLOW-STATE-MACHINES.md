# Workflow- und Statusmaschinen

Stand: 2026-08-30 · M2-01 implementierter Vertrag

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
gespeichert noch in der UI vorgetäuscht. Sie benötigen PDF-/Signaturverträge.

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
Teilstand hinterlassen.
