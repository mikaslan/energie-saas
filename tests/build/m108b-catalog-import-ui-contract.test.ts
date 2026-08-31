import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const CATALOG = "app/w/[workspaceId]/katalog";
const IMPORT = `${CATALOG}/import`;
const DETAIL = `${CATALOG}/importe/[importId]`;

describe("M108B catalog import portal contract", () => {
  it("hält die Uploadseite tenantgebunden und die Datei ausschließlich lokal", async () => {
    const [page, wizard] = await Promise.all([
      readFile(`${IMPORT}/page.tsx`, "utf8"),
      readFile(`${IMPORT}/import-wizard.tsx`, "utf8"),
    ]);
    expect(page).toContain("authorizedQuery");
    expect(page).toContain("assertCatalogImportAccess");
    expect(page).toContain("NotAuthenticatedError");
    expect(page).toContain("DeniedState");
    expect(page).toContain("ImportWizard");
    expect(wizard).toMatch(/^\s*["']use client["']/u);
    expect(wizard).toContain("encodeCatalogCsvPreviewEnvelope");
    expect(wizard).toContain("CATALOG_CSV_REQUIRED_COMMON_FIELDS");
    expect(wizard).toContain("CATALOG_CSV_PREVIEW_MEDIA_TYPE");
    expect(wizard).toContain('type="file"');
    expect(wizard).toContain('accept=".csv,text/csv"');
    expect(wizard).toContain('mode: "inspect"');
    expect(wizard).toContain('mode: "preview"');
    expect(wizard).toContain("Datei prüfen");
    expect(wizard).toContain("Vorschau erstellen");
    expect(wizard).toContain("data-catalog-import-page-state");
    expect(wizard).toContain("mapping_incomplete");
    expect(wizard).toContain("router.push");
    expect(wizard).toContain("prepared.replayed");
    expect(wizard).toContain("Bestehenden Import öffnen");
    expect(wizard).not.toContain("localStorage");
    expect(wizard).not.toContain("sessionStorage");
  });

  it("hält Start und Abbruch als exakte, reautorisierte Server Actions", async () => {
    const actions = await readFile(`${DETAIL}/actions.ts`, "utf8");
    expect(actions).toContain('"use server"');
    expect(actions).toContain("authorizedAction");
    expect(actions).toContain("startCatalogImport");
    expect(actions).toContain("cancelCatalogImport");
    expect(actions).toContain("CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION");
    expect(actions).toContain("rightsAttested");
    expect(actions).toContain("revalidatePath");
    expect(actions).not.toContain("redirect(");
  });

  it("zeigt geschützte Vorschau, feste Zustände, Resultate und Retention ehrlich", async () => {
    const [page, controls, refresh] = await Promise.all([
      readFile(`${DETAIL}/page.tsx`, "utf8"),
      readFile(`${DETAIL}/import-controls.tsx`, "utf8"),
      readFile(`${DETAIL}/status-refresh.tsx`, "utf8"),
    ]);
    expect(page).toContain("authorizedQuery");
    expect(page).toContain("getCatalogImport");
    expect(page).toContain("listCatalogImportRows");
    expect(page).toContain("snapshotRedactedAt");
    expect(page).toContain("Redigierte Fehler und Ergebnisse");
    expect(page).toContain("Feste Fehlercodes, Verarbeitungsergebnisse und Produktlinks");
    expect(page).toContain("error.sourceHeader");
    expect(page).toContain("EK netto");
    expect(page).toContain("VK netto");
    expect(page).toContain("Herkunft");
    expect(page).toContain("fehlerbericht");
    expect(page).toContain("ImportControls");
    expect(page).toContain("StatusRefresh");
    expect(page).toContain("data-catalog-import-detail-state");
    expect(page).toContain("rawSearch.after");
    expect(page).toContain("Vorherige 100");
    expect(page).toContain("Nächste 100");
    expect(page).toContain("prefetch={false}");
    for (const state of [
      "ready_for_review", "queued", "running", "retry_wait", "partial",
      "succeeded", "failed_final", "cancelled_before_start",
    ]) expect(page).toContain(`"${state}"`);
    expect(page).not.toContain("snapshotSha256");
    expect(controls).toMatch(/^\s*["']use client["']/u);
    expect(controls).toContain("useActionState");
    expect(controls).toContain("Import starten");
    expect(controls).toContain("Import abbrechen");
    expect(controls).toContain("lastOperation");
    expect(controls).not.toContain('cancelState.status !== "idle"');
    expect(controls).toContain('role={isError ? "alert" : "status"}');
    expect(refresh).toContain("router.refresh()");
    expect(refresh).toContain("document.visibilityState");
  });

  it("verknüpft den Katalog nur für vollständig Importberechtigte mit letztem Status", async () => {
    const page = await readFile(`${CATALOG}/page.tsx`, "utf8");
    expect(page).toContain("canImport");
    expect(page).toContain("getLatestCatalogImport");
    expect(page).toContain("CSV importieren");
    expect(page).toContain("Letzter CSV-Import");
  });

  it("stellt Loading, Fehler und Not-found ohne leere Zwischenoberfläche bereit", async () => {
    const files = await Promise.all([
      readFile(`${IMPORT}/loading.tsx`, "utf8"),
      readFile(`${IMPORT}/error.tsx`, "utf8"),
      readFile(`${DETAIL}/loading.tsx`, "utf8"),
      readFile(`${DETAIL}/error.tsx`, "utf8"),
      readFile(`${DETAIL}/not-found.tsx`, "utf8"),
    ]);
    expect(files.join("\n")).toContain('role="alert"');
    expect(files.join("\n")).toContain("animate-pulse motion-reduce:animate-none");
    expect(files.join("\n")).toContain("Zum Produktkatalog");
  });
});
