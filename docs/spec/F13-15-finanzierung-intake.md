# F13-15 Finanzierungs-Intake (Katalog F13.4)

Status: **SPECIFIED** · Lane: `codex/muse-fleet-3c-f13` · Migration: keine (STOPP-Regel)
Basis: Modulkatalog F13.4 („Finanzierung: Bees & Bears Ratenkauf 1–25 J.,
bis 70.000 €, Echtzeit-Bonität + PSD-Bankkredit; Antrag im Kundenportal,
Statusverfolgung, Betrieb ohne Vermittlerrolle") — 0 % implementiert.

Kein Reonic-Referenzbeleg; Verhalten ist reversible eigene Näherung nach
F13-01-Filing-Muster und F13-04/F13-06/F13-09-Portal-Muster. Bauarbeit.

MISSION-Grenze: keine Bestellung, keine Zahlung, keine Einreichung in
diesem Slice. Reonic wickelt keine Zahlungen ab (F2.5-Präzedenz), und es
gibt keine Finanzmathematik (keine Raten-/Zinsberechnung, F2.5-Slice-A-
NICHTZIEL gilt fort).

## §1 Filing-Objekt `financing_case`

Filing-Objekt am Projekt nach M13-Grundmuster (Formular → Sperre →
Statusmaschine → Datei-Slots → E-Mail je Übergang → Abrechnung pro
Vorgang; E-Mail hängt wie überall am fehlenden Provider, F13-10).

- Felder (v1): `produkttyp` (`ratenkauf` | `kredit`), `laufzeit_jahre`,
  `volumen_eur` (Cent-genau gespeichert, Anzeige ganzzahlig €),
  `provider` (`bees_bears` | `psd_bank`), `provider_referenz`
  (opake externe Referenz, Freitext ≤200, nie im Portal), `status`,
  Phasen-Zeitstempel (`beantragt_at`, `entschieden_at`,
  `ausgezahlt_at`, `abgeschlossen_at`).
- Validierung Ratenkauf (Katalogwahrheit, Service-Guard fail-closed):
  Laufzeit 1–25 Jahre, Volumen ≤ 70.000 €, Provider `bees_bears`.
  Verletzung → `ValidationError`, kein Filing.
- PSD-Kredit: Felder bis zur Bank-Vorgabe freitextlich
  (`laufzeit_jahre`/`volumen_eur` ohne Katalogschranke, nur positiv
  und ganzzahlig); Schranken folgen per Amendment, nie erfunden.
- Berechtigung: KEINE neuen Keys. Lesen `installation.read`,
  Schreiben `installation.write` (F13-01-Präzedenz: Service ist
  Lebenszyklus-Fortsetzung; Finanzierung ist Aktenergänzung).
- Genau ein aktiver Vorgang je Projekt (v1-Grenze wie F13-03);
  abgeschlossene/stornierte Vorgänge bleiben Historie.

## §2 Maschine

`beantragt → bonitaet → entschieden → ausgezahlt → abgeschlossen`,
dazu `abgelehnt` aus `beantragt`/`bonitaet`/`entschieden` und
`storniert` aus `beantragt`/`bonitaet`/`entschieden`.
`abgelehnt`/`storniert`/`abgeschlossen` terminal; Reopen nur via
neuen Vorgang (F13-01: Historie bleibt ehrlich).

- Guards fail-closed (Statuskanten, leere Titel, NotFound ohne Orakel,
  Fremdtenant sieht nichts) — F13-01-Muster.
- Events/Audit ohne PII über IDs/Status hinaus:
  `financing_case.status_changed` (Aggregat `project`, Actor wie
  Bestand, nur caseId/from/to — Titel/Volumen nie im Audit, wie
  Angebotskette F13-01 §Scopes-3).
- No-op (wertgleicher Status) → Return ohne Event/Audit/Touch
  (F2.5-§3.5-Präzedenz, portal-link.v1-Noop-Disziplin).

## §3 Human-Gate Partner

Der Provider-Kontakt ist manuell (Mensch trägt die Provider-Rückmeldung
ein — Muster: manuelle BzA-Nummern-Verknüpfung F13-02/Katalog F13.2):

- Statuspfad: interner Editor setzt `bonitaet`/`entschieden`/
  `abgelehnt`/`ausgezahlt` per Hand nach Provider-Rückmeldung
  (E-Mail/Telefon/Partnerportal außerhalb des Systems) und hinterlegt
  die opake `provider_referenz`.
- KEINE erfundenen API-Payloads (kein Bees&Bears-/PSD-Request-Schema,
  kein Webhook-Vertrag), KEINE Finanzmathematik (keine Bonitätsscores,
  keine Raten/Zinsen — reine Anzeige des gemeldeten Stands).
- Gate: Sandbox-Zugang + unterschriebener Partnervertrag sind
  Voraussetzung für JEDEN automatisierten Provider-Pfad; bis dahin
  bleibt §3 der einzige Pfad (kein halbautomatischer Versand).

## §4 Portal

Antragsformular + Status-Tab nach F13-04-Muster (reine Leseprojektion
des DEFINER-Resolvers; kein Schreibpfad außer dem Antrag selbst):

- Projektion `financing`: `status` (6er-Wortschatz §2 ohne
  `abgelehnt`-Detailgrund), `produkttyp`, Phasen-Daten
  (`beantragtAt`/`entschiedenAt`/`ausgezahltAt`/`abgeschlossenAt`).
  Nie Bonitäts-/Kreditdetails (kein Score, keine Referenz, kein
  Volumen, keine Laufzeit) — nur grober Stand (F13-04/F13-09:
  BzA-Nummer/Zählernummer-Präzedenz, nie-sensible-Nummern).
- Fehlender Vorgang → `financing: null` → kein Block
  (Alt-Projektionen parsen wie null, Muster F10-03).
- Antragsformular: Produkttyp + Wunschlaufzeit + Wunschvolumen
  (Katalogschranke Ratenkauf client- + serverseitig), legt `beantragt`
  an; bis zur Klärung aus §5 kein Online-Antrag mit Unterschrift
  (Entwurf ohne Signaturbindung).
- Datei-Slots: aktenverknüpfte Datei-Anfragen nach F13-07-Muster
  (Einkommensnachweis u. ä. nur per Titel-Kontext, kein Schema-Umbau
  am anonymen Pfad). Chat nach F13-10-Muster (`{side, body, at}`,
  nie IDs/Akteure).

## §5 Vermittlerrollen-Ausschluss

Katalog: „Betrieb ohne Vermittlerrolle". Bis zur Klärung gilt:

- UI-Disclaimer (Portal-Antrag + interner Vorgang): sinngemäß
  „Wir vermitteln keine Finanzierung und beraten nicht — wir leiten
  Ihre Anfrage nur an den Partner weiter und zeigen den Stand an."
- Prozessregel nur-Anzeige/Weiterleitung: keine Beratungstexte
  (keine Empfehlung, kein Vergleich, keine Konditionsaussage),
  kein Online-Antrag mit Unterschrift, keine Provisionserfassung.
- Rechtsfrage an Mikail: welche Rolle (Tippgeber vs. Vermittler)
  ist gewollt und zulässig? Antwort als Amendment; bis dahin bleibt
  dieser § die Sperre (fail-closed: Zweifel → kein Antragsschritt).

## §6 Preis

Der Katalog schweigt zum Preis (kein Betrag wie F13.1/F13.2/F13.3) →
Default 0 € / inklusive, Schnittstelle offen (M13 „Abrechnung pro
Vorgang" greift erst mit Bepreisungs-Amendment; kein erfundener Tarif).

## Testmatrix (geschlossen)

| ID | Test | Ebene | Stand |
|---|---|---|---|
| F1315-SVC-01 | Service-Modul `financing_case` existiert (Import löst auf) | unit/RED | ROT belegt |
| F1315-SVC-02 | Service-Signatur `create`/`setStatus` + Guards fail-closed | unit/RED | ROT belegt |
| F1315-GRD-01 | Ratenkauf-Schranke 1–25 J. / ≤70.000 €, PSD freitextlich | unit/RED | ROT belegt |
| F1315-MAS-01 | Maschine §2 + Events/Audit ohne PII, No-op | unit/RED | ROT belegt |
| F1315-PRT-01 | Portal-Projektion `financing`: grober Stand, nie Details | unit/RED | ROT belegt |
| F1315-PRT-02 | `portalFinancingSchema`-Allowlist fail-closed (Fremdschlüssel → null) | unit/RED | ROT belegt |

ROT-Beleg (`tests/unit/f1315-finanzierung.red.test.ts`, vor `describe.skip`):

```
❯ f1315-finanzierung.red.test.ts (6 tests | 6 failed)
  ✗ F1315-SVC-01: Error: Cannot find package '@/lib/financing-case'
  ✗ F1315-SVC-02: Error: Cannot find package '@/lib/financing-case'
  ✗ F1315-GRD-01: Error: Cannot find package '@/lib/financing-case'
  ✗ F1315-MAS-01: Error: Cannot find package '@/lib/financing-case'
  ✗ F1315-PRT-01: AssertionError: expected null not to be null
      (strict-Resolver verwirft unbekannten financing-Schlüssel)
  ✗ F1315-PRT-02: AssertionError: expected undefined to be defined
      (portalFinancingSchema-Export fehlt)
Test Files  1 failed (1) · Tests  6 failed (6)
```

Danach `describe.skip` + Spec-Ref (Vorbild F4-01d-RED); Re-Aktivierung
erst mit Implementierungs-Slice (Modul + Migration + Contract).

## Bewusst offen

- Echte Provider-Anbindung (Sandbox + Vertrag als Gate, §3).
- E-Mail je Übergang (RESEND-Blocker wie F13-10).
- Bepreisung (Amendment zu §6), Vermittlerrollen-Klärung (§5-Frage).
- PSD-Schranken (Amendment statt erfundener Limits, §1).
