# F10-04 Datei-Anfragen (Kunden-Upload je Projekt)

Ziel: interne Bitte um Kundendatei („Stromrechnung hochladen") mit
durchgängigem Pfad — Anlage in der Akte → offene Anfrage im
Kundenportal → Upload → Eingangs-QR mit Prüfsumme → Download →
Erledigt. Erster anonymer Schreibpfad des Portals (Token-DEFINER).
Bauarbeit, kein Referenzbeleg.

## ESTIMATE (reversibel, Referenzfrage offen)
- Modell: `file_request` n:1 je Projekt (v1 ein Beleg je Anfrage,
  10 MiB / PDF-JPEG-PNG als reversible Upload-Grenze). Maschine:
  `offen → hochgeladen → erledigt`; `storniert` nur aus offen,
  terminal (receipt-CHECK: storniert trägt nie Belegdaten).
- Beleg unter `immutable/`-WORM-Key (Key-Vertrag lib/storage);
  Storage-Backend per Env (`STORAGE_BACKEND=local` für Test/E2E/
  Preview ohne S3, sonst S3-kompatibel, `S3_BUCKET` Pflicht).
- Berechtigung: `project.read`/`project.write` (KEINE neuen Keys).
  Portal-Projektion nur Titel/Beschreibung/Stand/Zeiten/eigener
  Dateiname — nie Storage-Key/Prüfsumme (Allowlist-Vertrag).
- Race Withdraw→Fulfill: conflict/not_found + verwaistes
  WORM-Objekt (unveränderlich, unreferenziert — kein Cleanup in v1).
- Owner-Tanz für `fulfill_file_request` (Muster 0064): sonst filtert
  die FORCE-RLS-Actor-Policy den Invite-Lookup weg (not_found trotz
  gültigem Token — nachgemessen).

## Scopes
1. Migration 0104 (Tabelle, RLS tenant_isolation + FORCE,
   `fulfill_file_request`-DEFINER + Owner-Dance, Portal-Projektion
   `fileRequests`, Rollenvertrag wie 0103/F8-05).
2. Modul `file-requests`: Anlage/Liste/Transition (Tenant-Ctx),
   `fulfillFileRequestByToken` (Token→Invite-Bindung, fail-fast
   ohne Orphan, WORM-Put, atomares UPDATE), `downloadFileRequest`
   (dienende Bytes, kein URL-Umweg).
3. Portal: Dateien-Tab + Upload-Route (POST, Redirect mit
   ?upload=, kein globales Action-Limit angefasst).
4. Akte-Sektion: Anlage-Formular, Eingangs-QR (Dateiname, Größe,
   SHA-256), Beleg-Download, Folge-Buttons.

## Geschlossene Testmatrix
- `F1004-DB-01`: Anlage/Liste, Viewer liest, Fremdzugriff fail-closed.
- `F1004-DB-02`: Token-Erfüllung (WORM-Beleg, Portal-Projektion ohne
  interne Felder), Byte-identischer Download.
- `F1004-DB-03`: Doppel-Erfüllung (Conflict), Fremd-Request,
  Withdraw, ungültige Dateien/Tokens.
- `F1004-DB-04`: interne Übergänge, illegal fail-closed, erledigte
  Anfragen verschwinden aus der Portal-Projektion.
- `F1004-E2E-01`: Akte → Anlage → Portal-Link → Upload →
  Bestätigung → QR + Download (Byte-identisch) → Erledigt.

## Bewusst offen
- Mehrere Belege je Anfrage, Versionierung, Virenscan,
  Object-Lock (M2/M3), WORM-Orphan-Cleanup, direkter
  S3-Upload (signierte URLs), Portal-Download für Kunden,
  Echte S3-Anbindung in Preview/Prod (Q-F12-PROVIDER-PRIVACY).
