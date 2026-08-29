import "server-only";

// Next.js-Serverpfade importieren diese Fassade. Der Worker verwendet den
// Node-kompatiblen Core direkt, weil das externe `server-only`-Markerpaket in
// einem eigenstaendigen CJS-Prozess absichtlich zur Laufzeit wirft.
export * from "./pvgis";
