# F6-02 Schaltplan-Export (SVG-Datei, lesend)

Ziel: Das Einlinienbild je Angebotsvariante lässt sich als eigenständige
SVG-Datei herunterladen — rein lesend, keine Editierung, keine neue
Permission, keine Schemaänderung.

## Umfang

1. Reiner Dateiname-Builder `schematic-export-filename` (Angebotsnummer +
   Variantenname → `schaltplan-<sanitized>.svg`; unzulässige Zeichen werden
   zu `-`, ESTIMATE bleibt im Dateinamen-Kontext über den SVG-Titel).
2. Export-Button in der Schaltplan-Karte: serialisiert das gerenderte SVG
   (setzt `xmlns`, bettet `<title>` „Einphasiges Übersichtsschaltbild
   (Entwurf, ESTIMATE)" ein, XML-Deklaration voran) und lädt es als Blob
   herunter. Kein Server-Roundtrip, keine neue Datei im Storage.
3. E2E-Download-Beleg in der Angebotsdetailansicht (Dateiname, SVG-Kopf,
   ESTIMATE-Titel).

## ESTIMATE (reversibel)

- Export ist eine 1:1-Abbildung des F6-01-ESTIMATE-Layouts (kein
  normgerechtes Elektro-Dokument, kein Prüfstempel).
- Drucken/PDF bleibt beim Angebots-PDF (M2-02) — kein eigener
  Druck-Stylesheet-Pfad.
