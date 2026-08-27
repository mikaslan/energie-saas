# Mission: App-Struktur nach Blaupause, Design in WMEE-Farben

Du gestaltest die **Informationsarchitektur und das Design-System** der energie-saas-App
(Reonic-Funktionsnachbau). Zwei Vorgaben, beide hart:

1. **Struktur = unsere Blaupause.** Navigations- und Seitenaufbau folgen dem
   Modulkatalog (`docs/blaupause/01-modulkatalog.md`) — also dem funktionalen
   Reonic-Aufbau: ein Projekt-Datensatz über drei Phasen (Request → Offer →
   Installation), Kanban-Boards als Arbeitsfläche, Projekt-Detail mit Tabs, getrennte
   Bereiche für Katalog/Vorlagen und Einstellungen.
   **Clean-Room-Grenze (CONTRIBUTING.md, nicht verhandelbar):** Nachgebaut wird die
   FUNKTIONALE Struktur aus unserer eigenen Blaupause — NIEMALS Reonic-Screenshots,
   -Layouts, -Icons oder -Texte kopieren, keinen Reonic-Zugang anlegen. Optisch muss
   die App eigenständig sein; genau dafür gibt es Vorgabe 2.
2. **Farben = WMEE.** Die visuelle Identität nutzt die WMEE-Markenfarben:
   - Primär/Akzent: `hsl(152 60% 32%)` (sattes Grün, ≈ #21835C)
   - Tinte/Foreground: `hsl(158 40% 12%)` (dunkles Grün-Schwarz)
   - Sekundärfläche: `hsl(150 30% 96%)` (helles Grün-Grau)
   - Zusatzton: `#29384A` (Slate-Navy) für neutrale UI-Elemente
   Quelle: WMEE-Repo (`~/Downloads/Projects/webseiten/wmee-remake-magic-repo`,
   src/index.css) — bei Bedarf dort weitere Töne nachschlagen. Daraus ein VOLLSTÄNDIGES
   Token-Set ableiten (Light + Dark, Statusfarben ok/warn/crit getrennt vom Akzent,
   Hover/Focus-Stufen), als Tailwind-/CSS-Variablen ins Projekt.

## Kontext — zuerst lesen

Projekt: `~/Downloads/Projects/energie-saas/repo` (prüfe per `git log`, ob m0-fundament
und der tooling-Branch gemerged sind; arbeite auf aktuellem Stand, neuer Branch `design`).
Pflichtlektüre: `docs/PLAN.md`, `docs/blaupause/01-modulkatalog.md` (Struktur-Quelle!),
`docs/blaupause/02-marktbild.md` (Abschnitt „Besser-als-Reonic": Selbsterklärendes
Onboarding und Zugänglichkeit für Kleinbetriebe sind DESIGN-Aufgaben), `CONTRIBUTING.md`,
`modules/README.md`. Stack: Next.js 16 App Router, Tailwind, shadcn — Komponenten werden
auf shadcn-Basis gethemed, nicht neu erfunden.

## Geschmacksprofil des Auftraggebers (bindend)

Mikail mag **Tiefe statt flachem Editorial-Design** — Liquid-Glass-Anmutung, spürbare
Ebenen, echte Markenfarben statt Pastell-Verwässerung. Keine sterile
Bootstrap/Template-Optik. ABER: Das hier ist ein Arbeitswerkzeug für Handwerksbetriebe —
Lesbarkeit, Dichte und Geschwindigkeit schlagen Show-Effekte. Tiefe dosiert einsetzen
(Panels, Overlays, aktive Karten), nicht auf jeder Tabellenzeile.

## Arbeitsauftrag

**A — Struktur-Map:** Aus dem Modulkatalog eine Seiten-/Navigationskarte für M1–M4
ableiten (Textdokument `docs/design/struktur.md`): Hauptnavigation, jede Seite mit Zweck,
Kern-Elementen und F-Nummern-Referenz. Reihenfolge: Dashboard, Anfragen-Kanban,
Projekt-Detail (Tabs: Basis, Gebäude/Energie, Aufgaben, Notizen, Dateien, Aktivität),
Angebote (Liste + Editor mit Varianten/Stückliste), Rechnungen, Katalog, Vorlagen,
Einstellungen (Workspace, Team/Rechte, Boards). Mobile-Verhalten je Seite kurz notieren
(PWA, Monteur-Sicht kommt in M5 — Struktur jetzt schon mitdenken).

**B — Design-System:** Token-Set (Farben wie oben, Typo-Paar mit Charakter — NICHT
Standard-Inter-Einerlei; Radius-, Schatten-, Ebenen-System für den Liquid-Glass-Look;
Statusfarben; Dark Mode vollständig). shadcn-Theme entsprechend konfigurieren.
App-Shell bauen: Navigation, Topbar mit Workspace-Switcher-Platzhalter, Content-Bereich,
responsive.

**C — Drei Design-Varianten LIVE:** Baue die App-Shell + eine Beispielseite
(Anfragen-Kanban mit realistischen Dummy-Daten) in **3 Varianten** (z. B. „Glas dunkel",
„Glas hell", „kompakt-nüchtern als Kontrollvariante") unter `/design-varianten` als
klickbare Vergleichsseite und deploye einen Vercel-Preview. **Mikail entscheidet am
lebenden Objekt** — das ist sein bevorzugter Modus. Erst nach seiner Wahl wird die
Gewinner-Variante zum Standard erhoben und die Vergleichsseite entfernt.

**D — Übergabe:** `docs/design/STATUS.md` mit Entscheidungen, offenen Fragen und dem
Preview-Link; kurze Chat-Zusammenfassung mit der Bitte um Varianten-Wahl.

## Regeln

- `npm run check` bleibt nach jedem Commit grün; keine Modulgrenzen verletzen
  (UI konsumiert Module nur über deren `index.ts`).
- Realistische deutsche Dummy-Daten (Installateurs-Alltag), kein Lorem, keine echten
  Personendaten.
- Barrierefreiheit: Kontraste der Grün-Töne auf beiden Themes prüfen (WCAG AA für Text).
- Was du an Struktur-Unklarheiten findest, die nur der Modulkatalog beantworten müsste,
  aber nicht beantwortet: sammeln und am Ende fragen — nicht raten.
