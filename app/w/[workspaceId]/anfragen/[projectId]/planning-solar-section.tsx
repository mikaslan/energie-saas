// F3-06a Sonnenstands-Anzeige (Stufe-0, Client): Höhe/Azimut/Auf-Unter
// für einen wählbaren Zeitpunkt am Projektstandort. Reine Ableitung
// über den Batch-Contract (keine Persistenz, keine Provider-Calls).
// Eingabe ist UTC-Label (ESTIMATE SOLAR_DISPLAY_NO_DST_LABEL).
"use client";

import { useMemo, useState } from "react";
import {
  PLANNING_SOLAR_DISPLAY_VERSION,
  resolveSolarDisplay,
} from "@/lib/integrations/planning/contracts/solar-display";

function toDatetimeLocalValue(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}

function parseUtcLabel(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  const instant = Date.parse(`${value}:00Z`);
  return Number.isFinite(instant) && instant > 0 ? instant : null;
}

export function PlanningSolarSection({
  latitude,
  longitude,
  planningMode,
}: {
  latitude: number | null;
  longitude: number | null;
  planningMode?: "quick" | "2d" | "3d";
}) {
  const [datetime, setDatetime] = useState<string>(() => toDatetimeLocalValue(new Date()));
  const display = useMemo(() => {
    if (latitude === null || longitude === null) return null;
    const instantMsUtc = parseUtcLabel(datetime);
    if (instantMsUtc === null) return null;
    try {
      return resolveSolarDisplay({
        schemaVersion: PLANNING_SOLAR_DISPLAY_VERSION,
        latitude,
        longitude,
        instantMsUtc,
      });
    } catch {
      return null;
    }
  }, [datetime, latitude, longitude]);

  if (planningMode === "quick") return null;

  return (
    <section data-testid="planning-solar-section" aria-labelledby="planning-solar-heading">
      <h2 id="planning-solar-heading" className="text-lg font-semibold">
        Sonnenstand
      </h2>
      {latitude === null || longitude === null ? (
        <p data-testid="planning-solar-no-coords" className="mt-2 text-sm leading-6 text-slate-600">
          Für diesen Standort sind keine Koordinaten hinterlegt — Sonnenstand
          nicht berechenbar.
        </p>
      ) : (
        <div className="mt-2 grid gap-2">
          <label className="grid gap-1 text-sm">
            <span className="font-medium text-slate-700">Zeitpunkt (UTC)</span>
            <input
              data-testid="planning-solar-datetime"
              type="datetime-local"
              value={datetime}
              onChange={(event) => setDatetime(event.target.value)}
              className="min-h-11 rounded-md border border-slate-300 px-3"
            />
          </label>
          {display === null ? (
            <p className="text-sm text-slate-600">Kein gültiger Zeitpunkt.</p>
          ) : (
            <dl className="grid gap-1 text-sm">
              <div className="flex gap-2">
                <dt className="text-slate-500">Höhe:</dt>
                <dd data-testid="planning-solar-elevation">
                  {display.elevationDeg.toFixed(1)}°
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500">Azimut:</dt>
                <dd data-testid="planning-solar-azimuth">
                  {display.azimuthDegNorth.toFixed(1)}°
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500">Stand:</dt>
                <dd data-testid="planning-solar-state">
                  {display.sunUp ? "Sonne auf" : "Sonne unter"}
                </dd>
              </div>
            </dl>
          )}
        </div>
      )}
    </section>
  );
}
