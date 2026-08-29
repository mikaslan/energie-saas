# Einkaufsliste für Mikail (Phase D der Tooling-Mission)

Stand: 2026-08-27. Alles hier braucht **dich** (Zugangsdaten, E-Mail oder Geld) —
der Rest ist bereits installiert (siehe STATUS.md). Reihenfolge = Priorität.
Preise: Quelle + Datum in `entscheidungen.md`; USD-Beträge ~0,90–0,95 €/$.

**Kostenrahmen P1:** Dev-Phase ab sofort ≈ **14 € netto/Monat** (Hetzner CX33
8,49 € + IPv4 ~0,50 € + Object Storage 4,99 €) plus nutzungsbasiert Anthropic
(~1–10 €/M). Ab Pilot-Go-Live zusätzlich ≈ **60–75 €/Monat** (Vercel Pro 20 $ +
Stadia 20 $ + Resend Pro 20 $ + Neon Launch ~5–20 $).

| # | Tool/Dienst | Wofür (Modul) | Kosten | Wo kaufen/registrieren (URL) | Was Mikail liefert (exakte Env-Var-Namen) | Prio |
|---|---|---|---|---|---|---|
| 1 | GitHub `workflow`-Scope | CI scharf schalten (alle M) | 0 € | Terminal + Browser | — (danach pushen, s. u.) | ✅ 27.08. |
| 2 | Hetzner Cloud CX33 | Worker-Host: PDF, pvlib, pg-boss (M2–M4) | 8,49 €/M netto + IPv4 ~0,50 € | https://console.hetzner.com | — (SSH-Zugang für Deploy) | ✅ 28.08. — IP 2.28.70.140, Docker drauf |
| 3 | Hetzner Object Storage | GoBD-WORM-Archiv + Backups (M2/M3) | 4,99 €/M netto (1 TB) | https://console.hetzner.com | getrennter Archiv-Satz `S3_*` und Backup-Satz `S3_BACKUP_*` gemäß `.env.example` | P1 sofort |
| 4 | Sentry (Developer, **EU-Region**) | Fehler-Monitoring App+Worker | 0 € (später Team 26 $/M) | https://sentry.io/signup/ | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` (+ `SENTRY_AUTH_TOKEN` für Source-Maps) | P1 sofort |
| 5 | healthchecks.io (Free) | Dead-Man-Alarm des Workers | 0 € | https://healthchecks.io/accounts/signup/ | `HEALTHCHECKS_PING_URL` | P1 sofort |
| 6 | Anthropic Console | Bill Reading (Haiku 4.5), Angebotstexte (Sonnet 5) ab M2/M4 | nutzungsbasiert ~1–10 €/M, Prepaid | https://platform.claude.com/ | `ANTHROPIC_API_KEY` | P1 sofort |
| 7 | Geoapify (Free) | Geocoding DE-Adressen, CSV-Import (M1) | 0 € (3.000 Credits/Tag) | https://myprojects.geoapify.com/register | `GEOAPIFY_API_KEY` | P1 sofort |
| 8 | DATEV Developer-Portal | EXTF-Spezifikation + CSV-Prüfprogramm (M3) | 0 € | https://developer.datev.de/ | Spezifikations-PDF + Prüfprogramm in `docs/tooling/datev/` ablegen | P1 sofort |
| 9 | Neon-MCP verbinden | DB-Ops direkt aus Claude Code | 0 € | in Claude Code: `/neon` → authenticate | — (Browser-OAuth, 1 Min.) | P1 sofort |
| 10 | Stadia Maps | Karten-Tiles Kundenkarte (M1) | 0 € jetzt (Trial), **20 $/M ab Pilot** | https://client.stadiamaps.com/signup/ | `NEXT_PUBLIC_STADIA_MAPS_API_KEY` | P1, zahlen ab Pilot |
| 11 | Resend Produktions-Domain | Magic-Link + Transaktionsmails | 0 € (Free), **Pro 20 $/M ab Pilot** | https://resend.com (bestehender Account) | `RESEND_API_KEY` (neuer Key der Domain) | P1, zahlen ab Pilot |
| 12 | Vercel Pro | Kommerzielle Nutzung (Hobby verbietet sie!) | 20 $/M | https://vercel.com/pricing | — | P1, **vor** Pilot-Go-Live |
| 13 | Neon Launch | PITR >1 Tag, Prod-DB | usage-based ~5–20 $/M | https://console.neon.tech | — | P1, vor Pilot-Go-Live |
| 14 | FullCalendar Premium | M5-Plantafel (resource-timeline) | 480 $/Jahr (1–10 Devs) | https://fullcalendar.io/pricing | `NEXT_PUBLIC_FULLCALENDAR_LICENSE_KEY` | P2 bei M5-Start |
| 15 | Google Solar API | M6 Dach-/Ertragsdaten | 0 € bis 10k Calls/M, dann 10 $/1k | https://console.cloud.google.com | `GOOGLE_SOLAR_API_KEY` | P2 bei M6-Start |
| 16 | Großhändler-DATANORM | Katalog-Import (M1-Ausbau) | 0 € (Konto des Pilotkunden) | Rexel: datanorm.support@rexel.de | Beispieldateien | P2 |
| 17 | WhatsApp Business (360dialog) | F14.3 (M8) | per-Message, DE-Marketing ~0,05–0,14 $ | https://www.360dialog.com | — nur dokumentiert | P2 |
| 18 | DIN EN 12831-1 + DIN/TS | raumweise Normheizlast | 479,50 € einmalig | https://www.dinmedia.de | PDFs | P3 |
| 19 | ETIM Deutschland | dt. Klassifikationsmodell | ~3.300 €/Jahr (unverifiziert) | mitgliederbetreuung@etim.de | — | P3 |
| 20 | febis foerderdata / co2online | Long-Tail-Förderdaten | auf Anfrage | vertrieb@fe-bis.de / kooperationen@co2online.de | — | P3 |

## Schritt-für-Schritt je P1-Kauf

### 1. GitHub workflow-Scope (⏱ 2 Min — schaltet die CI scharf)
1. Terminal: `gh auth refresh -h github.com -s workflow` — Code kopieren, im Browser bestätigen.
2. `cd ~/Downloads/Projects/energie-saas/tooling-wt && git push -u origin tooling`
3. Nach dem M0-Merge (andere Session) auch: `git push origin main m0-fundament` (aus dem jeweiligen Worktree).
4. CI prüfen: `gh run watch` bzw. `gh run list --branch tooling`.

### 2. Hetzner CX33 (Worker) — ✅ ERLEDIGT 28.08.
Per API bestellt (`scripts/hetzner-provision.py`): CX33 `energie-saas-worker`
(ID 163858990), Ubuntu 24.04.4, nbg1, IP `2.28.70.140`, Firewall nur 22/tcp,
Docker + Compose installiert. Details in STATUS.md.

### 3. Hetzner Object Storage (⚠️ Object Lock geht NUR bei Bucket-Anlage)
1. In console.hetzner.com → Object Storage: zwei getrennte S3-Credentials erzeugen:
   Archiv/App und minimaler Backup-Key ohne Governance-Bypass.
2. AVV/DSGVO im Kundenkonto abschließen (Hetzner Docs → Data Privacy).
3. **Buckets lege ich per Skript an** (Object-Lock-Flag ist Pflicht bei Anlage!).
   Archivwerte gehören in den App-Secret-Store (`S3_ENDPOINT`, `S3_REGION`, Keys,
   `S3_BUCKET=energie-saas-archiv`); `S3_BACKUP_ENDPOINT`, `S3_BACKUP_REGION`,
   Backup-Key und `S3_BACKUP_BUCKET=energie-saas-backup` ausschließlich auf den
   Backup-Host — niemals gemeinsam in `.env.local` des Web-Prozesses.
4. Danach sage ich dir das Ergebnis des If-None-Match-Tests (ADR 0002 Test-Gate).

### 4. Sentry (⚠️ EU-Region ist bei Org-Anlage endgültig)
1. sentry.io/signup → bei Org-Erstellung **Data Storage Location: EU (Frankfurt)** wählen.
2. Zwei Projekte anlegen: `javascript-nextjs` und `node`.
3. Beide DSNs in `.env.local` (`SENTRY_DSN` = node-DSN für Worker+Server, `NEXT_PUBLIC_SENTRY_DSN` = nextjs-DSN).
4. DPA in Org-Settings akzeptieren.
5. Optional: Auth-Token für Source-Maps erzeugen (`SENTRY_AUTH_TOKEN`).

### 5. healthchecks.io
1. Account anlegen (E-Mail genügt).
2. Check „worker-heartbeat": Period 1 min, Grace 5 min.
3. Ping-URL als `HEALTHCHECKS_PING_URL` in die Worker-Env.
4. Alarmkanäle: E-Mail + (empfohlen) Telegram/Pushover.

### 6. Anthropic Console
1. platform.claude.com → Account, Commercial Terms akzeptieren (enthält DPA/SCCs).
2. Zahlungsmittel + kleines Prepaid-Budget (z. B. 20 €).
3. **Spend-Limit/Alert setzen.**
4. API-Key erzeugen → `ANTHROPIC_API_KEY`.

### 7. Geoapify
1. myprojects.geoapify.com/register → Projekt anlegen.
2. API-Key → `GEOAPIFY_API_KEY`.
3. AVV/DPA per Support anfragen (EU-Firma, nicht öffentlich verlinkt).

### 8. DATEV Developer-Portal
1. developer.datev.de → kostenloses Konto (keine DATEV-Mitgliedschaft nötig).
2. „DATEV-Format" → Schnittstellenbeschreibung Buchungsstapel (EXTF 700) als PDF laden.
3. CSV-Prüfprogramm herunterladen; beides in `docs/tooling/datev/` ablegen (gitignored, falls Lizenz unklar).

### 9. Neon-MCP
1. In Claude Code: `/neon` → authenticate → Browser-OAuth durchklicken. Fertig.

### 10. Stadia Maps (Konto jetzt, zahlen ab Pilot)
1. client.stadiamaps.com/signup → Property/Domain anlegen.
2. API-Key → `NEXT_PUBLIC_STADIA_MAPS_API_KEY`.
3. **Ab erstem zahlenden Nutzer:** Starter-Plan (20 $/M) buchen + DPA abschließen (stadiamaps.com/legal/data-processing-addendum/).

### 11. Resend Produktions-Domain
1. Dashboard → Domains → Sende-Domain anlegen, **Region eu-west-1** wählen.
2. DKIM-/SPF-TXT-Records beim DNS-Provider setzen, DMARC ergänzen.
3. Verifizieren, neuen API-Key → `RESEND_API_KEY`.
4. Bei >100 Mails/Tag: Pro (20 $/M).

### 12./13. Vercel Pro + Neon Launch (erst unmittelbar vor Pilot-Go-Live)
1. Vercel: Account auf Pro-Team upgraden, Projekt verschieben, DPA akzeptieren, Region fra1.
2. Neon: Projekt auf Launch, History-Retention 7–14 Tage, Kreditkarte hinterlegen.
