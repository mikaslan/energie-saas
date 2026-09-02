# WMEE Design System – Token-Entwurf & öffentlicher Flow

- **Titel**: WMEE-Design-System (visuelle Referenz) – Token-Entwurf & öffentlicher Rechner-Flow
- **Stand**: 2026-09-02
- **Status**: DRAFT – visuelle Abnahme durch den Eigentümer steht aus
- **Zugriff**: ausschließlich `curl` (Hinweis: `web_fetch` war in dieser Umgebung nicht verfügbar), nur öffentliche Seiten, kein Login, keine internen Systeme
- **Clean-Room**: WMEE = ausdrücklich erlaubte **visuelle** Referenz. Reonic = funktionale Referenz (der eingebettete Rechner). Keine Übernahme von Quellcode, UI-Texten, Assets oder personenbezogenen Daten. Preise/Zahlen unten sind OBSERVED (öffentlich veröffentlichte WMEE-Produktdaten) und **nicht** als interne Katalogwahrheit zu behandeln.

---

## 1. Klassifikations-Legende

| Klasse | Bedeutung |
|---|---|
| **OBSERVED** | im abgerufenen HTML/CSS wörtlich belegt; mit URL + Zugriffsdatum 2026-09-02 |
| **INFERRED** | aus beobachteten Artefakten (Dateinamen, Header, Klassen) geschlossen, nicht wörtlich belegt |
| **UNKNOWN** | nicht belegbar (z. B. JS-gerendert, hinter Interaktion) – wird ausdrücklich nicht erfunden |

## 2. Crawling-Umfang

Gecrawlt (per `curl -sL`, Zugriff 2026-09-02):

| # | URL | Art | Ergebnis |
|---|---|---|---|
| 1 | https://wmee.de/ | Startseite (SSR-HTML) | 200, 164 KB |
| 2 | https://wmee.de/anlage-konfigurieren | Rechner-/Paketpreis-Seite | 200, 117 KB |
| 3 | https://wmee.de/kontakt | Kontakt (Formular + Termin-Embed) | 200, 74 KB |
| 4 | https://wmee.de/impressum | Impressum | 200, 64 KB |
| 5 | https://wmee.de/referenzen | Referenzanlagen | 200, 160 KB |
| 6 | https://wmee.de/leistungen/pv-fuer-einfamilienhaus | Leistungs-/Inhaltsseite | 200, 100 KB |
| 7 | https://wmee.de/assets/index-BiLpMuHG.css | Haupt-CSS-Bundle | 200, 109 KB |
| 8 | https://portal.reonic.de/public/0bc6e4bf-b8dd-4190-af4f-653b8ce5d9a0/energyhouse | Reonic-Embed-Shell (nur Struktur-HEAD) | 404-Shell, 7 KB |

**Gesamt: 8 URLs (7 auf wmee.de, 1 Reonic-Embed-Shell).**

Der Token-Fundort ist primär die **Inline-`<style>`-Critical-CSS** im SSR-HTML von `https://wmee.de/` (dort stehen die vollständigen `:root`-Design-Tokens) sowie identisch wiederholt im Bundle `https://wmee.de/assets/index-BiLpMuHG.css`.

### Technischer Stack (INFERRED aus Artefakten, nicht wörtlich belegt)

- React-SPA mit Vite-Build: `modulepreload` + gehashte Assets `react-*.js`, `vendor-*.js`, `index-*.js` → **OBSERVED** (Dateinamen); „React/Vite" → **INFERRED**
- Tailwind CSS v3: `--tw-*`-Variablen, Utility-Klassennamen → **OBSERVED** (CSS); „Tailwind v3" → **INFERRED**
- shadcn/ui-Token-Konvention: das exakte Set `--background/--foreground/--card/--popover/--primary/--secondary/--muted/--accent/--destructive/--border/--input/--ring/--radius/--sidebar-*` → **INFERRED** (Namensmuster)
- Radix UI: Chunk `radix-*.js` → **INFERRED**
- Routing/Query/Icons: Chunks `router-*.js`, `query-*.js`, `icons-*.js`, `seo-*.js` → **INFERRED** (TanStack Query, React Router, Lucide-Icons)
- Google Fonts: `Inter` (400/500/600/700) + `Montserrat` (700/800/900) → **OBSERVED** (`fonts.googleapis.com/css2?family=…`)
- Hosting Vercel (`server: Vercel`), Calendly-Terminembed, Reonic-Embed → **OBSERVED** (Header/`<link>`/CSP)

---

## 3. Design-Token-Entwurf

### 3.1 Farbwelt

Alle Farben liegen im Quell-CSS als **HSL-Tripel** vor (`h s% l%`); die HEX-Werte sind deterministische HSL→RGB-Konvertierungen (Standardformel) und als *abgeleitet* gekennzeichnet. Fundort: `:root` in der Inline-Critical-CSS (`https://wmee.de/`, 2026-09-02), identisch im Bundle.

| Rolle | Token | HSL (OBSERVED) | HEX (abgeleitet) |
|---|---|---|---|
| Hintergrund | `--background` | `0 0% 100%` | `#FFFFFF` |
| Text (Haupt) | `--foreground` | `158 40% 12%` | `#122B22` |
| **Primär / Grün** | `--primary` | `152 60% 32%` | `#218355` |
| Text auf Primär | `--primary-foreground` | `0 0% 100%` | `#FFFFFF` |
| Akzent (gleich Primär) | `--accent` | `152 60% 32%` | `#218355` |
| Sekundärfläche | `--secondary` | `150 30% 96%` | `#F2F8F5` |
| Sekundärtext | `--secondary-foreground` | `158 40% 14%` | `#153228` |
| Gedämpfte Fläche | `--muted` | `150 20% 96%` | `#F3F7F5` |
| Gedämpfter Text | `--muted-foreground` | `215 28% 20%` | `#253141` |
| Karte | `--card` | `0 0% 100%` | `#FFFFFF` |
| Karten-Text | `--card-foreground` | `158 40% 12%` | `#122B22` |
| Popover | `--popover` | `0 0% 100%` | `#FFFFFF` |
| **Border** | `--border` | `150 20% 88%` | `#DAE7E0` |
| **Input-Border** | `--input` | `150 20% 88%` | `#DAE7E0` |
| **Focus-Ring** | `--ring` | `152 60% 32%` | `#218355` |
| Fehler/Zerstörend | `--destructive` | `0 75% 50%` | `#DF2020` |
| Header-Hintergrund | `--header` | `0 0% 100%` | `#FFFFFF` |
| Header-Text | `--header-foreground` | `158 40% 12%` | `#122B22` |
| Sidebar (7 Tokens) | `--sidebar-*` | wie `background`/`primary`/`accent`/`border`/`ring` | `#FFFFFF`/`#218355`/`#F2F8F5`/`#DAE7E0` |

**Sidebar-Satz (OBSERVED):** `--sidebar-background` `0 0% 100%`, `--sidebar-foreground`/`--sidebar-accent-foreground` `158 40% 14%`, `--sidebar-primary`/`--sidebar-ring` `152 60% 32%`, `--sidebar-accent` `150 30% 96%`, `--sidebar-border` `150 20% 88%`.

**Gradienten & Spezialfarben (OBSERVED):**

- `--gradient-overlay`: `linear-gradient(180deg, hsl(158 40% 6% / .45), hsl(158 40% 6% / .62))` → dunkles Grün-Overlay über Hero-Bildern.
- `--gradient-soft`: `linear-gradient(180deg, hsl(150 30% 98%), hsl(150 25% 94%))` → `#F8FBFA → #ECF4F0`.
- Hero-Loading-Hintergrund (wörtliches HEX im Inline-CSS): `linear-gradient(180deg, #0e2a1f 0%, #103a2a 60%, #0a1f17 100%)` → dunkler Grün-Verlauf (`#0E2A1F` → `#103A2A` → `#0A1F17`).
- Warme Akzente (Utility-Farben, OBSERVED im Bundle): `amber-400 #FBBF24`, `amber-500 #F59E0B`, `orange-400`/`orange-500 #F97316`, `orange-600 #EA580C` – sparsam eingesetzt (Energie-/„Sonne"-Akzent, z. B. `text-amber-400`, `to-orange-500`).
- Alpha-Flächen auf dunklem Hero: `bg-white/15 #FFFFFF26`, `bg-white/15`, `border-white/10`, `border-white/30` → **INFERRED**: Outline-/Ghost-Elemente auf dunklem Grund.

**Zusammenfassung Farbwelt (INFERRED als Gestaltungsprinzip):** Hell/Grün-Design — weißer Grund, sehr dunkles grünes Ink (`#122B22`), kräftiges Grün als Marken-/Aktionsfarbe (`#218355`), sehr helle grün-graue Flächen/Borders (`#DAE7E0`), ein dunkler Grün-Verlauf für Hero/Footer, warme Orange/Amber-Akzente als Kontrast.

### 3.2 Typografie

| Merkmal | Wert | Klasse |
|---|---|---|
| Fließtext-Font | `Inter`, fallback `system-ui, -apple-system, sans-serif` | OBSERVED |
| Headline-Font | `Montserrat` (Fallback `Inter, sans-serif`), Gewicht 700, `letter-spacing: -0.025em` | OBSERVED |
| Google-Font-Gewichte | Inter 400/500/600/700; Montserrat 700/800/900 | OBSERVED |
| Grund-Line-Height | `1.5` (html) | OBSERVED |

**Größenklassen (Utility-Skala, OBSERVED aus CSS):**

| Klasse | Größe / Line-Height |
|---|---|
| `text-xs` | 0.75rem / 1rem |
| `text-sm` | 0.875rem / 1.25rem |
| `text-base` | 1rem / 1.5rem |
| `text-lg` | 1.125rem / 1.75rem |
| `text-xl` | 1.25rem / 1.75rem |
| `text-2xl` | 1.5rem / 2rem |
| `text-3xl` | 1.875rem / 2.25rem |
| `text-4xl` | 2.25rem / 2.5rem |
| `text-5xl` | 3rem / 1 |
| `text-6xl` | 3.75rem / 1 |
| `text-7xl` | 4.5rem / 1 |
| `text-[10rem]` | 10rem (dekorative Hero-Ziffer) |

**Gewichte:** `font-normal` 400, `font-semibold` 600, `font-bold` 700, `font-extrabold` 800. **Letter-Spacing:** `tracking-tight` -0.025em, `tracking-wide` 0.025em, `tracking-widest` 0.1em, `tracking-[0.15em/0.18em/0.2em/0.22em]` (Eyebrow/Kicker).

**Komponenten-Typo:**
- `.eyebrow` (Kicker): 0.875rem, 600, uppercase, `letter-spacing: .2em`, Farbe `--primary` → OBSERVED.
- `.btn-primary`: 0.875rem, 600, uppercase, `letter-spacing: .025em` → OBSERVED.
- `h1/h2/h3` nutzen `font-size: inherit` (Reset) – konkrete Abschnittsgrößen werden über Utilities gesetzt; die exakte Größe je Sektion ist im SSR-HTML nicht vollständig maschinell zuordenbar → **UNKNOWN** (Skala selbst ist belegt).

### 3.3 Radien

| Token/Klasse | Wert | Klasse |
|---|---|---|
| `--radius` | `0.5rem` (8px) | OBSERVED |
| `rounded-sm` | `calc(var(--radius) - 4px)` = 4px | OBSERVED |
| `rounded-md` | `calc(var(--radius) - 2px)` = 6px | OBSERVED |
| `rounded-lg` | `var(--radius)` = 8px | OBSERVED |
| `rounded-xl` | 0.75rem (12px) | OBSERVED |
| `rounded-2xl` | 1rem (16px) | OBSERVED |
| `rounded-3xl` | 1.5rem (24px) | OBSERVED |
| `rounded-full` | 9999px (Pille) | OBSERVED |

### 3.4 Schatten

| Token/Klasse | Wert | Klasse |
|---|---|---|
| `--shadow-glow` | `0 10px 40px -10px hsl(152 60% 32% / .35)` | OBSERVED |
| `--shadow-soft` | `0 4px 24px -12px hsl(158 40% 12% / .18)` | OBSERVED |
| `shadow-sm/lg/xl/2xl` | Tailwind-Standard (0 1px 2px … bis 0 25px 50px) | OBSERVED |
| Hover-Karten | `0 12px 36px -14px primary/.4` bzw. `-16px primary/.25` | OBSERVED |
| Drop-Shadow (Hero-Text) | `0 2px 6px rgba(0,0,0,.95)` u. ä. | OBSERVED |

### 3.5 Abstände / Raster

- Spacing-Skala: Tailwind-Standard, Basis 0.25rem (`p-4`=1rem, `gap-4`=1rem, `gap-10`=2.5rem, `py-12`=3rem usw.) → OBSERVED.
- Container `.container-wm`: `max-width: 80rem` (1280px), Padding `0.75rem` → `1rem` (≥360px) → `1.5rem` (≥640px) → `2rem` (≥1024px) → OBSERVED.
- Sektion `.section`: Padding vertikal `3rem` → `5rem` (≥768px) → `6rem` (≥1024px) → OBSERVED.
- Header: `position: fixed`, Höhe `5rem` (80px), `z-index: 50`, `border-bottom: 1px solid var(--border)` → OBSERVED; `main { padding-top: 5rem }` (Ausgleich für fixierten Header).
- Grids: `grid-cols-1/2/3`, `md:grid-cols-2/12`, `lg:grid-cols-8/12`, `xl:grid-cols-[minmax(0,1fr)_400px]` → OBSERVED (Utility-Namen); konkrete Seiten-Spaltennutzung liegt im JS → teilw. UNKNOWN.

### 3.6 Buttons / Karten / Formular-Sprache

**Primärbutton (`.btn-primary`, OBSERVED als einzige benannte Komponentenklasse):**
- `display: inline-flex`, `min-height: 48px`, zentriert, `gap: .5rem`
- `border-radius: 9999px` (Pille)
- Hintergrund `--primary` (`#218355`), Text `--primary-foreground` (weiß)
- `padding: .75rem 1.5rem` (→ `1.75rem` ab ≥640px)
- 0.875rem / 600 / uppercase / `letter-spacing: .025em`
- Übergang `0.15s cubic-bezier(.4,0,.2,1)`
- Hover: `--shadow-glow` + `brightness(1.1)`; Active: `scale(0.98)` → OBSERVED

**Weitere Button-/Link-Sprache (INFERRED aus HTML-Klassen):** sekundäre/Ghost-Buttons werden aus Utilities gebaut (z. B. `bg-white/15` + `border-white/30` + `text-white` auf dunklem Hero; Text-Links mit Pfeil „→" wie „Alle Hersteller ansehen →"). Es existiert keine benannte `.btn-secondary`-Klasse → **OBSERVED** (Abwesenheit).

**Karten-Muster (INFERRED aus Utilities + Inhalten):** Fläche `bg-card`, Rand `border-border`, Radius `rounded-2xl/3xl`, Schatten `--shadow-soft`; Kategorien sichtbar u. a. als:
- „Wonach suchst du?"-Einstiegs-Karten (4 Karten: Neu bei PV / Preise & Angebot / Solarteur auswählen / Bestehende Anlage) → OBSERVED (Textstruktur).
- Paketpreis-Karten (Starter / Komfort-Bestseller / Premium-Plus) mit Badge („Bestseller"), Preis „ab X €", Spec-Liste, Add-on-Zeilen, CTA „Jetzt Angebot anfragen" → OBSERVED (Struktur, s. §4).

**Formular-Sprache (OBSERVED auf /kontakt):** native Felder mit Labels + Pflichtkennzeichnung `*`: **Name\***, **E-Mail\***, **Telefon**, **Nachricht\***, Submit „Anfrage senden". Input-Border `--input` (`#DAE7E0`), Focus-Ring `--ring` (`#218355`). Terminvereinbarung über **Calendly**-Embed („Terminkalender wird geladen", „Termin extern öffnen") → OBSERVED.

**Focus/A11y (OBSERVED):** `:focus-visible` → transparente Outline + Ring 2px (teils 1px) in `--ring`, `ring-offset 1px`; `prefers-reduced-motion: reduce` deaktiviert Marquee/Glow-Animationen → OBSERVED.

### 3.7 Responsive-Verhalten

Breakpoints (OBSERVED aus `@media (min-width: …)`):

| Name | Breite | Beispiele |
|---|---|---|
| `xs` | 360px | Container-Padding, `scroll-px-4` |
| `sm` | 640px | `grid-cols-2/3`, Header-/Icon-Größen |
| `md` | 768px | `grid-cols-12`, Marquee-rtl, Hero-Typo |
| `lg` | 1024px | `grid-cols-8/12`, Sektion-Padding |
| `xl` | 1280px | `grid-cols-[minmax(0,1fr)_400px]`, `min-h-92vh` |
| `2xl` | 1536px | Typo-/Gap-Feinjustierung |

Beobachtbare Responsive-Muster (OBSERVED): Mobile nutzt horizontale Snap-Scroller (`.snap-x`, `.snap-mandatory`, `no-scrollbar`, „Wische für mehr" bei Garantien/Hersteller/Paketen), die ab `sm` in Grids übergehen (`sm:snap-none`). Hero-Bilder mit `(max-width: 767px)`/`(min-width: 768px)` Preload (avif). `overflow-x: hidden` global.

### 3.8 Dark-Mode

**Nicht implementiert (OBSERVED als Abwesenheit):** Es gibt keine `.dark`-Token-Overrides im `:root` und keine `@media (prefers-color-scheme: dark)`-Regel. Einziger Treffer ist die einzelne, aus der shadcn-Komponentenbibliothek stammende Utility `.dark\:border-destructive:is(.dark *)` im Bundle — sie ist inert, da weder eine `.dark`-Klasse gesetzt noch dunkle Token definiert sind. **INFERRED:** Dark Mode ist nicht vorgesehen; „dunkel" existiert nur als bewusster dunkelgrüner Hero-/Footer-Verlauf, nicht als Theme.

---

## 4. Öffentlicher Rechner-/Angebots-Flow (Struktur)

### 4.1 Einstiegs-Gate („Wonach suchst du?")

Auf Startseite und Leistungsseiten (OBSERVED): vier Persona-Karten als Router:
1. **Neu bei PV** – „ob es sich lohnt" (Dach/Verbrauch/Budget) → führt zum Rechner.
2. **Preise & Angebot** – Paketpreise & Weg zum Angebot → `/anlage-konfigurieren`.
3. **Solarteur auswählen** – Vergleichskriterien (eigene Monteure, Markenkomponenten, keine Anzahlung, regional).
4. **Bestehende Anlage** – Optimierung/Nachrüstung (Speicher, Wallbox, Wärmepumpe, Monitoring).

### 4.2 Paketpreis-Pfad (alternative, statische Preistransparenz)

OBSERVED auf `/anlage-konfigurieren` (öffentliche WMEE-Produktdaten, Stand 2026-09-02): drei Pakete mit identischer Feldstruktur:

| Feld | Starter | Komfort (Bestseller) | Premium-Plus |
|---|---|---|---|
| Preis „ab" | 9.900 € | 13.900 € | 19.750 € |
| Empfohlen bei | 3.000 kWh/Jahr | 5.000 kWh/Jahr | 7.500 kWh/Jahr |
| PV-Leistung | 5,4 kWp | 10,4 kWp | 15,3 kWp |
| Speicher | 5,8 kWh | 8,8 kWh | 14,8 kWh |
| Hersteller | Sigenergy | Sigenergy | Sigenergy |
| Dachfläche | ca. 24 m² | ca. 46 m² | ca. 68 m² |
| Autarkie | ca. 80 % | ca. 80 % | ca. 80 % |
| Amortisation | ca. 9 Jahre | ca. 7 Jahre | ca. 7 Jahre |

Optionale Add-ons (OBSERVED, identische Struktur): Notstrom-Ready **+1.000 €**, AC-Wallbox **+1.250 €**, bidirektionale Wallbox **+2.000 €** (bei Starter „Upgrade beim Wechselrichter erforderlich"). Enthalten/optional/Zusatzkosten werden in drei Listen aufgeschlüsselt („Im Paket enthalten" / „Optional erweiterbar" / „Mögliche Zusatzkosten") → OBSERVED als Struktur.

### 4.3 Solarrechner-Pfad (der eigentliche „Rechner")

**OBSERVED (WMEE-Wrapper, Startseite + `/anlage-konfigurieren`):**
- Sektion „Solarrechner" mit CTA „Solarrechner laden"/„Rechner direkt hier starten".
- Transparenzhinweis: „Der Rechner kommt von der reonic GmbH. Mit einem Klick laden wir ihn direkt auf dieser Seite – dabei werden Daten an reonic übertragen."
- Kennzahlen: „2 Minuten · Sofortergebnis · Unverbindlich", „Lädt hier auf der Seite · 100 % kostenlos".
- Embed-Ziel (OBSERVED im SSR-HTML): `https://portal.reonic.de/public/0bc6e4bf-b8dd-4190-af4f-653b8ce5d9a0/energyhouse?utm_source=website&utm_medium=lovable_embed&utm_campaign=wm_website`.
- CSP (OBSERVED): `frame-src … portal.reonic.de`, `connect-src … apps.reonic.de` → Einbettung via Frame **oder** JS-Load möglich; im SSR-HTML ist **kein** statisches `<iframe>` vorhanden → **INFERRED**: lazy JS-geladener Embed.

**Reonic-Embed selbst (UNKNOWN, statisch nicht belegbar):** Der direkte Abruf der Portal-URL liefert nur eine SPA-Hülle (`<div id="root">`, `/app_config.js`, `/assets/index-*.js`, Titel „Reonic Portal"). Die internen **Schritte, Eingabefelder und Ergebnisdarstellung** des „energyhouse"-Flows sind JS-gerendert und per `curl` nicht beobachtbar → **UNKNOWN**, wird nicht erfunden. Clean-Room: Reonic ist funktionale Referenz; interne UI/Texte des Embeds werden hier nicht übernommen.

**Semantische Eingabekategorien (OBSERVED aus WMEE-eigenem Text, nicht aus dem Reonic-Embed):**
- „Eckdaten zu deinem Zuhause in wenigen Minuten"
- FAQ („Welche Informationen braucht WMEE für die Prüfung?"): Adresse, ungefährer Jahresstromverbrauch, Angaben zum Dach, Info zu Speicher/Wallbox/Wärmepumpe/E-Auto, optional Bilder von Dach/Zählerschrank/Hausanschlussraum → OBSERVED.

**Ergebnis (OBSERVED aus WMEE-Text):** „Sofortergebnis", „transparente Einschätzung", „wie viel du sparen könntest", „passende Anlagengröße ermitteln". Ergebnis mündet in Lead (Kontaktanfrage/Vor-Ort-Termin), nicht in einen Direktkauf → INFERRED aus dem 4-Schritte-Prozess.

### 4.4 Übergeordneter Kundenprozess (OBSERVED, Startseite „So einfach geht's")

1. **Projekt skizzieren** – Rechner, 2 Min. Eckdaten.
2. **Vor-Ort-Termin & faires Festangebot** – erst nach Besichtigung (Zählerschrank, Dach, Leitungsführung) verbindliches Angebot.
3. **Saubere Montage** – keine Anzahlung vor Montagebeginn, Festpreis, Netzbetreiber-/Anmeldepapierkram übernimmt WMEE.
4. **Service nach Übergabe** – Monitoring, Reaktion bei Auffälligkeiten, Garantien.

---

## 5. Referenzbeispiele (anonymisierte Struktur)

Die Seite `/referenzen` zeigt Projektkarten **ohne Namen, Straßen oder Kontaktdaten**. Sichtbare **Datenfelder** pro Karte (OBSERVED, nur Struktur notiert — keine Werte übernommen):

- **Baujahr** (Gruppierung 2026 / 2025 / 2024 / 2023)
- **Standort** als Postleitzahl + Ortsname (Orts-Ebene, keine Adresse)
- **Leistung** als „{N} Module mit {X,XXX} kWp" (teils nur kWp)
- **Speicher** in kWh (optional, nicht bei allen Karten)

Hinweis: PLZ+Ort ist bereits die von WMEE selbst gewählte Anonymisierungsstufe; es werden hier **keine** konkreten Orte/Werte reproduziert.

Startseiten-Beispielkarte „neuestes Projekt" (OBSERVED, bereits anonymisiert): Felder = **kWp**, **kWh Speicher**, **Übergabedatum**, **Gebäudetyp** (Einfamilienhaus), **Ausrichtung** (Süd-West), **Zusatzausstattung** (Wärmepumpe + Wallbox), **jährliche Ersparnis** (€), **Standort** (Ort). Keine PII.

---

## 6. Offene UNKNOWNs

1. **Reonic-„energyhouse"-Flow intern:** Schritte, Feldreihenfolge, Ergebnis-KPIs — JS-SPA, nicht statisch crawbar.
2. **Einbettungsmechanik:** iframe vs. inline JS-Load des Rechners (CSP erlaubt beides; kein statisches `<iframe>` im HTML).
3. **Konkrete Heading-Größen je Sektion:** Reset setzt `inherit`; Zuordnung der Utility-Größen pro Abschnitt liegt im JS.
4. **Dark-Mode:** nicht vorhanden (nur eine inerte shadcn-`dark:`-Utility) — falls später ein Theme geplant ist, fehlt die Beleglage.
5. **Grid-/Layout-Zuordnung je Sektion** (welche `col-span-*` wo) — nur Utility-Skala belegt, konkrete Nutzung im JS.
6. **Exakte Farbwerte in Bildern/Illustrationen** (Hero-avif, Kartenfotos) — nicht aus CSS ableitbar.

---

## 7. Abschluss-Metrik

- **Gecrawlte Seiten/URLs:** 8 (7 wmee.de, 1 Reonic-Embed-Shell)
- **Gefundene Design-Tokens:** 34 CSS-Custom-Properties in `:root` (Farben, Radius, Gradienten, 2 Custom-Schatten) + 6 Breakpoints + 8 Radien + 4 Utility-Schatten + 2 Font-Familien (Inter/Montserrat) + warme Akzente (amber/orange) + Hero-Gradient (3 HEX)
- **Offene UNKNOWNs:** 6 (siehe §6)
- **Ausgabedatei:** `/Users/mikail/Projects/energie-saas/docs/parity/WMEE-DESIGN-SYSTEM.md`
- **Status:** DRAFT — visuelle Abnahme durch den Eigentümer steht aus; keine PII, keine Secrets übernommen.
