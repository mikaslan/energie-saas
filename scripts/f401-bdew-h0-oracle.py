#!/usr/bin/env python3
"""F4.1 BDEW-H0-Orakel (Spec F4-01, Lastprofil-Upgrade): demandlib-Referenz
fuer den TS-Port (h0-load-v2): ElecSlp(2020, Bundesfeiertage) mit
statischem h0 und h0_dyn je Viertelstunde (lokale naive Zeit).

Absichtlich OHNE die BDEW-24./31.-Dezember-Samstagsregel (reines
demandlib-Verhalten); der TS-Test validiert gegen dieses Orakel und
pinnt die Samstagsregel separat als Selbstkonsistenz. Feb-29-Zeilen
sind enthalten (35136 Viertel); der Test matcht auf Achsen-Labels.

Verwendung (Projekt-Venv):
    source .venv/bin/activate
    python scripts/f401-bdew-h0-oracle.py
"""
from __future__ import annotations

import datetime
import hashlib
import json
import sys

ORACLE_OUT = "tests/fixtures/f401/bdew-h0-dyn-oracle-2020.json"
EXPECTED_DEMANDLIB = "0.2.2"

# Bundesfeiertage 2020 (ohne regionale; Rezeptjahr-Pin, versioniert).
HOLIDAYS_2020 = [
    (1, 1), (4, 10), (4, 13), (5, 1), (5, 21), (6, 1), (10, 3), (12, 25), (12, 26),
]


def main() -> int:
    try:
        import demandlib
        from demandlib import bdew
    except ImportError:
        print("demandlib fehlt im .venv")
        return 1
    if demandlib.__version__ != EXPECTED_DEMANDLIB:
        print(f"demandlib {demandlib.__version__} statt {EXPECTED_DEMANDLIB}")
        return 1
    holidays = {datetime.datetime(2020, month, day): "bund" for month, day in HOLIDAYS_2020}
    slp = bdew.ElecSlp(2020, holidays=holidays)
    frame = slp.get_profiles("h0", "h0_dyn")
    if len(frame) != 35_136:
        print(f"unerwartete Reihenlaenge: {len(frame)}")
        return 1
    stamps = [ts.strftime("%Y-%m-%dT%H:%M") for ts in frame.index]
    payload = {
        "provenance": {
            "source": "demandlib 0.2.2 ElecSlp(2020, Bundesfeiertage), h0 + h0_dyn",
            "holidays": [f"2020-{m:02d}-{d:02d}" for m, d in HOLIDAYS_2020],
            "note": "ohne 24./31.-Dezember-Samstagsregel (separat gepinnt)",
            "unit": "Jahresanteile (Summe h0 = 1)",
        },
        "stamps": stamps,
        "h0": [float(v) for v in frame["h0"]],
        "h0_dyn": [float(v) for v in frame["h0_dyn"]],
    }
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    with open(ORACLE_OUT, "wb") as handle:
        handle.write(raw)
        handle.write(b"\n")
    print(f"{ORACLE_OUT}: {len(frame)} Viertel, sha {hashlib.sha256(raw).hexdigest()[:12]}...")
    print(f"h0-Summe: {frame['h0'].sum():.9f}, h0_dyn-Summe: {frame['h0_dyn'].sum():.6f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
