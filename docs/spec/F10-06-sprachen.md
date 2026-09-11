# F10-06 Portal-Sprachen (Slice 1: DE/EN-Umschaltung im Kundenportal)

Erster geprüfter F10-Restpfad (STATUS: „Offen: My Files, Sprachen, Versand“;
Dateien-Tab belegt, Versand braucht externen Provider): das Kundenportal
rendert wahlweise Deutsch oder Englisch. Reversible eigene Näherung
(ESTIMATE, kein Reonic-Referenzbeleg für EN-Worte).

## Vertrag

- Quelle: `?lang=` (gewinnt, stateless) → Cookie `portal-lang` (von den
  anonymen POST-Routen gesetzt) → Default Deutsch. Unbekannte Werte
  (inkl. `?lang=xx`, fremde Cookie-Werte) fallen auf Deutsch zurück
  (fail-closed: kein Orakel, kein 404).
- `lib/integrations/portal/portal-language.ts` (`portal-language.v1`):
  `parsePortalLang`, `PORTAL_STRINGS` (DE/EN, Typschlüssel-Parität),
  Datums-/Bereichsformate (Berlin, de-DE/en-GB), Statuswort-Maps
  (Signatur/Service/Timeline/Next-Step/Installation-Fallback/Förderung/Netz).
- Seite (`app/p/[token]/page.tsx`): Chrome + seitenlokale Formatte je Sprache,
  `?lang=` an allen Tab-Links, Hidden-Field `lang` in beiden Formularen,
  `lang`-Attribut an der Section, Titel per `generateMetadata`.
- Routen (`file-requests`, `service-cases`): `lang` aus Formular (Allowlist),
  im Redirect erhalten, als HttpOnly-Cookie (`Path=/`, 1 Jahr, SameSite=Lax)
  gesetzt. Keine neue Permission (anonyme Token-Kapsel wie bisher).
- `not-found.tsx`: Cookie-Sprache (kann Token/`?lang=` nicht kennen).
- Nicht übersetzt (bewusst): Admin-Statuslabels F10-05 (Kundendaten wie
  erfasst), Projekt-/Termin-/Datei-/Betreibernamen, interne Modul-Labelmaps
  (interne App bleibt deutsch).

## Regeln

1. Keine Migration, keine Grants, keine neuen Routen-Secrets.
2. Ohne JS bedienbar (Links/Formulare wie bisher).
3. EN-Texte sind ESTIMATE; Schlüssel-Parität per Test (kein Drift).

## Tests

- Contract (`f1006-portal-language`): F1006-01 Parser-Fallbacks, F1006-02
  DE/EN-Schlüsselparität, F1006-03 Formate/Statusworte je Sprache.
- E2E (`F10-06-E2E-01`): Link per UI → `?lang=en` zeigt EN-Chrome (Overview,
  Upload-Button, Empty-States) → Tab-Link behält Sprache → `?lang=xx`
  fällt auf DE → Upload-POST setzt Cookie (Reload ohne Param bleibt EN) →
  ungültiger Link mit Cookie zeigt EN-404; keine Browser-Fehler.
