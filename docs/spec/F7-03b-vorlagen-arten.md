# F7-03b Punkt-Arten in Vorlagen (Katalog F7.3)

F7-02d „Bewusst offen“: „Radio in Vorlagen“; F7-02c „Bewusst offen“:
„Template-Autorenschaft von Anzeige-Punkten (Template-Items sind
komponentengebunden)“. Dieser Slice trägt die Projekt-Punkt-Arten in die
Vorlagen-Positionen: Eine Template-Position definiert neben Komponente
und Menge auch die Art des Punkts, den das Anwenden erzeugt.

## ESTIMATE (reversibel, keine Reonic-Referenz für Vorlagen-Arten)

- Modell: optionales `kind` je Template-Item (nullish = Legacy =
  Aufgabe). Alle sechs Projekt-Arten zulässig
  (`task`/`title`/`description`/`radio`/`text`/`multi`) — damit sind
  Anzeige-Punkte als Vorlagen-Positionen gleich mit abgedeckt.
- Render (Erst-Anlage, Merge-Nachschub, Reset): Art wird 1:1 auf den
  Projekt-Punkt übernommen; `done`/`required` false, `description`/
  `value` null. Die Vorlage definiert die ART, nie Inhalt oder Antwort
  (kein Antwortspeicher in der Vorlage — ehrlich wie F7-02E am Projekt).
- Radio-Exklusivität: frisch gerenderte Radios sind alle unerledigt →
  Validator ok. Zwei Radio-Positionen in EINER Vorlage sind legal (die
  Auswahl trifft der Monteur am Projekt, F7-02D-Scope).
- Merge (F7-13): fehlende Positionen werden MIT Art ergänzt; vorhandene
  Punkte (per componentId/Titel gematcht) behalten ihre Art — kein
  Art-Overwrite, Werterhalt wie bei Titeln. Reset rendert frisch MIT Art.
- Kein Art-Kombinations-Validator in der Vorlage (fail-open bei Anlage);
  der Projekt-Validator (0143) sichert jeden Apply/Merge/Reset
  fail-closed ab.
- UI (Template-Manager): Art-Select je Position (Aufgabe/Titel/
  Beschreibung/Einfachauswahl/Textantwort/Mehrfachauswahl), Default
  Aufgabe; Legacy-Positionen ohne kind zeigen Aufgabe und speichern
  unverändert (kein stilles Nachrüsten).
- UI (project-checklist-manager): Antwort-Textarea für Textpunkte auch
  OHNE Strukturrecht (canWrite, exklusiv zum Struktur-Textarea im
  ItemKindControl — nie doppelt). Befund: Vorlagen-Checklisten sind ab
  Version 1 struktur-geschützt (F7.4); ohne diese Zeile wäre Text aus
  Vorlagen für Editoren unbeantwortbar, obwohl F7.4 das Beantworten
  ausdrücklich erlaubt (Radio/Multi/Task gehen ohne Strukturrecht).
  Viewer (ohne canWrite) und Struktur-Editoren sehen exakt wie bisher.

## Vertrag

- Template-Contract (`checklistTemplateItemSchema`): `kind:
  checklistItemKindSchema.nullish()` (Import aus dem Projekt-Vertrag,
  kein Zyklus, keine Duplikat-Enum). striktes Objekt bleibt strikt;
  Legacy-Payloads ohne kind parsen unverändert.
- Service (`modules/checklists/templates.ts`): `RenderedTemplate`-Items
  tragen kind (Default null); `renderFreshBlocks` setzt kind auf den
  Projekt-Punkt; Merge-Nachschub setzt kind ebenso. Keine neue
  Tabelle/Permission — Template-Items-CHECK bleibt reines Array
  (Migration 0053 unverändert), Projekt-Validierung über 0143.
- UI (`template-manager.tsx`): Art-Select je Position im ItemEditor
  (`item.kind ?? "task"`), neue Positionen mit kind null; Server-Action
  unverändert (Schema-Gate lässt kind durch).
- Kommentar-Nachzug: „Radio-/Bild-Typen = Slice B“ im Render-Kommentar
  auf F7-03b-Stand bringen (Bild weiter Q-STORAGE-UPLOADS).

## Regeln

1. Keine Migration, keine neue Permission, kein Provider.
2. Outbox/Complete (F7-04/F7-04c): gerenderte Bäume laufen durch
   dieselbe Projekt-Validierung — keine Sonderpfade.
3. Portal/Resolver: Vorlagen-Arten sind Admin-Sache; Portal-Projektion
   unverändert (rendert, was der Projekt-Baum trägt).

## Tests

- DB (`f703b-vorlagen-arten`, Fixture-Muster F7.3): Vorlage mit
  radio/text/multi/title/description-Positionen anlegen → Apply →
  Projekt-Items tragen die Arten (kind rundheraus); ungültige Art →
  ChecklistValidationError bei Anlage; Legacy-Vorlage ohne kind →
  Apply unverändert (kind null); Merge ergänzt fehlende Position MIT
  Art und lässt vorhandene Art unangetastet; Reset rendert Art frisch.
- E2E (`F7-03B-E2E-01`, W3-Isolation wie F7.3-E2E-01): Vorlage mit
  Einfachauswahl- + Textantwort-Position anlegen → anwenden →
  Radio-Input + Antwort-Textarea sichtbar → Speichern → Reload
  persistent; keine Browser-Fehler (Axe wie Nachbar-Specs nach
  F7-02F-Muster).
- Nachbarn: F7-03/13/14-DB-Suiten, F7-02-Nachbarschaft (Validator
  unberührt), m111a (keine Migration — unverändert), db:generate
  ohne Drift.

## Bewusst offen

- Bild-/Signatur-Arten in Vorlagen (Q-STORAGE-UPLOADS), Antwort-Defaults
  in Vorlagen (Inhalt gehört ans Projekt, nicht in die Vorlage),
  Art-Wechsel per Merge an vorhandenen Punkten (Werterhalt geht vor).
