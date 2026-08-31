import type { CatalogImportActionState } from "./actions";

export type CatalogImportControlOperation = "start" | "cancel";

export const INITIAL_CATALOG_IMPORT_ACTION_STATE: CatalogImportActionState = {
  status: "idle",
};

export function selectCatalogImportActionState(input: Readonly<{
  lastOperation: CatalogImportControlOperation | null;
  startState: CatalogImportActionState;
  cancelState: CatalogImportActionState;
  startPending: boolean;
  cancelPending: boolean;
}>): CatalogImportActionState {
  if (input.lastOperation === "start") {
    return input.startPending
      ? INITIAL_CATALOG_IMPORT_ACTION_STATE
      : input.startState;
  }
  if (input.lastOperation === "cancel") {
    return input.cancelPending
      ? INITIAL_CATALOG_IMPORT_ACTION_STATE
      : input.cancelState;
  }
  return INITIAL_CATALOG_IMPORT_ACTION_STATE;
}
