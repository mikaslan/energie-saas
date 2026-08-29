"use client";

import {
  Map,
  Marker,
  type MarkerDragEvent,
} from "@vis.gl/react-maplibre";

const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const NUDGE_METERS = 1;
const METERS_PER_LATITUDE_DEGREE = 111_320;

type Pin = {
  latitude: number;
  longitude: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function nudgePin(
  pin: Pin,
  direction: "north" | "east" | "south" | "west",
): Pin {
  const latitudeDelta = NUDGE_METERS / METERS_PER_LATITUDE_DEGREE;
  const longitudeScale = Math.max(
    0.000_001,
    Math.cos((pin.latitude * Math.PI) / 180),
  );
  const longitudeDelta = NUDGE_METERS
    / (METERS_PER_LATITUDE_DEGREE * longitudeScale);

  if (direction === "north") {
    return { ...pin, latitude: clamp(pin.latitude + latitudeDelta, -90, 90) };
  }
  if (direction === "south") {
    return { ...pin, latitude: clamp(pin.latitude - latitudeDelta, -90, 90) };
  }
  if (direction === "east") {
    return { ...pin, longitude: clamp(pin.longitude + longitudeDelta, -180, 180) };
  }
  return { ...pin, longitude: clamp(pin.longitude - longitudeDelta, -180, 180) };
}

export function AddressPinMap({
  pin,
  onPinChange,
}: {
  pin: Pin;
  onPinChange: (pin: Pin) => void;
}) {
  const handleDragEnd = (event: MarkerDragEvent) => {
    const next = event.target.getLngLat();
    onPinChange({ latitude: next.lat, longitude: next.lng });
  };

  const nudge = (direction: "north" | "east" | "south" | "west") => {
    onPinChange(nudgePin(pin, direction));
  };

  return (
    <figure
      aria-labelledby="address-map-title"
      className="min-w-0 overflow-hidden rounded-lg border border-slate-300 bg-slate-100"
    >
      <figcaption id="address-map-title" className="border-b border-slate-200 bg-white px-3 py-2.5">
        <span className="block text-sm font-semibold text-slate-900">Planungs-Pin prüfen</span>
        <span className="mt-0.5 block text-xs leading-5 text-slate-600">
          Marker ziehen oder mit den Richtungstasten jeweils etwa einen Meter verschieben.
        </span>
      </figcaption>

      <div className="h-72 min-h-72 w-full sm:h-80" data-testid="address-pin-map">
        <Map
          initialViewState={{
            latitude: pin.latitude,
            longitude: pin.longitude,
            zoom: 18,
          }}
          mapStyle={MAP_STYLE_URL}
          scrollZoom={false}
          cooperativeGestures
          attributionControl={{ compact: false }}
          style={{ width: "100%", height: "100%" }}
        >
          <Marker
            latitude={pin.latitude}
            longitude={pin.longitude}
            anchor="bottom"
            draggable
            onDragEnd={handleDragEnd}
          >
            <span
              aria-hidden="true"
              className="block h-7 w-7 rounded-full border-4 border-white bg-blue-700 shadow-lg"
            />
          </Marker>
        </Map>
      </div>

      <div className="grid gap-3 border-t border-slate-200 bg-white p-3">
        <fieldset className="mx-auto grid grid-cols-3 gap-1.5">
          <legend className="sr-only">Planungs-Pin schrittweise verschieben</legend>
          <span aria-hidden="true" />
          <button
            type="button"
            onClick={() => nudge("north")}
            aria-label="Pin einen Meter nach Norden verschieben"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-lg font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            <span aria-hidden="true">↑</span>
          </button>
          <span aria-hidden="true" />
          <button
            type="button"
            onClick={() => nudge("west")}
            aria-label="Pin einen Meter nach Westen verschieben"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-lg font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            <span aria-hidden="true">←</span>
          </button>
          <button
            type="button"
            onClick={() => nudge("south")}
            aria-label="Pin einen Meter nach Süden verschieben"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-lg font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            <span aria-hidden="true">↓</span>
          </button>
          <button
            type="button"
            onClick={() => nudge("east")}
            aria-label="Pin einen Meter nach Osten verschieben"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-lg font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            <span aria-hidden="true">→</span>
          </button>
        </fieldset>

        <p className="break-words text-center text-[0.6875rem] leading-5 text-slate-600">
          Adressdaten ©{` `}
          <a className="underline hover:text-slate-900" href="https://www.geoapify.com/">Geoapify</a>
          {` `}/ {` `}
          <a className="underline hover:text-slate-900" href="https://www.openstreetmap.org/copyright">OpenStreetMap-Mitwirkende</a>
          {` `}· Karte ©{` `}
          <a className="underline hover:text-slate-900" href="https://openfreemap.org/">OpenFreeMap</a>
          {` `}/ OpenMapTiles
        </p>
      </div>
    </figure>
  );
}
