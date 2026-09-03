# F4.6 — Workspace-Simulationsdefaults (Wirtschaftlichkeit)

Status: SPECIFIED (Kimi NACHBESSERUNG → P1-1/P1-2/P2-1/P2-2/P3-1 eingearbeitet, Delta-reif) · Basis: `codex/m1-wave-02` `5c7ea33`
· Migration: **`0047_f4_06_economics_defaults`** (Root-Arbitrage 2026-09-04:
F4.6 wird vor M1-15b gebaut → M1-15b rückt auf `0048`; M1-15b-Spec
entsprechend aktualisiert). ADR: folgt M3-00-Muster (ADR 0024),
eigenständige ADR nicht nötig (Klon-Vertrag).

## 1. Zweck (Modulkatalog F4.6)

Workspace-weite Simulations-Defaults für die Wirtschaftlichkeitsrechnung:
Strompreis, Eskalation, Öl-/Gas-Preise. **Leere Felder → Länderreferenz**
(die Länderreferenz selbst ist ein Folgeslice; hier wird nur die nullable
Semantik + der DTO-Marker modelliert).

## 2. Umfang (schmal, M3-00-Klon)

- Singleton `workspace_economics_settings` je Workspace (UNIQUE
  workspace_id), CAS-Revision (Upsert mit baseRevision, Muster
  `workspace_invoicing_settings`).
- Felder (alle nullable bis auf revision):
  - `electricity_price_net_cents_per_kwh` BIGINT NULL — Strompreis
    netto, Cent/kWh. **Startet leer** (UNK-F4-03: keine erfundenen
    Zahlen; Mikail-Entscheid über echte Defaults offen).
  - `escalation_rate_bps` INTEGER NULL — jährliche Preiseskalation in
    Basispunkten (100 bps = 1 %). Startet leer.
  - `oil_price_net_cents_per_liter` BIGINT NULL — Ölpreis netto,
    Cent/Liter. Startet leer.
  - `gas_price_net_cents_per_kwh` BIGINT NULL — Gaspreis netto,
    Cent/kWh. Startet leer.
  - `cashflow_horizon_years` INTEGER NOT NULL DEFAULT 20 —
    Cashflow-Horizont (F4.5 „20-Jahres-Cashflow (Horizont
    einstellbar)"). ESTIMATE-markiert (UNK-F4-05: exakter Reonic-Default
    UNKNOWN; Modulkatalog nennt 20 Jahre).
- Bereiche (DECIDED): Preise 0…1_000_000 Cent (10.000 € je Einheit);
  Eskalation 0…2000 bps (20 %); Horizont 1…50 Jahre. **Bewusste
  Einschränkung (Kimi-P3-1):** negative Werte (Deflation, negative
  Strompreise) sind nicht darstellbar — der F4.5-Rechenkern darf das
  nicht annehmen.
- RLS/RBAC (M3-00-Muster): `economics.read` = Viewer+;
  `economics.write` = Admin ODER Editor mit Capability `economics`.
  External-only/Fremdtenant fail-closed. Actor-Helfer
  `_f406_actor_economics_role`, `_f406_actor_can_read_economics`,
  `_f406_actor_can_write_economics`; Policies tenant_isolation +
  restriktive Actor-Policies; no_truncate-Trigger; REVOKE-ALL/GRANT-
  Vertrag wie 0045.
- UI: Einstellungsseite `/w/[workspaceId]/einstellungen/wirtschaftlichkeit`
  (Klon des M3-00-Formulars, schmaler): Anzeige/Upsert der Defaults,
  Viewer read-only, leerer Zustand „Noch keine Defaults hinterlegt".
- Audit/Events: `workspace_economics_settings`-Upsert mit Event
  `workspace_economics_settings.upserted` + Audit im EIGENEN Namespace
  `economics.settings.write` (Kimi-P2-1: kein `invoicing.*`-Event —
  Paritätsfalle beim Klonen).

## 3. Nichtziele

- Länderreferenz-Tabelle (Preisquellen) — Folgeslice.
- F4.5-Rechenkern, KPI-Formeln, TOU/Arbitrage (UNK-F4-01/02/04) —
  eigene Slices nach ADR.
- Automatische Anwendung der Defaults in Berechnungen — Verkabelung im
  F4.5-Slice.

## 4. Verträge

- `workspace-economics-settings-command.v1`: `{ schemaVersion,
  baseRevision (0 = Insert, >=1 = CAS), input: { electricityPriceNetCentsPerKwh:
  number|null, escalationRateBps: number|null, oilPriceNetCentsPerLiter:
  number|null, gasPriceNetCentsPerKwh: number|null, cashflowHorizonYears:
  number } }`.
- `workspace-economics-settings.v1` (DTO): Werte + `revision` +
  `permissions: { canWrite }` + `hasAnyDefaults`.
  **Read-Semantik vor dem ersten Upsert (Kimi-P1-1):** keine Zeile →
  DTO mit allen 4 nullable Feldern `null`, `cashflowHorizonYears: 20`,
  `revision: 0`, `hasAnyDefaults: false`, `permissions.canWrite` berechnet
  — KEIN `not_found` (der Client braucht die initiale baseRevision 0).
  **hasAnyDefaults (Kimi-P1-2):** `true` ⇔ mindestens eines der 4
  nullable Felder (Strompreis, Eskalation, Ölpreis, Gaspreis) ist
  gesetzt; der Horizont (NOT NULL, Default 20) zählt nie. Teilmengen
  (nur Eskalation, nur ein Preis) sind Contract-Testfälle.
- Fehler: invalid/not_found/conflict/denied/unauthenticated
  (Invoicing-Fehlermuster, eigenes Modul `modules/economics`).

## 5. Testmatrix

| Kürzel | Prüfung |
|---|---|
| `F406-DB-01` | Singleton-UNIQUE; CAS-Revision (frisch, idempotent, stale) |
| `F406-DB-02` | Bereichs-CHECKs (Preis 0..1e6, Eskalation 0..2000, Horizont 1..50) |
| `F406-DB-03` | RLS: Viewer read, External/Worker/Fremdtenant fail-closed, Write-Matrix (Admin ODER Editor+capability) |
| `F406-DB-04` | no_truncate-Trigger + REVOKE-ALL/GRANT-Matrix (Kimi-P2-2); Insert ohne `cashflow_horizon_years` liefert Default 20 (Command sendet das Feld immer — DEFAULT ist Absicherung) |
| `F406-CON-01` | Contract-Schemas (Command/DTO, nullable Felder, bps-Bereiche) |
| `F406-UNIT-01` | Service-Mapping + Revision-Konflikt |
| `F406-E2E-01` | Editor legt Defaults an + lädt persistiert; Viewer read-only; External fail-closed; leerer Zustand; Axe A/AA |

Rollenprobe: 88/88 + neue `_f406`-Blöcke; PG18 5/5; `db:generate` ohne
Drift; Build grün; Kimi-Code-Review vor VERIFIED.

## 6. DECIDED / UNKNOWN

DECIDED: 0047-Zuweisung (Root-Arbitrage); M3-00-Klon-Vertrag; Bereiche
(inkl. Nicht-Darstellbarkeit negativer Werte, Kimi-P3-1); Horizont-Default
20 (ESTIMATE); „leere Felder → Länderreferenz" als nullable-Semantik;
Actor-Helfer-Präfix `_f406_` folgt dem 0045-Muster (dort `_m300_` nach
Slice-Name, Kimi-P2-3 ✓).
UNKNOWN: echte Default-Werte (UNK-F4-03, Mikail); exakter Reonic-Horizont
(UNK-F4-05, ESTIMATE); Länderreferenz-Datenquelle (Folgeslice).
