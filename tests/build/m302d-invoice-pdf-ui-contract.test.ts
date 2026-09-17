import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const DETAIL_ROUTE = "app/w/[workspaceId]/rechnungen/[type]/[documentId]";
const ACTIONS = "app/w/[workspaceId]/rechnungen/pdf-actions";
const PANEL = `${DETAIL_ROUTE}/invoice-pdf-panel.tsx`;
const DOWNLOAD = `${DETAIL_ROUTE}/pdf/[jobId]/route.ts`;

describe("M3-02d invoice PDF portal contract", () => {
  it("M302D-CT-05: laedt den minimierten Status im bestehenden autorisierten Page-Read", async () => {
    const page = await readFile(`${DETAIL_ROUTE}/page.tsx`, "utf8");

    expect(page).toContain("listInvoicePdfs");
    expect(page).toContain('from "@/modules/invoicing"');
    expect(page).not.toContain("@/modules/invoicing/pdf-service");
    expect(page).toContain("authorizedQuery");
    expect(page.indexOf("listInvoicePdfs")).toBeGreaterThan(
      page.indexOf("authorizedQuery"),
    );
    expect(page).toContain("invoicePdfs");
    expect(page).toContain("canRequestPdf");
    expect(page).not.toContain("artifactSha256");
    expect(page).not.toContain("inputSnapshot");
  });

  it("M302D-CT-04: haelt den Anfordern-Entrypoint strikt, erneut autorisiert und statusbasiert", async () => {
    const actions = await readFile(`${ACTIONS}.ts`, "utf8");

    for (const field of [
      "workspaceId",
      "type",
      "documentId",
    ]) {
      expect(actions).toContain(`"${field}"`);
    }
    expect(actions).toContain("parseExactForm");
    expect(actions).toContain("authorizedAction");
    expect(actions).toContain('"invoicing.write"');
    expect(actions).toContain("requestInvoicePdfInput");
    expect(actions).toContain("revalidatePath");
    expect(actions).not.toContain("redirect(");
    expect(actions).not.toMatch(/export\s+(?:const|let|var|class)\s+/u);
  });

  it("M302D-CT-05: zeigt echte Zustaende und ausschliesslich berechtigte Aktionen", async () => {
    const panel = await readFile(PANEL, "utf8");

    expect(panel).toMatch(/^\s*["']use client["']/u);
    expect(panel).toContain("useActionState");
    expect(panel).toContain("requestInvoicePdfAction");
    expect(panel).toContain("Rechnungs-PDF");
    expect(panel).toContain("canGenerate");
    expect(panel).toContain("Nur Lesezugriff");
    expect(panel).toContain('role={feedbackIsError ? "alert" : "status"}');
    expect(panel).toContain('aria-live={feedbackIsError ? "assertive" : "polite"}');
    for (const state of [
      "requested",
      "queued",
      "running",
      "retry_wait",
      "succeeded",
      "failed_final",
    ]) {
      expect(panel).toContain(`"${state}"`);
    }
    expect(panel).toContain("attemptCount");
    expect(panel).toContain("canDownload");
    expect(panel).toContain("jobId");
    expect(panel).not.toContain("Rechnung versenden");
    expect(panel).not.toContain("Öffentlicher Link");
    expect(panel).not.toContain("Signatur starten");
    expect(panel).not.toContain("artifactSha256");
  });

  it("M302D-CT-03: behandelt den Download als dynamischen privaten HTTP-Endpunkt mit Promise-Params", async () => {
    const route = await readFile(DOWNLOAD, "utf8");

    expect(route).toContain('dynamic = "force-dynamic"');
    expect(route).toContain("params: Promise<");
    expect(route).toMatch(/await\s+context\.params/u);
    expect(route).toContain("safeParse");
    expect(route).toContain("authorizedQuery");
    expect(route).toContain('"invoicing.issuing_details.write"');
    expect(route).toContain("readInvoicePdfArtifact");
    expect(route).toContain("Content-Disposition");
    expect(route).toContain("attachment;");
    expect(route).toContain("private, no-store");
    expect(route).toContain('Pragma: "no-cache"');
    expect(route).toContain("nosniff");
    expect(route).toContain("no-referrer");
  });
});
