#!/usr/bin/env python3
"""F4.1 Solar-Geometrie (Spec F4-01, "Solarposition ...").

Ein Batch, kein Netzwerk: Satte Sekunden-Laufzeit lokal. Erzeugt je
Providerstunde die unabhaengige SPA-Geometrie:

    geo = spa_python(time=t_utc, latitude, longitude, altitude,
                     pressure=101325.0, temperature=12.0,
                     delta_t=calculate_deltat(year, month),
                     atmos_refract=0.5667, how="numpy", numthreads=1)

Relative Air Mass aus zweiter SPA-Auswertung auf Meereshoehe, Eq. 31
direkt berechnet und gegen pvlib gegengeprueft:

    AM = 1/[cos(radians(z_app_deg))+0.50572*(96.07995-z_app_deg)^(-1.6364)]

    G_on = get_extra_radiation(t_utc, solar_constant=1366.1,
                               method="nrel", delta_t, how="numpy")
    G_0h = max(0, G_on*cos(z_true))

Verwendung (Projekt-Venv, M4-Deployment separat):
    source .venv/bin/activate
    python scripts/f401-spa-geometry.py --lat 52.52 --lon 13.41 \
        --elevation 47 --in tests/fixtures/f401/<tilted>.json \
        --out tests/fixtures/f401/spa-geometry-2020-<name>.json
    oder mit expliziter Zeitstempelliste (z. B. Viertelstundenpunkte):
    python scripts/f401-spa-geometry.py --lat 52.52 --lon 13.41 \
        --elevation 47 --timestamps /tmp/quarters.json \
        --out /tmp/spa-quarters.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys

import numpy as np
import pandas as pd

from pvlib.atmosphere import get_relative_airmass
from pvlib.irradiance import get_extra_radiation
from pvlib.solarposition import spa_python
from pvlib.spa import calculate_deltat

import pvlib


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lat", type=float, required=True)
    parser.add_argument("--lon", type=float, required=True)
    parser.add_argument("--elevation", type=float, required=True)
    parser.add_argument("--in", dest="input_path", required=False,
                        default=None,
                        help="Tilted-Fixture mit hours[].t (YYYYMMDD:HHmm UTC)")
    parser.add_argument("--timestamps", dest="timestamps_path", required=False,
                        default=None,
                        help="JSON-Liste von ISO-UTC-Zeitpunkten (Alternative zu --in)")
    parser.add_argument("--out", dest="output_path", required=True)
    return parser.parse_args()


def parse_stamp(stamp: str) -> pd.Timestamp:
    return pd.Timestamp(
        year=int(stamp[0:4]), month=int(stamp[4:6]), day=int(stamp[6:8]),
        hour=int(stamp[9:11]), minute=int(stamp[11:13]), tz="UTC",
    )


def air_mass_kasten_young(z_app_deg: float) -> float:
    return 1.0 / (
        math.cos(math.radians(z_app_deg))
        + 0.50572 * (96.07995 - z_app_deg) ** (-1.6364)
    )


def stamps_from_fixture(path: str) -> tuple[list[str], bytes]:
    with open(path, "rb") as handle:
        raw = handle.read()
    fixture = json.loads(raw)
    stamps = [hour["t"] for hour in fixture["hours"]]
    if len(stamps) != 8784:
        raise SystemExit(f"erwartet 8784 Stunden, gefunden {len(stamps)}")
    return stamps, raw


def stamps_from_iso_list(path: str) -> tuple[list[str], bytes]:
    with open(path, "rb") as handle:
        raw = handle.read()
    items = json.loads(raw)
    if not isinstance(items, list) or not all(isinstance(item, str) for item in items):
        raise SystemExit("Zeitstempelliste ist keine String-Liste")
    return items, raw


def parse_any_stamp(stamp: str) -> pd.Timestamp:
    if len(stamp) == 13 and stamp[8] == ":":
        return parse_stamp(stamp)
    parsed = pd.Timestamp(stamp)
    if parsed.tzinfo is None:
        return parsed.tz_localize("UTC")
    return parsed.tz_convert("UTC")


def main() -> int:
    args = parse_args()
    if (args.input_path is None) == (args.timestamps_path is None):
        raise SystemExit("genau eine Quelle: --in oder --timestamps")
    if args.input_path is not None:
        stamps, raw = stamps_from_fixture(args.input_path)
    else:
        stamps, raw = stamps_from_iso_list(args.timestamps_path or "")
    times = pd.DatetimeIndex([parse_any_stamp(stamp) for stamp in stamps])

    delta_t = np.asarray(calculate_deltat(times.year, times.month), dtype=float)
    geo = spa_python(
        times, args.lat, args.lon, args.elevation,
        pressure=101325.0, temperature=12.0, delta_t=delta_t,
        atmos_refract=0.5667, how="numpy", numthreads=1,
    )
    sea = spa_python(
        times, args.lat, args.lon, 0.0,
        pressure=101325.0, temperature=12.0, delta_t=delta_t,
        atmos_refract=0.5667, how="numpy", numthreads=1,
    )
    check = np.asarray(
        get_relative_airmass(sea["apparent_zenith"], model="kastenyoung1989"),
        dtype=float,
    )
    gon = np.asarray(
        get_extra_radiation(times, solar_constant=1366.1, method="nrel",
                            delta_t=delta_t, how="numpy"),
        dtype=float,
    )

    rows = []
    for index, stamp in enumerate(stamps):
        elev = float(geo["elevation"].iloc[index])
        azim = float(geo["azimuth"].iloc[index])
        z_true = float(geo["zenith"].iloc[index])
        z_app = float(sea["apparent_zenith"].iloc[index])
        g_on = float(gon[index])
        g_0h = max(0.0, g_on * math.cos(math.radians(z_true)))
        # Spec: Air Mass (und Clearness) nur bei Sonne ueber Horizont.
        if elev > 0:
            am_direct = air_mass_kasten_young(z_app)
            if not math.isfinite(check[index]) or abs(am_direct - check[index]) > 1e-9:
                raise SystemExit(f"AM-Gegenprobe verletzt bei {stamp}")
        else:
            am_direct = None
        rows.append({
            "t": stamp,
            "elevDeg": elev,
            "azimDeg": azim,
            "zenithTrueDeg": z_true,
            "zAppSeaLevelDeg": z_app,
            "am": am_direct,
            "gOn": g_on,
            "g0h": g_0h,
        })

    payload = {
        "provenance": {
            "generator": "scripts/f401-spa-geometry.py",
            "pvlib": pvlib.__version__,
            "pandas": pd.__version__,
            "numpy": np.__version__,
            "params": {
                "pressure": 101325.0, "temperature": 12.0,
                "atmosRefract": 0.5667, "how": "numpy", "numthreads": 1,
                "solarConstant": 1366.1, "airMass": "kastenyoung1989-sealevel-direct",
            },
            "site": {"latitude": args.lat, "longitude": args.lon,
                     "elevation": args.elevation},
            "sourceSha256": hashlib.sha256(raw).hexdigest(),
        },
        "hours": rows,
    }
    with open(args.output_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))
        handle.write("\n")
    print(f"{args.output_path}: {len(rows)} Stunden")
    return 0


if __name__ == "__main__":
    sys.exit(main())
