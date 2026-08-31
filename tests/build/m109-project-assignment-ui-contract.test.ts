import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const REQUESTS = "app/w/[workspaceId]/anfragen";
const DETAIL = `${REQUESTS}/[projectId]`;

describe("M1-09 Portalvertrag", () => {
  it("nutzt eine getrennte Action und übergibt weder Actor noch E-Mail als Autorität", async () => {
    const actions = await readFile(`${DETAIL}/assignment-actions.ts`, "utf8");
    expect(actions).toContain('"use server"');
    expect(actions).toContain("exactStringEntries");
    expect(actions).toContain('authorizedAction(workspaceId, "project.assign"');
    expect(actions).toContain("changeProjectAssignment");
    expect(actions).toContain("expectedAssignmentRevision");
    expect(actions).not.toContain("actorId");
    expect(actions).not.toContain("userId");
    expect(actions).not.toContain("email");
    expect(actions).not.toMatch(/export\s+(?:const|let|var|class)\s+/u);
  });

  it("verzweigt Externe vor Energie-, Katalog- und Offer-Reads in eine minimierte Ansicht", async () => {
    const [page, externalView] = await Promise.all([
      readFile(`${DETAIL}/page.tsx`, "utf8"),
      readFile(`${DETAIL}/assigned-external-request-view.tsx`, "utf8"),
    ]);
    expect(page).toContain("getProjectPageDetail");
    expect(page).toContain('pageDetail.audience === "assigned_external"');
    expect(page.indexOf('pageDetail.audience === "assigned_external"'))
      .toBeLessThan(page.indexOf("const energyResult = await loadProjectEnergy"));
    expect(externalView).toContain("Zugewiesene Anfrage");
    expect(externalView).toContain("Nur Lesezugriff");
    expect(externalView).toContain("detail.requirements.bidirectionalCharging");
    expect(externalView).not.toContain("calculatorEstimate");
    expect(externalView).not.toContain("latitude");
    expect(externalView).not.toContain("longitude");
    expect(externalView).not.toContain("ProductResolution");
    expect(externalView).not.toContain("OfferCreate");
  });

  it("zeigt intern Verantwortung, Suchgrenze und konfliktfeste native Controls", async () => {
    const panel = await readFile(`${DETAIL}/project-assignment-panel.tsx`, "utf8");
    expect(panel).toContain('<section id="project-assignment"');
    expect(panel).toContain("Projektverantwortung");
    expect(panel).toContain("Nicht zugewiesen");
    expect(panel).toContain("expectedAssignmentRevision");
    expect(panel).toContain("membershipSearch");
    expect(panel).toContain('minLength={2}');
    expect(panel).toContain('maxLength={100}');
    expect(panel).toContain('role={isError ? "alert" : "status"}');
    expect(panel).toContain("feedbackRef.current?.focus()");
    expect(panel).toContain("min-h-11");
  });

  it("markiert Boardkarten mit Verantwortung und hält External read-only", async () => {
    const [page, boardService] = await Promise.all([
      readFile(`${REQUESTS}/page.tsx`, "utf8"),
      readFile("modules/boards/service.ts", "utf8"),
    ]);
    expect(page).toContain("card.assignment.keyAccountLabel");
    expect(page).toContain("Nicht zugewiesen");
    expect(boardService).toContain("assigned_external");
    expect(boardService).toContain("canMoveCards: false");
  });
});
