# ADR 0024 — Checklisten-Segmentabschluss als DB-kontrollierter Zustand

- Status: **ANGENOMMEN / IMPLEMENTED**
- Datum: 2026-09-06
- Betroffene Specs: `docs/spec/F7-02-checklisten.md`,
  `docs/spec/F7-04-segment-complete.md`
- Migration: `0077_f7_04_segment_completion.sql`

## Kontext

Der ursprüngliche F7.2-Slice speicherte eine JSONB-Checkliste je Projekt und
gab Runtime direkte Insert-/Update-Rechte. Er hatte weder stabile Baum-IDs
noch einen gegen Caller-Fälschung geschützten Segmentabschluss. Reonic belegt
Abschlusszeit/Actor, Required-Gate, segmentbasierten Fortschritt und einen
Admin-only Unlock mit Werterhalt.

## Entscheidung 1 — Abschlusszustand liegt außerhalb des editierbaren JSON

`project_checklist_segment_completion` ist die kanonische Zustandsrelation,
eindeutig je Workspace/Checkliste/Segment. Der Read-Pfad überlagert daraus
`completedAt` und `completedById`; Save-Commands enthalten diese Felder nie.

Damit kann ein Whole-Tree-Save weder Abschlussmetadaten fälschen noch beim
Reorder verlieren. Unlock löscht genau diese Zeile und lässt den Inhalt
unverändert.

## Entscheidung 2 — Stabile IDs und mehrere Container

Block, Segment und Item erhalten UUIDs. Die alte Projekt-1:1-Constraint wird
entfernt, weil die tiefere öffentliche Referenz mehrere
Baustellendokumentations-Checklisten/Subphasen beschreibt. `id`, nicht Titel
oder Phase, ist Identität. Der bestehende Bildschirm wählt vorläufig
deterministisch den ersten Baustellendokumentations-Container.

Legacy-IDs werden deterministisch aus Checklist-ID und Pfad erzeugt. Gültige
vorhandene IDs bleiben erhalten; unbekannte Keys und korrupte explizite IDs
werden nicht still repariert, sondern brechen das Upgrade ab.

## Entscheidung 3 — Drei atomare Write-Kapseln, Runtime SELECT-only

Save, Complete und Unlock laufen als eng signierte `SECURITY DEFINER`-
Funktionen. Sie prüfen Workspace-GUC, Actor, Membership, interne Rolle,
Objektbindung und CAS erneut in der Datenbank. Runtime verliert direktes DML;
private Helfer verlieren EXECUTE.

Complete sperrt in kanonischer Reihenfolge Projekt → Installation → Checkliste,
prüft Phase/Installationszeile sowie sichtbare Pflichtpositionen und schreibt
Completion, Versionsbump, Domain-Event und Audit in einer Transaktion. Unlock
verwendet dieselbe Reihenfolge, ist Admin-only und schreibt keinen
Downstream-Zustand.

## Entscheidung 4 — Struktur und Antworten werden getrennt autorisiert

Editoren dürfen Antworten ändern und Segmente abschließen. Phase, Titel,
Baumstruktur, `required` und `visible` sind Admin-Konfiguration. Ein leerer
Editor darf aus Kompatibilitätsgründen bei Version 0 eine rein sichtbare,
optionale Struktur erzeugen; ab Version 1 vergleicht die DB die Struktur ohne
`done` und akzeptiert nur Antwortänderungen. Dabei wird `done` ausschließlich
auf vollständig sichtbaren Block→Segment→Item-Pfaden aus dem Strukturvergleich
entfernt; verborgene Antworten können Editoren nicht fälschen. Abgeschlossene
Segmente sind als Ganzes unveränderlich, bis ein Admin sie entsperrt.

## Entscheidung 5 — Replay ist idempotent, exakte Payload bleibt ESTIMATE

Wiederholtes Complete liefert den vorhandenen Abschluss, ohne Timestamp,
Version, Event oder Audit erneut zu erzeugen. Wiederholtes Unlock eines schon
offenen Segments ist ebenfalls No-op. Diese Semantik ist sicher und
verlustfrei, aber wegen fehlender öffentlicher Reonic-Write-Endpunkte als
`ESTIMATE` markiert.

## Entscheidung 6 — Kanonische, begrenzte Baumvalidierung

App und DB teilen NFKC-, JavaScript-Trim-, Unicode-17-`Cc`/`Cf`- und
UTF-16-Längenregeln. Einzelne UTF-16-Surrogathälften werden vor JSON/DB
abgewiesen, gültige Paare bleiben erlaubt. Der PostgreSQL-16/Unicode-17-Versatz
U+A7F1 wird explizit geschlossen. Vor tiefer Validierung gelten höchstens 500
Knoten und 900.000 UTF-8-Bytes serialisiertes JSON; die Server Action ist
explizit auf 1 MiB begrenzt. Baumpositionen sind in App und DB gemeinsam auf
den nichtnegativen int32-Bereich begrenzt. Die DB prüft UUID-Eindeutigkeit set-basiert per
HashAggregate. Schutzgrenzen sind mangels öffentlicher Reonic-Grenze ein
sicherheitsbegründetes `ESTIMATE`.

## Entscheidung 7 — Template-Apply serialisiert am Projekt

Der frühere Check-then-Create-Pfad war nach Aufhebung der Projekt-1:1-Constraint
nicht mehr gegen Parallelität geschützt. Template-Apply sperrt daher zuerst
das Projekt und prüft anschließend vorhandene Baustellendokumentation. Der
Gewinner erzeugt Aggregate, Event und Audit; ein paralleler Verlierer liefert
Conflict ohne Teilzustand. Die Lockfolge bleibt Projekt → Checkliste.

## Konsequenzen

- Abschlusszeit und Actor sind serverseitig und nicht caller-schreibbar.
- Required-Gate und Completion committen atomar; konkurrierende Saves werden
  durch Checklist-Lock + CAS serialisiert.
- Große oder adversariale Bäume sind an App- und DB-Grenze workload-begrenzt;
  Rollenproben pinnen auch semantische Schema-Metadaten, nicht nur Namen.
- Unlock bewahrt alle vorhandenen Itemwerte und rollt keine Phase, Installation
  oder Folgeaggregate zurück.
- Vollständige Konditionsauswertung, Itemtypen, Irrelevant-Begründung und
  Container-Auswahl bleiben explizite F7.2/F7.3-Folgeslices.
