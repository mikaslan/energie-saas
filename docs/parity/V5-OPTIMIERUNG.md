# V5-Optimierung — Datengetriebene Analyse des WMEE-Solarrechners v5

Stand: 2026-09-02 · **nur Analyse + Vorschlag** · keine Codeänderung am Rechner.
Quellen: Rechner-Code `wmee-remake-magic` (Branch `rechner/v5`, HEAD `36c1089`, 30.08.2026),
Katalog `energie-saas/artifacts/catalog-import-20260902/` (337 Komponenten, 41 Spalten + `flag`),
288 Katalogbilder, `REONIC-API-CAPABILITY-MAP.md`, `browser-recon-20260902/`,
Vault `20-Bereiche/D-Wmee/Rechner/`.

Harte Regeln eingehalten: kein Commit/Push, keine Änderung an `wmee-remake-magic`,
keine Reonic-Texte. Alle Zahlen aus den genannten Quellen; alles andere ist als **ESTIMATE**
markiert. Preise sind Eigentümer-Sache (Daniels Preisliste) — dieser Report **schlägt keine
Preisänderung vor**, sondern nur Befund + Empfehlung.

---

## 0. Zusammenfassung — Top-Befunde

1. **Der Katalog ist ein Sigenergy-zentriertes System, aber nur bruchstückhaft bepreist.**
   Vollständig bepreist ist praktisch nur Sigenergy (14 Wechselrichter + 2 Speicher + 3 Wallboxen
   + Zubehör). Module sind zu **109 von 114 ohne VK** (nur 5 bepreist), Speicher zu **66 von 71
   ohne VK** (nur 5 bepreist). Die Flagg‑Statistik (`NO_PURCHASE_PRICE` 264, `SALES_PRICE_ZERO` 266)
   bestätigt: **kein einziges der fünf Pakete S–XXL ist vollständig kosten-verifizierbar.**

2. **Das 2,92-kWh-Speicherraster des Rechners ist kein Katalog-SKU.** Es ist ein aus Daniels
   Preisliste zurückgerechneter Baustein. Er passt aber exakt zu **SigenStor BAT 10.0 (8,76 kWh
   nominal)**: Paket M (8,76 kWh), XL (17,52 = 2×8,76) und XXL (26,28 = 3×8,76) sind exakt
   1×/2×/3× SigenStor BAT 10.0. Nur S (5,84) und L (14,6) haben **keine** Katalog-Entsprechung.

3. **Modul: nur ein einziger 475-Wp-Kandidat mit Preis + echter SKU + Bild.** Der Rechner rechnet
   mit 475 Wp (`MODUL_WP`). Im Katalog ist **IBC SOLAR 2005700211** (475 Wp, EK 69,87 € / VK
   90,00 € netto, keine Flags, Bild `2005700211.png`) der einzige bepreiste 475-Wp-Typ; die fünf
   AIKO-475-Wp-Module tragen alle `NO_PURCHASE_PRICE + SALES_PRICE_ZERO`.

4. **Der dokumentierte v5-Umbau „fünf Festpreis-Pakete als Radiogruppe" ist im Code noch nicht
   angekommen.** Die Vault-Entscheidung vom 02.09.2026 („Schritt 5 = Paketwahl S–XXL, keine
   Regler") beschreibt einen Zustand, den der analysierte Branch-HEAD (30.08.2026) nicht enthält:
   Schritt 4 „Bausteine" zeigt weiterhin **Anlagengröße- und Speicher-Regler**. Die Paket-Karten
   existieren nur als „Drei Wege" auf der Ergebnisseite — und genau diese zeigt freie
   Raster-Auslegungen, die zu keinem Paket passen.

5. **Preis-Sanity M-Paket:** Komponenten-VK (IBC-Module + Sigen Hybrid 10.0 + SigenStor BAT 10.0)
   = **5.759 € netto** gegenüber **15.000 €** Listenpreis → **9.241 € (62 %) Montage/UK/Marge
   (ESTIMATE)**, konsistent mit dem 5.000-€-Fixanteil des Preismodells, aber aus dem Katalog
   nicht exakt belegbar (Montage-Einheiten teils unklar).

---

## A. Paket-Stücklisten gegen echte Produkte

### A.1 Was die Pakete wirklich enthalten (Stand `src/lib/solar/preise.ts`)

Die fünf Pakete sind **abstrakte Listenzeilen** — Modulzahl, kWp, belegte Fläche, Speicher-kWh,
Listenpreis. Es gibt **keine** Wechselrichter-Zeile, **keine** Modul-/Speicher-Marke im Paket
selbst. Der Rechenkern bepreist über die Formel `5.000 € + 630 €/kWp + 430 €/kWh` (Anpassung nach
kleinsten Quadraten über die fünf Listenzeilen).

| Paket | Verbrauch bis | Module | kWp | Fläche m² | Speicher kWh | Speicher (×2,92) | Listenpreis € |
|---|---|---|---|---|---|---|---|
| S | 3.000 kWh | 12 | 5,7 | 24 | 5,84 | 2 | 11.250 |
| M | 5.000 kWh | 22 | 10,45 | 44 | 8,76 | 3 | 15.000 |
| L | 7.500 kWh | 32 | 15,2 | 64 | 14,6 | 5 | 21.000 |
| XL | 10.000 kWh | 43 | 20,425 | 86 | 17,52 | 6 | 25.500 |
| XXL | ∞ | 52 | 24,7 | 104 | 26,28 | 9 | 31.750 |

**Zahlen-Abgleich mit der Aufgabenbeschreibung:** Die genannten Markenzählungen weichen leicht von
der realen CSV ab. Maßgeblich ist die CSV (je Typ): **AIKO-Module 56** (nicht 42), **GoodWe
gesamt 40** (davon 23 Wechselrichter), **KOSTAL gesamt 24** (davon 23 WR), **Pylontech gesamt 21**
(davon 19 Speicher), **BYD gesamt 20** (davon 19 Speicher), **Sigenergy gesamt 59** (davon 14
Speicher + 31 WR + 11 Zubehör + 3 Wallboxen). Für die Paket-Zuordnung zählen nur die typ-gefilterten
Zahlen.

### A.2 Kandidaten je Position (Top-2)

**Position 1 — Modul (475 Wp = `MODUL_WP`):**

| Rang | SKU | Marke/Modell | Wp | EK € | VK € | Flags | Bild |
|---|---|---|---|---|---|---|---|
| 1 | `2005700211` | IBC SOLAR 2005700211 | **475** | 69,87 | **90,00** | — (sauber) | `2005700211.png` |
| 2 | `WMEE-AF0AC0AE` | AIKO Neostar 3S+54 AIKO-A480-MCE54Db | 480 | 92,00 | **115,00** | SKU_GENERATED | `WMEE-AF0AC0AE.png` |
| — | 5× AIKO 475 Wp | Neostar A475-… (MAH54Mw/MCE54Db/Dw/Mb/Mw) | 475 | — | 0 | NO_PURCHASE_PRICE + SALES_PRICE_ZERO | je `WMEE-*.png` |

Hinweis: Das „typische" WMEE-Modul laut Preisliste ist 475 Wp. Nur **IBC 2005700211** ist 475 Wp
**mit** Preis, echter SKU und Bild. Die fünf AIKO-475-Typen (die Marke mit den meisten Modulen im
Katalog) sind durchgehend unbepreist.

**Position 2 — Wechselrichter (≈ 0,8–1,2× kWp, ESTIMATE nach Herstellerdaten):**

| Rang | Kandidat | Bereich | EK € | VK € | Flags | Bild (Beispiel) |
|---|---|---|---|---|---|---|
| 1 | Sigenergy Sigen Hybrid TP2 / SigenStor EC | 5–30 kW | 544–3.080 | **700–3.850** | SKU_GENERATED | `WMEE-C99D0959.png` (10.0 TP2), `WMEE-D398C444.png` (EC 10.0) |
| 2 | GoodWe ESA GW10K/GW12K-ETA-G20 · KOSTAL PLENTICORE plus 3.0-10 8.5 | 8,5–12 kW | 600–1.163 | **700–1.525** | SKU_GENERATED | `WMEE-C2AFC884.png` (GW10K), `WMEE-8BB0BEE5.jpg` (KOSTAL 8.5) |

Sigenergy ist die einzige Marke mit **durchgehender** WR-Preisliste (TP2 5–12 kW und SigenStor EC
5–30 kW inkl. Notstrom). GoodWe/KOSTAL decken nur den Bereich 8,5–12 kW ab → für S/M/L nutzbar,
für XL/XXL (20–25 kWp) fehlt dort der passende bepreiste Typ.

**Position 3 — Speicher (Baustein 2,92 kWh):**

| Rang | Kandidat | nominal kWh | EK € | VK € | Flags | Bild |
|---|---|---|---|---|---|---|
| 1 | Sigenergy SigenStor BAT 10.0 | **8,76** | 2.358 | **2.829** | SKU_GENERATED, TECH_INCOMPLETE | `WMEE-0199BB04.png` |
| 2 | Sigenergy SigenStor BAT 6.0 · GoodWe BAO9000-01-00P · Pylontech Force H3 9.69 | 6,02 / 8,7 / 9,69 | 1.840–2.131 | **2.208 / 1.925 / 2.700** | TECH_INCOMPLETE | `WMEE-A34037AD.png`, `BAO9000-01-00P.png`, Pylontech ohne Bild |

### A.3 Welche Pakete NICHT kosten-verifizierbar sind

| Paket | Speicher kWh | Katalog-Entsprechung | Verifizierbar? |
|---|---|---|---|
| S | 5,84 | kein SKU (nächstes: BAT 6.0 = 6,02) | ❌ Speicher; Modul/WR nur eingeschränkt |
| M | 8,76 | **SigenStor BAT 10.0 = 8,76 exakt** | ⚠️ teilweise (Modul+WR+Speicher je 1 bepreister Kandidat) |
| L | 14,6 | kein SKU (BAT 10.0 + BAT 6.0 = 14,78 ≈) | ❌ Speicher |
| XL | 17,52 | **2× SigenStor BAT 10.0 = 17,52 exakt** | ⚠️ Speicher exakt, WR nur SigenStor EC 20/25 |
| XXL | 26,28 | **3× SigenStor BAT 10.0 = 26,28 exakt** | ⚠️ Speicher exakt, WR nur SigenStor EC 25/30 |

**Gesamtfazit A:** Kein Paket ist vollständig kosten-verifizierbar, weil
(a) Modulpreise für 109/114 Module fehlen (inkl. aller AIKO/Trina-475-Wp-Typen),
(b) alle 71 Speicher `TECH_INCOMPLETE` sind (Quelle liefert nur Nennkapazität, keine nutzbare
Kapazität, keinen Wirkungsgrad — der Rechner nutzt aber „nutzbare" 2,92 kWh) und
(c) das 2,92-kWh-Raster ein Preislisten-Derivat ist, kein Katalog-SKU.
**M, XL und XXL** sind speicherseitig exakt auf SigenStor BAT 10.0 abbildbar; **S und L** nicht.

---

## B. Preis-Sanity

**Rahmen:** Katalog-`salesPriceNet` ist **netto** (REPORT §5); Paketpreise sind **Endkundenpreise
inkl. Montage/Inbetriebnahme**, bei Wohngebäude-PV gilt seit 2023 der Nullsteuersatz (§ 12 Abs. 3
UStG) — brutto = netto. Der Vergleich ist also näherungsweise zulässig.

### B.1 Preisanker aus dem Katalog (netto)

| Position | Kandidat | €/Einheit | Anker |
|---|---|---|---|
| Modul | IBC 2005700211 (475 Wp) | 90 €/Modul | **≈ 189 €/kWp** |
| Modul (Bandbreite) | Trina 450 / Jinko 470 / AIKO 480 | 72 / 95 / 115 € | 0,16–0,24 €/Wp |
| WR | Sigen Hybrid TP2 | 700–975 € | **≈ 95 €/kWp** |
| WR | SigenStor EC | 1.750–3.850 € | ≈ 210 €/kWp |
| Speicher | SigenStor BAT 10.0 | 2.829 € / 8,76 kWh | **≈ 323 €/kWh** |
| Speicher (Bandbreite) | GoodWe/Pylontech/SolarEdge | — | 221–403 €/kWh |

Der Rechner setzt **630 €/kWp** (Anlage) und **430 €/kWh** (Speicher) an. Modul ≈ 189 €/kWp ist
damit rund **30 %** der 630 €/kWp — der Rest (WR, Unterkonstruktion, Montage) ≈ 430 €/kWp.
Speicher-Komponente 221–403 €/kWh gegenüber 430 €/kWh → Montage/Marge am Speicher eher klein,
konsistent mit „ohne eigenen Fixanteil" (preise.ts).

### B.2 Durchgerechnet: Paket M (am besten verifizierbar)

| Position | Kandidat | VK netto |
|---|---|---|
| 22 Module | IBC SOLAR 2005700211 @ 90 € | 1.980 € |
| Wechselrichter | Sigenergy Sigen Hybrid 10.0 TP2 | 950 € |
| Speicher 8,76 kWh | Sigenergy SigenStor BAT 10.0 (exakt) | 2.829 € |
| **Summe Komponenten-VK** | | **5.759 €** |
| Listenpreis Paket M | | 15.000 € |
| **Rest (= Montage + UK + Kleinmaterial + Planung + Gerüst + Zählerschrank + Marge)** | | **9.241 € (62 %) → ESTIMATE** |

Plausibilisierung des Rests gegen den Katalog (je Zeile **ESTIMATE**, Einheiten teils unklar):
„Unterkonstruktion Schrägdach" 130–165 € (Einheit nicht eindeutig kWp/Modul), „Dachmontage"
330 €/kWp, „Elektroinstallation" 80 €/h, „Planung und Anmeldung beim Energieversorger" 1.250 €,
„Erweiterung Zählerschrank" 1.450 €, „Kleinmaterial" 450 €, „Netzwerkanbindung" 385 €,
„Baustelleneinrichtung" 100 €. Diese Posten stützen den 5.000-€-Fixanteil des Modells qualitativ,
lassen sich aber **nicht exakt** aufsummieren (Stundenzahl, kWp-Bezug und Gerüst fehlen).

### B.3 Befund + Empfehlung (keine Preisänderung)

- **Befund:** Die Paket-Listenpreise liegen deutlich über der Summe der (lückenhaft bepreisten)
  Komponenten-VK — der Abstand ist der Montage-/Dienstleistungs-/Marge-Anteil, der **aus dem
  Katalog nicht sauber belegbar** ist, weil die Montagepositionen nur teilweise und mit unklarer
  Einheit bepreist sind und die Marge im Komponentenkatalog fehlt (sie gehört in die Reonic
  `VariantLineItem`-Ebene, vgl. `REONIC-API-CAPABILITY-MAP.md`: `unitPurchasePrice`, `margin`).
- **Empfehlung (P1, Eigentümer-Freigabe):** Um Pakete ehrlich kosten-verifizierbar zu machen,
  müssten **Modul-EK/VK für die 475-Wp-Typen nachgepflegt** und **Speicher-Nenn→nutzbar +
  Wirkungsgrad** ergänzt werden. Das ist eine **Katalog-/Preispflege-Aufgabe des Eigentümers** —
  **nicht** eine Änderung an Daniels Preisliste im Rechner. Es werden **keine** Rechner-Preise
  verändert oder vorgeschlagen.

---

## C. Bild-Mapping (für die Paket-UI)

Alle 288 Bilder sind laut `ASSET-LICENSE.md` **eigene Produktfotos des Eigentümers**, Nutzung
„interner Produktkatalog", Quelle `reonic-private-static-production.s3.eu-central-1.amazonaws.com`.
**Vor** einer Verwendung im kunden­sichtbaren Rechner ist zu klären, ob „interner Produktkatalog"
den öffentlichen Rechner einschließt (Flag, kein Blocker). Die Bilder liegen unter
`energie-saas/artifacts/catalog-images-20260902/`, Name = `<sku>.<ext>`.

### C.1 Zuordnung Paket → Bestandteile → Bild

| Paket-Bestandteil | Empfohlener Kandidat | Bilddatei |
|---|---|---|
| Modul 475 Wp | IBC SOLAR 2005700211 | `2005700211.png` |
| Modul (alternativ) | AIKO Neostar A480 (bepreist) | `WMEE-AF0AC0AE.png` |
| Modul (alternativ, unbepreist) | AIKO Neostar A475 | `WMEE-F0AC1663.png`, `WMEE-A2777C03.png`, `WMEE-D67CD51F.png`, `WMEE-96BF357B.png`, `WMEE-7E32F72E.png` |
| WR S/M (5–12 kW) | Sigen Hybrid TP2 | `WMEE-1CDBA6EB.png` (5.0), `WMEE-77605CC8.png` (6.0), `WMEE-FC89D203.png` (8.0), `WMEE-C99D0959.png` (10.0), `WMEE-AFE334AE.png` (12.0) |
| WR M/L/XL/XXL (mit Notstrom) | SigenStor EC | `WMEE-5D98DDBD.png` (5.0) … `WMEE-5D91045A.png` (30.0) |
| WR M/L (alternativ) | GoodWe / KOSTAL / SolarEdge | `WMEE-C2AFC884.png` (GW10K), `WMEE-8BB0BEE5.jpg` (KOSTAL 8.5), `NX20K-RW000CYN4.png` |
| Speicher M/XL/XXL (8,76 / 2× / 3×) | SigenStor BAT 10.0 | `WMEE-0199BB04.png` |
| Speicher S (nächstes) | SigenStor BAT 6.0 | `WMEE-A34037AD.png` |
| Speicher (alternativ) | GoodWe / SolarEdge | `BAO9000-01-00P.png`, `NX-BLCK-5K-A-01.jpg` |
| Wallbox (Zusatzschalter) | SigenStor EVDC / GoodWe | `WMEE-1C2603E4.png` (EVDC 12), `WMEE-760CEDD9.png` (EVDC 25), `WMEE-0ADA2D61.png` (GWK11-HCA 11 kW) |

**Empfehlung (P0):** Da die v5-Paketkarten noch nicht existieren (siehe D.1), ist das Bild-Mapping
der **erste sofort umsetzbare** Baustein: eine statische `sku → bild`-Tabelle je Paketposition
liefern, damit die spätere Paket-UI sie nur noch referenziert. Tabelle oben ist die fertige
Grundlage.

---

## D. UX-/Paritäts-Befunde

### D.1 Dokumentierte v5-Entscheidung vs. Code-Stand (wichtigster Befund)

Die Vault-Notiz „v5 verkauft feste Pakete" (02.09.2026) beschreibt Schritt 5 als **„fünf
Festpreis-Pakete S–XXL als Karten in einer Radiogruppe, keine Regler für Module oder Speicher"**.
Der analysierte Branch-HEAD (`36c1089`, 30.08.2026) enthält das **nicht**: `Schritte.tsx`
(`SchrittBausteine`, Zeile 1391 ff.) zeigt weiterhin **„Anlagengröße"-Regler (Module)** und
**„Stromspeicher"-Regler (2,92-kWh-Schritte)** plus `ModulBild`. Es gibt keine Radiogruppe, kein
„Unser Vorschlag", keinen Paket-Stempel im Auswahl-Schritt. **Das heißt:** Die drei in der Notiz
als „offen" gelisteten Punkte („Drei Wege", 375-px-Paketkarten, `RESEND_API_KEY`) beziehen sich
auf einen Umbau, der im Code noch aussteht — die Analyse muss daher zwischen „Entscheidung" und
„implementiert" trennen.

### D.2 „Drei Wege" zeigt freie Auslegungen ohne Paketbezug

`empfehlung.ts` (`empfehleAuslegung`) durchrechnet ein Raster aus Modulzahl × Speicherbaustein
(12 Module bis Dachgrenze × 0–9 Bausteine) und zieht drei Karten: „Klein anfangen", „Zahlt sich am
schnellsten zurück", „Ganzes Dach" (`Ergebnis.tsx` 235–358). Diese Karten zeigen **beliebige
Rasterpunkte** (z. B. 26 Module / 9,0 kWp) und sind **nicht** an die fünf Pakete S–XXL gekoppelt.
`findePaket()` wird nur für das **eingestellte** Ergebnis aufgerufen (`Ergebnis.tsx` 1140), nicht
für die drei Karten. → Genau der in der Vault-Notiz benannte Widerspruch: Der Kunde bekommt drei
Auslegungen, die er nicht als „Paket" kaufen kann.

### D.3 375-px-Paketkarten ungeprüft

Die Vault-Notiz listet „Paketkarten bei 375 px Breite sind ungeprüft". Im Code gibt es 375-px-
Absicherungen **nur** für andere Komponenten (`bausteine.tsx` `Auswahl` Spalten­raster,
`Monatsbalken.tsx`, `Rechenlauf.tsx` 193, `SolarrechnerWizard.tsx` 563 Schrittleiste, `DachKarte.tsx`).
Für die (noch zu bauenden) Paketkarten existiert **keine** 375-px-Prüfung. Da die Paketkarten
fehlen, gilt die Lücke heute faktisch für die drei „Drei Wege"-Karten auf 375 px.

### D.4 `RESEND_API_KEY` fehlt

`api/contact.ts` (Zeile 382) und `api/feedback.ts` (Zeile 135) lesen `process.env.RESEND_API_KEY`.
Ohne den Wert liefert `/api/contact` den Fehlerpfad `not_configured` („liegt an uns, nicht an dir").
`KontaktSchritt.tsx` bildet das ab (Fehlertext Zeile 56–66). Das ist eine **Umgebungs-/Eigentümer-
Aktion** (Vercel-Env), keine Codeänderung.

### D.5 Energyhouse-Flow-Vergleich (Reonic vs. v5)

Aus `browser-recon-20260902/FLOW*.txt` (öffentliches Durchklicken):

| Schritt | Reonic Energyhouse | v5 |
|---|---|---|
| 1 | „Willkommen in Ihrem Energiehaushalt … sehen Sie direkt, was sich wann lohnt" + **„30 % geschafft"**-Fortschritt | Ausführlichkeits-Wahl (kein Prozent-Fortschritt) |
| 2 | **Standort** über Google-Maps-Karte, Haus exakt pinnen („Zur genauen Bestimmung des Ertrags … exakten Standort Ihres Hauses") | Adresse → **amtliche Orthophotos/LoD2** + Dachpolygon |
| 3+ | Verbrauch → Paketwahl → Ergebnis (laut Ablaufbeschreibung) | Dach → Verbrauch → Bausteine (Regler) → Ergebnis |

**Befunde:** (a) Reonic führt einen sichtbaren Prozent-Fortschritt; v5 hat eine Schrittleiste ohne
Prozentwert. (b) Reonic pinnt das Haus manuell auf einer Karte; v5 nutzt bewusst amtliche
Orthophotos/LoD2 (Vault-Entscheidung) — **kein** Paritäts-Defizit, sondern bewusste Abweichung,
aber der fehlende „Haus bestätigen"-Moment könnte den Verbrauchsschritt unverbindlicher wirken
lassen. (c) Reonic hat einen expliziten **Paketwahl-Schritt**; v5 hat aktuell den Bausteine-Regler-
Schritt (siehe D.1). (d) Der Reonic-Flow-Automat hing beim „Weiter"-Klick (Timeout, Button nicht
sichtbar) — ein Hinweis, dass der eigene v5-Flow auf **immer sichtbare, robuste** Weiter-Buttons
achten sollte (v5 hat das bereits über eine feste Weiter-Schaltfläche gelöst).

### D.6 Release-Notes (nur Hinweis, KEIN Scope)

`PORTAL-ALLE-SEITEN.txt` → `[release-notes]`: „1. Batterie-Arbitrage jetzt in Privat- und
Gewerbeprojekten · 2. Flexiblere Stromtarif-Einrichtung · 3. Einkaufspreis und Marge im
Zahlungs-Tab · Reonic KI-Erweiterungen · Krüppelwalmdach in der 3D Planung · Mehrere Boards &
Status für Installationen · Zeiterfassung". Diese Punkte betreffen **nicht** den v5-Rechner und
sind hier nur als späterer Paritäts-Hinweis notiert (Batterie-Arbitrage, flexible Tarife = v6-/energie-saas-Scope).

---

## E. Priorisierte Vorschlagsliste

Legende Aufwand: **S** klein (Stunden) · **M** mittel (1 Tag) · **L** groß (mehrere Tage).
Risiko: niedrig / mittel / hoch. **P0 = sofort mit vorhandenen Daten sicher umsetzbar.**

### P0 — sofort, vorhandene Daten

| # | Maßnahme | Datei(en) | Aufwand | Risiko |
|---|---|---|---|---|
| P0-1 | **Bild-Mapping-Tabelle** (Abschnitt C) als statische `sku→bild`-Referenz je Paketposition bereitstellen, damit die Paket-UI sie später nur referenziert. Lizenz-Klärung „interner Produktkatalog" vor Veröffentlichung. | neu: Mapping-Modul/Tabelle; Bilder aus `energie-saas/artifacts/catalog-images-20260902/` | S | niedrig |
| P0-2 | **„Drei Wege"-Bereinigung:** Den drei Ergebnis-Karten ihren Paketbezug geben — `findePaket(p.kwp, p.speicherKwh)` je Karte prüfen und Karten ohne Paket-Entsprechung entweder ausblenden oder mit „kein Listenpaket" kennzeichnen (bzw. auf das nächstgelegene Paket normieren). | `src/components/solarrechner/Ergebnis.tsx` (Karten-Block 235–358), `src/lib/solar/preise.ts` (`findePaket`) | S–M | niedrig |
| P0-3 | **375-px-Prüfung** der drei Ergebnis-Karten (und der späteren Paketkarten) nachziehen; vorhandene 375-px-Muster aus `bausteine.tsx`/`Rechenlauf.tsx` wiederverwenden. | `Ergebnis.tsx`, ggf. `Rechenlauf.tsx` | S | niedrig |
| P0-4 | **Dokumentations-Sync:** Den Gap „Entscheidung Paketwahl 02.09. vs. Code-Stand 30.08." in der Vault-Notiz/Status vermerken, damit nicht weiter gegen einen nicht existierenden UI-Stand optimiert wird. | Vault `v5 verkauft feste Pakete…` / `STATUS.md` | S | niedrig |

### P1 — Eigentümer-Freigabe nötig

| # | Maßnahme | Datei(en) | Aufwand | Risiko |
|---|---|---|---|---|
| P1-1 | **Modulpreise nachpflegen** (AIKO/Trina 475-Wp-Typen): EK/VK im Katalog ergänzen, damit die Paket-Stücklisten modulseitig verifizierbar werden. Katalog-/Preispflege, **keine** Rechner-Preisänderung. | `wmee-components.csv` / Katalog-Import (energie-saas) | M | mittel |
| P1-2 | **Speicher-Technikfelder ergänzen** (nutzbare Kapazität, Roundtrip-Wirkungsgrad, Dauerleistung), damit die 71 TECH_INCOMPLETE-Speicher importfähig werden und das 2,92-kWh-Raster sauber auf SigenStor-Module gemappt werden kann. | Katalog-Import (energie-saas) | M | mittel |
| P1-3 | **`RESEND_API_KEY` hinterlegen** (Vercel-Env für v5-Worktree), damit Kontakt-/Feedback-Versand real funktioniert. Eigentümer-/Deploy-Aktion, kein Code. | Vercel-Env; `api/contact.ts`, `api/feedback.ts` | S | niedrig |
| P1-4 | **Paketwahl-Schritt wirklich bauen** (falls Entscheidung 02.09. umgesetzt werden soll): Radiogruppe S–XXL aus `PAKETE` mit „Unser Vorschlag" + Ausblenden nicht passender Pakete; Regler ersetzen. Setzt P0-2 und die Bild-Tabelle voraus. | `Schritte.tsx` (`SchrittBausteine`), neu: Paketkarten-Komponente, `preise.ts` | L | mittel |
| P1-5 | **Stücklisten-/Preis-Änderungen an Paketen** nur als Vorschlag zur Eigentümer-Freigabe — konkret: ob Speichergrößen S (5,84) und L (14,6) auf Katalog-SKUs (6,02 / 14,78) normiert werden sollen. **Nicht eigenmächtig.** | `preise.ts` (nur nach Freigabe) | S | hoch (Eigentümer-Preisliste) |

### P2 — später / Hinweis, kein Scope

| # | Maßnahme | Aufwand | Risiko |
|---|---|---|---|
| P2-1 | Prozent-Fortschritt im v5-Wizard (analog Reonic „30 % geschafft") ergänzen. | S | niedrig |
| P2-2 | Batterie-Arbitrage, flexible Tarife (Release-Notes) — gehört zu v6/energie-saas, nicht v5. | L | hoch |
| P2-3 | „Haus bestätigen"-Moment im Adress-Schritt (Pin wie Reonic) — bewusste WMEE-Abweichung (amtliche Orthophotos), nur falls gewünscht. | M | mittel |

---

## Quellen & Nachweise

- Rechner: `/Users/mikail/Projects/wmee-remake-magic` Branch `rechner/v5` (HEAD `36c1089`, 30.08.2026):
  `src/lib/solar/preise.ts`, `constants.ts`, `empfehlung.ts`, `wirtschaftlichkeit.ts`, `ertrag.ts`,
  `types.ts`, `index.ts`; `src/rechner/RechnerApp.tsx`, `konfiguration.ts`;
  `src/components/solarrechner/{Schritte.tsx, Ergebnis.tsx, bausteine.tsx, KontaktSchritt.tsx,
  SolarrechnerWizard.tsx, Rechenlauf.tsx, Monatsbalken.tsx}`.
- Katalog: `/Users/mikail/Projects/energie-saas/artifacts/catalog-import-20260902/wmee-components.csv`
  (337 Zeilen), `REPORT.md`, `README.md`; Bilder `catalog-images-20260902/` (288) + `ASSET-LICENSE.md`.
- API-Map: `/Users/mikail/Projects/energie-saas/docs/parity/REONIC-API-CAPABILITY-MAP.md`
  (Component-Schema Zeile 595–599, `VariantLineItem` Zeile 504, `Price` Zeile 502).
- Portal: `/Users/mikail/Projects/energie-saas/artifacts/browser-recon-20260902/`
  (`FLOW.txt`–`FLOW6.txt`, `PORTAL-ALLE-SEITEN.txt`, `HOME-STRUCTUR.txt`).
- Vault: `20-Bereiche/D-Wmee/Rechner/` — „v5 verkauft feste Pakete…", „Daniel gibt Feedback…",
  „Der Rechner kann seine eigene Genauigkeit beziffern", „Kachel Bezahlt nach…";
  `Reonic Clone Final/00-Start-hier.md`, `01-Laufender-Stand.md` (Lizenz-Modus §440–457).

## KORREKTUR 2026-09-02 (Root, nach Worktree-Prüfung)

Die Analyse las den Repo-Branch `rechner/v5` (HEAD `36c1089`, 30.08.). Der
LIVE-Deploy-Worktree `~/Projects/webseiten/wmee-rechner-v5` ist jedoch
deutlich weiter (HEAD `879f094`, 02.09.) und enthält die dokumentierte
Paket-Entscheidung BEREITS: Radiogruppe mit „Unser Vorschlag"
(`src/components/solarrechner/Schritte.tsx:1497-1592`), `findePaket` im
Ergebnis (`Ergebnis.tsx:801`). Damit entfallen/ändern sich:
- Befund 4 (Entscheidung-vs-Code-Gap) und P0-4: **entfällt** — im Worktree
  umgesetzt.
- P0-2 („Drei Wege"-Bereinigung): im Worktree neu zu prüfen (Ergebnis.tsx
  nutzt bereits `findePaket`).
- Alle weiteren Befunde (Preislücken, SigenStor-Mapping, IBC-475-Kandidat,
  375-px, RESEND) bleiben gültig; Umsetzung erfolgt im DEPLOY-WORKTREE,
  nicht im Repo-Branch.
