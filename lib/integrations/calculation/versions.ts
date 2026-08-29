/**
 * Autoritative Versionspins fuer Reservation, Worker und Engineadapter.
 * Aenderungen an einem dieser Werte erzeugen bewusst eine neue fachliche
 * Reservation und duerfen deshalb nicht als lokale String-Duplikate leben.
 */
export const PLANNING_PROVIDER_RECIPE_VERSION = "pvgis-5.3-sarah3-2020.v1" as const;
export const PLANNING_MODEL_ID = "wmee-solar" as const;
export const PLANNING_MODEL_VERSION = "1.0.0" as const;
/**
 * Git-Blob-ID des tatsaechlich ausgefuehrten Clean-Room-Kerns in engine.ts.
 * Der nur als Referenz gepruefte Rechner-v3-Stand ist keine Runtime-
 * Provenienz und darf deshalb hier nie erscheinen.
 */
export const PLANNING_MODEL_SOURCE_REVISION =
  "2095ec8462aa32f7b7c9e075997b420620bde5de" as const;
export const PLANNING_DEFAULTS_VERSION = "wmee-planning-defaults.v1" as const;
export const PLANNING_RESERVATION_VERSION =
  "project-calculation-reservation.v1" as const;
