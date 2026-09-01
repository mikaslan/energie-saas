import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const REQUESTS = "app/w/[workspaceId]/anfragen";
const DETAIL = `${REQUESTS}/[projectId]`;
const CLOSED = `${REQUESTS}/abgeschlossen/page.tsx`;
const SETTINGS = "app/w/[workspaceId]/einstellungen/verlustgruende";

describe("M1-11a Project-Outcome Portalvertrag", () => {
  it("verknüpft offene und abgeschlossene Anfragen wechselseitig und markiert die aktive Sicht", async () => {
    const [openPage, closedPage] = await Promise.all([
      readFile(`${REQUESTS}/page.tsx`, "utf8"),
      readFile(CLOSED, "utf8"),
    ]);

    for (const page of [openPage, closedPage]) {
      expect(page).toContain('<nav aria-label="Anfrageansichten"');
      expect(page).toMatch(/>\s*Offen\s*<\/Link>/u);
      expect(page).toMatch(/>\s*Abgeschlossen\s*<\/Link>/u);
      expect(page).toContain("/anfragen/abgeschlossen");
    }
    expect(openPage).toContain('<Link\n            aria-current="page"');
    expect(openPage).toContain('href={`/w/${validWorkspaceId}/anfragen`}');
    expect(closedPage).toContain(
      '<Link aria-current="page" href={`/w/${workspaceId}/anfragen/abgeschlossen`}',
    );
    expect(closedPage).toContain('href={`/w/${workspaceId}/anfragen`}');
  });

  it("lädt und rendert das Outcome-Panel ausschließlich hinter der internen Detailgrenze", async () => {
    const page = await readFile(`${DETAIL}/page.tsx`, "utf8");
    const externalBoundary = page.indexOf(
      'if (pageDetail.audience === "assigned_external")',
    );
    const outcomeRead = page.indexOf(
      "const outcomeResult = await loadProjectOutcomeContext",
      externalBoundary,
    );
    const panel = page.indexOf("<ProjectOutcomePanel", outcomeRead);

    expect(externalBoundary).toBeGreaterThan(-1);
    expect(outcomeRead).toBeGreaterThan(externalBoundary);
    expect(panel).toBeGreaterThan(outcomeRead);
    expect(page).toContain('"project.read",\n      "project_outcome"');
    expect(page).toContain("context={outcomeContext}");
  });

  it("bezieht Viewer-Mutationsfähigkeit nur aus dem serverseitigen Context und nicht aus einem frei kombinierbaren Prop", async () => {
    const [page, panel, service] = await Promise.all([
      readFile(`${DETAIL}/page.tsx`, "utf8"),
      readFile(`${DETAIL}/project-outcome-panel.tsx`, "utf8"),
      readFile("modules/projects/outcome-service.ts", "utf8"),
    ]);
    const signatureStart = panel.indexOf("export function ProjectOutcomePanel");
    const signatureEnd = panel.indexOf("const boundAction", signatureStart);
    const propContract = panel.slice(signatureStart, signatureEnd);

    expect(propContract).toContain("context: ProjectOutcomeContext;");
    expect(propContract).not.toContain("canChangeOutcome:");
    expect(page).not.toContain("canChangeOutcome={");
    expect(panel).toContain("context.permissions.canChangeOutcome ? (");
    expect(panel).toContain(
      "Du kannst das Geschäftsergebnis sehen, aber nicht verändern.",
    );
    expect(service).toContain('const canChangeOutcome = row.phase === "request"');
    expect(service).toContain('&& row.contact_deleted_at === null');
    expect(service).toContain('can(ctx, "project.outcome.write")');
    expect(service).toContain("&& !isExternalOnly(ctx)");
    expect(service).toContain("activeLossReasons = canChangeOutcome");
    expect(service).toContain(".map(({ id, label }) => ({ id, label }))");
  });

  it("führt Lost-Grund, Kommentargrenze und alle verbindlichen Bestätigungen sichtbar", async () => {
    const panel = await readFile(`${DETAIL}/project-outcome-panel.tsx`, "utf8");

    expect(panel).toContain("context.activeLossReasons.map");
    expect(panel).toContain('<select name="lossReasonId" required');
    expect(panel).toContain(
      '<textarea name="lossReasonText" maxLength={500} rows={4}',
    );
    expect(panel).toContain('<input type="hidden" name="confirmation" value={kind} />');
    expect(panel).toContain('kind="mark_won"');
    expect(panel).toContain('kind="mark_lost"');
    expect(panel).toContain('kind="reopen"');
    expect(panel).toContain("Gewonnen verbindlich bestätigen");
    expect(panel).toContain("Verloren verbindlich bestätigen");
    expect(panel).toContain("Wieder öffnen bestätigen");
  });

  it("stellt die admin-autorisierte Verlustgrundverwaltung mit 80-Zeichen-Limit und Archivbestätigung bereit", async () => {
    const [page, manager] = await Promise.all([
      readFile(`${SETTINGS}/page.tsx`, "utf8"),
      readFile(`${SETTINGS}/loss-reason-manager.tsx`, "utf8"),
    ]);

    expect(page).toContain("authorizedQuery");
    expect(page).toContain('"settings.manage",\n      "project_loss_reason"');
    expect(page).toContain("listManagedProjectLossReasons(tx, ctx)");
    expect(page).toContain("<LossReasonManager");
    expect(manager).toContain('name="label" required minLength={1} maxLength={80}');
    expect(manager).toContain('name="kind" value="create"');
    expect(manager).toContain('kind="archive"');
    expect(manager).toContain('kind="reactivate"');
    expect(manager).toContain(
      '<input type="hidden" name="archiveConfirmation" value="archive" />',
    );
    expect(manager).toContain("Archivierung bestätigen");
    expect(manager).toContain("Reaktivieren");
  });

  it("nutzt für Angebotskontrollen dieselbe frische Outcome-Quelle wie Header und Panel", async () => {
    const page = await readFile(`${DETAIL}/page.tsx`, "utf8");

    expect(page).toContain("outcome: outcomeContext.outcome");
    expect(page).not.toContain("outcome: detail.project.outcome");
  });

  it("behandelt jeden ungültigen oder doppelten Closed-Cursor kontrolliert als 404", async () => {
    const page = await readFile(CLOSED, "utf8");

    expect(page).toContain(
      "if (rawSearch.cursor !== undefined && rawCursor === undefined) notFound()",
    );
    expect(page).toContain("if (!parsedCursor.success) notFound()");
    expect(page).toContain(
      "else if (error instanceof ProjectOutcomeValidationError) notFound()",
    );
  });

  it("rendert die geschlossene Activity-Bezeichnung und unterdrückt Taskdaten bei null taskId", async () => {
    const panel = await readFile(`${DETAIL}/project-activity-panel.tsx`, "utf8");
    const taskGuard = panel.indexOf("{item.taskId !== null ? (");
    const taskTitle = panel.indexOf("item.taskTitle", taskGuard);

    expect(panel).toContain("{item.label}");
    expect(taskGuard).toBeGreaterThan(-1);
    expect(taskTitle).toBeGreaterThan(taskGuard);
    expect(panel).toContain('item.taskTitle ?? "Nicht mehr verfügbar"');
    expect(panel).not.toContain("ACTIVITY_LABELS");
    expect(panel).not.toContain("item.eventType");
    expect(panel).not.toContain("item.payload");
  });
});
