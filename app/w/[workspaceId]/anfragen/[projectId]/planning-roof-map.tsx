// F3-03 Dach-Minimal: MapLibre-Polygonkarte (Client). Klicks legen im
// Zeichenmodus je einen Polygonpunkt an (x = Länge, y = Breite).
// Batch-1 ist providerfrei (F3-BATCH-1-vertrag): KEIN externer Stil —
// inline, keine Tile-/Glyph-/Sprite-Requests. Echte Basiskarte folgt
// mit den F3.2-Quellen-Adaptern.
"use client";

import { Layer, Map, Marker, Source } from "@vis.gl/react-maplibre";
import type { PlanningRoofPoint } from "./planning-roof-model";

const MAP_STYLE_INLINE = {
  version: 8 as const,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background" as const,
      paint: { "background-color": "#f1f5f9" },
    },
  ],
};
const DEFAULT_CENTER = { latitude: 52.52, longitude: 13.405 };

function centerFor(points: PlanningRoofPoint[]): { latitude: number; longitude: number } {
  if (points.length === 0) return DEFAULT_CENTER;
  const sum = points.reduce(
    (total, point) => ({ x: total.x + point.x, y: total.y + point.y }),
    { x: 0, y: 0 },
  );
  const averageX = sum.x / points.length;
  const averageY = sum.y / points.length;
  if (!Number.isFinite(averageX) || !Number.isFinite(averageY)) return DEFAULT_CENTER;
  return {
    latitude: Math.min(90, Math.max(-90, averageY)),
    longitude: Math.min(180, Math.max(-180, averageX)),
  };
}

export function PlanningRoofMap({
  points,
  drawing,
  disabled,
  onAddPoint,
}: {
  points: PlanningRoofPoint[];
  drawing: boolean;
  disabled: boolean;
  onAddPoint: (point: PlanningRoofPoint) => void;
}) {
  const center = centerFor(points);
  const lineCoordinates: number[][] = points.map((point) => [point.x, point.y]);
  if (points.length >= 3) {
    const first = points[0] as PlanningRoofPoint;
    lineCoordinates.push([first.x, first.y]);
  }
  const interactive = drawing && !disabled;

  return (
    <div
      data-testid="roof-map"
      className="h-72 min-h-72 w-full overflow-hidden rounded-md border border-slate-300 bg-slate-100"
    >
      <Map
        initialViewState={{
          latitude: center.latitude,
          longitude: center.longitude,
          zoom: 18,
        }}
        mapStyle={MAP_STYLE_INLINE}
        scrollZoom={false}
        cooperativeGestures
        attributionControl={false}
        cursor={interactive ? "crosshair" : undefined}
        onClick={(event) => {
          if (!interactive) return;
          onAddPoint({ x: event.lngLat.lng, y: event.lngLat.lat });
        }}
        style={{ width: "100%", height: "100%" }}
      >
        {points.length >= 2 ? (
          <Source
            id="roof-polygon"
            type="geojson"
            data={{
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  properties: {},
                  geometry: { type: "LineString", coordinates: lineCoordinates },
                },
              ],
            }}
          >
            <Layer
              id="roof-polygon-line"
              type="line"
              paint={{ "line-color": "#1d4ed8", "line-width": 2 }}
            />
          </Source>
        ) : null}
        {points.map((point, index) => (
          <Marker
            key={`${point.x}:${point.y}:${index}`}
            latitude={point.y}
            longitude={point.x}
            anchor="center"
          >
            <span
              aria-hidden="true"
              className="pointer-events-none block h-3 w-3 rounded-full border-2 border-white bg-blue-700 shadow"
            />
          </Marker>
        ))}
      </Map>
    </div>
  );
}
