# DASH-06 Angebotsdauer (Time-to-Offer)

Ziel: Median Projektanlage -> erstes Angebot (Tage), Projekte mit Angebot.

## ESTIMATE (reversibel, Referenzen offen)
- Angebotsdauer = `offer.created_at (aeltestes je Projekt) - project.created_at`.
- Vertragsstatus o.ae. Workflow-Referenzen fehlen (Q-DASHBOARD-REFERENZ); Sichtbarkeit =
  Angebotsliste (project.read).

## UI
- Karte „Angebotsdauer": Median in Tagen (1 Nachkommastelle) + „n Projekte",
  ohne Projekte „–", Cap mit „+ kann mehr umfassen".

## Scopes
1. `getOfferLeadTimeStats` deckelt auf 500.
2. Karte im Dashboard hinter Pipeline, nur bei `can("project", "read")`.
