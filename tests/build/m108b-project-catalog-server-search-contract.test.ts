import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const PROJECT_PRODUCTS =
  "app/w/[workspaceId]/anfragen/[projectId]/produkte";

describe("M108B serverseitige Projekt-Katalogsuche", () => {
  it("filtert aktive Produkte serverseitig vor dem bestehenden Trefferlimit", async () => {
    const [service, index] = await Promise.all([
      readFile("modules/catalog/service.ts", "utf8"),
      readFile("modules/catalog/index.ts", "utf8"),
    ]);
    expect(service).toContain("searchActiveProjectCatalogComponents");
    expect(service).toContain('requireCatalogAccess(ctx, "project.read"');
    expect(service).toContain("await readProject");
    expect(service).toContain('status: "active"');
    expect(service).toContain("query: parsed.data.query");
    expect(service).toContain("component.internal_sku = ${exactSku}");
    expect(index).toContain("searchActiveProjectCatalogComponents");
  });

  it("hält Suche als exakt validierte und autorisierte Server Action", async () => {
    const actions = await readFile(`${PROJECT_PRODUCTS}/actions.ts`, "utf8");
    expect(actions).toContain('"use server"');
    expect(actions).toContain("authorizedAction");
    expect(actions).toContain("searchActiveProjectCatalogComponents");
    expect(actions).toContain("searchProjectCatalogAction");
    expect(actions).toContain("NotAuthenticatedError");
    expect(actions).toContain("PermissionDeniedError");
    expect(actions).toContain("z.strictObject");
  });

  it("bewahrt gefundene Auswahl und sendet nur gewählte IDs bis Vertragsmaximum 500", async () => {
    const [form, catalogActions] = await Promise.all([
      readFile(`${PROJECT_PRODUCTS}/resolution-form.tsx`, "utf8"),
      readFile("app/w/[workspaceId]/katalog/actions.ts", "utf8"),
    ]);
    expect(form).toContain("searchProjectCatalogAction");
    expect(form).toContain("Produkt-SKU oder Name suchen");
    expect(form).toContain("Suchergebnisse");
    expect(form).toContain("Ausgewählte Produkte");
    expect(form).toContain("selectedComponents");
    expect(form).toContain('name="selectionCount"');
    expect(form).not.toContain("selection.${index}.selected");
    expect(catalogActions).toContain(
      'integerValue(stringValue(formData, "selectionCount"), 1, 500)',
    );
    expect(catalogActions).not.toContain(".selected`)");
  });
});
