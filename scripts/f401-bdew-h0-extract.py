#!/usr/bin/env python3
"""F4.1 BDEW-H0-Extraktion (Spec F4-01, Lastprofil-Upgrade): statische
Haushalts-Viertelstunden-Tabelle aus demandlib (MIT) nach
tests/fixtures/f401/bdew-h0-static.json + generiertem TS-Modul
lib/integrations/calculation/bdew-h0-table.ts.

Quelle: BDEW Standardlastprofile Strom, H0-Spalte aus
demandlib/bdew/bdew_data/selp_series.csv (2016 Zeilen = 3 Saisons x
7 Wochentage x 96 Viertel, Ordnung positional verifiziert: Bloecke
summer/winter/transition, je Mo-So, 00:00->23:45). Methode:
demandlib.bdew.ElecSlp (Saison, Wochentag 1=Mo..7=So, Feiertag=So).

Verwendung (Projekt-Venv):
    source .venv/bin/activate
    python scripts/f401-bdew-h0-extract.py
"""
from __future__ import annotations

import csv
import hashlib
import json
import sys

CSV_PATH = (
    ".venv/lib/python3.14/site-packages/demandlib/bdew/bdew_data/selp_series.csv"
)
JSON_OUT = "tests/fixtures/f401/bdew-h0-static.json"
TS_OUT = "lib/integrations/calculation/bdew-h0-table.ts"
EXPECTED_DEMANDLIB = "0.2.2"


def main() -> int:
    try:
        import demandlib
    except ImportError:
        print("demandlib fehlt im .venv (uv pip install --python .venv/bin/python demandlib)")
        return 1
    if demandlib.__version__ != EXPECTED_DEMANDLIB:
        print(f"demandlib {demandlib.__version__} statt {EXPECTED_DEMANDLIB}")
        return 1
    raw = open(CSV_PATH, "rb").read()
    rows = list(csv.DictReader(raw.decode("utf-8").splitlines()))
    if len(rows) != 2016:
        print(f"unerwartete Zeilenzahl: {len(rows)}")
        return 1
    periods: dict[str, dict[int, list[float]]] = {}
    for index, row in enumerate(rows):
        # Ordnung: positional (Block, Wochentag, Viertel aufsteigend).
        if int(row["weekday"]) != (index // 96) % 7 + 1:
            print(f"Ordnung verletzt bei Zeile {index}")
            return 1
        periods.setdefault(row["period"], {}).setdefault(
            int(row["weekday"]), []
        ).append(float(row["h0"]))
    for days in periods.values():
        if set(days) != {1, 2, 3, 4, 5, 6, 7}:
            print("Wochentage unvollstaendig")
            return 1
        for values in days.values():
            if len(values) != 96 or any(v < 0 for v in values):
                print("Viertel unvollstaendig/negativ")
                return 1
    csv_sha = hashlib.sha256(raw).hexdigest()
    provenance = {
        "source": "BDEW Standardlastprofile Strom, Haushalt H0 (statische Viertelstunden-Tabelle)",
        "via": f"demandlib {EXPECTED_DEMANDLIB} (MIT), bdew_data/selp_series.csv, Spalte h0",
        "csvSha256": csv_sha,
        "method": "demandlib.bdew.ElecSlp: (Saison, Wochentag 1=Mo..7=So, Feiertag=So) -> Form, Summe 1, x Jahres-kWh; h0_dyn = Form x BDEW-Glaettungspolynom F_t (Tag des Jahres)",
        "weekday": "1=Montag..7=Sonntag (pandas weekday+1), Feiertage wie Sonntag",
        "seasons": {
            "summer": "15.05.-14.09.",
            "transition": "21.03.-14.05. + 15.09.-31.10.",
            "winter": "01.01.-20.03. + 01.11.-31.12.",
        },
        "quartersPerDay": 96,
    }
    with open(JSON_OUT, "w", encoding="utf-8") as handle:
        json.dump(
            {"provenance": provenance, "periods": periods},
            handle,
            separators=(",", ":"),
        )
        handle.write("\n")
    lines = [
        "/**",
        " * F4.1 BDEW-H0-Tabelle (GENERiert, nicht von Hand pflegen):",
        " * statische Haushalts-Viertelstunden aus",
        " * demandlib/bdew_data/selp_series.csv (Spalte h0).",
        " *",
        f" * CSV-SHA-256: {csv_sha}",
        " * Generator: scripts/f401-bdew-h0-extract.py (prueft Ordnung,",
        " * Vollstaendigkeit und demandlib-Version).",
        " * Schluessel: Saison -> Wochentag 1=Mo..7=So -> 96 Viertel ab 00:00.",
        " */",
        "export const BDEW_H0_CSV_SHA256 =",
        f'  "{csv_sha}" as const;',
        "export const BDEW_H0_TABLE: Record<string, Record<number, readonly number[]>> = {",
    ]
    for period in ("summer", "winter", "transition"):
        lines.append(f"  {period}: {{")
        for weekday in range(1, 8):
            values = ", ".join(repr(v) for v in periods[period][weekday])
            lines.append(f"    {weekday}: [{values}],")
        lines.append("  },")
    lines.append("};")
    lines.append("")
    with open(TS_OUT, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))
    print(f"{JSON_OUT} + {TS_OUT}: 2016 Werte, csv {csv_sha[:12]}...")
    return 0


if __name__ == "__main__":
    sys.exit(main())
