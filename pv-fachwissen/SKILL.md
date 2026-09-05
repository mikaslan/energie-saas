---
name: pv-fachwissen
description: >
  Photovoltaik-Fachwissen für die Energie-SaaS: Komponenten, Kennzahlen,
  deutsche Marktregeln (EEG, MaStR), Planungsgrundlagen, Ertragssimulation
  (PVGIS), typische Paketgrößen. Laden bei Fachfragen, Berechnungslogik und
  Angebots-/Planungsmodulen.
---

# PV-Fachwissen — Orientierung für die Energie-SaaS

## Kern-Komponenten

- **Module:** Leistung in Wp (typ. 400–470 Wp/Modul); Flächenbedarf
  ≈ 2 m²/Modul; Neigung und Orientierung bestimmen den Ertrag.
- **Wechselrichter:** wandelt DC→AC; Dimensionierung ≈ 0,8–1,2× der
  Modulleistung — konkrete Auslegung immer nach Herstellerdaten.
- **Speicher:** nutzbare Kapazität in kWh; Eigenverbrauchsquote steigt
  (typ. 30 % ohne → 60–80 % mit Speicher, je nach Lastprofil).
- **Wallbox, Wärmepumpe:** Sektorkopplung; Wärmepumpen-Auslegung nach
  DIN EN 12831 / VDI 4645, nicht geraten.

## Kennzahlen

- kWp = Spitzenleistung; kWh = Energie; spezifischer Ertrag DE ≈
  850–1.100 kWh/kWp·a — lageabhängig, immer PVGIS statt Faustformel.
- Autarkiegrad und Eigenverbrauchsquote getrennt ausweisen; sie messen
  Verschiedenes.
- Wirtschaftlichkeit: Strompreis, Einspeisevergütung (EEG, degressiv),
  Anschaffungskosten €/kWp (typ. 1.200–1.800 €, marktabhängig — als Spanne
  markieren, nie als Fakt).

## Deutschland-spezifisch

- **EEG:** Einspeisevergütung, Anlagenregister; **MaStR:** Meldepflicht
  (Marktstammdatenregister) für Anlagen und Speicher.
- Netzanschluss: Anmeldung beim Netzbetreiber; > 30 kWp zusätzliche
  Auflagen; Balkonkraftwerke ≤ 800 W vereinfacht.
- Fördermittel (KfW, regionale Programme) ändern sich — vor Aussagen
  recherchieren, nie aus dem Gedächtnis garantieren.

## Planungseingaben (der Rechner)

Adresse (hausgenau), Jahresverbrauch, Dachfläche/-form (LoD2-Daten +
Orthofoto), Ausrichtung/Neigung, Verschattung, Bestandsanlage ja/nein.
Rechenkern: deterministisch, 8.760-Stunden-Profil, PVGIS-Monatswerte, alle
Annahmen versioniert; unbekannte Werte bleiben `unknown`, nie erraten.

## Grundsatz

Jede Zahl, die in Angebot oder PDF landet, kommt aus dem Rechenkern oder
einer benannten Quelle mit Datum. Faustformeln nur zur Plausibilisierung,
deklariert als ESTIMATE.
